import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { afterEach, test } from "node:test";

import Database from "better-sqlite3";

import { run } from "../src/main.js";
import { resolvePlanProfile } from "../src/plan-profile.js";
import { labelStatedBands, REPORTED_CAPACITY_POLICY } from "../src/reported-capacity.js";
import {
  readIngestionCursor,
  readStatedBandFrontier,
  readStatedBandProjection,
  readStatedBandRows,
  readStatedTimeline,
  storeObservations,
  writeStatedBands,
} from "../src/storage.js";
import {
  addCodexTurns,
  cleanupRunFixtures,
  createClaudeHistory,
  createCodexHistory,
  makeRunFixture,
  plantStatements,
} from "./fixtures/run-fixture.js";

afterEach(cleanupRunFixtures);

/** @param {string} alias @param {string} provider @param {string} plan */
function flags(alias, provider, plan) {
  return [
    "--non-interactive",
    "--source",
    alias,
    "--provider",
    provider,
    "--profile",
    "default",
    "--plan",
    plan,
  ];
}

/**
 * @param {Awaited<ReturnType<typeof makeRunFixture>>} fixture
 * @param {string[]} argv
 */
async function json(fixture, argv) {
  fixture.stdout.value = "";
  fixture.stderr.value = "";
  const exitCode = await run(["node", "snack", ...argv, "--json"], fixture.options);
  assert.equal(exitCode, 0, fixture.stderr.value);
  return JSON.parse(fixture.stdout.value);
}

test("status quotes what Codex stated, per installation and limit, beside the estimate", async () => {
  const fixture = await makeRunFixture("snack-codex-status-");
  fixture.options.env.CODEX_HOME = await createCodexHistory(fixture.root, [
    "version-0-159-3.jsonl",
    "version-0-147-0.jsonl",
    "restricted-usage-limit.jsonl",
  ]);
  const setup = await json(fixture, ["setup", "codex", ...flags("codex", "openai", "plus")]);

  const status = await json(fixture, ["status"]);
  const reported = status.data.reported_capacity;

  // One installation, one limit that stated a window (`premium` stated none): one entry, the latest.
  assert.equal(reported.length, 1);
  const [entry] = reported;
  assert.equal(entry.client, "codex");
  assert.equal(entry.limit_id, "codex");
  assert.equal(entry.parser_version, "codex-rate-limits-v1");
  assert.equal(entry.installation_id, setup.data.source.installation_id);
  // The fixture clock is 2026-01-02T03:04:05Z.
  assert.equal(
    entry.age_seconds,
    (Date.parse("2026-01-02T03:04:05Z") - Date.parse(entry.stated_at)) / 1000,
  );
  for (const window of entry.windows) {
    assert.equal(
      window.reset_passed,
      window.resets_at !== null &&
        Date.parse(window.resets_at) <= Date.parse("2026-01-02T03:04:05Z"),
    );
  }
});

test("a stated figure never moves the estimate, end to end", async () => {
  // The estimate-isolation property ADR-0007 rests on, asserted through the command a user runs:
  // the same history with and without its stated figures must give byte-identical viability,
  // risk, evidence, pressure, method and caveats.
  const fixture = await makeRunFixture("snack-codex-isolation-");
  fixture.options.env.CODEX_HOME = await createCodexHistory(fixture.root, [
    "version-0-159-3.jsonl",
    "version-0-147-0.jsonl",
    "restricted-reached-type.jsonl",
    "spend-control.jsonl",
  ]);
  await json(fixture, ["setup", "codex", ...flags("codex", "openai", "plus")]);
  await json(fixture, ["sync", "--full"]);

  const withFigures = await json(fixture, ["status", "--no-sync"]);
  assert.ok(withFigures.data.reported_capacity.length > 0, "no figure was stated; vacuous");

  const database = new Database(fixture.paths.databaseFile);
  try {
    const removed = database.prepare("DELETE FROM reported_capacity_observation").run();
    assert.ok(removed.changes > 0);
  } finally {
    database.close();
  }
  const withoutFigures = await json(fixture, ["status", "--no-sync"]);
  assert.deepEqual(withoutFigures.data.reported_capacity, []);

  for (const field of [
    "viability",
    "risk",
    "evidence",
    "method",
    "contributors",
    "pressure",
    "observed",
    "completeness",
    "caveats",
  ]) {
    assert.equal(
      JSON.stringify(withoutFigures.data[field]),
      JSON.stringify(withFigures.data[field]),
      `${field} moved when the stated figures were removed`,
    );
  }
  assert.equal(withFigures.status, withoutFigures.status);
});

