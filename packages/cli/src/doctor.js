import { Buffer } from "node:buffer";
import { access, constants, open, readdir, stat } from "node:fs/promises";
import { join } from "node:path";

import { readConfig } from "./config.js";
import { SnackError } from "./errors.js";
import { createOpenCodeAdapter } from "./opencode-adapter.js";
import { inspectPluginRegistration } from "./opencode-config.js";
import { resolvePlanProfile } from "./plan-profile.js";
import { setupJournalFile } from "./setup-journal.js";
import {
  inspectDatabase,
  readPendingMappingCount,
  readSourceSummary,
  readSpoolCursors,
  readSpoolIssueCount,
} from "./storage.js";

/** A bundled profile older than this keeps working, but its assumptions need review. */
const PLAN_PROFILE_STALE_DAYS = 365;

/**
 * @typedef {object} DoctorCheck
 * @property {string} id
 * @property {"pass" | "warn" | "fail"} status
 * @property {string} message
 */

/**
 * @param {import("./paths.js").SnackPaths} paths
 * @param {{nodeVersion?: string | undefined, platform?: NodeJS.Platform | undefined, now?: Date, opencodeConfigFile?: string}} [options]
 * @returns {Promise<{status: "ok" | "degraded" | "error", checks: DoctorCheck[]}>}
 */
export async function runDoctor(paths, options = {}) {
  /** @type {DoctorCheck[]} */
  const checks = [];
  const nodeVersion = options.nodeVersion ?? process.versions.node;
  const platform = options.platform ?? process.platform;
  const now = options.now ?? new Date();
  /** @type {Record<string, unknown> | undefined} */
  let config;

  checks.push(
    Number(nodeVersion.split(".")[0]) === 24
      ? pass("runtime", `Node.js ${nodeVersion} is supported.`)
      : fail("runtime", "SNACK requires Node.js 24."),
  );
  checks.push(
    platform === "linux" || platform === "darwin"
      ? pass("platform", `${platform} is supported.`)
      : fail("platform", `${platform} is not a supported platform.`),
  );

  try {
    config = await readConfig(paths.configFile);
    checks.push(pass("config", "Configuration is valid."));
  } catch (error) {
    if (error instanceof SnackError && error.reason === "config_missing") {
      checks.push(warn("config", "Configuration has not been created."));
    } else {
      checks.push(fail("config", "Configuration is invalid or inaccessible."));
    }
  }
  checks.push(await checkMode(paths.configDir, 0o700, "config_directory"));
  checks.push(await checkMode(paths.configFile, 0o600, "config_file"));
  const configLock = await checkLock(`${paths.configFile}.lock`, "config_lock");
  if (configLock) checks.push(configLock);
  const configBackup = await checkOptionalMode(`${paths.configFile}.bak`, 0o600, "config_backup");
  if (configBackup) checks.push(configBackup);
  checks.push(await checkSetupJournal(setupJournalFile(paths)));

  try {
    const storageLock = await checkLock(`${paths.databaseFile}.lock`, "storage_lock");
    if (storageLock) checks.push(storageLock);
    const storage = await inspectDatabase(paths.databaseFile);
    if (!storage.exists) {
      checks.push(warn("storage", "Storage has not been initialized."));
    } else {
      checks.push(
        storage.integrity === "ok"
          ? pass("storage_integrity", "SQLite integrity check passed.")
          : fail("storage_integrity", "SQLite integrity check failed."),
      );
      checks.push(
        storage.migrations === "current"
          ? pass("storage_migrations", "Storage migrations are current.")
          : fail("storage_migrations", "Storage migrations are not current."),
      );
    }
  } catch {
    checks.push(fail("storage", "Storage is invalid or inaccessible."));
  }
  checks.push(await checkMode(paths.dataDir, 0o700, "data_directory"));
  checks.push(await checkMode(paths.backupDir, 0o700, "backup_directory"));
  const spoolExists = await pathExists(paths.spoolDir);
  if (spoolExists) checks.push(await checkMode(paths.spoolDir, 0o700, "spool_directory"));
  checks.push(await checkMode(paths.databaseFile, 0o600, "database_file"));
  const backupFiles = await checkBackupFiles(paths.backupDir);
  if (backupFiles) checks.push(backupFiles);

  const sources = Array.isArray(config?.sources) ? config.sources : [];
  if (sources.some(isConfiguredSource) && options.opencodeConfigFile) {
    const registration = await inspectPluginRegistration(options.opencodeConfigFile);
    checks.push(
      registration === "compatible"
        ? pass("opencode_plugin", "OpenCode live-capture plugin registration is compatible.")
        : registration === "missing"
          ? warn("opencode_plugin", "OpenCode live-capture plugin is not registered.")
          : fail("opencode_plugin", "OpenCode live-capture plugin registration is incompatible."),
    );
  }
  for (const source of sources) {
    if (!isConfiguredSource(source)) continue;
    checks.push(planProfileCheck(source, now));
    try {
      const fingerprint = createOpenCodeAdapter({ databaseFile: source.database }).fingerprint();
      checks.push(
        fingerprint.supported && fingerprint.family === source.fingerprint
          ? pass(`source_fingerprint:${source.alias}`, "OpenCode schema fingerprint is supported.")
          : fail(
              `source_fingerprint:${source.alias}`,
              "OpenCode schema fingerprint is unsupported.",
            ),
      );
    } catch {
      checks.push(fail(`source_fingerprint:${source.alias}`, "OpenCode source is inaccessible."));
    }
    try {
      const pending = readPendingMappingCount(paths.databaseFile, source);
      checks.push(
        pending === 0
          ? pass(
              `source_mapping:${source.alias}`,
              "Provider and local profile mapping are explicit.",
            )
          : warn(
              `source_mapping:${source.alias}`,
              `${pending} schema-valid observation(s) need an explicit mapping.`,
            ),
      );
    } catch {
      checks.push(warn(`source_mapping:${source.alias}`, "Pending source mappings are unknown."));
    }
    try {
      const summary = readSourceSummary(paths.databaseFile, source.alias);
      const ageMs = summary.as_of === null ? null : now.getTime() - Date.parse(summary.as_of);
      checks.push(
        summary.as_of === null
          ? warn(`source_freshness:${source.alias}`, "No synchronized usage is available.")
          : ageMs !== null && ageMs > 24 * 60 * 60 * 1000
            ? warn(`source_freshness:${source.alias}`, "Synchronized usage is older than 24 hours.")
            : pass(`source_freshness:${source.alias}`, "Synchronized usage is available."),
      );
    } catch {
      checks.push(
        warn(`source_freshness:${source.alias}`, "Synchronized usage freshness is unknown."),
      );
    }
    if (spoolExists) {
      let cursors = null;
      try {
        cursors = readSpoolCursors(paths.databaseFile, source.alias);
      } catch {
        checks.push(
          warn(
            `spool_cursor:${source.alias}`,
            "Spool cursors are unavailable with current storage.",
          ),
        );
      }
      checks.push(
        ...(await checkSpoolDirectory(join(paths.spoolDir, source.alias), source.alias, cursors)),
      );
      try {
        const rejected = readSpoolIssueCount(paths.databaseFile, source.alias);
        checks.push(
          rejected === 0
            ? pass(`source_spool:${source.alias}`, "Live spool has no rejected events.")
            : warn(
                `source_spool:${source.alias}`,
                `${rejected} live spool event(s) were rejected.`,
              ),
        );
      } catch {
        checks.push(warn(`source_spool:${source.alias}`, "Live spool health is unknown."));
      }
    }
  }

  const status = checks.some((check) => check.status === "fail")
    ? "error"
    : checks.some((check) => check.status === "warn")
      ? "degraded"
      : "ok";
  return { status, checks };
}

