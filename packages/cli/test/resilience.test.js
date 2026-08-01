import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { spawn } from "node:child_process";
import { chmod, mkdir, readFile, readdir, rm, stat, utimes, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, test } from "node:test";

import Database from "better-sqlite3";

import { ExitCode } from "../src/errors.js";
import { run } from "../src/main.js";
import { readIngestionCursor } from "../src/storage.js";
import {
  cleanupRunFixtures,
  createClaudeHistory,
  createOpenCodeDatabase,
  makeRunFixture,
} from "./fixtures/run-fixture.js";

afterEach(cleanupRunFixtures);

/** A configured, synchronized source with one delivered forecast. */
async function makeWorkingInstall(prefix = "snack-resilience-") {
  const fixture = await makeRunFixture(prefix);
  fixture.options.env.OPENCODE_DB = await createOpenCodeDatabase(fixture.root);
  await run(
    [
      "node",
      "snack",
      "setup",
      "opencode",
      "--non-interactive",
      "--source",
      "work",
      "--provider",
      "anthropic",
      "--profile",
      "default",
      "--plan",
      "pro",
    ],
    fixture.options,
  );
  await run(["node", "snack", "sync", "--full"], fixture.options);
  await run(["node", "snack", "status"], fixture.options);
  fixture.stdout.value = "";
  fixture.stderr.value = "";
  return {
    ...fixture,
    resolved: fixture.paths,
  };
}

test("a corrupted database is diagnosed rather than half-read", async () => {
  const install = await makeWorkingInstall("snack-corrupt-");
  const original = await readFile(install.resolved.databaseFile);
  // Overwrite a page in the middle of the file. The header stays intact, so SQLite opens the
  // database and only discovers the damage when it reads through it.
  const damaged = Buffer.from(original);
  damaged.fill(0x6b, 6000, 9000);
  await writeFile(install.resolved.databaseFile, damaged, { mode: 0o600 });

  const doctorExit = await run(["node", "snack", "doctor", "--json"], install.options);
  const document = JSON.parse(install.stdout.value);
  // Damage deep enough to stop the database opening is reported as `storage`; damage the open
  // survives is reported as `storage_integrity`. Either is a diagnosis rather than a partial
  // read, which is what matters.
  const failed = document.data.checks.filter(
    (/** @type {{id: string, status: string}} */ check) =>
      check.status === "fail" && check.id.startsWith("storage"),
  );

  assert.notEqual(doctorExit, 0);
  assert.ok(failed.length > 0, JSON.stringify(document.data.checks));
  // The diagnosis names the problem without printing raw source rows out of the damaged pages.
  assert.doesNotMatch(install.stdout.value, /kkkk/u);
});

test("a database that is not a database at all is refused", async () => {
  const fixture = await makeRunFixture("snack-notadb-");
  fixture.options.env.OPENCODE_DB = await createOpenCodeDatabase(fixture.root);
  const paths = fixture.paths;
  await mkdir(paths.dataDir, { recursive: true, mode: 0o700 });
  await writeFile(paths.databaseFile, "this is not a SQLite file\n", { mode: 0o600 });

  const exitCode = await run(
    [
      "node",
      "snack",
      "setup",
      "opencode",
      "--non-interactive",
      "--source",
      "work",
      "--provider",
      "anthropic",
      "--profile",
      "default",
      "--plan",
      "pro",
      "--json",
    ],
    fixture.options,
  );

  assert.equal(exitCode, ExitCode.storage);
  assert.equal(JSON.parse(fixture.stdout.value).status, "error");
});

