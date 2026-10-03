import assert from "node:assert/strict";
import { afterEach, test } from "node:test";

import Database from "better-sqlite3";

import { run } from "../src/main.js";
import {
  initializeDatabase,
  purgeScope,
  readReportedCapacity,
  storeObservations,
} from "../src/storage.js";
import {
  cleanupRunFixtures,
  createCodexHistory,
  createOpenCodeDatabase,
  makeRunFixture,
} from "./fixtures/run-fixture.js";

afterEach(cleanupRunFixtures);

/** A synchronized source carrying one prompt and one delivered forecast. */
async function makePurgeableHistory({ installPlugin = false } = {}) {
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
      ...(installPlugin ? ["--install-plugin", "--yes"] : []),
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

test("purge deletes the sequence answers recorded with the forecasts it removes", async () => {
  const fixture = await makePurgeableHistory();
  const { databaseFile } = fixture.resolved;
  await run(["node", "snack", "status", "--no-sync", "--sequence", "10"], fixture.options);
  assert.equal(count(databaseFile, "prediction_attempt"), 2);
  assert.equal(count(databaseFile, "prediction_sequence"), 1);

  const preview = await purgeScope(
    fixture.resolved,
    { source: "work" },
    { now: new Date(), preview: true },
  );
  const result = await purgeScope(fixture.resolved, { source: "work" }, { now: new Date() });

  assert.equal(count(databaseFile, "prediction_sequence"), 0);
  assert.equal(count(databaseFile, "prediction_attempt"), 0);
  // A sequence rides with its forecast: it is counted with it, not beside it, so the purge payload
  // keeps the shape `data-purge.schema.json` froze.
  assert.equal(preview.counts.predictions, 2);
  assert.equal(result.counts.predictions, 2);
  assert.deepEqual(Object.keys(result.counts).sort(), [
    "predictions",
    "prompts",
    "reported_capacity_observations",
  ]);
});

test("recorded sequence answers stay immutable outside a purge", async () => {
  const fixture = await makePurgeableHistory();
  await run(["node", "snack", "status", "--no-sync", "--sequence", "3"], fixture.options);
  const database = new Database(fixture.resolved.databaseFile);
  try {
    assert.equal(
      /** @type {{total: number}} */ (
        database.prepare("SELECT COUNT(*) AS total FROM prediction_sequence").get()
      ).total,
      1,
    );
    assert.throws(() => database.prepare("DELETE FROM prediction_sequence").run(), /immutable/u);
    assert.throws(
      () => database.prepare("UPDATE prediction_sequence SET risk_label = 'low'").run(),
      /immutable/u,
    );
  } finally {
    database.close();
  }
});

/** A Codex source whose fresh statement made `status` record a shadow beside its attempt. */
async function makeShadowHistory() {
  const fixture = await makeRunFixture("snack-purge-shadow-");
  fixture.options.env.CODEX_HOME = await createCodexHistory(fixture.root, [
    "version-0-159-3.jsonl",
    "version-0-147-0.jsonl",
  ]);
  await run(
    [
      "node",
      "snack",
      "setup",
      "codex",
      "--non-interactive",
      "--source",
      "codex",
      "--provider",
      "openai",
      "--profile",
      "default",
      "--plan",
      "plus",
    ],
    fixture.options,
  );
  await run(["node", "snack", "sync", "--full"], fixture.options);
  await run(["node", "snack", "status", "--no-sync"], fixture.options);
  return fixture;
}

test("purge deletes the shadow forecasts recorded with the attempts it removes", async () => {
  const fixture = await makeShadowHistory();
  const { databaseFile } = fixture.paths;
  assert.equal(count(databaseFile, "prediction_attempt"), 1);
  assert.equal(count(databaseFile, "prediction_reported_capacity"), 1);

  const result = await purgeScope(fixture.paths, { source: "codex" }, { now: new Date() });

  assert.equal(count(databaseFile, "prediction_reported_capacity"), 0);
  assert.equal(count(databaseFile, "prediction_attempt"), 0);
  // Counted with its attempt, as a sequence is: the purge payload keeps its frozen shape.
  assert.equal(result.counts.predictions, 1);
});

test("recorded shadow forecasts stay immutable outside a purge", async () => {
  const fixture = await makeShadowHistory();
  const database = new Database(fixture.paths.databaseFile);
  try {
    assert.throws(
      () => database.prepare("DELETE FROM prediction_reported_capacity").run(),
      /immutable/u,
    );
    assert.throws(
      () => database.prepare("UPDATE prediction_reported_capacity SET band = 'full'").run(),
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
  const fixture = await makePurgeableHistory({ installPlugin: true });

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

test("--include-config does not report a plugin that was never registered", async () => {
  // The warning told every user to run `snack setup opencode` to stop a plugin that was not
  // running. A warning nobody can act on teaches people to ignore the warnings that matter, and
  // `doctor` reported the opposite of it on the same installation.
  const fixture = await makePurgeableHistory();

  const exitCode = await run(
    ["node", "snack", "data", "purge", "--source", "work", "--include-config", "--yes", "--json"],
    fixture.options,
  );
  const document = JSON.parse(fixture.stdout.value);

  assert.equal(exitCode, 0);
  assert.ok(
    !(
      /** @type {{code: string}[]} */ (document.warnings ?? []).some(
        (warning) => warning.code === "plugin_still_registered",
      )
    ),
    JSON.stringify(document.warnings),
  );
});

test("with a terminal, purge asks for the alias typed back", async () => {
  const fixture = await makePurgeableHistory();
  /** @type {{id: string, message: string}[]} */
  const asked = [];
  /** @param {string} value */
  const answerWith =
    (value) =>
    /** @param {{id: string, message: string}} question */
    async (question) => {
      asked.push(question);
      return value;
    };

  // Specification §12.8: confirmation is the source alias typed back rather than a keystroke.
  // A terminal is exactly what `cli.js` reports by passing a prompt port at all.
  const refused = await run(["node", "snack", "data", "purge", "--source", "work"], {
    ...fixture.options,
    prompt: answerWith("nope"),
  });

  assert.equal(refused, 0);
  assert.equal(asked.length, 1);
  assert.match(asked[0]?.message ?? "", /work/u);
  assert.equal(count(fixture.resolved.databaseFile, "prompt_execution"), 1);

  fixture.stdout.value = "";
  const applied = await run(["node", "snack", "data", "purge", "--source", "work"], {
    ...fixture.options,
    prompt: answerWith("work"),
  });

  assert.equal(applied, 0);
  assert.equal(count(fixture.resolved.databaseFile, "prompt_execution"), 0);
});

test("only a purge that removes the watermark resets the ingestion cursor", async () => {
  // The fixture's single prompt is at 2026-01-02T03:04, and the cursor's watermark with it.
  // Specification §12.8 resets the cursor only when the purged range contains that watermark:
  // any other reset forces a full re-scan that changes nothing.
  for (const argv of [
    // A window that closes before the watermark deletes nothing behind it.
    ["--since", "2020-01-01T00:00:00.000Z", "--until", "2020-06-01T00:00:00.000Z"],
    // A window that opens after it deletes nothing ahead of it either.
    ["--since", "2030-01-01T00:00:00.000Z"],
  ]) {
    const fixture = await makePurgeableHistory();
    assert.equal(count(fixture.resolved.databaseFile, "ingestion_cursor"), 1);

    const exitCode = await run(
      ["node", "snack", "data", "purge", "--source", "work", "--yes", "--json", ...argv],
      fixture.options,
    );

    assert.equal(exitCode, 0, fixture.stdout.value.slice(0, 200));
    assert.equal(JSON.parse(fixture.stdout.value).data.counts.prompts, 0);
    assert.equal(
      count(fixture.resolved.databaseFile, "ingestion_cursor"),
      1,
      `a purge of nothing reset the cursor: ${argv.join(" ")}`,
    );
  }

  const fixture = await makePurgeableHistory();
  const exitCode = await run(
    ["node", "snack", "data", "purge", "--source", "work", "--yes", "--json"],
    fixture.options,
  );

  assert.equal(exitCode, 0);
  assert.equal(count(fixture.resolved.databaseFile, "ingestion_cursor"), 0);
});

const CODEX_INSTALLATION = "33333333-4444-4555-8666-777777777777";

/** @param {string} alias */
function codexSource(alias) {
  return {
    alias,
    installation_id: CODEX_INSTALLATION,
    adapter: "codex",
    provider: "openai",
    profile: "default",
    plan: "plus",
    fingerprint: "cx-rollout-usagerecord-v1",
  };
}

/** @param {number} n @param {string} observedAt */
function statedFigure(n, observedAt) {
  return {
    observation_key: n.toString(16).padStart(64, "0"),
    observed_at: observedAt,
    limit_id: "codex",
    plan_type: "plus",
    windows: [
      { window_minutes: 300, used_percent: 34, resets_at: null },
      { window_minutes: 10080, used_percent: 19, resets_at: null },
    ],
    parser_version: "codex-rate-limits-v1",
    provider: "openai",
  };
}

/**
 * @param {string} databaseFile
 * @param {string} alias
 * @param {ReturnType<typeof statedFigure>[]} reported
 */
function storeStated(databaseFile, alias, reported) {
  return storeObservations(
    databaseFile,
    codexSource(alias),
    { observations: [], cursor: null, reported_capacity: reported },
    new Date("2026-01-03T00:00:00.000Z"),
  );
}

/** A database holding stated figures for two sources, on either side of a purge window. */
async function makeStatedFigures() {
  const fixture = await makeRunFixture("snack-purge-reported-");
  await initializeDatabase(fixture.paths, { applicationVersion: "1.3.0" });
  const { databaseFile } = fixture.paths;
  storeStated(databaseFile, "codex", [
    statedFigure(1, "2026-01-01T10:00:00.000Z"),
    statedFigure(2, "2026-01-02T10:00:00.000Z"),
    statedFigure(3, "2026-01-02T23:59:59.999Z"),
  ]);
  storeStated(databaseFile, "neighbour", [statedFigure(4, "2026-01-02T10:00:00.000Z")]);
  return fixture;
}

test("purge deletes the stated figures in its window, counts them, and previews the same count", async () => {
  const fixture = await makeStatedFigures();
  const { databaseFile } = fixture.paths;
  const scope = {
    source: "codex",
    since: "2026-01-02T00:00:00.000Z",
    until: "2026-01-02T23:59:59.999Z",
  };

  const preview = await purgeScope(fixture.paths, scope, { now: new Date(), preview: true });
  assert.equal(count(databaseFile, "reported_capacity_observation"), 8);
  const result = await purgeScope(fixture.paths, scope, { now: new Date() });

  // One snapshot, two stated windows: rows are what is deleted and what is counted.
  assert.equal(preview.counts.reported_capacity_observations, 2);
  assert.deepEqual(result.counts, preview.counts);
  // The half-open window keeps its upper bound, and the neighbour keeps everything.
  assert.equal(count(databaseFile, "reported_capacity_observation"), 6);

  const all = await purgeScope(fixture.paths, {}, { now: new Date() });
  assert.equal(all.counts.reported_capacity_observations, 6);
  assert.equal(count(databaseFile, "reported_capacity_observation"), 0);
});

test("after a purge, status quotes the latest figure that is still stored", async () => {
  const fixture = await makeStatedFigures();
  const { databaseFile } = fixture.paths;
  const latest = (/** @type {string} */ alias) =>
    readReportedCapacity(databaseFile, alias).map((entry) => entry.observed_at);
  assert.deepEqual(latest("codex"), ["2026-01-02T23:59:59.999Z"]);

  // Removing the newest statement must bring the one before it back, not leave a stale pointer.
  await purgeScope(
    fixture.paths,
    { source: "codex", since: "2026-01-02T12:00:00.000Z" },
    { now: new Date() },
  );
  assert.deepEqual(latest("codex"), ["2026-01-02T10:00:00.000Z"]);
  assert.deepEqual(latest("neighbour"), ["2026-01-02T10:00:00.000Z"]);
  // A statement stored after the purge is the latest again, and an older one arriving late is not.
  storeStated(databaseFile, "codex", [
    statedFigure(5, "2026-01-02T11:00:00.000Z"),
    statedFigure(6, "2026-01-01T09:00:00.000Z"),
  ]);
  assert.deepEqual(latest("codex"), ["2026-01-02T11:00:00.000Z"]);

  await purgeScope(fixture.paths, { source: "codex" }, { now: new Date() });
  assert.deepEqual(latest("codex"), []);
  assert.deepEqual(latest("neighbour"), ["2026-01-02T10:00:00.000Z"]);
});

test("a --prevent-reimport tombstone refuses the stated figures it covers, and only those", async () => {
  const fixture = await makeStatedFigures();
  const { databaseFile } = fixture.paths;

  await purgeScope(
    fixture.paths,
    { source: "codex", until: "2026-01-02T12:00:00.000Z" },
    { now: new Date(), preventReimport: true },
  );
  assert.equal(count(databaseFile, "reported_capacity_observation"), 4);

  const again = storeStated(databaseFile, "codex", [
    statedFigure(1, "2026-01-01T10:00:00.000Z"),
    statedFigure(2, "2026-01-02T10:00:00.000Z"),
    statedFigure(3, "2026-01-02T23:59:59.999Z"),
  ]);

  // A full re-read is exactly what a tombstone exists to survive.
  assert.deepEqual(again.reported_capacity, {
    inserted: 0,
    unchanged: 1,
    rejected: 0,
    tombstoned: 2,
    pending_mapping: 0,
  });
  assert.equal(count(databaseFile, "reported_capacity_observation"), 4);
});

test("the purge payload names the stated figures it removed, beside prompts and forecasts", async () => {
  const fixture = await makePurgeableHistory();

  await run(
    ["node", "snack", "data", "purge", "--source", "work", "--dry-run", "--json"],
    fixture.options,
  );

  assert.equal(JSON.parse(fixture.stdout.value).data.counts.reported_capacity_observations, 0);
});
