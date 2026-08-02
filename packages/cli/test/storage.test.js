import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, test } from "node:test";

import Database from "better-sqlite3";

import { ExitCode, SnackError } from "../src/errors.js";
import { run } from "../src/main.js";
import { resolvePaths } from "../src/paths.js";
import {
  createSetupDatabaseBackup,
  initializeDatabase,
  inspectDatabase,
  migrationDirectory,
  readIngestionCursor,
  readSpoolIssueCount,
  restoreSetupDatabaseBackup,
  storeObservations,
} from "../src/storage.js";
import {
  cleanupRunFixtures,
  createOpenCodeDatabase,
  makeRunFixture,
} from "./fixtures/run-fixture.js";

const now = new Date("2026-01-02T03:04:05.000Z");

/** A database carrying the real migrations, rather than the synthetic one `makeFixture` uses. */
async function makeStorage() {
  const root = await mkdtemp(join(tmpdir(), "snack-storage-real-"));
  temporaryRoots.push(root);
  return {
    root,
    paths: resolvePaths({
      env: { XDG_DATA_HOME: join(root, "data"), XDG_STATE_HOME: join(root, "state") },
      platform: /** @type {NodeJS.Platform} */ ("linux"),
      home: root,
    }),
  };
}

/** @type {string[]} */
const temporaryRoots = [];