test("a Codex source shares a capacity source with Claude Code without leaking client fields", async () => {
  const fixture = await makeRunFixture("snack-codex-shared-");
  fixture.options.env.CLAUDE_CONFIG_DIR = await createClaudeHistory(fixture.root);
  fixture.options.env.CODEX_HOME = await createCodexHistory(fixture.root);
  await json(fixture, ["setup", "claude", ...flags("work", "anthropic", "pro")]);
  await json(fixture, ["setup", "codex", ...flags("work", "openai", "pro")]);
  await json(fixture, ["sync", "--full"]);

  const status = await json(fixture, ["status", "--no-sync"]);
  // One lineage, one report, and the Codex figure beside its estimate.
  assert.equal(status.data.source.alias, "work");
  assert.equal(status.data.reported_capacity.length, 1);

  const exported = await json(fixture, ["export", "--format", "json", "--output", "-"]);
  const tables = exported.data.tables;
  assert.deepEqual(
    tables.source_bindings.map((/** @type {{adapter: string}} */ row) => row.adapter).sort(),
    ["claude", "codex"],
  );
  // Reported figures stay local in 1.3: nothing in the export names them.
  const text = JSON.stringify(exported);
  assert.doesNotMatch(text, /reported_capacity|used_percent|window_minutes/u);
  assert.equal(exported.data.export.export_schema_version, "2");
});

/** @param {Awaited<ReturnType<typeof makeRunFixture>>} fixture */
async function codexFixture(fixture) {
  fixture.options.env.CODEX_HOME = await createCodexHistory(fixture.root, [
    "version-0-159-3.jsonl",
    "version-0-147-0.jsonl",
    "restricted-usage-limit.jsonl",
  ]);
  const setup = await json(fixture, ["setup", "codex", ...flags("codex", "openai", "plus")]);
  await json(fixture, ["sync", "--full"]);
  return setup.data.source.installation_id;
}

test("the shadow is computed from a fresh statement, and the attempt recorded is the baseline's", async () => {
  const fixture = await makeRunFixture("snack-codex-shadow-");
  await codexFixture(fixture);

  const status = await json(fixture, ["status", "--no-sync", "--sequence", "10"]);
  const { shadow } = status.data;
  assert.equal(shadow.computed, true);
  assert.deepEqual(shadow.method, { id: "reported-capacity", version: "1" });
  assert.equal(shadow.model_policy_version, "reported-capacity-v1");
  assert.equal(shadow.evidence.policy_version, "reported-capacity-evidence-v1");
  assert.ok(!("used_percent" in shadow.binding), "the shadow repeats the stated figure");
  // The answer is the baseline's, and so is the sequence: `--sequence` stays baseline-only.
  assert.equal(status.data.method.id, "bayesian-pressure-band");
  assert.equal(status.data.sequence.method.id, "sequence-bayesian-pressure-band");

  const database = new Database(fixture.paths.databaseFile, { readonly: true });
  try {
    const attempt = /** @type {Record<string, unknown>} */ (
      database.prepare("SELECT * FROM prediction_attempt ORDER BY id DESC LIMIT 1").get()
    );
    assert.equal(attempt.method_id, status.data.method.id);
    assert.equal(attempt.point, status.data.viability.point);
    const row = /** @type {Record<string, unknown>} */ (
      database
        .prepare("SELECT * FROM prediction_reported_capacity WHERE prediction_attempt_id = ?")
        .get(attempt.id)
    );
    assert.equal(row.method_id, "reported-capacity");
    assert.equal(row.lower, shadow.viability.lower);
    assert.equal(row.point, shadow.viability.point);
    assert.equal(row.upper, shadow.viability.upper);
    assert.equal(row.risk_label, shadow.risk.label);
    assert.equal(row.evidence_level, shadow.evidence.level);
    assert.equal(row.backoff_level, shadow.contributors.backoff_level);
    assert.equal(row.window_minutes, shadow.binding.window_minutes);
    assert.equal(row.stated_at, shadow.binding.stated_at);
    assert.equal(row.band, shadow.binding.band);
    // The stored figure is the one Codex stated for the binding window, kept for calibration.
    const stated = status.data.reported_capacity[0].windows.find(
      (/** @type {{window_minutes: number}} */ window) =>
        window.window_minutes === shadow.binding.window_minutes,
    );
    assert.equal(row.used_percent, stated.used_percent);
  } finally {
    database.close();
  }
});

test("a statement more than six hours old binds nothing, and nothing is recorded beside the attempt", async () => {
  const fixture = await makeRunFixture("snack-codex-stale-");
  await codexFixture(fixture);
  const fresh = await json(fixture, ["status", "--no-sync"]);
  const statedAt = Date.parse(fresh.data.shadow.binding.stated_at);

  // Exactly six hours after the statement it still binds; one second later it does not.
  fixture.options.now = new Date(statedAt + 21_600_000);
  assert.equal(
    (await json(fixture, ["status", "--no-sync"])).data.shadow.reason ?? "binds",
    "binds",
  );
  fixture.options.now = new Date(statedAt + 21_601_000);
  const stale = await json(fixture, ["status", "--no-sync"]);
  assert.deepEqual([stale.data.shadow.computed, stale.data.shadow.reason], [false, "stale"]);
  assert.equal(stale.data.shadow.binding, null);
  assert.ok(!("viability" in stale.data.shadow));

  const database = new Database(fixture.paths.databaseFile, { readonly: true });
  try {
    const attempts = Number(
      /** @type {{n: number}} */ (
        database.prepare("SELECT COUNT(*) AS n FROM prediction_attempt").get()
      ).n,
    );
    const shadows = Number(
      /** @type {{n: number}} */ (
        database.prepare("SELECT COUNT(*) AS n FROM prediction_reported_capacity").get()
      ).n,
    );
    // Three invocations, two of them computed the shadow.
    assert.deepEqual([attempts, shadows], [3, 2]);
  } finally {
    database.close();
  }
});

