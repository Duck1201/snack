import assert from "node:assert/strict";
import { afterEach, test } from "node:test";

import Database from "better-sqlite3";

import { run } from "../src/main.js";
import { resolvePaths } from "../src/paths.js";
import { purgeScope } from "../src/storage.js";
import {
  cleanupRunFixtures,
  createOpenCodeDatabase,
  makeRunFixture,
} from "./fixtures/run-fixture.js";

afterEach(cleanupRunFixtures);

/** A synchronized source carrying one prompt and one delivered forecast. */
async function makePurgeableHistory() {
  const fixture = await makeRunFixture("snack-purge-");
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
    resolved: resolvePaths({ env: fixture.options.env, platform: "linux", home: fixture.root }),
  };
}

/** @param {string} databaseFile @param {string} table */
function count(databaseFile, table) {
  const database = new Database(databaseFile, { readonly: true });
  try {
    const row = /** @type {{total?: unknown}} */ (
      database.prepare(`SELECT COUNT(*) AS total FROM ${table}`).get()
    );
    return Number(row?.total ?? -1);
  } finally {
    database.close();
  }
}

test("purging a source removes its prompts and the forecasts recorded against it", async () => {
  const fixture = await makePurgeableHistory();
  const { databaseFile } = fixture.resolved;
  assert.equal(count(databaseFile, "prompt_execution"), 1);
  assert.equal(count(databaseFile, "prediction_attempt"), 1);
  assert.equal(count(databaseFile, "prediction_delivery"), 1);

  const result = await purgeScope(fixture.resolved, { source: "work" }, { now: new Date() });

  // Prediction attempts are immutable to every other code path, and purge is the one
  // deliberate exception the specification names: the command must delete exactly the scope
  // it previewed, snapshots included.
  assert.equal(count(databaseFile, "prompt_execution"), 0);
  assert.equal(count(databaseFile, "prediction_attempt"), 0);
  assert.equal(count(databaseFile, "prediction_delivery"), 0);
  assert.equal(count(databaseFile, "prompt_usage_slice"), 0);
  assert.equal(count(databaseFile, "prompt_source_outcome"), 0);
  assert.equal(result.counts.prompts, 1);
  assert.equal(result.counts.predictions, 1);
});

test("prediction attempts stay immutable outside a purge", async () => {
  const fixture = await makePurgeableHistory();
  const database = new Database(fixture.resolved.databaseFile);
  try {
    // Relaxing the trigger for purge must not relax it for anything else, including a direct
    // write from another connection while a purge is running elsewhere.
    assert.throws(() => database.prepare("DELETE FROM prediction_attempt").run(), /immutable/u);
    assert.throws(
      () => database.prepare("UPDATE prediction_attempt SET risk_label = 'low'").run(),
      /immutable/u,
    );
  } finally {
    database.close();
  }
});

test("a dry run previews the same shape it would apply, and changes nothing", async () => {
  const fixture = await makePurgeableHistory();
  const { databaseFile } = fixture.resolved;

  const exitCode = await run(
    ["node", "snack", "data", "purge", "--source", "work", "--dry-run", "--json"],
    fixture.options,
  );
  const preview = JSON.parse(fixture.stdout.value);
  fixture.stdout.value = "";
  await run(
    ["node", "snack", "data", "purge", "--source", "work", "--yes", "--json"],
    fixture.options,
  );
  const applied = JSON.parse(fixture.stdout.value);

  assert.equal(exitCode, 0);
  assert.equal(preview.data.dry_run, true);
  assert.equal(applied.data.dry_run, false);
  // One renderer, one contract: a preview is verifiably a preview of the real thing.
  assert.deepEqual(preview.data.counts, applied.data.counts);
  assert.deepEqual(preview.data.scope, applied.data.scope);
  assert.equal(preview.data.counts.prompts, 1);
  assert.equal(count(databaseFile, "prompt_execution"), 0);
});

test("a destructive purge is refused without confirmation", async () => {
  const fixture = await makePurgeableHistory();

  const exitCode = await run(
    ["node", "snack", "data", "purge", "--source", "work", "--json"],
    fixture.options,
  );

  // Test sinks are not a terminal, and JSON mode cannot prompt without breaking the
  // one-document contract. Both fail closed rather than deleting unasked.
  assert.equal(exitCode, 2);
  assert.equal(JSON.parse(fixture.stdout.value).errors[0].code, "confirmation_required");
  assert.equal(count(fixture.resolved.databaseFile, "prompt_execution"), 1);
});

test("purge selects exactly one source and leaves its neighbours alone", async () => {
  const fixture = await makePurgeableHistory();
  const { databaseFile } = fixture.resolved;
  // Seeded directly rather than through a second setup: both sources would read the same
  // OpenCode database with the same provider, which is an ambiguous mapping by design and
  // yields no second prompt to purge around.
  seedNeighbourSource(databaseFile, "other");
  assert.equal(count(databaseFile, "prompt_execution"), 2);

  await run(
    ["node", "snack", "data", "purge", "--source", "work", "--yes", "--json"],
    fixture.options,
  );
  const remaining = JSON.parse(fixture.stdout.value).data.counts;

  assert.equal(remaining.prompts, 1);
  assert.equal(count(databaseFile, "prompt_execution"), 1);
  assert.equal(soleSourceAlias(databaseFile), "other");
});

