import { createHash } from "node:crypto";
import { readFile, rm } from "node:fs/promises";
import { join } from "node:path";

import { applyEdits, modify, parse, printParseErrorCode } from "jsonc-parser";

import { SnackError, ExitCode } from "./errors.js";
import { writePrivateAtomic } from "./config.js";

const packageName = "@snack-ai/opencode";

/**
 * The plugin version setup writes. SNACK fetches no package itself; OpenCode resolves this
 * specifier. Inspection deliberately does not require an exact match — see
 * `inspectPluginRegistration`.
 */
export const pluginPackageSpec = `${packageName}@0.1.2`;
const packageSpec = pluginPackageSpec;

/**
 * Locate OpenCode's global configuration the same way OpenCode does.
 *
 * The environment falls back to `process.env` exactly as `resolvePaths` does: a real CLI
 * invocation passes no `env`, and reading `XDG_CONFIG_HOME` only off the argument would register
 * the plugin under `~/.config` while OpenCode reads it elsewhere — capture would silently never
 * start, and doctor would still call it compatible by looking in the same wrong place.
 *
 * @param {{env?: NodeJS.ProcessEnv, home?: string}} [options]
 */
export function resolveOpenCodeConfig(options = {}) {
  const env = options.env ?? process.env;
  const home = options.home ?? env.HOME ?? "";
  const configHome = env.XDG_CONFIG_HOME ?? join(home, ".config");
  return join(configHome, "opencode", "opencode.json");
}

/**
 * Classify the SNACK entry in OpenCode's global configuration.
 *
 * Compatibility is a property of the spool event contract, not of a version string: every
 * `@snack-ai/opencode@0.1.x` emits `spool-event-v1`. So a registration pinned at a version other
 * than the one setup writes is reported as `outdated` — an upgrade notice — while `incompatible`
 * is reserved for an entry SNACK genuinely cannot work with, namely one whose options are absent
 * or unrecognized.
 *
 * @param {string} configFile
 * @returns {Promise<"compatible" | "outdated" | "missing" | "incompatible" | "invalid">}
 */
export async function inspectPluginRegistration(configFile) {
  let source;
  try {
    source = await readFile(configFile, "utf8");
  } catch (error) {
    if (isNotFound(error)) return "missing";
    return "invalid";
  }
  /** @type {import("jsonc-parser").ParseError[]} */
  const errors = [];
  const parsed = parse(source, errors, { allowTrailingComma: true });
  if (errors.length > 0 || !isRecord(parsed) || !Array.isArray(parsed.plugin)) return "invalid";
  const plugin = parsed.plugin.find(
    (value) =>
      isSnackPluginSpecifier(value) || (Array.isArray(value) && isSnackPluginSpecifier(value[0])),
  );
  if (plugin === undefined) return "missing";
  if (!Array.isArray(plugin) || plugin.length !== 2 || !isRecoverablePlugin(plugin)) {
    return "incompatible";
  }
  return plugin[0] === packageSpec ? "compatible" : "outdated";
}

/**
 * Prepare the exact structural change owned by SNACK without rendering unrelated OpenCode settings.
 *
 * @param {string} configFile
 * @param {{installation_id: string, spool_directory: string, prospective_analysis: boolean, source_bindings: {provider: string, source_alias: string, spool_directory: string}[]}} options
 */
export async function preparePluginRegistration(configFile, options) {
  let source = "{}\n";
  let existed = false;
  try {
    source = await readFile(configFile, "utf8");
    existed = true;
  } catch (error) {
    if (!isNotFound(error)) throw configError();
  }
  /** @type {import("jsonc-parser").ParseError[]} */
  const errors = [];
  const parsed = parse(source, errors, { allowTrailingComma: true });
  if (errors.length > 0 || !isRecord(parsed)) {
    const detail = errors[0] ? printParseErrorCode(errors[0].error) : "Invalid structure";
    throw new SnackError(`OpenCode configuration is not valid JSONC (${detail}).`, {
      code: ExitCode.config,
      reason: "opencode_config_parse_error",
    });
  }
  if ("plugin" in parsed && !Array.isArray(parsed.plugin)) throw configError();
  const pluginPropertyExisted = "plugin" in parsed;
  const plugins = Array.isArray(parsed.plugin) ? parsed.plugin : [];
  const pluginOptions = {
    installation_id: options.installation_id,
    spool_directory: options.spool_directory,
    prospective_analysis: options.prospective_analysis,
    source_bindings: options.source_bindings,
  };
  const index = plugins.findIndex(
    (plugin) =>
      isSnackPluginSpecifier(plugin) ||
      (Array.isArray(plugin) && isSnackPluginSpecifier(plugin[0])),
  );
  const previousPlugin = index === -1 ? null : plugins[index];
  if (previousPlugin !== null && !isRecoverablePlugin(previousPlugin)) {
    throw new SnackError("Existing SNACK OpenCode plugin options cannot be safely recovered.", {
      code: ExitCode.config,
      reason: "opencode_plugin_options_unsupported",
    });
  }
  const updatedPlugins = [...plugins];
  if (index === -1) updatedPlugins.push([packageSpec, pluginOptions]);
  else updatedPlugins[index] = [packageSpec, pluginOptions];
  const installedPlugin = updatedPlugins[index === -1 ? updatedPlugins.length - 1 : index];
  const edits = modify(source, ["plugin"], updatedPlugins, {
    formattingOptions: { insertSpaces: true, tabSize: 2, eol: "\n" },
  });
  return {
    content: applyEdits(source, edits),
    spool_directories: [
      options.spool_directory,
      ...options.source_bindings.map((binding) => binding.spool_directory),
    ],
    previous_content: source,
    existed,
    config_existed: existed,
    plugin_property_existed: pluginPropertyExisted,
    previous_plugin: previousPlugin,
    previous_plugin_index: index,
    installed_plugin_hash: hashPluginEntry(installedPlugin),
    change: {
      target: "global",
      package: packageSpec,
      action: index === -1 ? "add" : "update",
      prospective_analysis: options.prospective_analysis,
    },
  };
}