test("at the instant a window resets it stops binding, and the next live window binds instead", async () => {
  const fixture = await makeRunFixture("snack-codex-reset-");
  await codexFixture(fixture);
  const fresh = await json(fixture, ["status", "--no-sync"]);
  const [latest] = fresh.data.reported_capacity;
  const windows = [...latest.windows].sort(
    (/** @type {{window_minutes: number}} */ left, /** @type {{window_minutes: number}} */ right) =>
      left.window_minutes - right.window_minutes,
  );
  const shortest = windows[0];
  assert.equal(fresh.data.shadow.binding.window_minutes, shortest.window_minutes);
  assert.ok(windows.length > 1 && shortest.resets_at !== null, "the fixture needs two windows");

  fixture.options.now = new Date(Date.parse(shortest.resets_at) - 1000);
  assert.equal(
    (await json(fixture, ["status", "--no-sync"])).data.shadow.binding.window_minutes,
    shortest.window_minutes,
  );
  fixture.options.now = new Date(shortest.resets_at);
  const reset = await json(fixture, ["status", "--no-sync"]);
  assert.notEqual(reset.data.shadow.binding?.window_minutes, shortest.window_minutes);
});

test("a Claude Code source never gets a stated figure, a shadow, or a per-method stream", async () => {
  const fixture = await makeRunFixture("snack-codex-routing-");
  fixture.options.env.CLAUDE_CONFIG_DIR = await createClaudeHistory(fixture.root);
  await json(fixture, ["setup", "claude", ...flags("personal", "anthropic", "pro")]);
  await codexFixture(fixture);

  const status = await json(fixture, ["status", "--no-sync"]);
  const reports = status.data.sources;
  const personal = reports.find(
    (/** @type {{source: {alias: string}}} */ report) => report.source.alias === "personal",
  );
  const codex = reports.find(
    (/** @type {{source: {alias: string}}} */ report) => report.source.alias === "codex",
  );
  assert.ok(codex.shadow.computed, "vacuous: the Codex source computed no shadow");
  assert.ok(!("shadow" in personal) && !("reported_capacity" in personal));

  const stats = await json(fixture, ["stats"]);
  for (const report of stats.data.sources) {
    assert.equal(
      "by_method" in report.calibration,
      report.source.alias === "codex",
      report.source.alias,
    );
  }

  const database = new Database(fixture.paths.databaseFile, { readonly: true });
  try {
    const leaked = database
      .prepare(
        `SELECT COUNT(*) AS n FROM prediction_reported_capacity
           JOIN prediction_attempt ON prediction_attempt.id = prediction_reported_capacity.prediction_attempt_id
          WHERE prediction_attempt.source_alias <> 'codex'`,
      )
      .get();
    assert.equal(/** @type {{n: number}} */ (leaked).n, 0);
    const statedForClaude = database
      .prepare(
        "SELECT COUNT(*) AS n FROM reported_capacity_observation WHERE source_alias = 'personal'",
      )
      .get();
    assert.equal(/** @type {{n: number}} */ (statedForClaude).n, 0);
  } finally {
    database.close();
  }
});

test("another client's prompt after a statement below full supersedes it", async () => {
  const fixture = await makeRunFixture("snack-codex-superseded-");
  const installationId = await codexFixture(fixture);
  const fresh = await json(fixture, ["status", "--no-sync"]);
  assert.equal(fresh.data.shadow.computed, true);
  assert.notEqual(fresh.data.shadow.binding.band, "full");

  // A prompt from another installation of this source, started after the statement.
  const database = new Database(fixture.paths.databaseFile);
  try {
    const template = /** @type {Record<string, unknown>} */ (
      database.prepare("SELECT * FROM prompt_execution ORDER BY id DESC LIMIT 1").get()
    );
    database
      .prepare(
        `INSERT INTO client_installation (id, client_kind, local_fingerprint, created_at, last_seen_at)
         SELECT 'foreign-installation', 'opencode', 'fingerprint-foreign', created_at, last_seen_at
           FROM client_installation WHERE id = ?`,
      )
      .run(installationId);
    const after = new Date(Date.parse(fresh.data.shadow.binding.stated_at) + 1000).toISOString();
    const columns = Object.keys(template).filter((column) => column !== "id");
    database
      .prepare(
        `INSERT INTO prompt_execution (${columns.join(", ")}) VALUES (${columns.map((column) => `@${column}`).join(", ")})`,
      )
      .run({
        ...template,
        installation_id: "foreign-installation",
        source_prompt_id: "foreign-prompt",
        observation_hash: "foreign-hash",
        started_at: after,
      });
  } finally {
    database.close();
  }
  const superseded = await json(fixture, ["status", "--no-sync"]);
  assert.deepEqual(
    [superseded.data.shadow.computed, superseded.data.shadow.reason],
    [false, "superseded"],
  );
});

