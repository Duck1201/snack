import { createHash, randomUUID } from "node:crypto";
import { chmod, mkdir, open, readFile, readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import Database from "better-sqlite3";
import lockfile from "proper-lockfile";

import { ExitCode, SnackError } from "./errors.js";

export const migrationDirectory = fileURLToPath(new URL("../migrations", import.meta.url));

/**
 * @typedef {object} Migration
 * @property {number} number
 * @property {string} name
 * @property {string} checksum
 * @property {string} sql
 */

/**
 * @param {{databaseFile: string, dataDir: string, backupDir: string}} paths
 * @param {{applicationVersion?: string, migrationsDir?: string, now?: Date}} [options]
 */
export async function initializeDatabase(paths, options = {}) {
  const migrationsDir = options.migrationsDir ?? migrationDirectory;

  /** @type {Database.Database | undefined} */
  let database;
  /** @type {(() => Promise<void>) | undefined} */
  let releaseLock;
  try {
    const migrations = await loadMigrations(migrationsDir);
    const existed = await pathExists(paths.databaseFile);
    await ensurePrivateDirectory(paths.dataDir);
    await ensurePrivateDirectory(paths.backupDir);
    const seed = await open(paths.databaseFile, "a", 0o600);
    await seed.close();
    await chmod(paths.databaseFile, 0o600);
    try {
      releaseLock = await lockfile.lock(paths.databaseFile, {
        realpath: false,
        stale: 120_000,
        update: 10_000,
        retries: { retries: 20, minTimeout: 50, maxTimeout: 250 },
      });
    } catch (error) {
      throw new SnackError("Storage is locked by another process; retry after it finishes.", {
        code: ExitCode.storage,
        reason: "storage_locked",
        cause: error,
      });
    }
    await chmod(`${paths.databaseFile}.lock`, 0o700);
    const opened = new Database(paths.databaseFile);
    database = opened;
    opened.pragma("foreign_keys = ON");
    opened.pragma("busy_timeout = 5000");
    await chmod(paths.databaseFile, 0o600);

    const applied = readAppliedMigrations(opened);
    verifyAppliedMigrations(applied, migrations);
    const pending = migrations.filter((migration) => !applied.has(migration.number));

    let backupFile;
    if (existed && pending.length > 0) {
      const stamp = (options.now ?? new Date()).toISOString().replaceAll(/[:.]/gu, "-");
      backupFile = join(paths.backupDir, `snack-before-${stamp}-${randomUUID()}.sqlite3`);
      await opened.backup(backupFile);
      await chmod(backupFile, 0o600);
    }

    /** @type {Migration[]} */
    let migrationsApplied = [];
    if (pending.length > 0 || !hasMigrationTable(opened)) {
      const apply = opened.transaction(() => {
        const lockedApplied = readAppliedMigrations(opened);
        verifyAppliedMigrations(lockedApplied, migrations);
        const lockedPending = migrations.filter(
          (migration) => !lockedApplied.has(migration.number),
        );
        createMigrationTable(opened);
        const insert = opened.prepare(`
          INSERT INTO schema_migration
            (number, name, checksum, applied_at, application_version)
          VALUES
            (@number, @name, @checksum, @applied_at, @application_version)
        `);
        for (const migration of lockedPending) {
          opened.exec(migration.sql);
          insert.run({
            number: migration.number,
            name: migration.name,
            checksum: migration.checksum,
            applied_at: (options.now ?? new Date()).toISOString(),
            application_version: options.applicationVersion ?? "0.1.0",
          });
        }
        return lockedPending;
      });
      migrationsApplied = apply.immediate();
    }

    const integrity = opened.pragma("quick_check", { simple: true });
    const foreignKeyViolations = /** @type {unknown[]} */ (opened.pragma("foreign_key_check"));
    if (integrity !== "ok" || foreignKeyViolations.length > 0) {
      throw new SnackError("Storage integrity check failed.", {
        code: ExitCode.storage,
        reason: "storage_integrity_error",
      });
    }

    return {
      applied: migrationsApplied.map((migration) => migration.number),
      backupCreated: backupFile !== undefined,
      migrationCount: migrations.length,
    };
  } catch (error) {
    if (error instanceof SnackError) throw error;
    throw new SnackError("Storage initialization failed.", {
      code: ExitCode.storage,
      reason: "storage_initialization_error",
      cause: error,
    });
  } finally {
    database?.close();
    await releaseLock?.().catch(() => {});
  }
}

/**
 * Read-only storage checks for doctor.
 *
 * @param {string} databaseFile
 * @param {{migrationsDir?: string}} [options]
 */
export async function inspectDatabase(databaseFile, options = {}) {
  if (!(await pathExists(databaseFile))) {
    return { exists: false, integrity: "missing", migrations: "unknown" };
  }

  /** @type {Database.Database | undefined} */
  let database;
  try {
    database = new Database(databaseFile, { readonly: true, fileMustExist: true });
    const integrity = database.pragma("quick_check", { simple: true });
    const foreignKeyViolations = /** @type {unknown[]} */ (database.pragma("foreign_key_check"));
    const migrations = await loadMigrations(options.migrationsDir ?? migrationDirectory);
    const applied = readAppliedMigrations(database);
    verifyAppliedMigrations(applied, migrations);
    return {
      exists: true,
      integrity: integrity === "ok" && foreignKeyViolations.length === 0 ? "ok" : "failed",
      migrations: applied.size === migrations.length ? "current" : "pending",
    };
  } catch (error) {
    if (error instanceof SnackError) throw error;
    throw new SnackError("Storage inspection failed.", {
      code: ExitCode.storage,
      reason: "storage_inspection_error",
      cause: error,
    });
  } finally {
    database?.close();
  }
}

/** @param {string} migrationsDir @returns {Promise<Migration[]>} */
export async function loadMigrations(migrationsDir) {
  const names = (await readdir(migrationsDir)).filter((name) => name.endsWith(".sql")).sort();
  /** @type {Migration[]} */
  const migrations = [];
  const numbers = new Set();
  for (const filename of names) {
    const match = /^(\d{3})_([a-z0-9_]+)\.sql$/u.exec(filename);
    if (!match?.[1] || !match[2]) {
      throw new SnackError("A migration filename is invalid.", {
        code: ExitCode.storage,
        reason: "migration_filename_error",
      });
    }
    const number = Number(match[1]);
    if (numbers.has(number)) {
      throw new SnackError("Migration numbers must be unique.", {
        code: ExitCode.storage,
        reason: "migration_number_conflict",
      });
    }
    numbers.add(number);
    const sql = await readFile(join(migrationsDir, filename), "utf8");
    migrations.push({
      number,
      name: match[2],
      checksum: createHash("sha256").update(sql).digest("hex"),
      sql,
    });
  }
  return migrations;
}

/** @param {Database.Database} database */
function hasMigrationTable(database) {
  const row = database
    .prepare("SELECT 1 AS present FROM sqlite_master WHERE type = 'table' AND name = ?")
    .get("schema_migration");
  return row !== undefined;
}

/** @param {Database.Database} database */
function createMigrationTable(database) {
  database.exec(`
    CREATE TABLE IF NOT EXISTS schema_migration (
      number INTEGER PRIMARY KEY,
      name TEXT NOT NULL UNIQUE,
      checksum TEXT NOT NULL,
      applied_at TEXT NOT NULL,
      application_version TEXT NOT NULL
    ) STRICT
  `);
}

/** @param {Database.Database} database */
function readAppliedMigrations(database) {
  /** @type {Map<number, {name: string, checksum: string}>} */
  const applied = new Map();
  if (!hasMigrationTable(database)) return applied;
  const rows = database.prepare("SELECT number, name, checksum FROM schema_migration").all();
  for (const row of rows) {
    if (
      typeof row === "object" &&
      row !== null &&
      "number" in row &&
      "name" in row &&
      "checksum" in row &&
      typeof row.number === "number" &&
      typeof row.name === "string" &&
      typeof row.checksum === "string"
    ) {
      applied.set(row.number, { name: row.name, checksum: row.checksum });
    }
  }
  return applied;
}

/**
 * @param {Map<number, {name: string, checksum: string}>} applied
 * @param {Migration[]} available
 */
function verifyAppliedMigrations(applied, available) {
  const byNumber = new Map(available.map((migration) => [migration.number, migration]));
  for (const [number, stored] of applied) {
    const migration = byNumber.get(number);
    if (!migration || migration.name !== stored.name || migration.checksum !== stored.checksum) {
      throw new SnackError("Stored migration history does not match this application version.", {
        code: ExitCode.storage,
        reason: "migration_history_mismatch",
      });
    }
  }
}

/** @param {string} path */
async function ensurePrivateDirectory(path) {
  await mkdir(path, { recursive: true, mode: 0o700 });
  await chmod(path, 0o700);
}

/** @param {string} path */
async function pathExists(path) {
  try {
    await stat(path);
    return true;
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return false;
    throw error;
  }
}
