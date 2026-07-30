import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { access, chmod, mkdir, open, readFile, rename, rm } from "node:fs/promises";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";

import Ajv2020 from "ajv/dist/2020.js";
import { applyEdits, modify, parse, printParseErrorCode } from "jsonc-parser";
import lockfile from "proper-lockfile";

import { ExitCode, SnackError } from "./errors.js";

const schemaPath = fileURLToPath(new URL("../schemas/config.schema.json", import.meta.url));
const schema = JSON.parse(await readFile(schemaPath, "utf8"));
const ajv = new Ajv2020.default({ allErrors: true, strict: true });
const validate = ajv.compile(schema);

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
    const issue = validate.errors?.[0];
    const location = issue?.instancePath || "configuration root";
    throw new SnackError(`Configuration schema rejected ${location}.`, {
      code: ExitCode.config,
      reason: "config_schema_error",
    });
  }
  return value;
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
      throw new SnackError("Configuration does not exist; use `snack config set` first.", {
        code: ExitCode.config,
        reason: "config_missing",
      });
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
  const path = parseKey(key);
  const value = parseCommandValue(rawValue);
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

  const edits = modify(source, path, value, {
    formattingOptions: { insertSpaces: true, tabSize: 2, eol: "\n" },
  });
  const updated = applyEdits(source, edits);
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
      release = await lockfile.lock(configFile, {
        realpath: false,
        stale: 120_000,
        update: 10_000,
        retries: { retries: 20, minTimeout: 50, maxTimeout: 250 },
      });
      await chmod(`${configFile}.lock`, 0o700);
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
    if (!isRecord(current) || !(part in current)) {
      throw new SnackError(`Configuration key '${key}' does not exist.`, {
        code: ExitCode.config,
        reason: "config_key_missing",
      });
    }
    current = current[part];
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

/** @param {string} key */
function parseKey(key) {
  const parts = key.split(".");
  if (
    parts.some(
      (part) => !/^[a-z][a-z0-9_]*$/u.test(part) || ["__proto__", "constructor"].includes(part),
    )
  ) {
    throw new SnackError("Configuration key is invalid.", {
      code: ExitCode.usage,
      reason: "invalid_config_key",
    });
  }
  return parts;
}

/** @param {string} raw */
function parseCommandValue(raw) {
  /** @type {import("jsonc-parser").ParseError[]} */
  const errors = [];
  const value = parse(raw, errors, { allowTrailingComma: false });
  return errors.length === 0 && value !== undefined ? value : raw;
}

/** @param {unknown} value @returns {value is Record<string, unknown>} */
function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** @param {unknown} error */
function isNotFound(error) {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
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