test("each prompt's stated band is projected as of its own start, and moves with a late statement or a purge", async () => {
  const fixture = await makeRunFixture("snack-codex-projection-");
  const installationId = await codexFixture(fixture);
  const { databaseFile } = fixture.paths;

  /** The projection, against the as-of labelling of the same stored history. */
  const compare = () => {
    const rows = readStatedBandRows(databaseFile, "codex");
    const expected = labelStatedBands(
      rows.map((row) => ({ ...row, outcome: /** @type {const} */ ("success") })),
      readStatedTimeline(databaseFile, "codex", { from: "" }),
      { periodStart: null },
    );
    assert.deepEqual(
      rows.map((row) => [row.stated_band, row.stated_band_policy_version]),
      expected.map((row) => [row.stated_band, "reported-capacity-v1"]),
    );
    return rows;
  };

  const synced = compare();
  assert.ok(synced.length > 1, "vacuous: too few prompts");
  const first = /** @type {{started_at: string, stated_band: string | null}} */ (synced[0]);
  assert.equal(first.stated_band, null, "the first prompt had a statement before it");

  // A statement read late, made just before the first prompt: the next synchronization moves it.
  plantStatements(
    databaseFile,
    "codex",
    installationId,
    [
      {
        observation_key: "e".repeat(64),
        observed_at: new Date(Date.parse(first.started_at) - 1000).toISOString(),
        limit_id: "codex",
        plan_type: "plus",
        windows: [{ window_minutes: 300, used_percent: 100, resets_at: null }],
        parser_version: "codex-rate-limits-v1",
      },
    ],
    /** @type {Date} */ (fixture.options.now),
  );
  await json(fixture, ["status"]);
  assert.equal(compare()[0]?.stated_band, "full");

  // Purging that statement moves it back.
  await json(fixture, [
    "data",
    "purge",
    "--source",
    "codex",
    "--since",
    new Date(Date.parse(first.started_at) - 2000).toISOString(),
    "--until",
    new Date(Date.parse(first.started_at) - 500).toISOString(),
    "--yes",
  ]);
  assert.equal(compare()[0]?.stated_band, null);
});

/**
 * The projection of a fixture's active period, against the as-of labelling of the same stored
 * history, under the current policy.
 *
 * @param {string} databaseFile
 */
function assertProjected(databaseFile) {
  const rows = readStatedBandRows(databaseFile, "codex");
  const expected = labelStatedBands(
    rows.map((row) => ({ ...row, outcome: /** @type {const} */ ("success") })),
    readStatedTimeline(databaseFile, "codex", { from: "" }),
    { periodStart: null },
  );
  assert.deepEqual(
    rows.map((row) => [row.stated_band, row.stated_band_policy_version]),
    expected.map((row) => [row.stated_band, REPORTED_CAPACITY_POLICY.version]),
  );
  return rows;
}

/** @param {string} databaseFile */
function frontierOf(databaseFile) {
  return readStatedBandFrontier(databaseFile, "codex", REPORTED_CAPACITY_POLICY.version);
}

test("a synchronization that brings nothing leaves no frontier, though an ended period holds prompts never computed", async () => {
  const fixture = await makeRunFixture("snack-codex-frontier-");
  await codexFixture(fixture);
  const { databaseFile, configFile } = fixture.paths;

  // A plan change ends the period the whole history was filed in.
  const config = JSON.parse(await readFile(configFile, "utf8"));
  config.sources[0].plan = "pro";
  await writeFile(configFile, JSON.stringify(config), { mode: 0o600 });
  fixture.options.now = new Date("2026-01-02T05:00:00.000Z");
  await json(fixture, ["sync"]);

  // What migration 018 leaves on a 1.4 database: no prompt computed, no projection recorded.
  const database = new Database(databaseFile);
  try {
    database.exec(
      "UPDATE prompt_execution SET stated_band = NULL, stated_band_policy_version = NULL",
    );
    if (
      database
        .prepare("SELECT 1 FROM sqlite_master WHERE name = 'stated_band_projection'")
        .get() !== undefined
    ) {
      database.exec("DELETE FROM stated_band_projection");
    }
    const ended = /** @type {{prompts: number}} */ (
      database
        .prepare(
          `SELECT COUNT(*) AS prompts FROM prompt_execution
             JOIN capacity_period ON capacity_period.id = prompt_execution.capacity_period_id
            WHERE capacity_period.ended_at IS NOT NULL`,
        )
        .get()
    );
    assert.ok(ended.prompts > 0, "vacuous: no prompt in an ended period");
  } finally {
    database.close();
  }

  fixture.options.now = new Date("2026-01-02T06:00:00.000Z");
  await json(fixture, ["sync"]);
  assert.equal(frontierOf(databaseFile), null, "the first synchronization left a frontier");
  fixture.options.now = new Date("2026-01-02T06:01:00.000Z");
  await json(fixture, ["sync"]);
  assert.equal(frontierOf(databaseFile), null, "a synchronization that brought nothing");
});

