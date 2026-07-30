import { readdir, stat } from "node:fs/promises";
import { join } from "node:path";

import { readConfig } from "./config.js";
import { SnackError } from "./errors.js";
import { inspectDatabase } from "./storage.js";

/**
 * @typedef {object} DoctorCheck
 * @property {string} id
 * @property {"pass" | "warn" | "fail"} status
 * @property {string} message
 */

/**
 * @param {import("./paths.js").SnackPaths} paths
 * @param {{nodeVersion?: string | undefined, platform?: NodeJS.Platform | undefined}} [options]
 * @returns {Promise<{status: "ok" | "degraded" | "error", checks: DoctorCheck[]}>}
 */
export async function runDoctor(paths, options = {}) {
  /** @type {DoctorCheck[]} */
  const checks = [];
  const nodeVersion = options.nodeVersion ?? process.versions.node;
  const platform = options.platform ?? process.platform;

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
    await readConfig(paths.configFile);
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
  checks.push(await checkMode(paths.databaseFile, 0o600, "database_file"));
  const backupFiles = await checkBackupFiles(paths.backupDir);
  if (backupFiles) checks.push(backupFiles);

  const status = checks.some((check) => check.status === "fail")
    ? "error"
    : checks.some((check) => check.status === "warn")
      ? "degraded"
      : "ok";
  return { status, checks };
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