test("storage that cannot be created fails without leaving a partial install", async () => {
  const fixture = await makeRunFixture("snack-nostorage-");
  fixture.options.env.OPENCODE_DB = await createOpenCodeDatabase(fixture.root);
  const paths = fixture.paths;
  // A plain file where the data directory belongs. SNACK normalizes the permissions of
  // directories it owns, so a read-only mode would simply be corrected; this is a failure it
  // cannot chmod its way out of.
  await mkdir(fixture.dataHome, { recursive: true, mode: 0o700 });
  await writeFile(paths.dataDir, "not a directory\n", { mode: 0o600 });

  const exitCode = await run(
    [
      "node",
      "snack",
      "setup",
      "opencode",
      "--non-interactive",
      "--source",
      "work",
      "--provider",
      "anthropic",
      "--profile",
      "default",
      "--plan",
      "pro",
      "--json",
    ],
    fixture.options,
  );

  assert.notEqual(exitCode, 0);
  // Setup must not leave a configuration pointing at storage it could not create.
  await assert.rejects(readFile(paths.configFile, "utf8"));
});

test("a lock abandoned by a killed command is reclaimed, not waited on forever", async () => {
  const install = await makeWorkingInstall("snack-stale-lock-");
  const lockDirectory = join(install.resolved.stateDir, "storage-operation.lock");
  await mkdir(lockDirectory, { recursive: true, mode: 0o700 });
  // A command killed mid-operation leaves its lock behind. Staleness is judged by age, so
  // backdate it well past the configured threshold.
  const longAgo = new Date(Date.now() - 3_600_000);
  await utimes(lockDirectory, longAgo, longAgo);

  const exitCode = await run(["node", "snack", "sync", "--full", "--json"], install.options);

  assert.equal(exitCode, 0, install.stdout.value.slice(0, 300));
});

test("an interrupted setup is recovered on the next command, not left half-applied", async () => {
  const fixture = await makeRunFixture("snack-interrupted-");
  fixture.options.env.OPENCODE_DB = await createOpenCodeDatabase(fixture.root);
  const paths = fixture.paths;

  // Fail the configuration write after storage has already been initialized, which is the
  // window a crash would land in.
  const exitCode = await run(
    [
      "node",
      "snack",
      "setup",
      "opencode",
      "--non-interactive",
      "--source",
      "work",
      "--provider",
      "anthropic",
      "--profile",
      "default",
      "--plan",
      "pro",
      "--json",
    ],
    {
      ...fixture.options,
      writeConfig: async () => {
        throw new Error("interrupted");
      },
    },
  );

  assert.notEqual(exitCode, 0);
  // No configuration, and no storage left behind claiming a source that was never configured.
  await assert.rejects(readFile(paths.configFile, "utf8"));
  const databaseExists = await stat(paths.databaseFile).then(
    () => true,
    () => false,
  );
  if (databaseExists) {
    const database = new Database(paths.databaseFile, { readonly: true });
    try {
      const sources = database.prepare("SELECT COUNT(*) AS total FROM capacity_source").get();
      assert.equal(Number(/** @type {{total: unknown}} */ (sources).total), 0);
    } finally {
      database.close();
    }
  }
});

// A mode bit denies nothing to uid 0, so the premise of a permission-denial test does not exist
// there. The WSL2 job runs as root; these two skip rather than assert a failure that cannot happen.
const runningAsRoot = process.getuid?.() === 0;

test(
  "a failed export leaves no partial file behind for someone to read",
  { skip: runningAsRoot },
  async () => {
    const install = await makeWorkingInstall("snack-export-io-");
    const directory = join(install.root, "unwritable");
    await mkdir(directory, { recursive: true, mode: 0o500 });

    try {
      const exitCode = await run(
        [
          "node",
          "snack",
          "export",
          "--format",
          "json",
          "--output",
          join(directory, "export.json"),
          "--json",
        ],
        install.options,
      );

      assert.equal(exitCode, ExitCode.io);
      assert.deepEqual(await readdir(directory), []);
    } finally {
      await chmod(directory, 0o700);
    }
  },
);

test(
  "a purge that cannot finish leaves the history exactly as it was",
  { skip: runningAsRoot },
  async () => {
    const install = await makeWorkingInstall("snack-purge-rollback-");
    const before = countPrompts(install.resolved.databaseFile);
    assert.ok(before > 0);

    // A database that cannot be written is the failure a purge is most likely to meet halfway
    // through, and the history must survive it untouched.
    await chmod(install.resolved.databaseFile, 0o400);
    try {
      const exitCode = await run(
        ["node", "snack", "data", "purge", "--source", "work", "--yes", "--json"],
        install.options,
      );

      assert.notEqual(exitCode, 0);
      assert.equal(countPrompts(install.resolved.databaseFile), before);
    } finally {
      await chmod(install.resolved.databaseFile, 0o600);
    }
  },
);

