import { createHash, randomUUID } from "node:crypto";
import { chmod, mkdir, open, readFile, readdir, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import Database from "better-sqlite3";
import lockfile from "proper-lockfile";

import { ExitCode, SnackError } from "./errors.js";

export const migrationDirectory = fileURLToPath(new URL("../migrations", import.meta.url));

/**
 * @typedef {object} ConfiguredOpenCodeSource
 * @property {string} alias
 * @property {string} installation_id
 * @property {string} adapter
 * @property {string} provider
 * @property {string} profile
 * @property {string} plan
 * @property {string} fingerprint
 */

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
      backupFile: backupFile ?? null,
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
 * Compensate a setup failure after storage initialization.
 *
 * @param {{databaseFile: string}} paths
 * @param {boolean} existed
 */
export async function rollbackDatabaseInitialization(paths, existed) {
  if (existed) return;
  await Promise.all([
    rm(paths.databaseFile, { force: true }),
    rm(`${paths.databaseFile}-wal`, { force: true }),
    rm(`${paths.databaseFile}-shm`, { force: true }),
  ]);
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

/**
 * @param {string} databaseFile
 * @param {string} sourceAlias
 */
export function readIngestionCursor(databaseFile, sourceAlias) {
  const database = new Database(databaseFile, { readonly: true, fileMustExist: true });
  try {
    const row = database
      .prepare(
        `SELECT time_updated, message_id
         FROM ingestion_cursor
         WHERE source_alias = ?`,
      )
      .get(sourceAlias);
    if (
      typeof row !== "object" ||
      row === null ||
      !("time_updated" in row) ||
      !("message_id" in row) ||
      typeof row.time_updated !== "number" ||
      typeof row.message_id !== "string"
    ) {
      return null;
    }
    return { time_updated: row.time_updated, message_id: row.message_id };
  } finally {
    database.close();
  }
}

/**
 * @param {string} databaseFile
 * @param {ConfiguredOpenCodeSource} source
 * @param {{observations: Observation[], cursor: {time_updated: number, message_id: string} | null}} batch
 * @param {Date} now
 * @param {{mappedProviders?: Set<string>, providerMappingCounts?: Map<string, number>}} [options]
 */
export function storeObservations(databaseFile, source, batch, now, options = {}) {
  const database = new Database(databaseFile);
  try {
    database.pragma("foreign_keys = ON");
    database.pragma("busy_timeout = 5000");
    const store = database.transaction(() => {
      const timestamp = now.toISOString();
      const period = ensureSourceBindingAndPeriod(database, source, timestamp);
      if (
        typeof period !== "object" ||
        period === null ||
        !("id" in period) ||
        typeof period.id !== "number"
      ) {
        throw new Error("Active capacity period is invalid.");
      }
      const selectObservationPeriod = database.prepare(
        `SELECT id
         FROM capacity_period
         WHERE source_alias = ?
           AND (started_at <= ? OR id = (
             SELECT MIN(id) FROM capacity_period WHERE source_alias = ?
           ))
           AND (ended_at IS NULL OR ? < ended_at)
         ORDER BY started_at DESC
         LIMIT 1`,
      );

      const counts = {
        alias: source.alias,
        path: "backfill",
        read: batch.observations.length,
        inserted: 0,
        updated: 0,
        unchanged: 0,
        excluded: 0,
        pending_mapping: 0,
        rejected_invalid: 0,
        failed: 0,
      };
      for (const observation of batch.observations) {
        const mappedCount =
          observation.provider === null
            ? 0
            : (options.providerMappingCounts?.get(observation.provider) ??
              Number(observation.provider === source.provider));
        if (observation.provider === source.provider && mappedCount > 1) {
          database
            .prepare(
              `INSERT INTO ambiguous_profile_mapping
                 (installation_id, source_prompt_id, provider, model, first_seen_at)
               VALUES (?, ?, ?, ?, ?)
               ON CONFLICT(installation_id, source_prompt_id, provider) DO NOTHING`,
            )
            .run(
              source.installation_id,
              observation.source_prompt_id,
              observation.provider,
              observation.model,
              timestamp,
            );
          counts.pending_mapping += 1;
          continue;
        }
        if (observation.provider !== source.provider) {
          if (observation.provider !== null && options.mappedProviders?.has(observation.provider)) {
            database
              .prepare(
                `DELETE FROM pending_mapping
                 WHERE source_alias = ? AND source_prompt_id = ? AND provider = ?`,
              )
              .run(source.alias, observation.source_prompt_id, observation.provider);
            continue;
          }
          database
            .prepare(
              `INSERT INTO pending_mapping
                 (source_alias, source_prompt_id, provider, model, first_seen_at)
               VALUES (?, ?, ?, ?, ?)
               ON CONFLICT(source_alias, source_prompt_id, provider) DO NOTHING`,
            )
            .run(
              source.alias,
              observation.source_prompt_id,
              observation.provider ?? "unknown",
              observation.model,
              timestamp,
            );
          counts.pending_mapping += 1;
          continue;
        }
        database
          .prepare(
            `DELETE FROM ambiguous_profile_mapping
             WHERE installation_id = ? AND source_prompt_id = ? AND provider = ?`,
          )
          .run(source.installation_id, observation.source_prompt_id, observation.provider);
        database
          .prepare(
            `DELETE FROM pending_mapping
             WHERE source_alias = ? AND source_prompt_id = ? AND provider = ?`,
          )
          .run(source.alias, observation.source_prompt_id, observation.provider);
        if (!isValidObservation(observation)) {
          counts.rejected_invalid += 1;
          continue;
        }
        const observationHash = hashObservation(observation);
        const existing = database
          .prepare(
            `SELECT id, source_revision, observation_hash, completion
             FROM prompt_execution
             WHERE source_alias = ? AND source_prompt_id = ?`,
          )
          .get(source.alias, observation.source_prompt_id);
        if (
          typeof existing === "object" &&
          existing !== null &&
          "source_revision" in existing &&
          typeof existing.source_revision === "string" &&
          "completion" in existing &&
          ((existing.completion === "completed" && observation.completion === "provisional") ||
            (existing.completion === observation.completion &&
              compareRevision(observation.revision, existing.source_revision) < 0))
        ) {
          counts.unchanged += 1;
          continue;
        }
        if (
          typeof existing === "object" &&
          existing !== null &&
          "source_revision" in existing &&
          existing.source_revision === observation.revision &&
          "observation_hash" in existing &&
          existing.observation_hash === observationHash
        ) {
          counts.unchanged += 1;
          continue;
        }

        let promptId;
        if (typeof existing === "object" && existing !== null && "id" in existing) {
          promptId = existing.id;
          database
            .prepare(
              `UPDATE prompt_execution SET
                 source_session_fingerprint = ?, source_revision = ?,
                 observation_hash = ?, revision_domain = ?, parser_version = ?, started_at = ?, completed_at = ?,
                 duration_ms = ?, completion = ?, last_observed_at = ?
               WHERE id = ?`,
            )
            .run(
              hashOpaque(observation.source_session_id),
              observation.revision,
              observationHash,
              observation.revision_domain,
              observation.parser_version,
              observation.started_at,
              observation.completed_at,
              observation.duration_ms,
              observation.completion,
              timestamp,
              promptId,
            );
          database
            .prepare("DELETE FROM prompt_usage_slice WHERE prompt_execution_id = ?")
            .run(promptId);
          database
            .prepare("DELETE FROM prompt_source_outcome WHERE prompt_execution_id = ?")
            .run(promptId);
          database
            .prepare("DELETE FROM restriction_observation WHERE prompt_execution_id = ?")
            .run(promptId);
          counts.updated += 1;
        } else {
          const observationPeriod = selectObservationPeriod.get(
            source.alias,
            observation.started_at,
            source.alias,
            observation.started_at,
          );
          if (
            typeof observationPeriod !== "object" ||
            observationPeriod === null ||
            !("id" in observationPeriod) ||
            typeof observationPeriod.id !== "number"
          ) {
            throw new Error("Observation capacity period is invalid.");
          }
          const inserted = database
            .prepare(
              `INSERT INTO prompt_execution
                 (source_alias, capacity_period_id, source_prompt_id, source_session_fingerprint,
                  source_revision, observation_hash, revision_domain, parser_version, started_at, completed_at,
                  duration_ms, completion, first_observed_at, last_observed_at)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            )
            .run(
              source.alias,
              observationPeriod.id,
              observation.source_prompt_id,
              hashOpaque(observation.source_session_id),
              observation.revision,
              observationHash,
              observation.revision_domain,
              observation.parser_version,
              observation.started_at,
              observation.completed_at,
              observation.duration_ms,
              observation.completion,
              timestamp,
              timestamp,
            );
          promptId = Number(inserted.lastInsertRowid);
          counts.inserted += 1;
        }

        const insertSlice = database.prepare(
          `INSERT INTO prompt_usage_slice
             (prompt_execution_id, source_slice_id, provider, model, input_tokens, output_tokens,
              reasoning_tokens, cache_read_tokens, cache_write_tokens, cost_decimal, currency)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        );
        for (const slice of observation.usage_slices) {
          insertSlice.run(
            promptId,
            slice.source_slice_id,
            slice.provider,
            slice.model,
            slice.input_tokens,
            slice.output_tokens,
            slice.reasoning_tokens,
            slice.cache_read_tokens,
            slice.cache_write_tokens,
            slice.cost_decimal,
            slice.currency,
          );
        }
        database
          .prepare(
            `INSERT INTO prompt_source_outcome
               (prompt_execution_id, outcome, policy_version)
             VALUES (?, ?, 'opencode-outcome-v1')`,
          )
          .run(promptId, observation.outcome);
        const insertRestriction = database.prepare(
          `INSERT INTO restriction_observation
             (prompt_execution_id, class, source_code, observed_at, classifier_version, provenance)
           VALUES (?, ?, ?, ?, ?, ?)`,
        );
        for (const restriction of observation.restrictions) {
          insertRestriction.run(
            promptId,
            restriction.class,
            restriction.source_code,
            restriction.observed_at,
            restriction.classifier_version,
            restriction.provenance,
          );
        }
        if (observation.outcome === "excluded") counts.excluded += 1;
      }

      database
        .prepare(
          `INSERT INTO ingestion_cursor
             (source_alias, fingerprint, time_updated, message_id, committed_at)
           VALUES (?, ?, ?, ?, ?)
           ON CONFLICT(source_alias) DO UPDATE SET
             fingerprint = excluded.fingerprint,
             time_updated = excluded.time_updated,
             message_id = excluded.message_id,
             committed_at = excluded.committed_at`,
        )
        .run(
          source.alias,
          source.fingerprint,
          batch.cursor?.time_updated ?? null,
          batch.cursor?.message_id ?? null,
          timestamp,
        );
      return counts;
    });
    return store.immediate();
  } finally {
    database.close();
  }
}

/**
 * Start a capacity period immediately after a setup change commits.
 *
 * @param {string} databaseFile
 * @param {ConfiguredOpenCodeSource} source
 * @param {Date} now
 */
export function ensureCapacityPeriod(databaseFile, source, now) {
  const database = new Database(databaseFile);
  try {
    database.pragma("foreign_keys = ON");
    database.pragma("busy_timeout = 5000");
    return database
      .transaction(() => ensureSourceBindingAndPeriod(database, source, now.toISOString()))
      .immediate();
  } finally {
    database.close();
  }
}

/**
 * @param {Database.Database} database
 * @param {ConfiguredOpenCodeSource} source
 * @param {string} timestamp
 */
function ensureSourceBindingAndPeriod(database, source, timestamp) {
  database
    .prepare(
      `INSERT INTO capacity_source (alias, created_at)
       VALUES (?, ?)
       ON CONFLICT(alias) DO NOTHING`,
    )
    .run(source.alias, timestamp);

  const binding = database
    .prepare("SELECT installation_id FROM source_binding WHERE source_alias = ?")
    .get(source.alias);
  if (typeof binding !== "object" || binding === null || !("installation_id" in binding)) {
    database
      .prepare(
        `INSERT INTO client_installation
           (id, client_kind, local_fingerprint, created_at, last_seen_at)
         VALUES (?, 'opencode', ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET last_seen_at = excluded.last_seen_at`,
      )
      .run(source.installation_id, source.installation_id, timestamp, timestamp);
    database
      .prepare(
        `INSERT INTO source_binding
           (source_alias, installation_id, adapter, provider, profile)
         VALUES (?, ?, ?, ?, ?)`,
      )
      .run(source.alias, source.installation_id, source.adapter, source.provider, source.profile);
  } else {
    database
      .prepare(
        `UPDATE client_installation
         SET last_seen_at = ?
         WHERE id = ?`,
      )
      .run(timestamp, binding.installation_id);
    database
      .prepare(
        `UPDATE source_binding
         SET provider = ?, profile = ?
         WHERE source_alias = ?`,
      )
      .run(source.provider, source.profile, source.alias);
  }

  let period = database
    .prepare(
      `SELECT id, provider, profile, plan
       FROM capacity_period
       WHERE source_alias = ? AND ended_at IS NULL`,
    )
    .get(source.alias);
  if (
    typeof period !== "object" ||
    period === null ||
    !("provider" in period) ||
    period.provider !== source.provider ||
    !("profile" in period) ||
    period.profile !== source.profile ||
    !("plan" in period) ||
    period.plan !== source.plan
  ) {
    database
      .prepare(
        `UPDATE capacity_period
         SET ended_at = ?
         WHERE source_alias = ? AND ended_at IS NULL`,
      )
      .run(timestamp, source.alias);
    const inserted = database
      .prepare(
        `INSERT INTO capacity_period
           (source_alias, provider, profile, plan, started_at)
         VALUES (?, ?, ?, ?, ?)`,
      )
      .run(source.alias, source.provider, source.profile, source.plan, timestamp);
    period = { id: Number(inserted.lastInsertRowid) };
  }
  if (typeof period !== "object" || period === null || !("id" in period)) {
    throw new Error("Active capacity period is invalid.");
  }
  return period;
}

/**
 * @param {string} databaseFile
 * @param {string} sourceAlias
 */
export function readSourceSummary(databaseFile, sourceAlias) {
  const database = new Database(databaseFile, { readonly: true, fileMustExist: true });
  try {
    const row = database
      .prepare(
        `SELECT
           (SELECT started_at FROM capacity_period
            WHERE source_alias = ? AND ended_at IS NULL) AS active_period_started_at,
           COUNT(prompt_execution.id) AS prompts,
           COALESCE(SUM(prompt_source_outcome.outcome = 'success'), 0) AS successes,
           COALESCE(SUM(prompt_source_outcome.outcome = 'restricted'), 0) AS restrictions,
           COALESCE(SUM(prompt_source_outcome.outcome = 'excluded'), 0) AS excluded,
           MAX(COALESCE(prompt_execution.completed_at, prompt_execution.started_at)) AS as_of
         FROM prompt_execution
         JOIN capacity_period
           ON capacity_period.id = prompt_execution.capacity_period_id
          AND capacity_period.ended_at IS NULL
         JOIN prompt_source_outcome
           ON prompt_source_outcome.prompt_execution_id = prompt_execution.id
         WHERE prompt_execution.source_alias = ?`,
      )
      .get(sourceAlias, sourceAlias);
    if (
      typeof row !== "object" ||
      row === null ||
      !("prompts" in row) ||
      !("successes" in row) ||
      !("restrictions" in row) ||
      !("excluded" in row) ||
      !("as_of" in row) ||
      !("active_period_started_at" in row)
    ) {
      throw new Error("Source summary is invalid.");
    }
    return {
      prompts: Number(row.prompts),
      successes: Number(row.successes),
      restrictions: Number(row.restrictions),
      excluded: Number(row.excluded),
      as_of: typeof row.as_of === "string" ? row.as_of : null,
      active_period_started_at:
        typeof row.active_period_started_at === "string" ? row.active_period_started_at : null,
    };
  } finally {
    database.close();
  }
}

/** @param {string} databaseFile @param {ConfiguredOpenCodeSource} source */
export function readPendingMappingCount(databaseFile, source) {
  const database = new Database(databaseFile, { readonly: true, fileMustExist: true });
  try {
    const row = database
      .prepare(
        `SELECT
           (SELECT COUNT(*) FROM pending_mapping WHERE source_alias = ?) +
           (SELECT COUNT(*) FROM ambiguous_profile_mapping
            WHERE installation_id = ? AND provider = ?) AS count`,
      )
      .get(source.alias, source.installation_id, source.provider);
    return typeof row === "object" && row !== null && "count" in row ? Number(row.count) : 0;
  } finally {
    database.close();
  }
}

/** @param {string} value */
function hashOpaque(value) {
  return createHash("sha256").update(`opencode-session\0${value}`).digest("hex");
}

/** @param {Observation} observation */
function hashObservation(observation) {
  return createHash("sha256").update(JSON.stringify(observation)).digest("hex");
}

/** @param {string} left @param {string} right */
function compareRevision(left, right) {
  const leftSeparator = left.indexOf(":");
  const rightSeparator = right.indexOf(":");
  const leftTime = Number(left.slice(0, leftSeparator));
  const rightTime = Number(right.slice(0, rightSeparator));
  if (leftTime !== rightTime) return leftTime - rightTime;
  return left.slice(leftSeparator + 1).localeCompare(right.slice(rightSeparator + 1));
}

/** @param {Observation} observation */
function isValidObservation(observation) {
  const tokenValues = observation.usage_slices.flatMap((slice) => [
    slice.input_tokens,
    slice.output_tokens,
    slice.reasoning_tokens,
    slice.cache_read_tokens,
    slice.cache_write_tokens,
  ]);
  return tokenValues.every(
    (value) => value === null || (Number.isSafeInteger(value) && value >= 0),
  );
}

/**
 * @typedef {object} Observation
 * @property {string} source_prompt_id
 * @property {string} source_session_id
 * @property {string} revision
 * @property {string} revision_domain
 * @property {string} parser_version
 * @property {string} started_at
 * @property {string | null} completed_at
 * @property {number | null} duration_ms
 * @property {string} completion
 * @property {string | null} provider
 * @property {string | null} model
 * @property {string} outcome
 * @property {Array<{source_slice_id: string, provider: string | null, model: string | null, input_tokens: number | null, output_tokens: number | null, reasoning_tokens: number | null, cache_read_tokens: number | null, cache_write_tokens: number | null, cost_decimal: string | null, currency: string | null}>} usage_slices
 * @property {Array<{class: string, source_code: string, observed_at: string, classifier_version: string, provenance: string}>} restrictions
 */

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