/** @param {string} configFile @param {string} content @param {string} expectedContent */
export async function writePluginRegistration(configFile, content, expectedContent) {
  // OpenCode config can contain credentials; never duplicate it into a SNACK-managed backup.
  let current = null;
  try {
    current = await readFile(configFile, "utf8");
  } catch (error) {
    if (!isNotFound(error)) throw configError();
  }
  if (current !== (expectedContent === "{}\n" && current === null ? null : expectedContent)) {
    throw new SnackError("OpenCode configuration changed while setup was running.", {
      code: ExitCode.config,
      reason: "opencode_config_changed",
    });
  }
  await writePrivateAtomic(configFile, content);
}

/** @param {string} configFile @param {unknown} previousPlugin @param {number} previousPluginIndex @param {boolean} configExisted @param {boolean} pluginPropertyExisted @param {string} installedPluginHash */
export async function restorePluginRegistration(
  configFile,
  previousPlugin,
  previousPluginIndex,
  configExisted,
  pluginPropertyExisted,
  installedPluginHash,
) {
  let source;
  try {
    source = await readFile(configFile, "utf8");
  } catch (error) {
    if (isNotFound(error) && previousPlugin === null) return;
    throw configError();
  }
  /** @type {import("jsonc-parser").ParseError[]} */
  const errors = [];
  const parsed = parse(source, errors, { allowTrailingComma: true });
  if (errors.length > 0 || !isRecord(parsed)) throw configError();
  const plugins = Array.isArray(parsed.plugin) ? parsed.plugin : [];
  const installedPlugin = plugins.find(
    (plugin) =>
      isSnackPluginSpecifier(plugin) ||
      (Array.isArray(plugin) && isSnackPluginSpecifier(plugin[0])),
  );
  if (installedPlugin === undefined || hashPluginEntry(installedPlugin) !== installedPluginHash) {
    return;
  }
  const withoutSnack = plugins.filter(
    (plugin) =>
      !isSnackPluginSpecifier(plugin) &&
      !(Array.isArray(plugin) && isSnackPluginSpecifier(plugin[0])),
  );
  if (previousPlugin !== null) {
    withoutSnack.splice(
      Math.max(0, Math.min(previousPluginIndex, withoutSnack.length)),
      0,
      previousPlugin,
    );
  }
  if (
    !configExisted &&
    Object.keys(parsed).every((key) => key === "plugin") &&
    withoutSnack.length === 0
  ) {
    await rm(configFile, { force: true });
    return;
  }
  const content = applyEdits(
    source,
    modify(source, ["plugin"], pluginPropertyExisted ? withoutSnack : undefined, {
      formattingOptions: { insertSpaces: true, tabSize: 2, eol: "\n" },
    }),
  );
  await writePrivateAtomic(configFile, content);
}

/** @param {unknown} entry */
function hashPluginEntry(entry) {
  return createHash("sha256").update(JSON.stringify(entry)).digest("hex");
}

/** @param {unknown} plugin */
function isRecoverablePlugin(plugin) {
  if (isSnackPluginSpecifier(plugin)) return true;
  if (!Array.isArray(plugin) || plugin.length !== 2 || !isSnackPluginSpecifier(plugin[0])) {
    return false;
  }
  const options = plugin[1];
  if (!isRecord(options)) return false;
  const allowed = new Set([
    "installation_id",
    "spool_directory",
    "prospective_analysis",
    "source_bindings",
  ]);
  if (!Object.keys(options).every((key) => allowed.has(key))) return false;
  if ("installation_id" in options && typeof options.installation_id !== "string") return false;
  if ("spool_directory" in options && typeof options.spool_directory !== "string") return false;
  if ("prospective_analysis" in options && typeof options.prospective_analysis !== "boolean") {
    return false;
  }
  if ("source_bindings" in options) {
    if (!Array.isArray(options.source_bindings)) return false;
    for (const binding of options.source_bindings) {
      if (
        !isRecord(binding) ||
        !Object.keys(binding).every((key) =>
          ["provider", "source_alias", "spool_directory"].includes(key),
        ) ||
        typeof binding.provider !== "string" ||
        typeof binding.source_alias !== "string" ||
        typeof binding.spool_directory !== "string"
      ) {
        return false;
      }
    }
  }
  return true;
}

/** @param {unknown} value */
function isSnackPluginSpecifier(value) {
  return (
    typeof value === "string" && (value === packageName || value.startsWith(`${packageName}@`))
  );
}

/** @param {unknown} value @returns {value is Record<string, unknown>} */
function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function configError() {
  return new SnackError("OpenCode configuration could not be read.", {
    code: ExitCode.config,
    reason: "opencode_config_read_error",
  });
}

/** @param {unknown} error */
function isNotFound(error) {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}