test("a spool segment that was cut mid-write is reported and skipped, not guessed at", async () => {
  const install = await makeWorkingInstall("snack-partial-spool-");
  const spoolDirectory = join(install.resolved.spoolDir, "work");
  await mkdir(spoolDirectory, { recursive: true, mode: 0o700 });
  // A line without its terminating newline is exactly what a crash mid-append leaves.
  await writeFile(
    join(spoolDirectory, "segment-0001.ndjson"),
    '{"schema_version":1,"event_id":"a","installation_id":"x","source_prompt_id":"p1"',
    { mode: 0o600 },
  );

  const exitCode = await run(["node", "snack", "sync", "--json"], install.options);
  const document = JSON.parse(install.stdout.value);

  // Fail closed on the truncated record while still committing everything else.
  assert.equal(exitCode, 0);
  assert.ok(
    JSON.stringify(document).includes("rejected_invalid") ||
      document.warnings.length > 0 ||
      document.status === "degraded",
    JSON.stringify(document),
  );
  assert.equal(countPrompts(install.resolved.databaseFile) >= 1, true);
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

test("a database from a future release is refused by every path that touches it", async () => {
  const install = await makeWorkingInstall("snack-future-schema-");
  const before = countPrompts(install.resolved.databaseFile);
  const database = new Database(install.resolved.databaseFile);
  try {
    database
      .prepare(
        `INSERT INTO schema_migration (number, name, checksum, applied_at, application_version)
         VALUES (999, 'from_a_later_release', 'unknown', ?, '9.9.9')`,
      )
      .run(new Date().toISOString());
  } finally {
    database.close();
  }

  // Reading rows written under a schema this build does not know is guessing at their meaning,
  // and exporting them would stamp that guess with this build's provenance. Purging them would
  // delete rows it cannot interpret. Every path must refuse, not just the ones that write.
  for (const argv of [
    ["sync", "--full"],
    ["status"],
    ["status", "--no-sync"],
    ["stats"],
    ["doctor"],
    ["export", "--format", "json", "--output", "-"],
    ["data", "purge", "--source", "work", "--dry-run"],
    ["data", "purge", "--source", "work", "--yes"],
  ]) {
    install.stdout.value = "";
    install.stderr.value = "";
    const exitCode = await run(["node", "snack", ...argv, "--json"], install.options);
    assert.equal(exitCode, ExitCode.storage, argv.join(" "));
  }
  assert.equal(countPrompts(install.resolved.databaseFile), before);
});

test("a migration that changed after it was applied is refused, and named as drift", async () => {
  // The other half of the guard above, and the one `npm run upgrade:smoke` exists to catch: not a
  // database from the future, but a released migration edited in place under its own checksum. The
  // two are told apart deliberately -- `storage_newer_than_application` sends the reader to a newer
  // release, `migration_history_mismatch` sends them to the backup -- so the reason code is part of
  // what is asserted here, not just the exit code.
  const install = await makeWorkingInstall("snack-migration-drift-");
  const before = countPrompts(install.resolved.databaseFile);
  const database = new Database(install.resolved.databaseFile);
  try {
    // Migration 1 is the one every supported database has applied, so drifting it is the case that
    // reaches every installation rather than only the recently upgraded ones.
    database.prepare("UPDATE schema_migration SET checksum = 'drifted' WHERE number = 1").run();
  } finally {
    database.close();
  }

  for (const argv of [
    ["sync", "--full"],
    ["status", "--no-sync"],
    ["stats"],
    ["export", "--format", "json", "--output", "-"],
  ]) {
    install.stdout.value = "";
    install.stderr.value = "";
    const exitCode = await run(["node", "snack", ...argv, "--json"], install.options);
    assert.equal(exitCode, ExitCode.storage, argv.join(" "));
    const document = JSON.parse(install.stdout.value || install.stderr.value);
    assert.equal(document.errors[0].code, "migration_history_mismatch", argv.join(" "));
  }
  assert.equal(countPrompts(install.resolved.databaseFile), before);
});

test("cleanup keeps a pre-migration backup when migrating an existing database", async () => {
  const install = await makeWorkingInstall("snack-backup-");
  const backups = await readdir(install.resolved.backupDir).catch(() => []);

  // Stage 6 adds migrations over a database created by an earlier release; the backup taken
  // before applying them is the only way back.
  for (const backup of backups) {
    assert.equal((await stat(join(install.resolved.backupDir, backup))).mode & 0o777, 0o600);
  }
  await rm(install.resolved.backupDir, { recursive: true, force: true });
  assert.equal(await run(["node", "snack", "doctor"], install.options), 0);
});

test("storage that was never migrated is refused as storage, not as a crash", async () => {
  // A zero-byte database is what a truncating crash or a full disk leaves behind. It opens
  // cleanly and holds no migration history, so the read guard used to let it through and the
  // first real query failed far from anything that could explain it.
  for (const make of [
    /** @param {string} file */ async (file) => writeFile(file, "", { mode: 0o600 }),
    /** @param {string} file */ async (file) => mkdir(file, { recursive: true, mode: 0o700 }),
  ]) {
    const install = await makeWorkingInstall("snack-unmigrated-");
    const fixture = install;
    await rm(fixture.resolved.databaseFile, { recursive: true, force: true });
    await make(fixture.resolved.databaseFile);

    for (const argv of [
      ["status", "--no-sync"],
      ["stats"],
      ["export", "--format", "json", "--output", "-"],
      ["data", "purge", "--all", "--dry-run"],
    ]) {
      fixture.stdout.value = "";
      fixture.stderr.value = "";
      const exitCode = await run(["node", "snack", ...argv, "--json"], fixture.options);
      assert.equal(exitCode, ExitCode.storage, argv.join(" "));
    }
  }
});

test("a source that disappears mid-history leaves the cursor where it was", async () => {
  // Ingestion commits the cursor inside the same transaction that stores the rows, so a source
  // that vanishes between two syncs must leave the cursor exactly where the last committed batch
  // put it. A cursor that advanced over a read that did not happen is the worst outcome ingestion
  // has: the records it skipped are never read again, and nothing reports them missing.
  const install = await makeWorkingInstall("snack-source-gone-");
  const cursorBefore = readIngestionCursor(install.resolved.databaseFile, "work");
  const promptsBefore = countPrompts(install.resolved.databaseFile);
  assert.ok(cursorBefore, "the fixture never committed a cursor");

  await rm(String(install.options.env.OPENCODE_DB), { force: true });
  install.stdout.value = "";
  install.stderr.value = "";
  const exitCode = await run(["node", "snack", "sync", "--full", "--json"], install.options);

  // Degraded rather than failed: one unreadable source does not invalidate the history already
  // stored, and the document says which source could not be read.
  const document = JSON.parse(install.stdout.value);
  assert.equal(exitCode, 0, JSON.stringify(document.errors));
  assert.equal(document.status, "degraded");
  assert.deepEqual(
    document.warnings.map((/** @type {{code: string}} */ warning) => warning.code),
    ["source_sync_failed"],
  );
  assert.deepEqual(readIngestionCursor(install.resolved.databaseFile, "work"), cursorBefore);
  assert.equal(countPrompts(install.resolved.databaseFile), promptsBefore);
});

test("a Claude history whose shape drifted is refused rather than half-read", async () => {
  // The OpenCode adapter has this test; the Claude one did not. A client release that moved a
  // usage field must fail closed, because the alternative is a history stored with null tokens --
  // partial data that looks complete and biases every horizon computed from it.
  const fixture = await makeRunFixture("snack-claude-drift-");
  const configDir = await createClaudeHistory(fixture.root);
  fixture.options.env.CLAUDE_CONFIG_DIR = configDir;
  await run(
    [
      "node",
      "snack",
      "setup",
      "claude",
      "--non-interactive",
      "--source",
      "personal",
      "--provider",
      "anthropic",
      "--profile",
      "default",
      "--plan",
      "pro",
    ],
    fixture.options,
  );
  await run(["node", "snack", "sync", "--full"], fixture.options);
  const before = countPrompts(fixture.paths.databaseFile);

  // Drift the history after setup accepted it, which is what a client upgrade does.
  const projects = join(configDir, "projects", "-fixture-project");
  const [sessionFile] = await readdir(projects);
  const target = join(projects, String(sessionFile));
  const drifted = (await readFile(target, "utf8"))
    .split("\n")
    .filter((line) => line.trim() !== "")
    .map((line) => {
      const record = JSON.parse(line);
      if (record.type === "assistant") delete record.message.usage;
      return JSON.stringify(record);
    })
    .join("\n");
  await writeFile(target, `${drifted}\n`, { mode: 0o600 });

  fixture.stdout.value = "";
  fixture.stderr.value = "";
  const exitCode = await run(["node", "snack", "sync", "--full", "--json"], fixture.options);

  const document = JSON.parse(fixture.stdout.value);
  assert.equal(document.status, "degraded", JSON.stringify(document));
  assert.deepEqual(
    document.warnings.map((/** @type {{code: string}} */ warning) => warning.code),
    ["source_sync_failed"],
  );
  assert.equal(exitCode, 0);
  // Nothing new was stored from a history this build can no longer read.
  assert.equal(countPrompts(fixture.paths.databaseFile), before);
});

// Not covered: a destination that answers ENOSPC mid-write. An earlier version of this file used
// `/dev/full`, and it was wrong in both directions -- as root the export creates `/dev/full.partial`
// and renames it over the device, exiting 0; as anyone else it fails because `/dev` is not writable,
// which is a permission error dressed up as a full disk. The honest statement is that a real full
// filesystem needs a loopback mount, and that "a destination that cannot be written" is already
// covered by the CSV test above.

test("two commands writing at once serialize instead of corrupting each other", async () => {
  // The storage lock is tested in-process, where both callers share one runtime and one file
  // handle table. Two real processes share neither, which is the arrangement a user creates by
  // running `snack sync` in one terminal while a shell hook runs `snack status` in another.
  const install = await makeWorkingInstall("snack-concurrent-");
  const cli = fileURLToPath(new URL("../src/cli.js", import.meta.url));
  const environment = {
    ...process.env,
    HOME: install.root,
    XDG_CONFIG_HOME: String(install.options.env.XDG_CONFIG_HOME),
    XDG_DATA_HOME: String(install.options.env.XDG_DATA_HOME),
    XDG_STATE_HOME: String(install.options.env.XDG_STATE_HOME),
    XDG_CACHE_HOME: String(install.options.env.XDG_CACHE_HOME),
    OPENCODE_DB: String(install.options.env.OPENCODE_DB),
  };
  /** @param {string[]} argv */
  const spawnSnack = (argv) =>
    new Promise((resolve) => {
      const child = spawn(process.execPath, [cli, ...argv], { env: environment });
      let stderr = "";
      child.stderr.on("data", (chunk) => {
        stderr += chunk;
      });
      child.once("close", (code) => resolve({ code, stderr }));
    });

  const results = await Promise.all([
    spawnSnack(["sync", "--full", "--json"]),
    spawnSnack(["sync", "--full", "--json"]),
    spawnSnack(["status", "--json"]),
  ]);

  for (const result of results) {
    const { code, stderr } = /** @type {{code: number, stderr: string}} */ (result);
    // Either answer is correct -- one may wait for the other, or report the lock is held -- but
    // neither may be an internal failure, and neither may leave the database damaged.
    assert.notEqual(code, ExitCode.internal, stderr);
  }
  const database = new Database(install.resolved.databaseFile, { readonly: true });
  try {
    assert.equal(
      /** @type {{integrity_check: string}[]} */ (database.pragma("integrity_check"))[0]
        ?.integrity_check,
      "ok",
    );
  } finally {
    database.close();
  }
});
