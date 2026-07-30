import assert from "node:assert/strict";
import { mkdir, mkdtemp, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, test } from "node:test";

import Database from "better-sqlite3";

import { SnackError } from "../src/errors.js";
import { initializeDatabase, inspectDatabase } from "../src/storage.js";

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