test("a statement committed without the restate that follows it is projected by the next synchronization", async () => {
  const fixture = await makeRunFixture("snack-codex-crash-");
  await codexFixture(fixture);
  const { databaseFile, configFile } = fixture.paths;
  const synced = assertProjected(databaseFile);
  const first = /** @type {{started_at: string, stated_band: string | null}} */ (synced[0]);
  assert.equal(first.stated_band, null, "the first prompt had a statement before it");
  assert.equal(frontierOf(databaseFile), null);

  // The ingestion transaction of a synchronization that stopped right after it committed -- the
  // process killed before the restate ran: a statement read late, made just before the first
  // prompt, is stored and nothing is recomputed.
  const config = JSON.parse(await readFile(configFile, "utf8"));
  storeObservations(
    databaseFile,
    config.sources[0],
    {
      observations: [],
      cursor: readIngestionCursor(databaseFile, "codex"),
      reported_capacity: [
        {
          observation_key: "e".repeat(64),
          observed_at: new Date(Date.parse(first.started_at) - 1000).toISOString(),
          limit_id: "codex",
          plan_type: "plus",
          windows: [{ window_minutes: 300, used_percent: 100, resets_at: null }],
          parser_version: "codex-rate-limits-v1",
          provider: "openai",
        },
      ],
    },
    /** @type {Date} */ (fixture.options.now),
    // What `synchronizeSource` passes, so the batch files into the same period.
    { planProfile: resolvePlanProfile(config.sources[0]).profile },
  );
  assert.equal(readStatedBandRows(databaseFile, "codex")[0]?.stated_band, null);
  assert.notEqual(frontierOf(databaseFile), null, "the commit left no durable frontier");

  // An hour later, a synchronization that reads nothing new heals it.
  fixture.options.now = new Date(Date.parse(String(fixture.options.now)) + 3_600_000);
  await json(fixture, ["sync"]);
  assert.equal(assertProjected(databaseFile)[0]?.stated_band, "full");
  assert.equal(frontierOf(databaseFile), null);
});

test("a prompt synchronized after the projection is current is projected by that synchronization", async () => {
  const fixture = await makeRunFixture("snack-codex-incremental-");
  await codexFixture(fixture);
  const { databaseFile } = fixture.paths;
  const before = assertProjected(databaseFile).length;
  assert.equal(frontierOf(databaseFile), null);

  // Three turns half an hour after the fixture's statements, read by an incremental sync.
  await addCodexTurns(/** @type {string} */ (fixture.options.env.CODEX_HOME), {
    from: Date.parse("2026-01-02T02:30:00.000Z"),
    count: 3,
    spacingMs: 60_000,
  });
  await json(fixture, ["sync"]);
  const rows = assertProjected(databaseFile);
  assert.equal(rows.length, before + 3);
  assert.ok(
    rows.slice(-3).every((row) => row.stated_band !== null),
    "vacuous: no statement binds the new prompts",
  );
  assert.equal(frontierOf(databaseFile), null);
});

test("a projection made under another policy version is recomputed whole", async () => {
  const fixture = await makeRunFixture("snack-codex-policy-");
  await codexFixture(fixture);
  const { databaseFile } = fixture.paths;
  assertProjected(databaseFile);

  // A projection recorded by an earlier policy, its bands since tampered with: the version alone
  // must send the next synchronization back over the whole active period.
  const database = new Database(databaseFile);
  try {
    database.exec(
      `UPDATE stated_band_projection SET policy_version = 'reported-capacity-v0';
       UPDATE prompt_execution SET stated_band = 'full'`,
    );
  } finally {
    database.close();
  }
  assert.equal(frontierOf(databaseFile), "");
  await json(fixture, ["sync"]);
  assertProjected(databaseFile);
  assert.equal(frontierOf(databaseFile), null);
});

test("a source no Codex installation feeds keeps no stated-band state on its prompts", async () => {
  const fixture = await makeRunFixture("snack-claude-projection-");
  fixture.options.env.CLAUDE_CONFIG_DIR = await createClaudeHistory(fixture.root);
  await json(fixture, ["setup", "claude", ...flags("personal", "anthropic", "pro")]);
  await json(fixture, ["sync", "--full"]);
  await json(fixture, ["sync"]);
  const database = new Database(fixture.paths.databaseFile, { readonly: true });
  try {
    const prompts = /** @type {{prompts: number, stated: number}} */ (
      database
        .prepare(
          `SELECT COUNT(*) AS prompts,
                  COUNT(stated_band) + COUNT(stated_band_policy_version) AS stated
             FROM prompt_execution`,
        )
        .get()
    );
    assert.ok(prompts.prompts > 0, "vacuous: no prompt");
    assert.equal(prompts.stated, 0);
    // No index carries a row per prompt for the projection: a six-figure Claude Code history would
    // pay for every one of them and never use it.
    assert.deepEqual(
      database
        .prepare(
          `SELECT name FROM sqlite_master
            WHERE type = 'index' AND tbl_name = 'prompt_execution' AND sql LIKE '%stated_band%'`,
        )
        .all(),
      [],
    );
  } finally {
    database.close();
  }
});

