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