afterEach(async () => {
  await cleanupRunFixtures();
  await Promise.all(
    temporaryRoots.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

test("applies migrations once with private permissions", async () => {
  const fixture = await makeFixture();
  const first = await initializeDatabase(fixture.paths, {
    migrationsDir: fixture.migrations,
    now: new Date("2026-01-02T03:04:05.000Z"),
  });
  const second = await initializeDatabase(fixture.paths, { migrationsDir: fixture.migrations });
  const inspection = await inspectDatabase(fixture.paths.databaseFile, {
    migrationsDir: fixture.migrations,
  });

  assert.deepEqual(first.applied, [1]);
  assert.deepEqual(second.applied, []);
  assert.equal(second.backupCreated, false);
  assert.deepEqual(inspection, { exists: true, integrity: "ok", migrations: "current" });
  assert.equal((await stat(fixture.paths.dataDir)).mode & 0o777, 0o700);
  assert.equal((await stat(fixture.paths.databaseFile)).mode & 0o777, 0o600);
});

test("backs up an existing database before a pending migration", async () => {
  const fixture = await makeFixture();
  await initializeDatabase(fixture.paths, { migrationsDir: fixture.migrations });
  await writeFile(
    join(fixture.migrations, "002_add_value.sql"),
    "ALTER TABLE sample ADD COLUMN value TEXT;\n",
  );

  const result = await initializeDatabase(fixture.paths, {
    migrationsDir: fixture.migrations,
    now: new Date("2026-01-02T03:04:05.000Z"),
  });

  assert.deepEqual(result.applied, [2]);
  assert.equal(result.backupCreated, true);
  const backups = await readdir(fixture.paths.backupDir);
  assert.equal(backups.length, 1);
  const backupName = backups[0];
  assert.ok(backupName);
  const backup = join(fixture.paths.backupDir, backupName);
  assert.equal((await stat(backup)).mode & 0o777, 0o600);
});

test("rejects modified migration history", async () => {
  const fixture = await makeFixture();
  await initializeDatabase(fixture.paths, { migrationsDir: fixture.migrations });
  await writeFile(join(fixture.migrations, "001_initialize.sql"), "CREATE TABLE changed (id);\n");

  await assert.rejects(
    initializeDatabase(fixture.paths, { migrationsDir: fixture.migrations }),
    (error) => error instanceof SnackError && error.reason === "migration_history_mismatch",
  );
});

test("serializes concurrent migration attempts", async () => {
  const fixture = await makeFixture();
  const [first, second] = await Promise.all([
    initializeDatabase(fixture.paths, { migrationsDir: fixture.migrations }),
    initializeDatabase(fixture.paths, { migrationsDir: fixture.migrations }),
  ]);

  assert.deepEqual([...first.applied, ...second.applied].sort(), [1]);
});

test("serializes backup and concurrent upgrades", async () => {
  const fixture = await makeFixture();
  await initializeDatabase(fixture.paths, { migrationsDir: fixture.migrations });
  await writeFile(
    join(fixture.migrations, "002_add_value.sql"),
    "ALTER TABLE sample ADD COLUMN value TEXT;\n",
  );

  const [first, second] = await Promise.all([
    initializeDatabase(fixture.paths, { migrationsDir: fixture.migrations }),
    initializeDatabase(fixture.paths, { migrationsDir: fixture.migrations }),
  ]);

  assert.deepEqual([...first.applied, ...second.applied].sort(), [2]);
  const backups = await readdir(fixture.paths.backupDir);
  assert.equal(backups.length, 1);
  const backupName = backups[0];
  assert.ok(backupName);
  const backup = new Database(join(fixture.paths.backupDir, backupName), { readonly: true });
  try {
    const columns = /** @type {{name: string}[]} */ (
      backup.prepare("PRAGMA table_info(sample)").all()
    );
    assert.deepEqual(
      columns.map((column) => column.name),
      ["id"],
    );
  } finally {
    backup.close();
  }
});

test("reports foreign-key corruption", async () => {
  const fixture = await makeFixture();
  await writeFile(
    join(fixture.migrations, "001_initialize.sql"),
    [
      "CREATE TABLE parent (id INTEGER PRIMARY KEY) STRICT;",
      "CREATE TABLE child (id INTEGER PRIMARY KEY, parent_id INTEGER REFERENCES parent(id)) STRICT;",
      "",
    ].join("\n"),
  );
  await initializeDatabase(fixture.paths, { migrationsDir: fixture.migrations });
  const database = new Database(fixture.paths.databaseFile);
  try {
    database.pragma("foreign_keys = OFF");
    database.prepare("INSERT INTO child (id, parent_id) VALUES (1, 999)").run();
  } finally {
    database.close();
  }

  const inspection = await inspectDatabase(fixture.paths.databaseFile, {
    migrationsDir: fixture.migrations,
  });
  assert.equal(inspection.integrity, "failed");
});

test("rolls back a failing migration transaction", async () => {
  const fixture = await makeFixture();
  await initializeDatabase(fixture.paths, { migrationsDir: fixture.migrations });
  await writeFile(
    join(fixture.migrations, "002_broken.sql"),
    "CREATE TABLE should_rollback (id INTEGER); INVALID SQL;\n",
  );

  await assert.rejects(
    initializeDatabase(fixture.paths, { migrationsDir: fixture.migrations }),
    (error) => error instanceof SnackError && error.reason === "storage_initialization_error",
  );

  const database = new Database(fixture.paths.databaseFile, { readonly: true });
  try {
    const table = database
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?")
      .get("should_rollback");
    const count = database.prepare("SELECT COUNT(*) AS count FROM schema_migration").get();
    assert.equal(table, undefined);
    assert.deepEqual(count, { count: 1 });
  } finally {
    database.close();
  }
});

async function makeFixture() {
  const root = await mkdtemp(join(tmpdir(), "snack-storage-"));
  temporaryRoots.push(root);
  const migrations = join(root, "migrations");
  const dataDir = join(root, "data");
  await mkdir(migrations, { mode: 0o700 });
  await writeFile(
    join(migrations, "001_initialize.sql"),
    "CREATE TABLE sample (id INTEGER PRIMARY KEY) STRICT;\n",
  );
  return {
    migrations,
    paths: {
      dataDir,
      databaseFile: join(dataDir, "snack.sqlite3"),
      backupDir: join(dataDir, "backups"),
    },
  };
}

test("an ingestion cursor never advances past writes that did not commit", async () => {
  const { paths } = await makeStorage();
  await initializeDatabase(paths, { applicationVersion: "0.6.0", now });
  seedSource(paths.databaseFile);
  const source = configuredSource(paths.databaseFile);

  const first = storeObservations(
    paths.databaseFile,
    source,
    { observations: [observation(1, "2026-01-02T01:00:00.000Z")], cursor: cursorAt(1000) },
    now,
  );
  assert.equal(first.inserted, 1);
  assert.deepEqual(readIngestionCursor(paths.databaseFile, "work"), cursorAt(1000));

  // A batch that fails partway must leave the cursor where the last committed batch put it.
  // Advancing it first would skip these observations forever, silently.
  assert.throws(() =>
    storeObservations(
      paths.databaseFile,
      source,
      {
        observations: [
          observation(2, "2026-01-02T02:00:00.000Z"),
          // A completion value the schema refuses, so the transaction aborts mid-batch.
          /** @type {import("../src/storage.js").Observation} */ ({
            ...observation(3, "2026-01-02T03:00:00.000Z"),
            completion: "not-a-completion",
          }),
        ],
        cursor: cursorAt(9999),
      },
      now,
    ),
  );

  assert.deepEqual(readIngestionCursor(paths.databaseFile, "work"), cursorAt(1000));
  assert.equal(countPrompts(paths.databaseFile), 1);
});

test("a restored setup backup returns the database to exactly its earlier state", async () => {
  const { paths } = await makeStorage();
  await initializeDatabase(paths, { applicationVersion: "0.6.0", now });
  seedSource(paths.databaseFile);
  const source = configuredSource(paths.databaseFile);
  storeObservations(
    paths.databaseFile,
    source,
    { observations: [observation(1, "2026-01-02T01:00:00.000Z")], cursor: cursorAt(1000) },
    now,
  );

  const backupFile = await createSetupDatabaseBackup(paths);
  assert.ok(backupFile);
  storeObservations(
    paths.databaseFile,
    source,
    { observations: [observation(2, "2026-01-02T02:00:00.000Z")], cursor: cursorAt(2000) },
    now,
  );
  assert.equal(countPrompts(paths.databaseFile), 2);

  await restoreSetupDatabaseBackup(paths, backupFile);

  // Setup rolls back through this path, so it has to undo the observations too, not just the
  // configuration that pointed at them.
  assert.equal(countPrompts(paths.databaseFile), 1);
  assert.deepEqual(readIngestionCursor(paths.databaseFile, "work"), cursorAt(1000));
  assert.equal((await stat(paths.databaseFile)).mode & 0o777, 0o600);
});

test("re-storing the same observations converges instead of duplicating them", async () => {
  const { paths } = await makeStorage();
  await initializeDatabase(paths, { applicationVersion: "0.6.0", now });
  seedSource(paths.databaseFile);
  const source = configuredSource(paths.databaseFile);
  const batch = {
    observations: [
      observation(1, "2026-01-02T01:00:00.000Z"),
      observation(2, "2026-01-02T02:00:00.000Z"),
    ],
    cursor: cursorAt(2000),
  };

  const first = storeObservations(paths.databaseFile, source, batch, now);
  const second = storeObservations(paths.databaseFile, source, batch, now);

  // A full re-read is the documented recovery path, so it must be safe to run at any time.
  assert.equal(first.inserted, 2);
  assert.equal(second.inserted, 0);
  assert.equal(second.unchanged, 2);
  assert.equal(countPrompts(paths.databaseFile), 2);
});

/** @param {string} databaseFile */
function countPrompts(databaseFile) {
  const database = new Database(databaseFile, { readonly: true });
  try {
    const row = /** @type {{total?: unknown}} */ (
      database.prepare("SELECT COUNT(*) AS total FROM prompt_execution").get()
    );
    return Number(row?.total ?? -1);
  } finally {
    database.close();
  }
}

/** @param {number} timeUpdated */
function cursorAt(timeUpdated) {
  return { time_updated: timeUpdated, message_id: `message-${timeUpdated}` };
}

test("upgrading a 0.6 database to 0.7 keeps every row it already held", async () => {
  // The MVP is the first guaranteed migration baseline, so this is the gate the whole stage hangs
  // from: 0.6 data survives 0.7 or 0.7 does not ship. The 0.7 migration rebuilds tables that other
  // tables point at, which is the one shape of migration SQLite cannot express as an alteration.
  const { paths } = await makeStorage();
  const baseline = await copyMigrationsThrough(9);
  await initializeDatabase(paths, {
    migrationsDir: baseline,
    applicationVersion: "0.6.0",
    now,
  });
  // Seeded with the SQL a 0.6 binary would have written, rather than through today's write path:
  // this database has to be what 0.6 actually left behind, including a cursor in the columns 0.6
  // used before the cursor became an opaque document.
  seedZeroSixDatabase(paths.databaseFile);
  const before = tableCounts(paths.databaseFile);

  // Pinned to the migrations 0.7 shipped. Left pointing at the whole directory this test would
  // quietly become "0.6 upgrades to whatever is newest" the moment a later release added one, and
  // the 0.6-to-0.7 leg it is named after would stop being covered by anything.
  const upgrade = await initializeDatabase(paths, {
    migrationsDir: await copyMigrationsThrough(11),
    applicationVersion: "0.7.0",
    now,
  });

  assert.deepEqual(upgrade.applied, [10, 11]);
  assert.equal(upgrade.backupCreated, true);
  const after = tableCounts(paths.databaseFile);
  // The migration history is the one table an upgrade is supposed to grow. Every other table has
  // to come out the far side holding exactly what it held, including the ones the migration
  // rebuilds from scratch.
  assert.equal(after.schema_migration, (before.schema_migration ?? 0) + 2);
  assert.deepEqual({ ...after, schema_migration: 0 }, { ...before, schema_migration: 0 });
  // Stopped at 0.7 while the installed release ships more migrations, so `pending` is the honest
  // reading and the one a user in this position would see: intact, upgradeable, not yet upgraded.
  assert.deepEqual(await inspectDatabase(paths.databaseFile), {
    exists: true,
    integrity: "ok",
    migrations: "pending",
  });
  assert.deepEqual(readIngestionCursor(paths.databaseFile, "work"), cursorAt(2000));
});

test("upgrading a 0.7 database to 0.8 keeps every row it already held", async () => {
  // 0.8 records which client produced each prompt, which is a column on the largest table in the
  // database and the one four other tables cascade from. The rows a 0.7 install already holds are
  // the thing that has to survive it.
  const { paths } = await makeStorage();
  const baseline = await copyMigrationsThrough(11);
  await initializeDatabase(paths, { migrationsDir: baseline, applicationVersion: "0.7.0", now });
  // Every column this seed writes still exists at 011, so the rows a 0.6 binary left behind are
  // also the rows a 0.7 binary holds; what differs is the schema they now sit in.
  seedZeroSixDatabase(paths.databaseFile);
  const before = tableCounts(paths.databaseFile);

  const upgrade = await initializeDatabase(paths, {
    migrationsDir: await copyMigrationsThrough(12),
    applicationVersion: "0.8.0",
    now,
  });

  assert.deepEqual(upgrade.applied, [12]);
  assert.equal(upgrade.backupCreated, true);
  const after = tableCounts(paths.databaseFile);
  assert.equal(after.schema_migration, (before.schema_migration ?? 0) + 1);
  assert.deepEqual({ ...after, schema_migration: 0 }, { ...before, schema_migration: 0 });
  assert.deepEqual(await inspectDatabase(paths.databaseFile), {
    exists: true,
    integrity: "ok",
    migrations: "pending",
  });
});

test("a 0.6 database reaches 1.1.1 one release at a time, without a reset", async () => {
  // 0.6 is the guaranteed migration baseline, and the promise is that it stays reachable as the
  // chain grows rather than only from whichever release last thought about it. An install that
  // skipped a release entirely takes the same path, one upgrade at a time.
  //
  // The last leg is the one that earns its keep: migration 013 rebuilds `capacity_period` and every
  // table that cascades from it, which is the largest rebuild this project has done. A row lost
  // there is a row of the user's own history.
  const { paths } = await makeStorage();
  await initializeDatabase(paths, {
    migrationsDir: await copyMigrationsThrough(9),
    applicationVersion: "0.6.0",
    now,
  });
  seedZeroSixDatabase(paths.databaseFile);
  const before = tableCounts(paths.databaseFile);

  const toZeroSeven = await initializeDatabase(paths, {
    migrationsDir: await copyMigrationsThrough(11),
    applicationVersion: "0.7.0",
    now,
  });
  const toZeroEight = await initializeDatabase(paths, {
    migrationsDir: await copyMigrationsThrough(12),
    applicationVersion: "0.8.0",
    now,
  });
  const toOneOneOne = await initializeDatabase(paths, { applicationVersion: "1.1.1", now });

  assert.deepEqual(toZeroSeven.applied, [10, 11]);
  assert.deepEqual(toZeroEight.applied, [12]);
  assert.deepEqual(toOneOneOne.applied, [13]);
  const after = tableCounts(paths.databaseFile);
  assert.equal(after.schema_migration, (before.schema_migration ?? 0) + 4);
  assert.deepEqual({ ...after, schema_migration: 0 }, { ...before, schema_migration: 0 });
  // The cursor is what makes it an upgrade rather than a reset: a database that forgot where its
  // reader stopped would re-ingest a whole history and describe usage that never happened.
  assert.deepEqual(readIngestionCursor(paths.databaseFile, "work"), cursorAt(2000));
  // Row counts alone cannot tell a preserved forecast from a rewritten one, and a forecast the user
  // was actually shown is the one row the product may never restate. Compared field by field.
  assert.deepEqual(readDeliveredForecast(paths.databaseFile), {
    prediction_attempt_id: 1,
    lower: 0.4,
    point: 0.6,
    upper: 0.8,
    risk_label: "elevated",
    evidence_level: "low",
    model_policy_version: "stage5-prediction-v2",
    delivered_at: now.toISOString(),
    channel: "stdout",
    is_primary: 1,
    prompt_execution_id: 1,
  });
});

/**
 * Read the one forecast the user was shown, with the delivery and evaluation that reference it.
 *
 * @param {string} databaseFile
 */
function readDeliveredForecast(databaseFile) {
  const database = new Database(databaseFile, { readonly: true });
  try {
    return database
      .prepare(
        `SELECT prediction_attempt.id AS prediction_attempt_id,
                prediction_attempt.lower, prediction_attempt.point, prediction_attempt.upper,
                prediction_attempt.risk_label, prediction_attempt.evidence_level,
                prediction_attempt.model_policy_version,
                prediction_delivery.delivered_at, prediction_delivery.channel,
                prediction_evaluation.is_primary, prediction_evaluation.prompt_execution_id
           FROM prediction_attempt
           JOIN prediction_delivery
             ON prediction_delivery.prediction_attempt_id = prediction_attempt.id
           JOIN prediction_evaluation
             ON prediction_evaluation.prediction_attempt_id = prediction_attempt.id`,
      )
      .get();
  } finally {
    database.close();
  }
}

test("a database still at an older schema is refused rather than half-read", async () => {
  // The mirror of "a database written by a newer release", and the one that was missing. A
  // read-only path verifies that every migration the database claims is one this build ships, and
  // never that this build's migrations have all been applied -- so a database left at an older
  // schema passes the check and then meets a column that does not exist yet. `status --no-sync`
  // answered exit 10, "Unexpected internal failure", which is the one answer that helps nobody.
  //
  // This is the state every single upgrade passes through: the pending migrations apply on the
  // first command that opens storage for write, so a read-only command run before that one is
  // ordinary, not exotic.
  const fixture = await makeRunFixture("snack-unmigrated-");
  fixture.options.env.OPENCODE_DB = await createOpenCodeDatabase(fixture.root);
  await initializeDatabase(fixture.paths, {
    migrationsDir: await copyMigrationsThrough(9),
    applicationVersion: "0.6.0",
    now,
  });
  seedZeroSixDatabase(fixture.paths.databaseFile);
  const before = tableCounts(fixture.paths.databaseFile);
  await writeZeroSixConfig(fixture);

  for (const argv of [
    ["status", "--no-sync"],
    ["export", "--format", "json", "--output", "-"],
    ["data", "purge", "--source", "work", "--dry-run"],
  ]) {
    fixture.stdout.value = "";
    fixture.stderr.value = "";
    const exitCode = await run(["node", "snack", ...argv, "--json"], fixture.options);

    assert.equal(exitCode, ExitCode.storage, `${argv.join(" ")}: ${fixture.stdout.value}`);
    const document = JSON.parse(fixture.stdout.value);
    assert.equal(document.errors[0].code, "storage_migrations_pending", argv.join(" "));
    // Actionable, or it is no better than the crash it replaces: the message names the command
    // that fixes it.
    assert.match(document.errors[0].message, /snack sync/u);
  }
  // Refusing means refusing: nothing was read, so nothing was written either.
  assert.deepEqual(tableCounts(fixture.paths.databaseFile), before);
});

test("a 0.6 database answers every command the frozen release publishes", async () => {
  // The migration chain is tested; what the commands then do with those rows is not. An upgrade
  // that preserved every row and then answered `status` with an error would pass every test above
  // and still be worthless to the person who upgraded.
  //
  // 0.9 added no migration of its own -- the chain still ends at 012 -- so the 0.6 -> 0.9 promise
  // is not another leg to apply. It is this: the rows a 0.6 binary left behind are readable by the
  // release that froze the contracts, through the documents that contract publishes.
  const fixture = await makeRunFixture("snack-zero-six-");
  fixture.options.env.OPENCODE_DB = await createOpenCodeDatabase(fixture.root);
  await initializeDatabase(fixture.paths, {
    migrationsDir: await copyMigrationsThrough(9),
    applicationVersion: "0.6.0",
    now,
  });
  seedZeroSixDatabase(fixture.paths.databaseFile);
  const before = tableCounts(fixture.paths.databaseFile);
  await writeZeroSixConfig(fixture);

  /** @param {string[]} argv */
  const document = async (...argv) => {
    fixture.stdout.value = "";
    fixture.stderr.value = "";
    const exitCode = await run(["node", "snack", ...argv, "--json"], fixture.options);
    return { exitCode, document: JSON.parse(fixture.stdout.value) };
  };

  // Before anything migrates, `doctor` is the command that says so. It diagnoses without changing,
  // so it must not quietly upgrade the database out from under the person asking what state it is
  // in -- and reporting a pending migration as healthy would be the worse answer.
  const beforeUpgrade = await document("doctor");
  assert.equal(beforeUpgrade.exitCode, ExitCode.storage);
  assert.deepEqual(
    beforeUpgrade.document.errors.map((/** @type {{code: string}} */ error) => error.code),
    ["storage_migrations"],
  );

  // The upgrade itself, in the order it really happens: the first command that opens storage for
  // write applies the pending migrations. `config set` is the smallest one that does, so what
  // follows is measuring the upgrade rather than an upgrade plus an ingestion.
  const upgrade = await document("config", "set", "analysis.horizons", '["PT1H"]');
  assert.equal(upgrade.exitCode, 0, JSON.stringify(upgrade.document.errors));
  assert.deepEqual(upgrade.document.data.storage.applied, [10, 11, 12, 13]);
  assert.equal(upgrade.document.data.storage.backup_created, true);

  const status = await document("status", "--no-sync");
  const stats = await document("stats", "--verbose");
  const exported = await document("export", "--format", "json", "--output", "-");
  const doctor = await document("doctor");

  for (const [name, answer] of Object.entries({ status, stats, export: exported, doctor })) {
    assert.equal(answer.exitCode, 0, `${name}: ${JSON.stringify(answer.document.errors)}`);
    assert.equal(answer.document.schema_version, "2", name);
    assert.notEqual(answer.document.status, "error", name);
  }
  // The prompt 0.6 recorded is still the prompt being described, not a history that started over.
  assert.equal(status.document.data.observed.prompts, 1);
  assert.equal(exported.document.data.tables.prompts.length, 1);
  assert.ok(
    doctor.document.data.checks.every(
      (/** @type {{status: string}} */ check) => check.status !== "fail",
    ),
    JSON.stringify(doctor.document.data.checks),
  );
  // Nothing was dropped on the way through. `status` records the forecast it just produced, so the
  // two prediction tables grow by exactly that one -- growing is the command working, and any other
  // table moving at all would be the upgrade losing or inventing history.
  const after = tableCounts(fixture.paths.databaseFile);
  assert.equal(after.schema_migration, (before.schema_migration ?? 0) + 4);
  assert.equal(after.prediction_attempt, (before.prediction_attempt ?? 0) + 1);
  assert.equal(after.prediction_delivery, (before.prediction_delivery ?? 0) + 1);
  const unchanged = (/** @type {Record<string, number>} */ counts) => ({
    ...counts,
    schema_migration: 0,
    prediction_attempt: 0,
    prediction_delivery: 0,
  });
  assert.deepEqual(unchanged(after), unchanged(before));
  // The forecast 0.6 showed the user is the one row the product may never restate, and it came
  // through an upgrade and four commands untouched.
  assert.deepEqual(readDeliveredForecast(fixture.paths.databaseFile), {
    prediction_attempt_id: 1,
    lower: 0.4,
    point: 0.6,
    upper: 0.8,
    risk_label: "elevated",
    evidence_level: "low",
    model_policy_version: "stage5-prediction-v2",
    delivered_at: now.toISOString(),
    channel: "stdout",
    is_primary: 1,
    prompt_execution_id: 1,
  });
  // The cursor still says where the reader stopped, so a later synchronization resumes rather than
  // re-ingesting a history that already happened.
  assert.deepEqual(readIngestionCursor(fixture.paths.databaseFile, "work"), cursorAt(2000));
});

/**
 * The configuration a 0.6 install would hold for the source `seedZeroSixDatabase` writes, so the
 * database and the configuration describe the same capacity source rather than two.
 *
 * @param {Awaited<ReturnType<typeof makeRunFixture>>} fixture
 */
async function writeZeroSixConfig(fixture) {
  await mkdir(fixture.paths.configDir, { recursive: true, mode: 0o700 });
  await writeFile(
    fixture.paths.configFile,
    `${JSON.stringify({
      schema_version: 1,
      sources: [
        {
          alias: "work",
          installation_id: "11111111-2222-4333-8444-555555555555",
          adapter: "opencode",
          database: fixture.options.env.OPENCODE_DB,
          provider: "anthropic",
          profile: "default",
          plan: "pro",
          fingerprint: "oc-sqlite-msgpart-v1",
        },
      ],
      analysis: { horizons: ["PT1H"] },
      presentation: { json: false },
    })}\n`,
    { mode: 0o600 },
  );
}

test("a database written by a newer release says so instead of blaming the migration history", async () => {
  // Running an older binary against a database a newer one already upgraded is a thing people do
  // -- a rollback, a second machine, an npm install that resolved differently. Until now it
  // produced `migration_history_mismatch`, the same answer given for a tampered or hand-edited
  // migration, which sends someone hunting for corruption that is not there. The two situations
  // are distinguishable: a stored number nobody has heard of and higher than anything available
  // means the database is ahead, not damaged.
  const { paths } = await makeStorage();
  await initializeDatabase(paths, { applicationVersion: "0.8.0", now });
  const older = await copyMigrationsThrough(11);

  await assert.rejects(
    () => initializeDatabase(paths, { migrationsDir: older, applicationVersion: "0.7.0", now }),
    (error) => {
      assert.ok(error instanceof SnackError);
      assert.equal(error.reason, "storage_newer_than_application");
      // The message has to name both numbers and where the way back is. No downgrade is offered:
      // the pre-migration backup is the only route, and it already exists.
      assert.match(error.message, /12/u);
      assert.match(error.message, /11/u);
      assert.match(error.message, /backup/iu);
      return true;
    },
  );

  // And the read-only inspection reports it rather than throwing, so `doctor` can say which of the
  // two problems this is instead of reporting storage as unreadable.
  assert.deepEqual(await inspectDatabase(paths.databaseFile, { migrationsDir: older }), {
    exists: true,
    integrity: "ok",
    migrations: "ahead",
  });
});

test("a prompt stored before the second client arrived keeps an honest unknown attribution", async () => {
  // The upgrade can only attribute a prompt when its source has one binding, because then there is
  // one client it could have come from. Where two clients already shared a source, naming either
  // one would be a guess, and a guess is worse than the gap: it would be counted as evidence about
  // a client that may never have run that prompt.
  const { paths } = await makeStorage();
  await initializeDatabase(paths, {
    migrationsDir: await copyMigrationsThrough(11),
    applicationVersion: "0.7.0",
    now,
  });
  seedZeroSixDatabase(paths.databaseFile);
  seedSecondClientOnSharedSource(paths.databaseFile);

  await initializeDatabase(paths, { applicationVersion: "0.8.0", now });

  const attributions = readAttributions(paths.databaseFile);
  // `prompt-1` sits on the shared alias and stays unknown; `prompt-2` sits on a source only one
  // client is bound to and is attributed to that client.
  assert.deepEqual(attributions, [
    { source_prompt_id: "prompt-1", installation_id: null },
    { source_prompt_id: "prompt-2", installation_id: "99999999-2222-4333-8444-555555555555" },
  ]);
});

test("a prompt the upgrade left unattributed is not claimed by a client that reused its id", async () => {
  // The gap the collision guard did not cover. On a source two clients already shared, migration
  // 012 leaves the attribution unknown by design -- and an unknown attribution used to be treated
  // as a free one: the next client to present that prompt id claimed the row and overwrote it.
  //
  // That is the same silent data loss the guard exists to stop, reached by the one path this stage
  // is actually about: an upgraded shared source.
  const { paths } = await makeStorage();
  await initializeDatabase(paths, {
    migrationsDir: await copyMigrationsThrough(11),
    applicationVersion: "0.7.0",
    now,
  });
  seedZeroSixDatabase(paths.databaseFile);
  seedSecondClientOnSharedSource(paths.databaseFile);
  await initializeDatabase(paths, { applicationVersion: "0.8.0", now });
  // Confirms the premise rather than assuming it: `prompt-1` is on the shared alias, so the upgrade
  // could not attribute it and left it NULL.
  assert.equal(readStoredPrompt(paths.databaseFile, "prompt-1").installation_id, null);

  const claudeSource = {
    alias: "work",
    installation_id: "99999999-2222-4333-8444-555555555555",
    adapter: "claude",
    provider: "anthropic",
    profile: "default",
    plan: "pro",
    fingerprint: "cc-jsonl-turntree-v1",
  };
  const counts = storeObservations(
    paths.databaseFile,
    claudeSource,
    {
      observations: [
        {
          // The other client's own prompt, which merely happens to carry the same identifier.
          source_prompt_id: "prompt-1",
          source_session_id: "claude-session",
          revision: "2026-01-02T05:00:00.000Z",
          revision_domain: "claude-uuid-v1",
          parser_version: "claude-session-v1",
          started_at: "2026-01-02T05:00:00.000Z",
          completed_at: "2026-01-02T05:00:09.000Z",
          duration_ms: 9000,
          completion: "completed",
          provider: "anthropic",
          model: "claude-opus-5",
          outcome: "success",
          usage_slices: [
            {
              source_slice_id: "slice-b",
              provider: "anthropic",
              model: "claude-opus-5",
              input_tokens: 999,
              output_tokens: 888,
              reasoning_tokens: null,
              cache_read_tokens: null,
              cache_write_tokens: null,
              cost_decimal: null,
              currency: null,
            },
          ],
          restrictions: [],
        },
      ],
      cursor: null,
    },
    now,
    {
      mappedProviders: new Set(["anthropic"]),
      providerMappingCounts: new Map([["anthropic", 1]]),
      path: "backfill",
    },
  );

  // The stored prompt is untouched: still the first client's parser, duration and usage slice.
  const stored = readStoredPrompt(paths.databaseFile, "prompt-1");
  assert.equal(stored.parser_version, "opencode-session-v1");
  assert.equal(stored.duration_ms, 1000);
  assert.equal(stored.slices, 1);
  assert.equal(stored.source_slice_id, "slice-1");
  // And it stays unattributed rather than being handed to whoever asked last.
  assert.equal(stored.installation_id, null);
  // Refused and reported, not absorbed.
  assert.equal(counts.rejected_invalid, 1);
  assert.equal(counts.updated, 0);
  assert.equal(readSpoolIssueCount(paths.databaseFile, "work"), 1);
});

/** @param {string} databaseFile @param {string} sourcePromptId */
function readStoredPrompt(databaseFile, sourcePromptId) {
  const database = new Database(databaseFile, { readonly: true });
  try {
    return /** @type {Record<string, unknown>} */ (
      database
        .prepare(
          `SELECT prompt_execution.installation_id, prompt_execution.parser_version,
                  prompt_execution.duration_ms,
                  (SELECT COUNT(*) FROM prompt_usage_slice
                    WHERE prompt_execution_id = prompt_execution.id) AS slices,
                  (SELECT source_slice_id FROM prompt_usage_slice
                    WHERE prompt_execution_id = prompt_execution.id) AS source_slice_id
             FROM prompt_execution
            WHERE source_prompt_id = ?`,
        )
        .get(sourcePromptId)
    );
  } finally {
    database.close();
  }
}

/**
 * Add a second client bound to the same capacity source, plus a source only one client feeds, so
 * the upgrade has both an ambiguous and an unambiguous case to decide.
 *
 * @param {string} databaseFile
 */
function seedSecondClientOnSharedSource(databaseFile) {
  const database = new Database(databaseFile);
  try {
    database.pragma("foreign_keys = ON");
    database.exec(`
      INSERT INTO client_installation (id, client_kind, local_fingerprint, created_at, last_seen_at)
        VALUES ('99999999-2222-4333-8444-555555555555', 'claude', 'fingerprint-2',
                '${now.toISOString()}', '${now.toISOString()}');
      INSERT INTO source_binding (source_alias, installation_id, adapter, provider, profile)
        VALUES ('work', '99999999-2222-4333-8444-555555555555', 'claude', 'anthropic', 'default');
      INSERT INTO capacity_source (alias, created_at) VALUES ('personal', '${now.toISOString()}');
      INSERT INTO source_binding (source_alias, installation_id, adapter, provider, profile)
        VALUES ('personal', '99999999-2222-4333-8444-555555555555', 'claude', 'anthropic',
                'default');
      INSERT INTO capacity_period (id, source_alias, provider, profile, plan, started_at)
        VALUES (2, 'personal', 'anthropic', 'default', 'pro', '${now.toISOString()}');
      INSERT INTO prompt_execution
          (id, source_alias, capacity_period_id, source_prompt_id, source_session_fingerprint,
           source_revision, observation_hash, revision_domain, parser_version, started_at,
           completed_at, duration_ms, completion, first_observed_at, last_observed_at)
        VALUES (2, 'personal', 2, 'prompt-2', 'session-hash-2', '1', 'hash-2', 'claude-uuid-v1',
                'cc-jsonl-turntree-v1', '2026-01-02T02:00:00.000Z', '2026-01-02T02:00:01.000Z',
                1000, 'completed', '${now.toISOString()}', '${now.toISOString()}');
    `);
  } finally {
    database.close();
  }
}

/** @param {string} databaseFile */
function readAttributions(databaseFile) {
  const database = new Database(databaseFile, { readonly: true });
  try {
    return database
      .prepare(
        "SELECT source_prompt_id, installation_id FROM prompt_execution ORDER BY source_prompt_id",
      )
      .all();
  } finally {
    database.close();
  }
}

/**
 * Fill a database at the 0.6 schema with one of every row an upgrade has to preserve, including
 * the two tables migration 010 rebuilds from scratch and the cursor columns it supersedes.
 *
 * @param {string} databaseFile
 */
function seedZeroSixDatabase(databaseFile) {
  const database = new Database(databaseFile);
  try {
    database.pragma("foreign_keys = ON");
    database.exec(`
      INSERT INTO capacity_source (alias, created_at) VALUES ('work', '${now.toISOString()}');
      INSERT INTO client_installation (id, client_kind, local_fingerprint, created_at, last_seen_at)
        VALUES ('11111111-2222-4333-8444-555555555555', 'opencode', 'fingerprint-1',
                '${now.toISOString()}', '${now.toISOString()}');
      INSERT INTO source_binding (source_alias, installation_id, adapter, provider, profile)
        VALUES ('work', '11111111-2222-4333-8444-555555555555', 'opencode', 'anthropic', 'default');
      INSERT INTO ambiguous_profile_mapping
          (installation_id, source_prompt_id, provider, model, first_seen_at)
        VALUES ('11111111-2222-4333-8444-555555555555', 'prompt-9', 'anthropic', 'claude-sonnet',
                '${now.toISOString()}');
      INSERT INTO pending_spool_observation
          (installation_id, source_prompt_id, provider, revision, observation_json, first_seen_at)
        VALUES ('11111111-2222-4333-8444-555555555555', 'prompt-8', 'anthropic', '1', '{}',
                '${now.toISOString()}');
      INSERT INTO capacity_period (id, source_alias, provider, profile, plan, started_at)
        VALUES (1, 'work', 'anthropic', 'default', 'pro', '${now.toISOString()}');
      INSERT INTO prompt_execution
          (id, source_alias, capacity_period_id, source_prompt_id, source_session_fingerprint,
           source_revision, observation_hash, revision_domain, parser_version, started_at,
           completed_at, duration_ms, completion, first_observed_at, last_observed_at)
        VALUES (1, 'work', 1, 'prompt-1', 'session-hash', '1', 'hash-1', 'opencode-message-v1',
                'opencode-session-v1', '2026-01-02T01:00:00.000Z', '2026-01-02T01:00:01.000Z',
                1000, 'completed', '${now.toISOString()}', '${now.toISOString()}');
      INSERT INTO prompt_usage_slice
          (prompt_execution_id, source_slice_id, provider, model, input_tokens, output_tokens,
           reasoning_tokens, cache_read_tokens, cache_write_tokens, cost_decimal, currency)
        VALUES (1, 'slice-1', 'anthropic', 'claude-sonnet', 10, 20, NULL, 30, 40, '0.01', 'USD');
      INSERT INTO prompt_source_outcome (prompt_execution_id, outcome, policy_version)
        VALUES (1, 'restricted', 'stage2-outcome-v1');
      INSERT INTO restriction_observation
          (prompt_execution_id, class, source_code, observed_at, classifier_version, provenance)
        VALUES (1, 'rate_limit', 'http_429', '2026-01-02T01:00:01.000Z', 'opencode-error-v1',
                'backfill');
      INSERT INTO ingestion_cursor
          (source_alias, fingerprint, time_updated, message_id, committed_at)
        VALUES ('work', 'oc-sqlite-msgpart-v1', 2000, 'message-2000', '${now.toISOString()}');
      -- A forecast the user was actually shown, the record that it was shown, and the outcome it
      -- was later scored against. These are the snapshots the migration baseline promises to
      -- preserve, and they are the rows an upgrade can least afford to lose: they are immutable by
      -- trigger precisely because a forecast the user saw cannot be rewritten afterwards, so a
      -- migration that dropped them would destroy the only record of what was promised.
      INSERT INTO prediction_attempt
          (id, source_alias, capacity_period_id, generated_at, method_id, method_version,
           model_policy_version, risk_policy_version, evidence_policy_version, weight_policy_version,
           analytics_policy_version, category_policy_version, lower, point, upper, coverage_target,
           risk_label, evidence_level, expected_size_category, backoff_level, pressure_band,
           pressure_score, pressure_contributors_json, plan_profile_id, plan_profile_version,
           data_as_of, completeness)
        VALUES (1, 'work', 1, '${now.toISOString()}', 'bayesian-pressure-band', '1',
                'stage5-prediction-v2', 'stage5-risk-v1', 'stage5-evidence-v1', 'stage5-weight-v1',
                'stage4-analytics-v1', 'stage6-category-v1', 0.4, 0.6, 0.8, 0.8, 'elevated', 'low',
                'typical', 'band', 'moderate', 0.5, NULL, 'generic', '1.0.0',
                '${now.toISOString()}', 'complete');
      INSERT INTO prediction_delivery
          (prediction_attempt_id, delivered_at, channel, format, invocation_id)
        VALUES (1, '${now.toISOString()}', 'stdout', 'human', 'invocation-1');
      INSERT INTO prediction_evaluation
          (prediction_attempt_id, prompt_execution_id, linked_at, is_primary, policy_version)
        VALUES (1, 1, '${now.toISOString()}', 1, 'stage5-evaluation-v1');
    `);
  } finally {
    database.close();
  }
}

/**
 * Copy the released migrations up to a version, so an older database can be built to upgrade from.
 *
 * @param {number} through
 */
async function copyMigrationsThrough(through) {
  const root = await mkdtemp(join(tmpdir(), "snack-storage-baseline-"));
  temporaryRoots.push(root);
  const directory = join(root, "migrations");
  await mkdir(directory, { mode: 0o700 });
  for (const name of (await readdir(migrationDirectory)).sort()) {
    if (Number(name.slice(0, 3)) > through) continue;
    await writeFile(join(directory, name), await readFile(join(migrationDirectory, name), "utf8"));
  }
  return directory;
}

/**
 * Count the rows of every table the database holds, so an upgrade can be compared against them.
 *
 * @param {string} databaseFile
 */
function tableCounts(databaseFile) {
  const database = new Database(databaseFile, { readonly: true });
  try {
    const tables = /** @type {{name: string}[]} */ (
      database
        .prepare(
          "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
        )
        .all()
    );
    return Object.fromEntries(
      tables.map((table) => [
        table.name,
        Number(
          /** @type {{total: number}} */ (
            database.prepare(`SELECT COUNT(*) AS total FROM "${table.name}"`).get()
          ).total,
        ),
      ]),
    );
  } finally {
    database.close();
  }
}

/** @param {string} databaseFile */
function seedSource(databaseFile) {
  const database = new Database(databaseFile);
  try {
    database.pragma("foreign_keys = ON");
    database
      .prepare("INSERT INTO capacity_source (alias, created_at) VALUES ('work', ?)")
      .run(now.toISOString());
  } finally {
    database.close();
  }
}

/** @param {string} databaseFile */
function configuredSource(databaseFile) {
  return {
    alias: "work",
    installation_id: "11111111-2222-4333-8444-555555555555",
    adapter: /** @type {"opencode"} */ ("opencode"),
    database: databaseFile,
    provider: "anthropic",
    profile: "default",
    plan: "pro",
    fingerprint: "oc-sqlite-msgpart-v1",
  };
}

/** @param {number} id @param {string} startedAt @returns {import("../src/storage.js").Observation} */
function observation(id, startedAt) {
  return {
    source_prompt_id: `prompt-${id}`,
    source_session_id: "session-1",
    revision: "1",
    revision_domain: "opencode-message-v1",
    parser_version: "opencode-session-v1",
    started_at: startedAt,
    completed_at: startedAt,
    duration_ms: 1000,
    completion: "completed",
    outcome: "success",
    provider: "anthropic",
    model: "claude-sonnet",
    usage_slices: [],
    restrictions: [],
  };
}