/** @param {string} directory @param {string} alias @param {Map<string, number> | null} cursors */
async function checkSpoolDirectory(directory, alias, cursors) {
  /** @type {DoctorCheck[]} */
  const checks = [];
  try {
    const details = await stat(directory);
    checks.push(
      (details.mode & 0o777) === 0o700
        ? pass(`spool_permissions:${alias}`, "Source spool permissions are private.")
        : fail(`spool_permissions:${alias}`, "Source spool directory permissions must be 700."),
    );
    await access(directory, constants.W_OK);
    checks.push(pass(`spool_writable:${alias}`, "Source spool directory is writable."));
    const names = (await readdir(directory)).filter(
      (name) => name === "current.open" || name.endsWith(".ndjson"),
    );
    let truncated = 0;
    let cursorLag = 0;
    for (const name of names) {
      const file = join(directory, name);
      const fileDetails = await stat(file);
      if ((fileDetails.mode & 0o777) !== 0o600) {
        checks.push(fail(`spool_files:${alias}`, "Every spool segment must use permissions 600."));
        return checks;
      }
      if (fileDetails.size > 0 && !(await endsWithNewline(file, fileDetails.size))) truncated += 1;
      if (
        cursors !== null &&
        name.endsWith(".ndjson") &&
        (cursors.get(name) ?? 0) < fileDetails.size
      ) {
        cursorLag += 1;
      }
    }
    checks.push(pass(`spool_files:${alias}`, "Spool segment permissions are private."));
    checks.push(
      truncated === 0
        ? pass(`spool_truncation:${alias}`, "Spool segments contain no truncated tail.")
        : warn(`spool_truncation:${alias}`, `${truncated} spool segment(s) have a truncated tail.`),
    );
    checks.push(
      pass(
        `spool_rotation:${alias}`,
        `${names.filter((name) => name.endsWith(".ndjson")).length} closed segment(s).`,
      ),
    );
    if (cursors !== null) {
      checks.push(
        cursorLag === 0
          ? pass(`spool_cursor:${alias}`, "Closed spool segments are fully acknowledged.")
          : warn(
              `spool_cursor:${alias}`,
              `${cursorLag} closed spool segment(s) await synchronization.`,
            ),
      );
    }
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      return [warn(`spool_writable:${alias}`, "Source spool has not received live events.")];
    }
    return [fail(`spool_writable:${alias}`, "Source spool is inaccessible or not writable.")];
  }
  return checks;
}

