import assert from "node:assert/strict";
import { copyFile } from "node:fs/promises";
import { afterEach, test } from "node:test";

import Database from "better-sqlite3";
import fc from "fast-check";

import { run } from "../src/main.js";
import {
  cleanupRunFixtures,
  createCodexHistory,
  makeRunFixture,
  plantStatements,
} from "./fixtures/run-fixture.js";

afterEach(cleanupRunFixtures);

/**
 * Shadow mode, as a property (ADR-0007, amended 1.5.0): whatever Codex states, the answer `status`
 * gives for a Codex-fed source is the one the baseline alone gives. The statements are generated
 * fresh at the fixture clock -- inside the six-hour limit, in every band, resetting before and
 * after it -- so the shadow really is computed on most runs, and the property is checked through
 * the command a user runs: the JSON answer, the sequence, the envelope's status and warnings, and
 * the overview a reader sees.
 */

const NOW = Date.parse("2026-01-02T03:04:05.000Z");

const statedInstant = fc
  .integer({ min: NOW - 7 * 3600 * 1000, max: NOW })
  .map((ms) => new Date(ms).toISOString());
const resetInstant = fc.option(
  fc
    .integer({ min: NOW - 3600 * 1000, max: NOW + 10 * 86400 * 1000 })
    .map((ms) => new Date(ms).toISOString()),
  { nil: null },
);

const statedWindow = fc.record({
  window_minutes: fc.constantFrom(300, 10080, 43200),
  used_percent: fc.oneof(
    fc.constantFrom(0, 79.99, 80, 99.99, 100),
    fc.double({ min: 0, max: 100, noNaN: true }),
  ),
  resets_at: resetInstant,
});

const statedSnapshot = fc.record({
  observation_key: fc.stringMatching(/^[0-9a-f]{64}$/u),
  observed_at: statedInstant,
  limit_id: fc.option(fc.constantFrom("codex", "premium"), { nil: null }),
  plan_type: fc.option(fc.constantFrom("free", "plus"), { nil: null }),
  windows: fc.uniqueArray(statedWindow, {
    minLength: 1,
    maxLength: 2,
    selector: (window) => window.window_minutes,
  }),
  parser_version: fc.constant("codex-rate-limits-v1"),
  provider: fc.constant("openai"),
});

/**
 * A window stated full or nearly full a minute before the clock.
 *
 * @param {number} usedPercent
 * @param {number} n
 */
function fixedSnapshot(usedPercent, n) {
  return {
    observation_key: String(n).padStart(64, "a"),
    observed_at: new Date(NOW - 60_000).toISOString(),
    limit_id: /** @type {"codex" | "premium" | null} */ ("codex"),
    plan_type: /** @type {"free" | "plus" | null} */ ("plus"),
    windows: [
      {
        window_minutes: /** @type {300 | 10080 | 43200} */ (300),
        used_percent: usedPercent,
        resets_at: /** @type {string | null} */ (new Date(NOW + 3_600_000).toISOString()),
      },
    ],
    parser_version: /** @type {const} */ ("codex-rate-limits-v1"),
    provider: /** @type {const} */ ("openai"),
  };
}

/**
 * Everything the answer is made of. `reported_capacity` and `shadow` are the two members a stated
 * figure is allowed to add; nothing else may differ.
 *
 * @param {string} stdout
 */
function answerOf(stdout) {
  const document = JSON.parse(stdout);
  const { shadow, ...answer } = document.data;
  delete answer.reported_capacity;
  return {
    answer,
    status: document.status,
    warnings: document.warnings,
    shadow: /** @type {{computed: boolean, binding: {band: string} | null} | undefined} */ (shadow),
  };
}

test("whatever Codex states, the status answer is the one the baseline alone gives", async () => {
  const fixture = await makeRunFixture("snack-shadow-isolation-");
  fixture.options.env.CODEX_HOME = await createCodexHistory(fixture.root, [
    "version-0-159-3.jsonl",
    "version-0-147-0.jsonl",
    "restricted-usage-limit.jsonl",
    "restricted-reached-type.jsonl",
  ]);
  /** @param {string[]} argv */
  const invoke = async (...argv) => {
    fixture.stdout.value = "";
    fixture.stderr.value = "";
    const exitCode = await run(["node", "snack", ...argv], fixture.options);
    assert.equal(exitCode, 0, fixture.stderr.value);
    return fixture.stdout.value;
  };
  const setup = JSON.parse(
    await invoke(
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
      "--json",
    ),
  );
  await invoke("sync", "--full");

  // The baseline alone: the same history with every statement the fixture carried removed.
  const { databaseFile } = fixture.paths;
  const database = new Database(databaseFile);
  try {
    database.exec(
      "DELETE FROM reported_capacity_latest; DELETE FROM reported_capacity_observation",
    );
  } finally {
    database.close();
  }
  const pristine = `${databaseFile}.pristine`;
  await copyFile(databaseFile, pristine);

  const installationId = setup.data.source.installation_id;

  /** @param {import("../src/storage.js").ReportedCapacitySnapshot[]} reported */
  const plant = (reported) =>
    plantStatements(databaseFile, "codex", installationId, reported, new Date(NOW));

  /** @param {import("../src/storage.js").ReportedCapacitySnapshot[]} reported */
  const statusWith = async (reported) => {
    await copyFile(pristine, databaseFile);
    plant(reported);
    return {
      single: answerOf(await invoke("status", "--no-sync", "--json")),
      sequence: answerOf(await invoke("status", "--no-sync", "--sequence", "3", "--json")),
      overview: await invoke("status", "--no-sync"),
    };
  };

  const baseline = await statusWith([]);
  assert.equal(baseline.single.shadow?.computed, false, "a shadow computed from no statement");

  const seen = { computed: 0, full: 0 };
  await fc.assert(
    fc.asyncProperty(
      fc.uniqueArray(statedSnapshot, {
        minLength: 1,
        maxLength: 5,
        selector: (snapshot) => snapshot.observation_key,
      }),
      async (reported) => {
        const stated = await statusWith(reported);
        if (stated.single.shadow?.computed === true) seen.computed += 1;
        if (stated.single.shadow?.binding?.band === "full") seen.full += 1;
        assert.deepEqual(stated.single.answer, baseline.single.answer);
        assert.deepEqual(stated.single.status, baseline.single.status);
        assert.deepEqual(stated.single.warnings, baseline.single.warnings);
        assert.deepEqual(stated.sequence.answer, baseline.sequence.answer);
        assert.equal(stated.overview, baseline.overview);
      },
    ),
    {
      numRuns: 40,
      // Always run, beside the random ones: a window stated full and one nearly full, a minute
      // before the clock, so the guards below never depend on what the generator happened to draw.
      examples: [[[fixedSnapshot(100, 1)]], [[fixedSnapshot(90, 2)]]],
    },
  );
  // Non-vacuity: the property held while the shadow was really computed, in the full band too.
  assert.ok(seen.computed >= 5, `the shadow was computed on ${seen.computed} runs only`);
  assert.ok(seen.full >= 1, "no run bound a window stated full");
});