/** @param {string} databaseFile @param {string} alias */
function seedNeighbourSource(databaseFile, alias) {
  const database = new Database(databaseFile);
  try {
    database.pragma("foreign_keys = ON");
    database
      .prepare("INSERT INTO capacity_source (alias, created_at) VALUES (?, ?)")
      .run(alias, "2026-01-01T00:00:00.000Z");
    database
      .prepare(
        `INSERT INTO capacity_period (source_alias, provider, profile, plan, started_at)
         VALUES (?, 'openai', 'second', 'pro', '2026-01-01T00:00:00.000Z')`,
      )
      .run(alias);
    const periodId = database
      .prepare("SELECT id FROM capacity_period WHERE source_alias = ?")
      .get(alias);
    database
      .prepare(
        `INSERT INTO prompt_execution
           (source_alias, capacity_period_id, source_prompt_id, source_session_fingerprint,
            source_revision, observation_hash, revision_domain, parser_version, started_at,
            completed_at, duration_ms, completion, first_observed_at, last_observed_at)
         VALUES (?, ?, 'neighbour-1', 'session', '1', 'hash', 'opencode', 'p1',
                 '2026-01-02T03:04:05.000Z', '2026-01-02T03:04:10.000Z', 5000, 'completed',
                 '2026-01-02T03:04:05.000Z', '2026-01-02T03:04:10.000Z')`,
      )
      .run(alias, Number(/** @type {{id: unknown}} */ (periodId).id));
  } finally {
    database.close();
  }
}

/** @param {string} databaseFile */
function soleSourceAlias(databaseFile) {
  const database = new Database(databaseFile, { readonly: true });
  try {
    const row = database.prepare("SELECT DISTINCT source_alias FROM prompt_execution").get();
    return String(/** @type {{source_alias: unknown}} */ (row).source_alias);
  } finally {
    database.close();
  }
}

test("without --prevent-reimport a full synchronization restores what was purged", async () => {
  const fixture = await makePurgeableHistory();
  const { databaseFile } = fixture.resolved;

  await run(
    ["node", "snack", "data", "purge", "--source", "work", "--yes", "--json"],
    fixture.options,
  );
  assert.equal(count(databaseFile, "prompt_execution"), 0);
  await run(["node", "snack", "sync", "--full"], fixture.options);

  // Purge removes local records, not the source they came from. Saying so is the point.
  assert.equal(count(databaseFile, "prompt_execution"), 1);
});

test("--prevent-reimport survives a full synchronization, which ignores cursors", async () => {
  const fixture = await makePurgeableHistory();
  const { databaseFile } = fixture.resolved;

  await run(
    ["node", "snack", "data", "purge", "--source", "work", "--prevent-reimport", "--yes", "--json"],
    fixture.options,
  );
  fixture.stdout.value = "";
  const exitCode = await run(["node", "snack", "sync", "--full"], fixture.options);

  // A cursor policy could not do this: `--full` re-reads everything by definition. The
  // tombstone is enforced during ingestion instead.
  assert.equal(exitCode, 0);
  assert.equal(count(databaseFile, "prompt_execution"), 0);
  assert.match(fixture.stdout.value, /1 tombstoned/u);
});

test("--all covers every configured source", async () => {
  const fixture = await makePurgeableHistory();
  const { databaseFile } = fixture.resolved;
  seedNeighbourSource(databaseFile, "other");

  const exitCode = await run(
    ["node", "snack", "data", "purge", "--all", "--yes", "--json"],
    fixture.options,
  );

  assert.equal(exitCode, 0);
  assert.equal(JSON.parse(fixture.stdout.value).data.counts.prompts, 2);
  assert.equal(count(databaseFile, "prompt_execution"), 0);
});

test("purge requires exactly one of --source and --all", async () => {
  const fixture = await makePurgeableHistory();

  for (const argv of [
    ["node", "snack", "data", "purge", "--yes", "--json"],
    ["node", "snack", "data", "purge", "--all", "--source", "work", "--yes", "--json"],
  ]) {
    fixture.stdout.value = "";
    assert.equal(await run(argv, fixture.options), 2, argv.join(" "));
    assert.equal(JSON.parse(fixture.stdout.value).errors[0].code, "purge_scope_required");
  }
  assert.equal(count(fixture.resolved.databaseFile, "prompt_execution"), 1);
});

test("--include-config drops the source but leaves capture to setup to undo", async () => {
  const fixture = await makePurgeableHistory();

  const exitCode = await run(
    ["node", "snack", "data", "purge", "--source", "work", "--include-config", "--yes", "--json"],
    fixture.options,
  );
  const document = JSON.parse(fixture.stdout.value);
  fixture.stdout.value = "";
  await run(["node", "snack", "config", "get", "sources", "--json"], fixture.options);

  assert.equal(exitCode, 0);
  assert.deepEqual(JSON.parse(fixture.stdout.value).data.value, []);
  // The plugin keeps writing to the spool until setup says otherwise, and the OpenCode
  // configuration may hold credentials, so purge reports rather than edits it.
  assert.ok(
    /** @type {{code: string}[]} */ (document.warnings).some(
      (warning) => warning.code === "plugin_still_registered",
    ),
    JSON.stringify(document.warnings),
  );
});
