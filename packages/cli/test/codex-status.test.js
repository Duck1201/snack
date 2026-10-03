import assert from "node:assert/strict";
import { afterEach, test } from "node:test";

import Database from "better-sqlite3";

import { run } from "../src/main.js";
import {
  cleanupRunFixtures,
  createClaudeHistory,
  createCodexHistory,
  makeRunFixture,
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
