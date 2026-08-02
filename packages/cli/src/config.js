import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { access, chmod, mkdir, open, readFile, rename, rm } from "node:fs/promises";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";

import Ajv2020 from "ajv/dist/2020.js";
import { applyEdits, modify, parse, printParseErrorCode } from "jsonc-parser";

import { ExitCode, SnackError } from "./errors.js";
import { acquirePrivateLock } from "./file-lock.js";
import { isNotFound, isRecord } from "./guards.js";

const schemaPath = fileURLToPath(new URL("../schemas/config.schema.json", import.meta.url));
const schema = JSON.parse(await readFile(schemaPath, "utf8"));
const ajv = new Ajv2020.default({ allErrors: true, strict: true });
const validate = ajv.compile(schema);

/**
 * The identifier rule each configured-source field must satisfy, read out of the same schema that
 * enforces it on write.
 *
 * Setup asks for these values one at a time and only finds out at the end whether the
 * configuration will take them, which costs someone the whole questionnaire over one space in a
 * profile name. Lifting the rules out of the schema lets a question refuse its own answer on the
 * spot; reading them rather than restating them is what keeps the two checks from drifting apart.
 */
const sourceIdentifierPatterns =
  /** @type {Readonly<Record<"alias" | "provider" | "profile" | "plan", string>>} */ (
    Object.freeze(
      Object.fromEntries(
        ["alias", "provider", "profile", "plan"].map((field) => {
          const property = schema.properties.sources.items.properties[field];
          const reference =
            String(property.$ref ?? "")
              .split("/")
              .pop() ?? "";
          return [field, String(property.pattern ?? schema.$defs[reference].pattern)];
        }),
      ),
    )
  );

/**
 * State the rule a configured-source identifier has to match, for a question to show up front.
 *
 * @param {"alias" | "provider" | "profile" | "plan"} field
 */
function describeSourceIdentifier(field) {
  return `must match ${sourceIdentifierPatterns[field]}`;
}

/**
 * Report why a configured-source identifier is unusable, or `null` when it is fine.
 *
 * The message names the field and the value as well as the rule: the schema error it replaces says
 * only which path was rejected, which is of no help to someone who has just typed an answer.
 *
 * @param {"alias" | "provider" | "profile" | "plan"} field
 * @param {string} value
 */
export function checkSourceIdentifier(field, value) {
  if (new RegExp(sourceIdentifierPatterns[field]).test(value)) return null;
  return `${field} "${value}" is not usable; it ${describeSourceIdentifier(field)}.`;
}

export const defaultConfig = Object.freeze({
  schema_version: 1,
  sources: [],
  analysis: {
    horizons: ["PT1H", "PT5H", "P1D", "P7D"],
  },
  presentation: {
    json: false,
  },
  prospective_analysis: {
    enabled: false,
  },
});

/**
 * Recognize a configured capacity source of any supported client.
 *
 * The schema already refuses a malformed source on read; this is the runtime narrowing the command
 * and diagnostic layers share, so they cannot disagree about what counts as configured. Where a
 * client keeps its history is the client's own business — a database file for OpenCode, a projects
 * directory for Claude Code — so either satisfies the check.
 *
 * @param {unknown} value
 * @returns {value is {alias: string, installation_id: string, adapter: "opencode" | "claude", database?: string, projects?: string, provider: string, profile: string, plan: string, fingerprint: string}}
 */
export function isConfiguredSource(value) {
  return (
    typeof value === "object" &&
    value !== null &&
    "alias" in value &&
    typeof value.alias === "string" &&
    "installation_id" in value &&
    typeof value.installation_id === "string" &&
    "adapter" in value &&
    (value.adapter === "opencode" || value.adapter === "claude") &&
    "provider" in value &&
    typeof value.provider === "string" &&
    "profile" in value &&
    typeof value.profile === "string" &&
    "plan" in value &&
    typeof value.plan === "string" &&
    (("database" in value && typeof value.database === "string") ||
      ("projects" in value && typeof value.projects === "string")) &&
    "fingerprint" in value &&
    typeof value.fingerprint === "string"
  );
}

/**
 * Refuse an alias no configured capacity source answers to.
 *
 * Every command that narrows to one source owes the same answer to a typo, so the guard lives here
 * rather than being restated per command — `doctor` restated it by omission and reported a healthy
 * installation for an alias that did not exist.
 *
 * @param {string | undefined} alias
 * @param {unknown} sources the `sources` array as it came out of the configuration
 */
export function requireConfiguredSource(alias, sources) {
  if (alias === undefined) return;
  const configured = Array.isArray(sources) ? sources : [];
  if (configured.some((source) => isConfiguredSource(source) && source.alias === alias)) return;
  // Never echo the value back. An alias arrives from argv, and argv is exactly where someone pastes
  // something private by accident; a rejected value must not travel into a JSON document that gets
  // shared.
  throw new SnackError("The requested capacity source is not configured.", {
    code: ExitCode.unavailable,
    reason: "source_not_configured",
  });
}

