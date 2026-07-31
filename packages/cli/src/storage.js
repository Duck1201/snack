import { createHash, randomUUID } from "node:crypto";
import { chmod, mkdir, open, readFile, readdir, rename, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import Database from "better-sqlite3";
import lockfile from "proper-lockfile";

import { ExitCode, SnackError } from "./errors.js";

export const migrationDirectory = fileURLToPath(new URL("../migrations", import.meta.url));

/**
 * Serialize commands that can write or replace canonical storage.
 *
 * @template T
 * @param {{stateDir: string}} paths
 * @param {() => Promise<T>} callback
 */
export async function withStorageOperationLock(paths, callback) {
  await ensurePrivateDirectory(paths.stateDir);
  const target = join(paths.stateDir, "storage-operation");
  const seed = await open(target, "a", 0o600);
  await seed.close();
  await chmod(target, 0o600);
  let release;
  try {
    release = await lockfile.lock(target, {
      realpath: false,
      stale: 120_000,
      update: 10_000,
      retries: { retries: 20, minTimeout: 50, maxTimeout: 250 },
    });
    await chmod(`${target}.lock`, 0o700);
  } catch (error) {
    throw new SnackError("Storage is locked by another operation; retry after it finishes.", {
      code: ExitCode.storage,
      reason: "storage_locked",
      cause: error,
    });
  }
  try {
    return await callback();
  } finally {
    await release?.().catch(() => {});
  }
}

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

/** @param {{databaseFile: string, stateDir: string}} paths */
export async function createSetupDatabaseBackup(paths) {
  if (!(await pathExists(paths.databaseFile))) return null;
  await ensurePrivateDirectory(paths.stateDir);
  const backupFile = join(paths.stateDir, `setup-${randomUUID()}.sqlite3`);
  const database = new Database(paths.databaseFile, { readonly: true, fileMustExist: true });
  try {
    await database.backup(backupFile);
    await chmod(backupFile, 0o600);
    return backupFile;
  } finally {
    database.close();
  }
}

/** @param {{databaseFile: string}} paths @param {string | null} backupFile */
export async function restoreSetupDatabaseBackup(paths, backupFile) {
  if (backupFile === null) {
    await Promise.all([
      rm(paths.databaseFile, { force: true }),
      rm(`${paths.databaseFile}-wal`, { force: true }),
      rm(`${paths.databaseFile}-shm`, { force: true }),
    ]);
    return;
  }
  const backup = new Database(backupFile, { readonly: true, fileMustExist: true });
  const restoredFile = `${paths.databaseFile}.setup-restore-${randomUUID()}`;
  try {
    if (
      backup.pragma("quick_check", { simple: true }) !== "ok" ||
      /** @type {unknown[]} */ (backup.pragma("foreign_key_check")).length > 0
    ) {
      throw new Error("Setup database backup failed integrity validation.");
    }
    await backup.backup(restoredFile);
    await chmod(restoredFile, 0o600);
    const restored = new Database(restoredFile, { readonly: true, fileMustExist: true });
    try {
      if (
        restored.pragma("quick_check", { simple: true }) !== "ok" ||
        /** @type {unknown[]} */ (restored.pragma("foreign_key_check")).length > 0
      ) {
        throw new Error("Restored setup database failed integrity validation.");
      }
    } finally {
      restored.close();
    }
    await rename(restoredFile, paths.databaseFile);
    await Promise.all([
      rm(`${paths.databaseFile}-wal`, { force: true }),
      rm(`${paths.databaseFile}-shm`, { force: true }),
    ]);
  } finally {
    backup.close();
    await rm(restoredFile, { force: true });
  }
  await rm(backupFile, { force: true });
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
 * @param {string} sourceAlias
 * @returns {Map<string, number>}
 */
export function readSpoolCursors(databaseFile, sourceAlias) {
  const database = new Database(databaseFile, { readonly: true, fileMustExist: true });
  try {
    const rows = database
      .prepare("SELECT segment, byte_offset FROM spool_cursor WHERE source_alias = ?")
      .all(sourceAlias);
    return new Map(
      rows.flatMap((row) =>
        typeof row === "object" &&
        row !== null &&
        "segment" in row &&
        typeof row.segment === "string" &&
        "byte_offset" in row &&
        typeof row.byte_offset === "number"
          ? [[row.segment, row.byte_offset]]
          : [],
      ),
    );
  } finally {
    database.close();
  }
}

/** @param {string} databaseFile @param {string} sourceAlias */
export function readSpoolIssueCount(databaseFile, sourceAlias) {
  const database = new Database(databaseFile, { readonly: true, fileMustExist: true });
  try {
    const row = database
      .prepare(
        "SELECT COALESCE(SUM(occurrences), 0) AS count FROM ingestion_issue WHERE source_alias = ?",
      )
      .get(sourceAlias);
    return typeof row === "object" && row !== null && "count" in row ? Number(row.count) : 0;
  } finally {
    database.close();
  }
}

/**
 * @param {string} databaseFile
 * @param {ConfiguredOpenCodeSource} source
 * @param {{observations: Observation[], cursor: {time_updated: number, message_id: string} | null}} batch
 * @param {Date} now
 * @param {{mappedProviders?: Set<string>, providerMappingCounts?: Map<string, number>, path?: "backfill" | "spool", spoolCursors?: {segment: string, byte_offset: number}[], rejected?: {segment: string, line_offset: number}[], planProfile?: {id: string, version: string} | null}} [options]
 */
export function storeObservations(databaseFile, source, batch, now, options = {}) {
  const database = new Database(databaseFile);
  try {
    database.pragma("foreign_keys = ON");
    database.pragma("busy_timeout = 5000");
    const store = database.transaction(() => {
      const timestamp = now.toISOString();
      const period = ensureSourceBindingAndPeriod(
        database,
        source,
        timestamp,
        options.planProfile ?? null,
      );
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
      const retainPendingSpoolObservation = database.prepare(
        `INSERT INTO pending_spool_observation
           (installation_id, source_prompt_id, provider, revision, observation_json, first_seen_at)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(installation_id, source_prompt_id, provider, revision) DO NOTHING`,
      );

      const counts = {
        alias: source.alias,
        path: options.path ?? "backfill",
        read: batch.observations.length,
        inserted: 0,
        updated: 0,
        unchanged: 0,
        excluded: 0,
        pending_mapping: 0,
        rejected_invalid: options.rejected?.length ?? 0,
        tombstoned: 0,
        failed: 0,
      };
      // Loaded once per batch. Enforcing the tombstone here rather than through the ingestion
      // cursor is what makes it survive `--full`, which re-reads everything by definition.
      const tombstones = readPurgeTombstones(database, source.alias);
      for (const observation of batch.observations) {
        if (
          tombstones.length > 0 &&
          observation.started_at !== null &&
          observation.started_at !== undefined &&
          isTombstoned(tombstones, observation.started_at)
        ) {
          counts.tombstoned += 1;
          continue;
        }
        const inputFeatures = observation.input_features ?? null;
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
          if ((options.path ?? "backfill") === "spool") {
            retainPendingSpoolObservation.run(
              source.installation_id,
              observation.source_prompt_id,
              observation.provider,
              observation.revision,
              JSON.stringify(observation),
              timestamp,
            );
          }
          counts.pending_mapping += 1;
          continue;
        }
        if (observation.provider !== source.provider) {
          if (observation.provider !== null && options.mappedProviders?.has(observation.provider)) {
            database
              .prepare(
                `DELETE FROM pending_mapping
                 WHERE source_prompt_id = ? AND provider = ?
                   AND source_alias IN (
                     SELECT source_alias FROM source_binding WHERE installation_id = ?
                   )`,
              )
              .run(observation.source_prompt_id, observation.provider, source.installation_id);
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
          if ((options.path ?? "backfill") === "spool") {
            retainPendingSpoolObservation.run(
              source.installation_id,
              observation.source_prompt_id,
              observation.provider ?? "unknown",
              observation.revision,
              JSON.stringify(observation),
              timestamp,
            );
          }
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
             WHERE source_prompt_id = ? AND provider = ?
               AND source_alias IN (
                 SELECT source_alias FROM source_binding WHERE installation_id = ?
               )`,
          )
          .run(observation.source_prompt_id, observation.provider, source.installation_id);
        if ((options.path ?? "backfill") === "spool") {
          database
            .prepare(
              `DELETE FROM pending_spool_observation
               WHERE installation_id = ? AND source_prompt_id = ? AND provider = ?`,
            )
            .run(source.installation_id, observation.source_prompt_id, observation.provider);
        }
        if (!isValidObservation(observation)) {
          counts.rejected_invalid += 1;
          continue;
        }
        const observationHash = hashObservation(observation);
        const existing = database
          .prepare(
            `SELECT id, source_revision, observation_hash, completion, revision_domain
              FROM prompt_execution
             WHERE source_alias = ? AND source_prompt_id = ?`,
          )
          .get(source.alias, observation.source_prompt_id);
        const existingRevisionDomain =
          typeof existing === "object" &&
          existing !== null &&
          "revision_domain" in existing &&
          typeof existing.revision_domain === "string"
            ? existing.revision_domain
            : null;
        if (
          (options.path ?? "backfill") === "spool" &&
          typeof existing === "object" &&
          existing !== null &&
          "id" in existing &&
          typeof existing.id === "number"
        ) {
          database
            .prepare(
              "UPDATE prompt_execution SET seen_spool = 1, last_observed_at = ? WHERE id = ?",
            )
            .run(timestamp, existing.id);
        }
        if (
          observation.restrictions.length > 0 &&
          typeof existing === "object" &&
          existing !== null &&
          "id" in existing &&
          typeof existing.id === "number"
        ) {
          const insertRestriction = database.prepare(
            `INSERT OR IGNORE INTO restriction_observation
               (prompt_execution_id, class, source_code, observed_at, classifier_version, provenance)
             VALUES (?, ?, ?, ?, ?, ?)`,
          );
          for (const restriction of observation.restrictions) {
            insertRestriction.run(
              existing.id,
              restriction.class,
              restriction.source_code,
              restriction.observed_at,
              restriction.classifier_version,
              restriction.provenance,
            );
          }
          database
            .prepare(
              "UPDATE prompt_source_outcome SET outcome = 'restricted' WHERE prompt_execution_id = ?",
            )
            .run(existing.id);
        }
        if (
          typeof existing === "object" &&
          existing !== null &&
          "source_revision" in existing &&
          typeof existing.source_revision === "string" &&
          "completion" in existing &&
          ((existing.completion === "completed" && observation.completion === "provisional") ||
            (existingRevisionDomain === observation.revision_domain &&
              existing.completion === observation.completion &&
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

        const existingRecord =
          typeof existing === "object" && existing !== null
            ? /** @type {Record<string, unknown>} */ (existing)
            : null;
        const backfillFinalizesProvisional =
          (options.path ?? "backfill") === "backfill" &&
          existingRecord?.completion === "provisional" &&
          observation.completion === "completed";
        if (
          existingRevisionDomain !== null &&
          existingRevisionDomain !== observation.revision_domain &&
          !backfillFinalizesProvisional
        ) {
          const existingOutcome = database
            .prepare("SELECT outcome FROM prompt_source_outcome WHERE prompt_execution_id = ?")
            .get(existingRecord?.id);
          const existingIsRestricted =
            typeof existingOutcome === "object" &&
            existingOutcome !== null &&
            "outcome" in existingOutcome &&
            existingOutcome.outcome === "restricted";
          const compatibleBackfill =
            (options.path ?? "backfill") === "backfill" &&
            (existingIsRestricted ||
              (typeof existingOutcome === "object" &&
                existingOutcome !== null &&
                "outcome" in existingOutcome &&
                existingOutcome.outcome === observation.outcome));
          if (compatibleBackfill) {
            // Backfill supplies finalized boundaries and usage; live restrictions remain dominant.
          } else if (
            observation.restrictions.length > 0 &&
            existingRecord !== null &&
            typeof existingRecord.id === "number"
          ) {
            const promptId = existingRecord.id;
            database
              .prepare(
                "UPDATE prompt_execution SET seen_spool = 1, last_observed_at = ? WHERE id = ?",
              )
              .run(timestamp, promptId);
            database
              .prepare(
                "UPDATE prompt_source_outcome SET outcome = 'restricted' WHERE prompt_execution_id = ?",
              )
              .run(promptId);
            const insertRestriction = database.prepare(
              `INSERT OR IGNORE INTO restriction_observation
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
            counts.updated += 1;
          } else if (existingIsRestricted) {
            counts.unchanged += 1;
          } else if (
            typeof existingOutcome === "object" &&
            existingOutcome !== null &&
            "outcome" in existingOutcome &&
            typeof existingOutcome.outcome === "string" &&
            existingOutcome.outcome !== observation.outcome &&
            existingRecord !== null &&
            typeof existingRecord.id === "number"
          ) {
            database
              .prepare(
                "UPDATE prompt_source_outcome SET outcome = 'excluded' WHERE prompt_execution_id = ?",
              )
              .run(existingRecord.id);
            database
              .prepare(
                `INSERT INTO ingestion_issue
                   (source_alias, path, reason, segment, line_offset, first_seen_at, last_seen_at, occurrences)
                 VALUES (?, ?, 'incomparable_outcome_conflict', NULL, NULL, ?, ?, 1)`,
              )
              .run(source.alias, options.path ?? "backfill", timestamp, timestamp);
            counts.excluded += 1;
            counts.updated += 1;
          } else {
            counts.unchanged += 1;
          }
          if (!compatibleBackfill) continue;
        }

        let promptId;
        /** @type {Observation["restrictions"]} */
        let restrictions = observation.restrictions;
        if (typeof existing === "object" && existing !== null && "id" in existing) {
          promptId = existing.id;
          const existingRestrictions = database
            .prepare(
              `SELECT class, source_code, observed_at, classifier_version, provenance
               FROM restriction_observation WHERE prompt_execution_id = ?`,
            )
            .all(promptId);
          restrictions = mergeRestrictions(existingRestrictions, observation.restrictions);
          database
            .prepare(
              `UPDATE prompt_execution SET
                   source_session_fingerprint = ?, source_revision = ?,
                   observation_hash = ?, revision_domain = ?, parser_version = ?, started_at = ?, completed_at = ?,
                   duration_ms = ?, completion = ?,
                   input_analyzer_version = COALESCE(?, input_analyzer_version),
                   estimated_input_tokens = COALESCE(?, estimated_input_tokens),
                   input_line_count_bucket = COALESCE(?, input_line_count_bucket),
                   input_code_block_count_bucket = COALESCE(?, input_code_block_count_bucket),
                   input_attachment_count = COALESCE(?, input_attachment_count),
                   seen_spool = MAX(seen_spool, ?), last_observed_at = ?
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
              inputFeatures?.analyzer_version ?? null,
              inputFeatures?.estimated_input_tokens ?? null,
              inputFeatures?.line_count_bucket ?? null,
              inputFeatures?.code_block_count_bucket ?? null,
              inputFeatures?.attachment_count ?? null,
              Number(options.path === "spool"),
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
                   duration_ms, completion, input_analyzer_version, estimated_input_tokens,
                   input_line_count_bucket, input_code_block_count_bucket, input_attachment_count,
                   first_observed_at, last_observed_at, seen_spool)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
              inputFeatures?.analyzer_version ?? null,
              inputFeatures?.estimated_input_tokens ?? null,
              inputFeatures?.line_count_bucket ?? null,
              inputFeatures?.code_block_count_bucket ?? null,
              inputFeatures?.attachment_count ?? null,
              timestamp,
              timestamp,
              Number(options.path === "spool"),
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
          .run(promptId, restrictions.length > 0 ? "restricted" : observation.outcome);
        const insertRestriction = database.prepare(
          `INSERT INTO restriction_observation
             (prompt_execution_id, class, source_code, observed_at, classifier_version, provenance)
           VALUES (?, ?, ?, ?, ?, ?)`,
        );
        for (const restriction of restrictions) {
          insertRestriction.run(
            promptId,
            restriction.class,
            restriction.source_code,
            restriction.observed_at,
            restriction.classifier_version,
            restriction.provenance,
          );
        }
        if ((restrictions.length > 0 ? "restricted" : observation.outcome) === "excluded")
          counts.excluded += 1;
      }

      if (options.path === "spool") {
        const saveCursor = database.prepare(
          `INSERT INTO spool_cursor (source_alias, segment, byte_offset, committed_at)
           VALUES (?, ?, ?, ?)
           ON CONFLICT(source_alias, segment) DO UPDATE SET
             byte_offset = excluded.byte_offset, committed_at = excluded.committed_at`,
        );
        for (const cursor of options.spoolCursors ?? []) {
          saveCursor.run(source.alias, cursor.segment, cursor.byte_offset, timestamp);
        }
        const saveIssue = database.prepare(
          `INSERT INTO ingestion_issue
             (source_alias, path, reason, segment, line_offset, first_seen_at, last_seen_at, occurrences)
           VALUES (?, 'spool', 'invalid_spool_event', ?, ?, ?, ?, 1)
           ON CONFLICT(source_alias, path, reason, segment, line_offset) DO UPDATE SET
             last_seen_at = excluded.last_seen_at, occurrences = ingestion_issue.occurrences + 1`,
        );
        for (const issue of options.rejected ?? []) {
          saveIssue.run(source.alias, issue.segment, issue.line_offset, timestamp, timestamp);
        }
      } else {
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
      }
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
 * @param {{id: string, version: string} | null} [planProfile]
 */
export function ensureCapacityPeriod(databaseFile, source, now, planProfile = null) {
  const database = new Database(databaseFile);
  try {
    database.pragma("foreign_keys = ON");
    database.pragma("busy_timeout = 5000");
    return database
      .transaction(() =>
        ensureSourceBindingAndPeriod(database, source, now.toISOString(), planProfile),
      )
      .immediate();
  } finally {
    database.close();
  }
}

/**
 * @param {Database.Database} database
 * @param {ConfiguredOpenCodeSource} source
 * @param {string} timestamp
 * @param {{id: string, version: string} | null} planProfile
 */
function ensureSourceBindingAndPeriod(database, source, timestamp, planProfile) {
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
      `SELECT id, provider, profile, plan, plan_profile_id
       FROM capacity_period
       WHERE source_alias = ? AND ended_at IS NULL`,
    )
    .get(source.alias);
  // ponytail: a profile version bump alone keeps the period, so shipping an updated
  // bundled profile never resets local evidence. Doctor reports the drift instead.
  if (
    typeof period !== "object" ||
    period === null ||
    !("provider" in period) ||
    period.provider !== source.provider ||
    !("profile" in period) ||
    period.profile !== source.profile ||
    !("plan" in period) ||
    period.plan !== source.plan ||
    !("plan_profile_id" in period) ||
    period.plan_profile_id !== (planProfile?.id ?? null)
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
           (source_alias, provider, profile, plan, started_at,
            plan_profile_id, plan_profile_version)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        source.alias,
        source.provider,
        source.profile,
        source.plan,
        timestamp,
        planProfile?.id ?? null,
        planProfile?.version ?? null,
      );
    period = { id: Number(inserted.lastInsertRowid) };
  }
  if (typeof period !== "object" || period === null || !("id" in period)) {
    throw new Error("Active capacity period is invalid.");
  }
  return period;
}

/**
 * Aggregate the active capacity period, which every `status` run reads.
 *
 * The counts describe the whole period, so the aggregate is unavoidably linear in its prompts:
 * 37 ms at 100,000, inside the 250 ms status budget with room to spare, and about ten times that
 * at a million. A history reaches a million prompts after years of daily use, so this stays a
 * measured ceiling rather than a problem.
 *
 * ponytail: full aggregate per run. Maintain incremental counters on the capacity period, or
 * narrow the summary to a bounded window, once `status` p95 stops meeting its budget — and not
 * before, because either change trades a simple truth for a cache that can drift.
 *
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
           (SELECT id FROM capacity_period
            WHERE source_alias = ? AND ended_at IS NULL) AS active_period_id,
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
      .get(sourceAlias, sourceAlias, sourceAlias);
    if (
      typeof row !== "object" ||
      row === null ||
      !("prompts" in row) ||
      !("successes" in row) ||
      !("restrictions" in row) ||
      !("excluded" in row) ||
      !("as_of" in row) ||
      !("active_period_started_at" in row) ||
      !("active_period_id" in row)
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
      active_period_id: row.active_period_id === null ? null : Number(row.active_period_id),
    };
  } finally {
    database.close();
  }
}

/**
 * @typedef {object} OutcomeHistoryRow
 * @property {number} prompt_execution_id
 * @property {number} capacity_period_id
 * @property {string} started_at
 * @property {"success" | "restricted" | "excluded"} outcome
 * @property {string | null} size_category Null while the prompt has not been categorized.
 */

/**
 * @typedef {object} CategorizationRow
 * @property {number} prompt_execution_id
 * @property {string} started_at
 * @property {number | null} estimated_input_tokens
 */

/**
 * Read the input features the size categorization consumes, in chronological order.
 *
 * @param {string} databaseFile
 * @param {string} sourceAlias
 * @returns {CategorizationRow[]}
 */
export function readCategorizationRows(databaseFile, sourceAlias) {
  const database = new Database(databaseFile, { readonly: true, fileMustExist: true });
  try {
    const rows = database
      .prepare(
        `SELECT id AS prompt_execution_id, started_at, estimated_input_tokens
         FROM prompt_execution
         WHERE source_alias = ?
         ORDER BY started_at ASC, id ASC`,
      )
      .all(sourceAlias);
    return rows.map((row) => {
      if (
        typeof row !== "object" ||
        row === null ||
        !("prompt_execution_id" in row) ||
        !("started_at" in row) ||
        !("estimated_input_tokens" in row)
      ) {
        throw new Error("Categorization row is invalid.");
      }
      return {
        prompt_execution_id: Number(row.prompt_execution_id),
        started_at: String(row.started_at),
        estimated_input_tokens:
          row.estimated_input_tokens === null ? null : Number(row.estimated_input_tokens),
      };
    });
  } finally {
    database.close();
  }
}

/**
 * Persist derived size categories in one transaction.
 *
 * The categories are computed by the prediction modules; storage only writes what it is
 * given, so the whole chronological suffix stays consistent or none of it is written.
 *
 * @param {string} databaseFile
 * @param {{prompt_execution_id: number, size_category: string, category_policy_version: string, category_baseline_as_of: string | null}[]} rows
 * @returns {number} rows written
 */
export function writeSizeCategories(databaseFile, rows) {
  if (rows.length === 0) return 0;
  const database = new Database(databaseFile, { fileMustExist: true });
  try {
    database.pragma("foreign_keys = ON");
    const update = database.prepare(
      `UPDATE prompt_execution
          SET size_category = @size_category,
              category_policy_version = @category_policy_version,
              category_baseline_as_of = @category_baseline_as_of
        WHERE id = @prompt_execution_id`,
    );
    return database.transaction((/** @type {typeof rows} */ batch) =>
      batch.reduce((written, row) => written + update.run(row).changes, 0),
    )(rows);
  } finally {
    database.close();
  }
}

/**
 * Read the source outcomes of a source's active capacity period.
 *
 * Rows come back domain-shaped and unaggregated: decay, cell selection, and evidence
 * gates belong to the prediction module, not to SQL. `limit` keeps the most recent
 * prompts and still returns them oldest first, so a caller whose weighting makes the tail
 * irrelevant does not pay to read it.
 *
 * @param {string} databaseFile
 * @param {string} sourceAlias
 * @param {{limit?: number}} [options]
 * @returns {OutcomeHistoryRow[]}
 */
export function readOutcomeRows(databaseFile, sourceAlias, options = {}) {
  const database = new Database(databaseFile, { readonly: true, fileMustExist: true });
  try {
    const rows = database
      .prepare(
        `SELECT
           prompt_execution.id AS prompt_execution_id,
           prompt_execution.capacity_period_id AS capacity_period_id,
           prompt_execution.started_at AS started_at,
           prompt_source_outcome.outcome AS outcome,
           prompt_execution.size_category AS size_category
         FROM prompt_execution
         JOIN capacity_period
           ON capacity_period.id = prompt_execution.capacity_period_id
          AND capacity_period.ended_at IS NULL
         JOIN prompt_source_outcome
           ON prompt_source_outcome.prompt_execution_id = prompt_execution.id
         WHERE prompt_execution.source_alias = ?
         ORDER BY prompt_execution.started_at ${options.limit === undefined ? "ASC" : "DESC"},
                  prompt_execution.id ${options.limit === undefined ? "ASC" : "DESC"}
         ${options.limit === undefined ? "" : "LIMIT ?"}`,
      )
      .all(...(options.limit === undefined ? [sourceAlias] : [sourceAlias, options.limit]));
    if (options.limit !== undefined) rows.reverse();
    return rows.map((row) => {
      if (
        typeof row !== "object" ||
        row === null ||
        !("prompt_execution_id" in row) ||
        !("capacity_period_id" in row) ||
        !("started_at" in row) ||
        !("outcome" in row) ||
        !("size_category" in row)
      ) {
        throw new Error("Outcome history row is invalid.");
      }
      return {
        prompt_execution_id: Number(row.prompt_execution_id),
        capacity_period_id: Number(row.capacity_period_id),
        started_at: String(row.started_at),
        outcome: /** @type {"success" | "restricted" | "excluded"} */ (String(row.outcome)),
        size_category: row.size_category === null ? null : String(row.size_category),
      };
    });
  } finally {
    database.close();
  }
}

/**
 * @typedef {object} UsageSliceRow
 * @property {string} source_slice_id
 * @property {string} provider
 * @property {string | null} model
 * @property {number | null} input_tokens
 * @property {number | null} output_tokens
 * @property {number | null} reasoning_tokens
 * @property {number | null} cache_read_tokens
 * @property {number | null} cache_write_tokens
 * @property {string | null} cost_decimal
 * @property {string | null} currency
 */

/**
 * @typedef {object} UsageWindowRow
 * @property {number} prompt_execution_id
 * @property {number} capacity_period_id
 * @property {string} started_at
 * @property {string | null} completed_at
 * @property {number | null} duration_ms
 * @property {string} outcome
 * @property {UsageSliceRow[]} slices
 */

/**
 * Read every prompt of one capacity source whose start falls inside a rolling window.
 *
 * The window is half-open: `from` is inclusive and `to` is exclusive. Rows are returned
 * unaggregated; horizon statistics are computed by the analytics module.
 *
 * @param {string} databaseFile
 * @param {string} sourceAlias
 * @param {{from: string, to: string}} window
 * @returns {UsageWindowRow[]}
 */
export function readUsageWindowRows(databaseFile, sourceAlias, window) {
  const database = new Database(databaseFile, { readonly: true, fileMustExist: true });
  try {
    const rows = database
      .prepare(
        `SELECT
           prompt_execution.id AS prompt_execution_id,
           prompt_execution.capacity_period_id AS capacity_period_id,
           prompt_execution.started_at AS started_at,
           prompt_execution.completed_at AS completed_at,
           prompt_execution.duration_ms AS duration_ms,
           prompt_source_outcome.outcome AS outcome,
           prompt_usage_slice.source_slice_id AS source_slice_id,
           prompt_usage_slice.provider AS provider,
           prompt_usage_slice.model AS model,
           prompt_usage_slice.input_tokens AS input_tokens,
           prompt_usage_slice.output_tokens AS output_tokens,
           prompt_usage_slice.reasoning_tokens AS reasoning_tokens,
           prompt_usage_slice.cache_read_tokens AS cache_read_tokens,
           prompt_usage_slice.cache_write_tokens AS cache_write_tokens,
           prompt_usage_slice.cost_decimal AS cost_decimal,
           prompt_usage_slice.currency AS currency
         FROM prompt_execution
         JOIN prompt_source_outcome
           ON prompt_source_outcome.prompt_execution_id = prompt_execution.id
         LEFT JOIN prompt_usage_slice
           ON prompt_usage_slice.prompt_execution_id = prompt_execution.id
         WHERE prompt_execution.source_alias = ?
           AND prompt_execution.started_at >= ?
           AND prompt_execution.started_at < ?
         ORDER BY prompt_execution.started_at, prompt_execution.id,
                  prompt_usage_slice.source_slice_id`,
      )
      .all(sourceAlias, window.from, window.to);

    /** @type {Map<number, UsageWindowRow>} */
    const prompts = new Map();
    for (const row of /** @type {(UsageWindowRow & UsageSliceRow)[]} */ (rows)) {
      let prompt = prompts.get(row.prompt_execution_id);
      if (prompt === undefined) {
        prompt = {
          prompt_execution_id: row.prompt_execution_id,
          capacity_period_id: row.capacity_period_id,
          started_at: row.started_at,
          completed_at: row.completed_at,
          duration_ms: row.duration_ms,
          outcome: row.outcome,
          slices: [],
        };
        prompts.set(row.prompt_execution_id, prompt);
      }
      if (row.source_slice_id !== null) {
        prompt.slices.push({
          source_slice_id: row.source_slice_id,
          provider: row.provider,
          model: row.model,
          input_tokens: row.input_tokens,
          output_tokens: row.output_tokens,
          reasoning_tokens: row.reasoning_tokens,
          cache_read_tokens: row.cache_read_tokens,
          cache_write_tokens: row.cache_write_tokens,
          cost_decimal: row.cost_decimal,
          currency: row.currency,
        });
      }
    }
    return [...prompts.values()];
  } finally {
    database.close();
  }
}

/**
 * @typedef {object} RestrictionWindowRow
 * @property {number} prompt_execution_id
 * @property {string} class
 * @property {string} source_code
 * @property {string} observed_at
 */

/**
 * Read observed restrictions of one capacity source inside a rolling window.
 *
 * Only sanitized identifiers are stored, so no message text can be returned here.
 *
 * @param {string} databaseFile
 * @param {string} sourceAlias
 * @param {{from: string, to: string}} window
 * @returns {RestrictionWindowRow[]}
 */
export function readRestrictionWindowRows(databaseFile, sourceAlias, window) {
  const database = new Database(databaseFile, { readonly: true, fileMustExist: true });
  try {
    return /** @type {RestrictionWindowRow[]} */ (
      database
        .prepare(
          `SELECT
             restriction_observation.prompt_execution_id AS prompt_execution_id,
             restriction_observation.class AS class,
             restriction_observation.source_code AS source_code,
             restriction_observation.observed_at AS observed_at
           FROM restriction_observation
           JOIN prompt_execution
             ON prompt_execution.id = restriction_observation.prompt_execution_id
           WHERE prompt_execution.source_alias = ?
             AND restriction_observation.observed_at >= ?
             AND restriction_observation.observed_at < ?
           ORDER BY restriction_observation.observed_at,
                    restriction_observation.prompt_execution_id,
                    restriction_observation.class`,
        )
        .all(sourceAlias, window.from, window.to)
    );
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

/** @param {string} databaseFile @param {ConfiguredOpenCodeSource} source */
export function readPendingSpoolObservations(databaseFile, source) {
  const database = new Database(databaseFile, { readonly: true, fileMustExist: true });
  try {
    return database
      .prepare(
        `SELECT observation_json FROM pending_spool_observation
         WHERE installation_id = ? AND provider = ?
         ORDER BY first_seen_at, source_prompt_id, revision`,
      )
      .all(source.installation_id, source.provider)
      .flatMap((row) => {
        if (
          typeof row !== "object" ||
          row === null ||
          !("observation_json" in row) ||
          typeof row.observation_json !== "string"
        ) {
          return [];
        }
        try {
          const observation = /** @type {Observation} */ (JSON.parse(row.observation_json));
          return isValidObservation(observation) ? [observation] : [];
        } catch {
          return [];
        }
      });
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
  if (!/^\d+:/u.test(left) || !/^\d+:/u.test(right)) return left.localeCompare(right);
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
 * @param {unknown[]} existing
 * @param {Observation["restrictions"]} incoming
 * @returns {Observation["restrictions"]}
 */
function mergeRestrictions(existing, incoming) {
  const restrictions = [...incoming];
  for (const value of existing) {
    if (
      typeof value !== "object" ||
      value === null ||
      !("class" in value) ||
      !("source_code" in value) ||
      !("observed_at" in value) ||
      !("classifier_version" in value) ||
      !("provenance" in value) ||
      typeof value.class !== "string" ||
      typeof value.source_code !== "string" ||
      typeof value.observed_at !== "string" ||
      typeof value.classifier_version !== "string" ||
      typeof value.provenance !== "string"
    ) {
      continue;
    }
    if (
      !restrictions.some(
        (restriction) =>
          restriction.class === value.class &&
          restriction.source_code === value.source_code &&
          restriction.observed_at === value.observed_at,
      )
    ) {
      restrictions.push({
        class: value.class,
        source_code: value.source_code,
        observed_at: value.observed_at,
        classifier_version: value.classifier_version,
        provenance: value.provenance,
      });
    }
  }
  return restrictions;
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
 * @property {{analyzer_version: string, estimated_input_tokens: number, line_count_bucket: string, code_block_count_bucket: string, attachment_count: number} | null | undefined} [input_features]
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

/**
 * @typedef {object} PredictionAttempt
 * @property {string} source_alias
 * @property {number} capacity_period_id
 * @property {string} generated_at
 * @property {string} method_id
 * @property {string} method_version
 * @property {string} model_policy_version
 * @property {string} risk_policy_version
 * @property {string} evidence_policy_version
 * @property {string} weight_policy_version
 * @property {string} analytics_policy_version
 * @property {string | null} category_policy_version
 * @property {number} lower
 * @property {number} point
 * @property {number} upper
 * @property {number} coverage_target
 * @property {string} risk_label
 * @property {string} evidence_level
 * @property {string} expected_size_category
 * @property {string} backoff_level
 * @property {string} pressure_band
 * @property {number | null} pressure_score
 * @property {string | null} pressure_contributors_json
 * @property {string} plan_profile_id
 * @property {string} plan_profile_version
 * @property {string | null} data_as_of
 * @property {string} completeness
 */

/**
 * Store one immutable prediction attempt.
 *
 * @param {string} databaseFile
 * @param {Record<string, unknown>} attempt
 * @returns {number} attempt id
 */
export function recordPredictionAttempt(databaseFile, attempt) {
  const database = new Database(databaseFile, { fileMustExist: true });
  try {
    database.pragma("foreign_keys = ON");
    const columns = [
      "source_alias",
      "capacity_period_id",
      "generated_at",
      "method_id",
      "method_version",
      "model_policy_version",
      "risk_policy_version",
      "evidence_policy_version",
      "weight_policy_version",
      "analytics_policy_version",
      "category_policy_version",
      "lower",
      "point",
      "upper",
      "coverage_target",
      "risk_label",
      "evidence_level",
      "expected_size_category",
      "backoff_level",
      "pressure_band",
      "pressure_score",
      "pressure_contributors_json",
      "plan_profile_id",
      "plan_profile_version",
      "data_as_of",
      "completeness",
    ];
    const result = database
      .prepare(
        `INSERT INTO prediction_attempt (${columns.join(", ")})
         VALUES (${columns.map((column) => `@${column}`).join(", ")})`,
      )
      .run(Object.fromEntries(columns.map((column) => [column, attempt[column] ?? null])));
    return Number(result.lastInsertRowid);
  } finally {
    database.close();
  }
}

/**
 * Confirm that an attempt reached the user, promoting it to a prediction snapshot.
 *
 * @param {string} databaseFile
 * @param {{prediction_attempt_id: number, delivered_at: string, channel: string, format: string, invocation_id: string}} delivery
 */
export function recordPredictionDelivery(databaseFile, delivery) {
  const database = new Database(databaseFile, { fileMustExist: true });
  try {
    database.pragma("foreign_keys = ON");
    database
      .prepare(
        `INSERT INTO prediction_delivery
           (prediction_attempt_id, delivered_at, channel, format, invocation_id)
         VALUES (@prediction_attempt_id, @delivered_at, @channel, @format, @invocation_id)`,
      )
      .run(delivery);
  } finally {
    database.close();
  }
}

/**
 * Link a delivered forecast to the outcome that followed it.
 *
 * @param {string} databaseFile
 * @param {{prediction_attempt_id: number, prompt_execution_id: number, linked_at: string, is_primary: boolean, policy_version: string}} evaluation
 */
export function linkPredictionEvaluation(databaseFile, evaluation) {
  const database = new Database(databaseFile, { fileMustExist: true });
  try {
    database.pragma("foreign_keys = ON");
    database
      .prepare(
        `INSERT INTO prediction_evaluation
           (prediction_attempt_id, prompt_execution_id, linked_at, is_primary, policy_version)
         VALUES (@prediction_attempt_id, @prompt_execution_id, @linked_at, @is_primary,
                 @policy_version)`,
      )
      .run({ ...evaluation, is_primary: evaluation.is_primary ? 1 : 0 });
  } catch (error) {
    // The unique partial index reports a constraint failure; name what it protects.
    if (error instanceof Error && /prediction_evaluation_primary_idx|UNIQUE/u.test(error.message)) {
      throw new SnackError("This outcome already has a primary live forecast.", {
        code: ExitCode.storage,
        reason: "primary_forecast_exists",
        cause: error,
      });
    }
    throw error;
  } finally {
    database.close();
  }
}

/**
 * Delivered attempts of a source: the prediction snapshots.
 *
 * @param {string} databaseFile
 * @param {string} sourceAlias
 * @returns {{prediction_attempt_id: number, generated_at: string, delivered_at: string, lower: number, point: number, upper: number, risk_label: string, evidence_level: string, model_policy_version: string, capacity_period_id: number}[]}
 */
export function readPredictionSnapshots(databaseFile, sourceAlias) {
  const database = new Database(databaseFile, { readonly: true, fileMustExist: true });
  try {
    const rows = database
      .prepare(
        `SELECT
           prediction_attempt.id AS prediction_attempt_id,
           prediction_attempt.generated_at AS generated_at,
           prediction_delivery.delivered_at AS delivered_at,
           prediction_attempt.lower AS lower,
           prediction_attempt.point AS point,
           prediction_attempt.upper AS upper,
           prediction_attempt.risk_label AS risk_label,
           prediction_attempt.evidence_level AS evidence_level,
           prediction_attempt.model_policy_version AS model_policy_version,
           prediction_attempt.capacity_period_id AS capacity_period_id
         FROM prediction_attempt
         JOIN prediction_delivery
           ON prediction_delivery.prediction_attempt_id = prediction_attempt.id
         WHERE prediction_attempt.source_alias = ?
         ORDER BY prediction_attempt.generated_at ASC, prediction_attempt.id ASC`,
      )
      .all(sourceAlias);
    return /** @type {ReturnType<typeof readPredictionSnapshots>} */ (
      /** @type {unknown} */ (rows)
    );
  } finally {
    database.close();
  }
}

/**
 * Attempts of a source, delivered or not. Undelivered ones are diagnostics only.
 *
 * @param {string} databaseFile
 * @param {string} sourceAlias
 * @returns {number}
 */
export function readPredictionAttemptCount(databaseFile, sourceAlias) {
  const database = new Database(databaseFile, { readonly: true, fileMustExist: true });
  try {
    const row = database
      .prepare("SELECT COUNT(*) AS attempts FROM prediction_attempt WHERE source_alias = ?")
      .get(sourceAlias);
    return Number(/** @type {{attempts: number}} */ (row).attempts);
  } finally {
    database.close();
  }
}

/**
 * Attach every unevaluated outcome to the last snapshot delivered before it.
 *
 * A prompt that started before any forecast existed stays unevaluated: nothing predicted
 * it, and attaching it to a later forecast would score that forecast on hindsight.
 *
 * @param {string} databaseFile
 * @param {string} sourceAlias
 * @param {string} policyVersion
 * @returns {number} evaluations created
 */
export function linkPrimaryEvaluations(databaseFile, sourceAlias, policyVersion) {
  const database = new Database(databaseFile, { fileMustExist: true });
  try {
    database.pragma("foreign_keys = ON");
    const result = database
      .prepare(
        `INSERT INTO prediction_evaluation
           (prediction_attempt_id, prompt_execution_id, linked_at, is_primary, policy_version)
         SELECT
           (SELECT prediction_attempt.id
              FROM prediction_attempt
              JOIN prediction_delivery
                ON prediction_delivery.prediction_attempt_id = prediction_attempt.id
             WHERE prediction_attempt.source_alias = prompt_execution.source_alias
               AND prediction_attempt.capacity_period_id = prompt_execution.capacity_period_id
               AND prediction_attempt.generated_at < prompt_execution.started_at
             ORDER BY prediction_attempt.generated_at DESC, prediction_attempt.id DESC
             LIMIT 1),
           prompt_execution.id,
           prompt_execution.started_at,
           1,
           @policy_version
         FROM prompt_execution
         WHERE prompt_execution.source_alias = @source_alias
           AND NOT EXISTS (
             SELECT 1 FROM prediction_evaluation
              WHERE prediction_evaluation.prompt_execution_id = prompt_execution.id
           )
           AND EXISTS (
             SELECT 1
               FROM prediction_attempt
               JOIN prediction_delivery
                 ON prediction_delivery.prediction_attempt_id = prediction_attempt.id
              WHERE prediction_attempt.source_alias = prompt_execution.source_alias
                AND prediction_attempt.capacity_period_id = prompt_execution.capacity_period_id
                AND prediction_attempt.generated_at < prompt_execution.started_at
           )`,
      )
      .run({ source_alias: sourceAlias, policy_version: policyVersion });
    return Number(result.changes);
  } finally {
    database.close();
  }
}

/**
 * @typedef {object} CalibrationPair
 * @property {number} prediction_attempt_id
 * @property {number} lower
 * @property {number} point
 * @property {number} upper
 * @property {"success" | "restricted" | "excluded"} outcome
 * @property {string} evidence_level
 * @property {string} model_policy_version
 */

/**
 * Delivered forecasts paired with the outcome that followed them.
 *
 * @param {string} databaseFile
 * @param {string} sourceAlias
 * @returns {CalibrationPair[]}
 */
export function readCalibrationPairs(databaseFile, sourceAlias) {
  const database = new Database(databaseFile, { readonly: true, fileMustExist: true });
  try {
    const rows = database
      .prepare(
        `SELECT
           prediction_attempt.id AS prediction_attempt_id,
           prediction_attempt.lower AS lower,
           prediction_attempt.point AS point,
           prediction_attempt.upper AS upper,
           prediction_attempt.evidence_level AS evidence_level,
           prediction_attempt.model_policy_version AS model_policy_version,
           prompt_source_outcome.outcome AS outcome
         FROM prediction_evaluation
         JOIN prediction_attempt
           ON prediction_attempt.id = prediction_evaluation.prediction_attempt_id
         JOIN prompt_source_outcome
           ON prompt_source_outcome.prompt_execution_id = prediction_evaluation.prompt_execution_id
         WHERE prediction_attempt.source_alias = ?
           AND prediction_evaluation.is_primary = 1
         ORDER BY prediction_evaluation.linked_at ASC`,
      )
      .all(sourceAlias);
    return /** @type {CalibrationPair[]} */ (/** @type {unknown} */ (rows));
  } finally {
    database.close();
  }
}

/**
 * @typedef {object} PurgeScope
 * @property {string} [source] One capacity source; absent means every configured source.
 * @property {string} [since] Inclusive lower bound.
 * @property {string} [until] Exclusive upper bound.
 */

/**
 * Delete exactly one scope of observations, and nothing else.
 *
 * Runs under the storage operation lock so a concurrent synchronization cannot re-insert rows
 * midway through, and inside one immediate transaction so a failure leaves the history intact.
 * The counts gathered for the preview are compared against the rows actually deleted before the
 * transaction commits, which turns "purge never exceeds its selection" into something the
 * command checks rather than something it claims.
 *
 * @param {{databaseFile: string, stateDir: string}} paths
 * @param {PurgeScope} scope
 * @param {{now: Date, preview?: boolean, preventReimport?: boolean}} options
 * @returns {Promise<{counts: Record<string, number>, cursor_reset: string[], tombstones: number}>}
 */
export async function purgeScope(paths, scope, options) {
  return withStorageOperationLock(paths, async () => purgeScopeLocked(paths, scope, options));
}

/**
 * @param {{databaseFile: string}} paths
 * @param {PurgeScope} scope
 * @param {{now: Date, preview?: boolean, preventReimport?: boolean}} options
 */
function purgeScopeLocked(paths, scope, options) {
  const database = new Database(paths.databaseFile, { fileMustExist: true });
  try {
    database.pragma("foreign_keys = ON");
    database.pragma("busy_timeout = 5000");
    // A TEMP table is visible only to this connection, so it lifts the immutability trigger on
    // prediction snapshots here and nowhere else. See migrations/009_purge_tombstone.sql.
    // ponytail: per-connection sentinel, not a capability system. Upgrade to a signed operation
    // token only if a second write path ever needs this exception.
    database.exec("CREATE TEMP TABLE IF NOT EXISTS snack_purge (marker INTEGER)");
    const parameters = {
      source: scope.source ?? null,
      since: scope.since ?? null,
      until: scope.until ?? null,
    };
    const promptFilter = `
      (@source IS NULL OR prompt_execution.source_alias = @source)
      AND (@since IS NULL OR prompt_execution.started_at >= @since)
      AND (@until IS NULL OR prompt_execution.started_at < @until)`;
    const attemptFilter = `
      (@source IS NULL OR prediction_attempt.source_alias = @source)
      AND (@since IS NULL OR prediction_attempt.generated_at >= @since)
      AND (@until IS NULL OR prediction_attempt.generated_at < @until)`;

    const apply = database.transaction(() => {
      const counted = {
        prompts: countRows(
          database,
          `SELECT COUNT(*) AS total FROM prompt_execution WHERE ${promptFilter}`,
          parameters,
        ),
        predictions: countRows(
          database,
          `SELECT COUNT(*) AS total FROM prediction_attempt WHERE ${attemptFilter}`,
          parameters,
        ),
      };
      if (options.preview === true) {
        return { counts: counted, cursor_reset: previewCursorResets(database, scope, parameters) };
      }

      // Evaluations first: they reference attempts, and nothing cascades from the attempt side.
      database
        .prepare(
          `DELETE FROM prediction_evaluation
            WHERE prediction_attempt_id IN (
              SELECT id FROM prediction_attempt WHERE ${attemptFilter})
               OR prompt_execution_id IN (
              SELECT id FROM prompt_execution WHERE ${promptFilter})`,
        )
        .run(parameters);
      database
        .prepare(
          `DELETE FROM prediction_delivery
            WHERE prediction_attempt_id IN (
              SELECT id FROM prediction_attempt WHERE ${attemptFilter})`,
        )
        .run(parameters);
      const deletedPredictions = database
        .prepare(`DELETE FROM prediction_attempt WHERE ${attemptFilter}`)
        .run(parameters).changes;
      // Usage slices, outcomes, and restrictions cascade from prompt_execution.
      const deletedPrompts = database
        .prepare(`DELETE FROM prompt_execution WHERE ${promptFilter}`)
        .run(parameters).changes;

      if (deletedPrompts !== counted.prompts || deletedPredictions !== counted.predictions) {
        throw new SnackError("Purge would have removed a different set than it previewed.", {
          code: ExitCode.storage,
          reason: "purge_scope_mismatch",
        });
      }

      const cursorReset = resetContainedCursors(database, scope, parameters);
      const tombstones =
        options.preventReimport === true ? writeTombstones(database, scope, options.now) : 0;
      return { counts: counted, cursor_reset: cursorReset, tombstones };
    });
    const result = apply.immediate();
    return { tombstones: 0, ...result };
  } finally {
    database.exec("DROP TABLE IF EXISTS temp.snack_purge");
    database.close();
  }
}

/** @param {import("better-sqlite3").Database} database @param {string} sql @param {Record<string, unknown>} parameters */
function countRows(database, sql, parameters) {
  const row = database.prepare(sql).get(parameters);
  return Number(typeof row === "object" && row !== null && "total" in row ? row.total : Number.NaN);
}

/**
 * Which sources would lose their ingestion cursor, without touching it.
 *
 * @param {import("better-sqlite3").Database} database
 * @param {PurgeScope} scope
 * @param {Record<string, unknown>} parameters
 */
function previewCursorResets(database, scope, parameters) {
  return database
    .prepare(cursorResetSelect())
    .all(parameters)
    .map((row) => String(/** @type {{source_alias: unknown}} */ (row).source_alias));
}

/**
 * Reset the ingestion cursor of any source whose watermark falls inside the purged range.
 *
 * The cursor is a single high-watermark and cannot describe a hole. Leaving it in place after
 * purging recent data would make the next incremental synchronization skip straight past the
 * removed records and never restore them, with nothing reported. Purging strictly older data
 * leaves the cursor alone, because the watermark still describes reality.
 *
 * @param {import("better-sqlite3").Database} database
 * @param {PurgeScope} scope
 * @param {Record<string, unknown>} parameters
 */
function resetContainedCursors(database, scope, parameters) {
  const affected = previewCursorResets(database, scope, parameters);
  if (affected.length > 0) {
    database
      .prepare(
        `DELETE FROM ingestion_cursor WHERE source_alias IN (${affected.map(() => "?").join(",")})`,
      )
      .run(...affected);
  }
  return affected;
}

function cursorResetSelect() {
  // An open upper bound means the purge reaches the present, so any watermark is inside it.
  return `SELECT source_alias
            FROM ingestion_cursor
           WHERE (@source IS NULL OR source_alias = @source)
             AND (@until IS NULL OR time_updated < @until)`;
}

/**
 * @param {import("better-sqlite3").Database} database
 * @param {PurgeScope} scope
 * @param {Date} now
 */
function writeTombstones(database, scope, now) {
  const aliases =
    scope.source === undefined
      ? database
          .prepare("SELECT alias FROM capacity_source")
          .all()
          .map((row) => String(/** @type {{alias: unknown}} */ (row).alias))
      : [scope.source];
  const insert = database.prepare(
    `INSERT INTO purge_tombstone
       (source_alias, from_at, until_at, purged_at, blocks_reimport)
     VALUES (?, ?, ?, ?, 1)`,
  );
  for (const alias of aliases) {
    insert.run(alias, scope.since ?? null, scope.until ?? null, now.toISOString());
  }
  return aliases.length;
}

/**
 * Ranges a source refuses to re-import because they were purged on purpose.
 *
 * @param {import("better-sqlite3").Database} database
 * @param {string} sourceAlias
 * @returns {{from_at: string | null, until_at: string | null}[]}
 */
export function readPurgeTombstones(database, sourceAlias) {
  return database
    .prepare(
      `SELECT from_at, until_at FROM purge_tombstone
        WHERE source_alias = ? AND blocks_reimport = 1`,
    )
    .all(sourceAlias)
    .map((row) => {
      const record = /** @type {{from_at: unknown, until_at: unknown}} */ (row);
      return {
        from_at: record.from_at === null ? null : String(record.from_at),
        until_at: record.until_at === null ? null : String(record.until_at),
      };
    });
}

/**
 * @param {{from_at: string | null, until_at: string | null}[]} tombstones
 * @param {string} startedAt
 */
export function isTombstoned(tombstones, startedAt) {
  return tombstones.some(
    (tombstone) =>
      (tombstone.from_at === null || startedAt >= tombstone.from_at) &&
      (tombstone.until_at === null || startedAt < tombstone.until_at),
  );
}

/**
 * Refuse to read storage this build cannot interpret.
 *
 * `initializeDatabase` verifies the migration history because it is about to write. The paths
 * that only read — `status --no-sync`, `stats`, `export`, and the previews and deletions of
 * `data purge` — used to skip that check and work over whatever they found. Rows written under
 * a schema a later SNACK introduced may not mean what this build assumes: exporting them would
 * stamp that assumption with this build's provenance, and purging them would delete records it
 * cannot interpret.
 *
 * Absent storage is not an error here. Each command already reports "nothing observed yet"
 * through its own contract.
 *
 * @param {string} databaseFile
 */
export async function assertReadableStorage(databaseFile) {
  if (!(await pathExists(databaseFile))) return;
  const database = new Database(databaseFile, { readonly: true, fileMustExist: true });
  try {
    verifyAppliedMigrations(
      readAppliedMigrations(database),
      await loadMigrations(migrationDirectory),
    );
  } catch (error) {
    if (error instanceof SnackError) throw error;
    throw new SnackError("Storage could not be read.", {
      code: ExitCode.storage,
      reason: "storage_read_error",
      cause: error,
    });
  } finally {
    database.close();
  }
}