/**
 * A stated figure for one window of one limit, in the shape `plantStatements` takes.
 *
 * @param {string} key one character, repeated into the observation key
 * @param {string} observedAt
 * @param {number} usedPercent
 */
function statement(key, observedAt, usedPercent) {
  return {
    observation_key: key.repeat(64),
    observed_at: observedAt,
    limit_id: "codex",
    plan_type: "plus",
    windows: [{ window_minutes: 10080, used_percent: usedPercent, resets_at: null }],
    parser_version: "codex-rate-limits-v1",
  };
}

/**
 * Commit prompts as one ingestion transaction of `installationId` on the fixture's Codex source --
 * what `synchronizeSource` does for each batch it reads -- and nothing else: no restate follows.
 *
 * @param {Awaited<ReturnType<typeof makeRunFixture>>} fixture
 * @param {string} installationId
 * @param {{id: string, startedAt: string, revision?: string}[]} prompts
 */
async function commitPrompts(fixture, installationId, prompts) {
  const { databaseFile, configFile } = fixture.paths;
  const config = JSON.parse(await readFile(configFile, "utf8"));
  const source = { ...config.sources[0], installation_id: installationId };
  storeObservations(
    databaseFile,
    source,
    {
      observations: prompts.map((prompt) => ({
        source_prompt_id: prompt.id,
        source_session_id: "direct-session",
        revision: prompt.revision ?? "1",
        revision_domain: "codex-turn-v1",
        parser_version: "codex-rollout-v1",
        started_at: prompt.startedAt,
        completed_at: prompt.startedAt,
        duration_ms: 3000,
        completion: "completed",
        outcome: "success",
        provider: "openai",
        model: "gpt-test",
        usage_slices: [],
        restrictions: [],
      })),
      cursor: readIngestionCursor(databaseFile, "codex"),
    },
    /** @type {Date} */ (fixture.options.now),
    { planProfile: resolvePlanProfile(config.sources[0]).profile },
  );
}

/**
 * The projected band of each named prompt.
 *
 * @param {string} databaseFile
 * @param {string[]} ids source prompt ids
 */
function bandsOf(databaseFile, ids) {
  const database = new Database(databaseFile, { readonly: true });
  try {
    const read = database.prepare(
      "SELECT stated_band FROM prompt_execution WHERE source_alias = 'codex' AND source_prompt_id = ?",
    );
    return ids.map((id) => /** @type {{stated_band: string | null}} */ (read.get(id)).stated_band);
  } finally {
    database.close();
  }
}

test("a frontier hours after the statement that binds it still reads that statement, and leaves earlier prompts alone", async () => {
  const fixture = await makeRunFixture("snack-codex-lookback-");
  const installationId = await codexFixture(fixture);
  const { databaseFile } = fixture.paths;
  const codexHome = /** @type {string} */ (fixture.options.env.CODEX_HOME);

  // Codex states the source full at 04:00, and nothing after.
  fixture.options.now = new Date("2026-01-02T04:00:30.000Z");
  plantStatements(
    databaseFile,
    "codex",
    installationId,
    [statement("a", "2026-01-02T04:00:00.000Z", 100)],
    fixture.options.now,
  );
  await json(fixture, ["sync"]);

  // Three hours later, two turns: the frontier is theirs, and the statement is three hours older.
  await addCodexTurns(codexHome, {
    from: Date.parse("2026-01-02T07:00:00.000Z"),
    count: 2,
    spacingMs: 60_000,
  });
  fixture.options.now = new Date("2026-01-02T07:10:00.000Z");
  await json(fixture, ["sync"]);
  const afterTurns = assertProjected(databaseFile).filter(
    (row) => row.started_at >= "2026-01-02T07:00:00.000Z",
  );
  assert.deepEqual(
    afterTurns.map((row) => row.stated_band),
    ["full", "full"],
  );

  // Five and a half hours after those, one more turn. Its lookback starts after the statement, so
  // the two turns before it must be left as they are, not recomputed from a timeline without it.
  await addCodexTurns(codexHome, {
    from: Date.parse("2026-01-02T12:30:00.000Z"),
    count: 1,
    spacingMs: 60_000,
    thread: 1,
  });
  fixture.options.now = new Date("2026-01-02T12:40:00.000Z");
  await json(fixture, ["sync"]);
  const late = assertProjected(databaseFile).filter(
    (row) => row.started_at >= "2026-01-02T07:00:00.000Z",
  );
  assert.deepEqual(
    late.map((row) => row.stated_band),
    ["full", "full", null],
  );
  assert.equal(frontierOf(databaseFile), null);
});