/** @param {string} file @param {number} size */
async function endsWithNewline(file, size) {
  const handle = await open(file, "r");
  try {
    const byte = Buffer.alloc(1);
    await handle.read(byte, 0, 1, size - 1);
    return byte[0] === 10;
  } finally {
    await handle.close();
  }
}

/** @param {string} path @param {string} id */
async function checkLock(path, id) {
  try {
    await stat(path);
    return warn(id, "Another process may be active; retry if the lock persists.");
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return undefined;
    return fail(id, "Lock state could not be inspected.");
  }
}

/** @param {string} path @param {number} expected @param {string} id */
async function checkOptionalMode(path, expected, id) {
  try {
    const details = await stat(path);
    return (details.mode & 0o777) === expected
      ? pass(id, `Permissions are ${expected.toString(8)}.`)
      : fail(id, `Permissions must be ${expected.toString(8)}.`);
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return undefined;
    return fail(id, "Permissions could not be inspected.");
  }
}

/** @param {string} backupDir */
async function checkBackupFiles(backupDir) {
  try {
    const files = (await readdir(backupDir)).filter((name) => name.endsWith(".sqlite3"));
    for (const file of files) {
      const details = await stat(join(backupDir, file));
      if ((details.mode & 0o777) !== 0o600) {
        return fail("backup_files", "Every database backup must use permissions 600.");
      }
    }
    return pass("backup_files", "Database backup permissions are private.");
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return undefined;
    return fail("backup_files", "Database backup permissions could not be inspected.");
  }
}

/** @param {string} path @param {number} expected @param {string} id */
async function checkMode(path, expected, id) {
  try {
    const details = await stat(path);
    const actual = details.mode & 0o777;
    return actual === expected
      ? pass(id, `Permissions are ${expected.toString(8)}.`)
      : fail(id, `Permissions must be ${expected.toString(8)}.`);
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      return warn(id, "Path has not been created.");
    }
    return fail(id, "Permissions could not be inspected.");
  }
}

/** @param {string} path */
async function pathExists(path) {
  try {
    await stat(path);
    return true;
  } catch (error) {
    return !(error instanceof Error && "code" in error && error.code === "ENOENT");
  }
}

/** @param {string} file */
async function checkSetupJournal(file) {
  try {
    await stat(file);
    return warn(
      "setup_recovery",
      "An interrupted OpenCode plugin setup will be recovered on rerun.",
    );
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      return pass("setup_recovery", "No interrupted setup recovery is pending.");
    }
    return fail("setup_recovery", "Setup recovery state could not be inspected.");
  }
}

/**
 * Report which plan profile a source actually uses and how old its assumptions are.
 *
 * A profile is a weak prior; an old one keeps influencing pressure weights, so its age
 * has to be visible rather than implied.
 *
 * @param {{alias: string, plan?: string, plan_profile?: string}} source
 * @param {Date} now
 */
function planProfileCheck(source, now) {
  const id = `plan_profile:${source.alias}`;
  const { profile, warnings } = resolvePlanProfile(source);
  if (warnings.length > 0) {
    return warn(
      id,
      `Configured plan profile is unusable; using ${profile.id}@${profile.version} (${profile.provenance}).`,
    );
  }
  const ageDays = (now.getTime() - Date.parse(`${profile.as_of}T00:00:00.000Z`)) / 86_400_000;
  const description = `${profile.id}@${profile.version} (${profile.provenance}, as of ${profile.as_of})`;
  return ageDays > PLAN_PROFILE_STALE_DAYS
    ? warn(id, `Plan profile ${description} is older than ${PLAN_PROFILE_STALE_DAYS} days.`)
    : pass(id, `Plan profile ${description}.`);
}

/** @param {string} id @param {string} message @returns {DoctorCheck} */
function pass(id, message) {
  return { id, status: "pass", message };
}

/** @param {string} id @param {string} message @returns {DoctorCheck} */
function warn(id, message) {
  return { id, status: "warn", message };
}

/** @param {string} id @param {string} message @returns {DoctorCheck} */
function fail(id, message) {
  return { id, status: "fail", message };
}

/** @param {unknown} value */
function isConfiguredSource(value) {
  return (
    typeof value === "object" &&
    value !== null &&
    "alias" in value &&
    typeof value.alias === "string" &&
    "installation_id" in value &&
    typeof value.installation_id === "string" &&
    "provider" in value &&
    typeof value.provider === "string" &&
    "database" in value &&
    typeof value.database === "string" &&
    "fingerprint" in value &&
    typeof value.fingerprint === "string"
  );
}
