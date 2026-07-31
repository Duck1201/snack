import assert from "node:assert/strict";
import { mkdir, mkdtemp, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, test } from "node:test";

import Database from "better-sqlite3";

import { SnackError } from "../src/errors.js";
import { resolvePaths } from "../src/paths.js";
import {
  createSetupDatabaseBackup,
  initializeDatabase,
  inspectDatabase,
  readIngestionCursor,
  restoreSetupDatabaseBackup,
  storeObservations,
} from "../src/storage.js";

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