/**
 * @param {string} text
 * @returns {Record<string, unknown>}
 */
export function parseAndValidateConfig(text) {
  /** @type {import("jsonc-parser").ParseError[]} */
  const errors = [];
  const value = parse(text, errors, { allowTrailingComma: true });
  if (errors.length > 0) {
    const firstError = errors[0];
    const reason = firstError ? printParseErrorCode(firstError.error) : "Unknown";
    throw new SnackError(`Configuration is not valid JSONC (${reason}).`, {
      code: ExitCode.config,
      reason: "config_parse_error",
    });
  }
  if (!isRecord(value) || !validate(value)) {
    throw describeSchemaRejection(validate.errors);
  }
  return value;
}

/**
 * Turn Ajv's error list into one diagnostic that says which rule refused the configuration.
 *
 * Reporting only the location answered a missing field, a mistyped value and an unsupported client
 * with the same sentence, and gave a `--json` consumer nothing the human line did not already have.
 * The rejected value never appears: a configuration is exactly where a private path would sit, so
 * the diagnostic names the rule and the location and stops there.
 *
 * @param {import("ajv").ErrorObject[] | null | undefined} errors
 */
function describeSchemaRejection(errors) {
  // Two rules, in order. A field's own declaration beats a `oneOf` branch: an unsupported adapter
  // fails every branch, so the branch errors accuse whichever field that branch happened to pin --
  // reporting the fingerprint for a mistyped client name. Then the deepest path wins, because the
  // composite error reported against the parent is the one that says least.
  const insideBranch = (/** @type {import("ajv").ErrorObject} */ error) =>
    error.schemaPath.includes("/oneOf/") || error.keyword === "oneOf";
  const issue = [...(errors ?? [])].sort(
    (left, right) =>
      Number(insideBranch(left)) - Number(insideBranch(right)) ||
      right.instancePath.length - left.instancePath.length,
  )[0];
  const location = issue?.instancePath || "configuration root";
  // Named here rather than derived from Ajv's keyword: these codes are a public contract, and
  // `enum` and `const` are two spellings of the same answer to the reader -- an unsupported value.
  const explained =
    issue?.keyword === "required"
      ? // A schema-declared name, not anything the user typed.
        {
          reason: "config_schema_required",
          detail: `it is missing ${String(issue.params.missingProperty)}`,
        }
      : issue?.keyword === "pattern"
        ? {
            reason: "config_schema_pattern",
            detail: "the value is not in the form this field accepts",
          }
        : issue?.keyword === "enum" || issue?.keyword === "const"
          ? {
              reason: "config_schema_unsupported_value",
              detail: "the value is not one SNACK supports",
            }
          : issue?.keyword === "type"
            ? {
                reason: "config_schema_type",
                detail: `the value is not ${String(issue.params.type)}`,
              }
            : issue?.keyword === "additionalProperties"
              ? {
                  reason: "config_schema_unknown_property",
                  detail: "it carries a property SNACK does not recognize",
                }
              : undefined;
  return new SnackError(
    explained === undefined
      ? `Configuration schema rejected ${location}.`
      : `Configuration schema rejected ${location}: ${explained.detail}.`,
    {
      code: ExitCode.config,
      reason: explained?.reason ?? "config_schema_error",
    },
  );
}

/**
 * @param {string} configFile
 * @returns {Promise<Record<string, unknown>>}
 */
export async function readConfig(configFile) {
  try {
    return parseAndValidateConfig(await readFile(configFile, "utf8"));
  } catch (error) {
    if (isNotFound(error)) {
      // Both clients are named. Sending someone who only runs Claude Code to set up OpenCode is a
      // dead end, and this is the first message a new user sees.
      throw new SnackError(
        "Configuration does not exist; run `snack setup opencode` or `snack setup claude` first.",
        {
          code: ExitCode.config,
          reason: "config_missing",
        },
      );
    }
    if (!(error instanceof SnackError)) {
      throw new SnackError("Configuration could not be read.", {
        code: ExitCode.config,
        reason: "config_read_error",
        cause: error,
      });
    }
    throw error;
  }
}

/**
 * @param {string} configFile
 * @param {string} key
 * @param {string} rawValue
 */
export async function setConfigValue(configFile, key, rawValue) {
  await prepareConfigValue(configFile, key, rawValue);
  return withConfigLock(configFile, async () => {
    const prepared = await prepareConfigValue(configFile, key, rawValue);
    await writePrivateAtomic(configFile, prepared.content, { backup: true });
    return prepared.config;
  });
}

/**
 * Validate a proposed update without mutating the filesystem.
 *
 * @param {string} configFile
 * @param {string} key
 * @param {string} rawValue
 */