test("two ingestion commits without a restate between them keep the earlier frontier", async () => {
  const fixture = await makeRunFixture("snack-codex-two-commits-");
  await codexFixture(fixture);
  const { databaseFile, configFile } = fixture.paths;
  const first = /** @type {{started_at: string}} */ (assertProjected(databaseFile)[0]);
  const config = JSON.parse(await readFile(configFile, "utf8"));
  const early = new Date(Date.parse(first.started_at) - 1000).toISOString();

  // `synchronizeSource` commits a source in several batches and restates once, after the last: the
  // second commit, with a later statement, must not raise the frontier the first one lowered.
  for (const { key, observedAt } of [
    { key: "e", observedAt: early },
    { key: "f", observedAt: "2026-01-02T02:00:30.000Z" },
  ]) {
    storeObservations(
      databaseFile,
      config.sources[0],
      {
        observations: [],
        cursor: readIngestionCursor(databaseFile, "codex"),
        reported_capacity: [{ ...statement(key, observedAt, 100), provider: "openai" }],
      },
      /** @type {Date} */ (fixture.options.now),
      { planProfile: resolvePlanProfile(config.sources[0]).profile },
    );
  }
  assert.equal(frontierOf(databaseFile), early);

  await json(fixture, ["sync"]);
  assert.equal(assertProjected(databaseFile)[0]?.stated_band, "full");
  assert.equal(frontierOf(databaseFile), null);
});

test("a revision that moves a prompt's start lowers the frontier to the earlier of its two starts", async () => {
  const fixture = await makeRunFixture("snack-codex-revision-");
  const installationId = await codexFixture(fixture);
  const { databaseFile } = fixture.paths;

  await commitPrompts(fixture, installationId, [
    { id: "moved", startedAt: "2026-01-02T02:00:30.000Z" },
  ]);
  await json(fixture, ["sync"]);
  assert.equal(frontierOf(databaseFile), null);

  // Moved later: what it bound from its old start may have moved too.
  await commitPrompts(fixture, installationId, [
    { id: "moved", startedAt: "2026-01-02T02:00:40.000Z", revision: "2" },
  ]);
  assert.equal(frontierOf(databaseFile), "2026-01-02T02:00:30.000Z");
  await json(fixture, ["sync"]);
  assertProjected(databaseFile);

  // Moved earlier: its new start is the earliest instant that can have moved.
  await commitPrompts(fixture, installationId, [
    { id: "moved", startedAt: "2026-01-02T02:00:01.000Z", revision: "3" },
  ]);
  assert.equal(frontierOf(databaseFile), "2026-01-02T02:00:01.000Z");
  await json(fixture, ["sync"]);
  assertProjected(databaseFile);
  assert.equal(frontierOf(databaseFile), null);
});

test("attributing a prompt whose client was unknown supersedes another installation's statement", async () => {
  const fixture = await makeRunFixture("snack-codex-attribution-");
  const installationId = await codexFixture(fixture);
  const { databaseFile } = fixture.paths;
  const other = "22222222-3333-4444-8555-666666666666";

  // Hours after the fixture's own statements, a second Codex installation on the same source
  // states it clear, and the first runs two prompts.
  fixture.options.now = new Date("2026-01-02T09:10:00.000Z");
  await commitPrompts(fixture, other, []);
  plantStatements(
    databaseFile,
    "codex",
    other,
    [statement("b", "2026-01-02T09:00:00.000Z", 10)],
    fixture.options.now,
  );
  const prompts = [
    { id: "orphan", startedAt: "2026-01-02T09:00:10.000Z" },
    { id: "after", startedAt: "2026-01-02T09:00:20.000Z" },
  ];
  await commitPrompts(fixture, installationId, prompts);
  await json(fixture, ["sync"]);
  assert.deepEqual(bandsOf(databaseFile, ["orphan", "after"]), ["clear", null]);

  // What an upgrade leaves on a shared source: the first prompt's client unknown. Unknown is not
  // another client's, so the statement binds the second prompt again.
  const database = new Database(databaseFile);
  try {
    database.exec(
      `UPDATE prompt_execution SET installation_id = NULL WHERE source_prompt_id = 'orphan';
       UPDATE stated_band_projection SET stale_from = ''`,
    );
  } finally {
    database.close();
  }
  await json(fixture, ["sync"]);
  assert.deepEqual(bandsOf(databaseFile, ["orphan", "after"]), ["clear", "clear"]);

  // Its client observes it again and claims it: it is another installation's prompt after the
  // statement, so the next one is superseded.
  await commitPrompts(fixture, installationId, prompts);
  assert.equal(frontierOf(databaseFile), "2026-01-02T09:00:10.000Z");
  await json(fixture, ["sync"]);
  assert.deepEqual(bandsOf(databaseFile, ["orphan", "after"]), ["clear", null]);
  assertProjected(databaseFile);
});

test("a purge of every source restates every source it reached", async () => {
  const fixture = await makeRunFixture("snack-codex-purge-all-");
  const installationId = await codexFixture(fixture);
  const { databaseFile } = fixture.paths;
  const first = /** @type {{started_at: string}} */ (assertProjected(databaseFile)[0]);
  plantStatements(
    databaseFile,
    "codex",
    installationId,
    [statement("e", new Date(Date.parse(first.started_at) - 1000).toISOString(), 100)],
    /** @type {Date} */ (fixture.options.now),
  );
  await json(fixture, ["sync"]);
  assert.equal(assertProjected(databaseFile)[0]?.stated_band, "full");

  await json(fixture, [
    "data",
    "purge",
    "--all",
    "--since",
    new Date(Date.parse(first.started_at) - 2000).toISOString(),
    "--until",
    new Date(Date.parse(first.started_at) - 500).toISOString(),
    "--yes",
  ]);
  assert.equal(assertProjected(databaseFile)[0]?.stated_band, null);
  assert.equal(frontierOf(databaseFile), null);
});

