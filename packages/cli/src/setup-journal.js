import { readFile, rm } from "node:fs/promises";
import { join } from "node:path";

import { writePrivateAtomic } from "./config.js";
import { restorePluginRegistration } from "./opencode-config.js";
import { restoreSetupDatabaseBackup } from "./storage.js";

const filename = "setup-opencode-plugin.json";

/** @param {import("./paths.js").SnackPaths} paths */
export function setupJournalFile(paths) {
  return join(paths.stateDir, filename);
}

/** @param {import("./paths.js").SnackPaths} paths @param {{opencode_config_file: string, config_existed: boolean, plugin_property_existed: boolean, previous_plugin: unknown, previous_plugin_index: number, installed_plugin_hash: string, previous_snack_config: string | null, database_backup_file: string | null}} entry */
export async function writeSetupJournal(paths, entry) {
  await writePrivateAtomic(
    setupJournalFile(paths),
    `${JSON.stringify({ version: 3, ...entry })}\n`,
  );
}

/** @param {import("./paths.js").SnackPaths} paths @param {{restorePlugin?: boolean}} [options] */
export async function recoverSetupJournal(paths, options = {}) {
  let raw;
  try {
    raw = await readFile(setupJournalFile(paths), "utf8");
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return false;
    throw error;
  }
  const entry = JSON.parse(raw);
  if (
    typeof entry !== "object" ||
    entry === null ||
    entry.version !== 3 ||
    typeof entry.opencode_config_file !== "string" ||
    typeof entry.config_existed !== "boolean" ||
    typeof entry.plugin_property_existed !== "boolean" ||
    typeof entry.installed_plugin_hash !== "string" ||
    !Number.isInteger(entry.previous_plugin_index) ||
    !("previous_plugin" in entry) ||
    !("previous_snack_config" in entry) ||
    !("database_backup_file" in entry) ||
    (entry.database_backup_file !== null && typeof entry.database_backup_file !== "string") ||
    (entry.previous_snack_config !== null && typeof entry.previous_snack_config !== "string")
  ) {
    throw new Error("Setup recovery journal is invalid.");
  }
  if (entry.previous_snack_config === null) await rm(paths.configFile, { force: true });
  else await writePrivateAtomic(paths.configFile, entry.previous_snack_config);
  if (options.restorePlugin !== false) {
    await restorePluginRegistration(
      entry.opencode_config_file,
      entry.previous_plugin,
      entry.previous_plugin_index,
      entry.config_existed,
      entry.plugin_property_existed,
      entry.installed_plugin_hash,
    );
  }
  await restoreSetupDatabaseBackup(paths, entry.database_backup_file);
  await rm(setupJournalFile(paths), { force: true });
  return true;
}

/** @param {import("./paths.js").SnackPaths} paths */
export async function clearSetupJournal(paths) {
  await rm(setupJournalFile(paths), { force: true });
}