export async function prepareConfigValue(configFile, key, rawValue) {
  return prepareConfigValues(configFile, [[key, parseCommandValue(rawValue)]]);
}

/**
 * Validate multiple configuration updates as one atomic replacement.
 *
 * @param {string} configFile
 * @param {[string, unknown][]} updates
 */
export async function prepareConfigValues(configFile, updates) {
  let source;
  try {
    source = await readFile(configFile, "utf8");
  } catch (error) {
    if (!isNotFound(error)) {
      throw new SnackError("Configuration could not be read.", {
        code: ExitCode.config,
        reason: "config_read_error",
        cause: error,
      });
    }
    source = `${JSON.stringify(defaultConfig, null, 2)}\n`;
  }

  let updated = source;
  for (const [key, value] of updates) {
    const edits = modify(updated, parseKey(key), value, {
      formattingOptions: { insertSpaces: true, tabSize: 2, eol: "\n" },
    });
    updated = applyEdits(updated, edits);
  }
  const config = parseAndValidateConfig(updated);
  return { config, content: updated };
}

/**
 * Serialize a configuration read-modify-write operation across processes.
 *
 * @template T
 * @param {string} configFile
 * @param {() => Promise<T>} operation
 * @returns {Promise<T>}
 */
export async function withConfigLock(configFile, operation) {
  const parent = dirname(configFile);
  /** @type {(() => Promise<void>) | undefined} */
  let release;
  try {
    try {
      await mkdir(parent, { recursive: true, mode: 0o700 });
      await chmod(parent, 0o700);
      release = await acquirePrivateLock(configFile);
    } catch (error) {
      throw new SnackError("Configuration update lock could not be established.", {
        code: ExitCode.config,
        reason: "config_lock_error",
        cause: error,
      });
    }
    return await operation();
  } finally {
    await release?.().catch(() => {});
  }
}

/**
 * @param {Record<string, unknown>} config
 * @param {string | undefined} key
 */
export function getConfigValue(config, key) {
  if (!key) return config;
  const path = parseKey(key);
  /** @type {unknown} */
  let current = config;
  for (const part of path) {
    const missing = () =>
      new SnackError(`Configuration key '${key}' does not exist.`, {
        code: ExitCode.config,
        reason: "config_key_missing",
      });
    if (typeof part === "number") {
      if (!Array.isArray(current) || part >= current.length) throw missing();
      current = current[part];
    } else {
      if (!isRecord(current) || !(part in current)) throw missing();
      current = current[part];
    }
  }
  return current;
}

/**
 * @param {string} target
 * @param {string} content
 * @param {{backup?: boolean}} [options]
 */
export async function writePrivateAtomic(target, content, options = {}) {
  const parent = dirname(target);
  const temporary = `${target}.${randomUUID()}.tmp`;
  try {
    await mkdir(parent, { recursive: true, mode: 0o700 });
    await chmod(parent, 0o700);

    if (options.backup && (await exists(target))) {
      const backup = `${target}.bak`;
      await writePrivateAtomic(backup, await readFile(target, "utf8"));
    }

    const handle = await open(temporary, "wx", 0o600);
    try {
      await handle.writeFile(content, "utf8");
      await handle.sync();
    } finally {
      await handle.close();
    }
    await rename(temporary, target);
    await chmod(target, 0o600);
  } catch (error) {
    await rm(temporary, { force: true }).catch(() => {});
    throw new SnackError("Configuration could not be replaced atomically.", {
      code: ExitCode.config,
      reason: "config_write_error",
      cause: error,
    });
  }
}

/**
 * Split a dotted configuration key into a JSONC path.
 *
 * A wholly numeric segment addresses an array element, so one configured source can be edited
 * in place instead of rewriting the whole `sources` array. Numeric segments become numbers
 * because that is what a JSONC path expects for an index.
 *
 * @param {string} key
 * @returns {(string | number)[]}
 */
function parseKey(key) {
  const parts = key.split(".");
  if (
    parts.some(
      (part) =>
        !/^(?:[a-z][a-z0-9_]*|\d+)$/u.test(part) || ["__proto__", "constructor"].includes(part),
    )
  ) {
    throw new SnackError("Configuration key is invalid.", {
      code: ExitCode.usage,
      reason: "invalid_config_key",
    });
  }
  return parts.map((part) => (/^\d+$/u.test(part) ? Number(part) : part));
}

/** @param {string} raw */
function parseCommandValue(raw) {
  /** @type {import("jsonc-parser").ParseError[]} */
  const errors = [];
  const value = parse(raw, errors, { allowTrailingComma: false });
  return errors.length === 0 && value !== undefined ? value : raw;
}

/** @param {string} path */
async function exists(path) {
  try {
    await access(path, constants.F_OK);
    return true;
  } catch {
    return false;
  }
}