test("a purge that removes only another client's prompt lifts the supersession it caused", async () => {
  const fixture = await makeRunFixture("snack-codex-purge-foreign-");
  const installationId = await codexFixture(fixture);
  const { databaseFile } = fixture.paths;
  const other = "22222222-3333-4444-8555-666666666666";

  fixture.options.now = new Date("2026-01-02T09:10:00.000Z");
  plantStatements(
    databaseFile,
    "codex",
    installationId,
    [statement("c", "2026-01-02T09:00:00.000Z", 10)],
    fixture.options.now,
  );
  await commitPrompts(fixture, installationId, [
    { id: "own-1", startedAt: "2026-01-02T09:00:10.000Z" },
    { id: "own-2", startedAt: "2026-01-02T09:00:30.000Z" },
  ]);
  await commitPrompts(fixture, other, [{ id: "foreign", startedAt: "2026-01-02T09:00:20.000Z" }]);
  await json(fixture, ["sync"]);
  assert.deepEqual(bandsOf(databaseFile, ["own-1", "own-2"]), ["clear", null]);

  // No statement is in the range: only the other client's prompt goes.
  const purged = await json(fixture, [
    "data",
    "purge",
    "--source",
    "codex",
    "--since",
    "2026-01-02T09:00:15.000Z",
    "--until",
    "2026-01-02T09:00:25.000Z",
    "--yes",
  ]);
  assert.equal(purged.data.counts.prompts, 1);
  assert.equal(purged.data.counts.reported_capacity_observations, 0);
  assert.deepEqual(bandsOf(databaseFile, ["own-1", "own-2"]), ["clear", "clear"]);
  assertProjected(databaseFile);
});

test("a frontier lowered between the restate's read and its write survives the write", async () => {
  const fixture = await makeRunFixture("snack-codex-stolen-lock-");
  const installationId = await codexFixture(fixture);
  const { databaseFile } = fixture.paths;
  const now = /** @type {Date} */ (fixture.options.now);
  const version = REPORTED_CAPACITY_POLICY.version;
  plantStatements(
    databaseFile,
    "codex",
    installationId,
    [statement("g", "2026-01-02T02:00:20.000Z", 100)],
    now,
  );
  const read = readStatedBandProjection(databaseFile, "codex", version);
  assert.deepEqual(read, {
    frontier: "2026-01-02T02:00:20.000Z",
    stale_from: "2026-01-02T02:00:20.000Z",
  });

  // A synchronization that took over a lock it judged stale commits an earlier statement while
  // this restate computes: clearing the frontier it read must not clear the one it never saw.
  plantStatements(
    databaseFile,
    "codex",
    installationId,
    [statement("h", "2026-01-02T02:00:01.000Z", 100)],
    now,
  );
  writeStatedBands(databaseFile, "codex", [], version, read.stale_from);
  assert.equal(frontierOf(databaseFile), "2026-01-02T02:00:01.000Z");

  await json(fixture, ["sync"]);
  assertProjected(databaseFile);
  assert.equal(frontierOf(databaseFile), null);
});

test("a start written with an offset lowers the frontier to its instant, and is projected", async () => {
  const fixture = await makeRunFixture("snack-codex-offset-");
  const installationId = await codexFixture(fixture);
  const { databaseFile } = fixture.paths;

  // The Claude Code backfill stores timestamps as the client wrote them and the spool accepts an
  // offset: as text, 03:00:30+01:00 sorts after 02:00:40Z, though it is ten seconds earlier.
  await commitPrompts(fixture, installationId, [
    { id: "late", startedAt: "2026-01-02T02:00:40.000Z" },
    { id: "offset", startedAt: "2026-01-02T03:00:30.000+01:00" },
  ]);
  assert.equal(frontierOf(databaseFile), "2026-01-02T02:00:30.000Z");
  await json(fixture, ["sync"]);
  assertProjected(databaseFile);
  assert.deepEqual(bandsOf(databaseFile, ["late", "offset"]), ["clear", "clear"]);

  // The prompt at the frontier itself, written with a zero offset: as text it sorts before the
  // frontier's own spelling of the same instant, and must still be recomputed.
  await commitPrompts(fixture, installationId, [
    { id: "zero-offset", startedAt: "2026-01-02T02:00:20+00:00" },
  ]);
  assert.equal(frontierOf(databaseFile), "2026-01-02T02:00:20.000Z");
  await json(fixture, ["sync"]);
  assertProjected(databaseFile);
  assert.deepEqual(bandsOf(databaseFile, ["zero-offset"]), ["clear"]);
  assert.equal(frontierOf(databaseFile), null);
});
