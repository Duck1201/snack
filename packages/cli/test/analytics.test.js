import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, test } from "node:test";

import Database from "better-sqlite3";
import fc from "fast-check";

import {
  effectiveSampleSize,
  horizonWindow,
  parseHorizon,
  summarizeUsageProfile,
} from "../src/analytics.js";
import { resolvePaths } from "../src/paths.js";
import {
  initializeDatabase,
  readRestrictionWindowRows,
  readUsageWindowRows,
} from "../src/storage.js";

/** @type {string[]} */
const temporaryRoots = [];

afterEach(async () => {
  while (temporaryRoots.length > 0) {
    const root = temporaryRoots.pop();
    if (root !== undefined) {
      await rm(root, { recursive: true, force: true });
    }
  }
});

/**
 * Create a migrated SNACK database holding one capacity source and period.
 *
 * @returns {Promise<{databaseFile: string, seed: (rows: SeedPrompt[]) => void}>}
 */
async function makeSeededDatabase() {
  const root = await mkdtemp(join(tmpdir(), "snack-analytics-"));
  temporaryRoots.push(root);
  const paths = resolvePaths({
    env: { XDG_DATA_HOME: join(root, "data"), XDG_STATE_HOME: join(root, "state") },
    platform: "linux",
    home: root,
  });
  await initializeDatabase(paths, {
    applicationVersion: "0.4.0",
    now: new Date("2026-01-01T00:00:00.000Z"),
  });

  const database = new Database(paths.databaseFile);
  database.pragma("foreign_keys = ON");
  database
    .prepare("INSERT INTO capacity_source (alias, created_at) VALUES ('work', ?)")
    .run("2026-01-01T00:00:00.000Z");
  database
    .prepare(
      `INSERT INTO capacity_period (id, source_alias, provider, profile, plan, started_at)
       VALUES (1, 'work', 'anthropic', 'default', 'pro', '2026-01-01T00:00:00.000Z')`,
    )
    .run();
  database.close();

  return {
    databaseFile: paths.databaseFile,
    seed(rows) {
      const connection = new Database(paths.databaseFile);
      connection.pragma("foreign_keys = ON");
      const insertPrompt = connection.prepare(
        `INSERT INTO prompt_execution
           (id, source_alias, capacity_period_id, source_prompt_id, source_session_fingerprint,
            source_revision, observation_hash, revision_domain, parser_version, started_at,
            completed_at, duration_ms, completion, first_observed_at, last_observed_at)
         VALUES (@id, 'work', 1, @source_prompt_id, 'session', '1', 'hash', 'opencode', 'p1',
                 @started_at, @completed_at, @duration_ms, 'completed', @started_at, @started_at)`,
      );
      const insertOutcome = connection.prepare(
        `INSERT INTO prompt_source_outcome (prompt_execution_id, outcome, policy_version)
         VALUES (?, ?, 'stage2-outcome-v1')`,
      );
      const insertRestriction = connection.prepare(
        `INSERT INTO restriction_observation
           (prompt_execution_id, class, source_code, observed_at, classifier_version, provenance)
         VALUES (?, ?, ?, ?, 'stage2-classifier-v1', 'backfill')`,
      );
      const insertSlice = connection.prepare(
        `INSERT INTO prompt_usage_slice
           (prompt_execution_id, source_slice_id, provider, model, input_tokens, output_tokens,
            reasoning_tokens, cache_read_tokens, cache_write_tokens, cost_decimal, currency)
         VALUES (@prompt_execution_id, @source_slice_id, @provider, @model, @input_tokens,
                 @output_tokens, @reasoning_tokens, @cache_read_tokens, @cache_write_tokens,
                 @cost_decimal, @currency)`,
      );
      connection.transaction(() => {
        for (const row of rows) {
          insertPrompt.run({
            id: row.id,
            source_prompt_id: `prompt-${row.id}`,
            started_at: row.started_at,
            completed_at: row.completed_at ?? row.started_at,
            duration_ms: row.duration_ms ?? null,
          });
          insertOutcome.run(row.id, row.outcome ?? "success");
          for (const restriction of row.restrictions ?? []) {
            insertRestriction.run(
              row.id,
              restriction.class,
              restriction.source_code ?? "429",
              restriction.observed_at ?? row.started_at,
            );
          }
          for (const [index, slice] of (row.slices ?? []).entries()) {
            insertSlice.run({
              prompt_execution_id: row.id,
              source_slice_id: `slice-${index}`,
              provider: slice.provider ?? "anthropic",
              model: slice.model ?? "claude-opus-5",
              input_tokens: slice.input_tokens ?? null,
              output_tokens: slice.output_tokens ?? null,
              reasoning_tokens: slice.reasoning_tokens ?? null,
              cache_read_tokens: slice.cache_read_tokens ?? null,
              cache_write_tokens: slice.cache_write_tokens ?? null,
              cost_decimal: slice.cost_decimal ?? null,
              currency: slice.currency ?? null,
            });
          }
        }
      })();
      connection.close();
    },
  };
}

/**
 * @typedef {object} SeedPrompt
 * @property {number} id
 * @property {string} started_at
 * @property {string} [completed_at]
 * @property {number} [duration_ms]
 * @property {"success" | "restricted" | "excluded"} [outcome]
 * @property {Record<string, string | number | null>[]} [slices]
 * @property {{class: string, source_code?: string, observed_at?: string}[]} [restrictions]
 */

test("parseHorizon converts a supported ISO-8601 duration to seconds", () => {
  assert.equal(parseHorizon("PT5H"), 18000);
  assert.equal(parseHorizon("P7D"), 604800);
  assert.equal(parseHorizon("P1DT2H3M4S"), 93784);
});

test("parseHorizon rejects a duration outside the configured subset", () => {
  assert.throws(() => parseHorizon("5h"), { reason: "horizon_unsupported" });
});

test("horizonWindow anchors a rolling window on the injected clock", () => {
  const now = new Date("2026-01-02T03:04:05.000Z");

  assert.deepEqual(horizonWindow(now, 18000), {
    from: "2026-01-01T22:04:05.000Z",
    to: "2026-01-02T03:04:05.000Z",
  });
});

test("readUsageWindowRows keeps the window half-open on both boundaries", async () => {
  const { databaseFile, seed } = await makeSeededDatabase();
  seed([
    { id: 1, started_at: "2026-01-01T22:04:04.999Z" },
    { id: 2, started_at: "2026-01-01T22:04:05.000Z" },
    { id: 3, started_at: "2026-01-02T01:00:00.000Z" },
    { id: 4, started_at: "2026-01-02T03:04:05.000Z" },
  ]);

  const rows = readUsageWindowRows(databaseFile, "work", {
    from: "2026-01-01T22:04:05.000Z",
    to: "2026-01-02T03:04:05.000Z",
  });

  assert.deepEqual(
    rows.map((row) => row.prompt_execution_id),
    [2, 3],
  );
});

test("summarizeUsageProfile separates eligible outcomes from excluded ones", async () => {
  const { databaseFile, seed } = await makeSeededDatabase();
  seed([
    { id: 1, started_at: "2026-01-02T01:00:00.000Z", outcome: "success" },
    { id: 2, started_at: "2026-01-02T01:10:00.000Z", outcome: "success" },
    { id: 3, started_at: "2026-01-02T01:20:00.000Z", outcome: "restricted" },
    { id: 4, started_at: "2026-01-02T01:30:00.000Z", outcome: "excluded" },
    { id: 5, started_at: "2026-01-02T01:40:00.000Z", outcome: "excluded" },
  ]);
  const window = { from: "2026-01-01T22:04:05.000Z", to: "2026-01-02T03:04:05.000Z" };

  const profile = summarizeUsageProfile(readUsageWindowRows(databaseFile, "work", window), [], {
    horizon: "PT5H",
    window,
  });

  assert.deepEqual(profile.prompts, {
    count: 5,
    eligible: 3,
    successes: 2,
    restrictions: 1,
    excluded: 2,
  });
  assert.equal(profile.horizon, "PT5H");
  assert.deepEqual(profile.window, window);
});

test("summarizeUsageProfile reports absent token dimensions as unknown, never zero", async () => {
  const { databaseFile, seed } = await makeSeededDatabase();
  seed([
    {
      id: 1,
      started_at: "2026-01-02T01:00:00.000Z",
      slices: [{ input_tokens: 100, output_tokens: 20 }],
    },
    {
      id: 2,
      started_at: "2026-01-02T01:10:00.000Z",
      slices: [{ input_tokens: 50, output_tokens: null }],
    },
  ]);
  const window = { from: "2026-01-01T22:04:05.000Z", to: "2026-01-02T03:04:05.000Z" };

  const profile = summarizeUsageProfile(readUsageWindowRows(databaseFile, "work", window), [], {
    horizon: "PT5H",
    window,
  });

  assert.deepEqual(profile.dimensions.input_tokens, {
    value: 150,
    unit: "tokens",
    sample_size: 2,
    missing: 0,
    complete: true,
  });
  assert.deepEqual(profile.dimensions.output_tokens, {
    value: 20,
    unit: "tokens",
    sample_size: 1,
    missing: 1,
    complete: false,
  });
  assert.deepEqual(profile.dimensions.reasoning_tokens, {
    status: "unknown",
    unit: "tokens",
    sample_size: 0,
    missing: 2,
    complete: false,
  });
});

test("summarizeUsageProfile reports duration percentiles by linear interpolation", async () => {
  const { databaseFile, seed } = await makeSeededDatabase();
  // Worked by hand with the R-7 convention (numpy/Excel default):
  // rank = p * (n - 1) over [100, 200, 300, 400, 500].
  // p50 -> rank 2.0 -> 300. p90 -> rank 3.6 -> 400 + 0.6 * (500 - 400) = 460.
  seed([
    { id: 1, started_at: "2026-01-02T01:00:00.000Z", duration_ms: 300 },
    { id: 2, started_at: "2026-01-02T01:01:00.000Z", duration_ms: 100 },
    { id: 3, started_at: "2026-01-02T01:02:00.000Z", duration_ms: 500 },
    { id: 4, started_at: "2026-01-02T01:03:00.000Z", duration_ms: 200 },
    { id: 5, started_at: "2026-01-02T01:04:00.000Z", duration_ms: 400 },
    { id: 6, started_at: "2026-01-02T01:05:00.000Z" },
  ]);
  const window = { from: "2026-01-01T22:04:05.000Z", to: "2026-01-02T03:04:05.000Z" };

  const profile = summarizeUsageProfile(readUsageWindowRows(databaseFile, "work", window), [], {
    horizon: "PT5H",
    window,
  });

  assert.deepEqual(profile.duration, {
    p50: 300,
    p90: 460,
    unit: "ms",
    sample_size: 5,
    missing: 1,
    complete: false,
  });
});

test("effectiveSampleSize halves an observation's weight every half-life", () => {
  const now = new Date("2026-01-02T03:00:00.000Z");

  // One observation now, one an hour old, one two hours old: 1 + 0.5 + 0.25.
  assert.equal(
    effectiveSampleSize(
      ["2026-01-02T03:00:00.000Z", "2026-01-02T02:00:00.000Z", "2026-01-02T01:00:00.000Z"],
      now,
      3600,
    ),
    1.75,
  );
});

test("effectiveSampleSize stays below the raw count as observations age", () => {
  const now = new Date("2026-01-02T03:00:00.000Z");
  const recent = ["2026-01-02T02:50:00.000Z", "2026-01-02T02:55:00.000Z"];
  const older = ["2026-01-01T02:50:00.000Z", "2026-01-01T02:55:00.000Z"];

  const recentSize = effectiveSampleSize(recent, now, 3600);
  const olderSize = effectiveSampleSize(older, now, 3600);

  assert.ok(olderSize < recentSize, `${olderSize} should be below ${recentSize}`);
  assert.ok(recentSize < recent.length, `${recentSize} should be below the raw count`);
});

test("readRestrictionWindowRows returns sanitized classes inside the window only", async () => {
  const { databaseFile, seed } = await makeSeededDatabase();
  seed([
    {
      id: 1,
      started_at: "2026-01-01T20:00:00.000Z",
      outcome: "restricted",
      restrictions: [{ class: "rate_limit" }],
    },
    {
      id: 2,
      started_at: "2026-01-02T01:00:00.000Z",
      outcome: "restricted",
      restrictions: [{ class: "rate_limit", source_code: "429" }],
    },
    {
      id: 3,
      started_at: "2026-01-02T02:00:00.000Z",
      outcome: "restricted",
      restrictions: [{ class: "plan_limit", source_code: "403" }],
    },
  ]);
  const window = { from: "2026-01-01T22:04:05.000Z", to: "2026-01-02T03:04:05.000Z" };

  const rows = readRestrictionWindowRows(databaseFile, "work", window);

  assert.deepEqual(rows, [
    {
      prompt_execution_id: 2,
      class: "rate_limit",
      source_code: "429",
      observed_at: "2026-01-02T01:00:00.000Z",
    },
    {
      prompt_execution_id: 3,
      class: "plan_limit",
      source_code: "403",
      observed_at: "2026-01-02T02:00:00.000Z",
    },
  ]);
});

test("summarizeUsageProfile groups observed restrictions by explicit class", async () => {
  const { databaseFile, seed } = await makeSeededDatabase();
  seed([
    {
      id: 1,
      started_at: "2026-01-02T01:00:00.000Z",
      outcome: "restricted",
      restrictions: [{ class: "rate_limit" }],
    },
    {
      id: 2,
      started_at: "2026-01-02T01:30:00.000Z",
      outcome: "restricted",
      restrictions: [{ class: "rate_limit" }],
    },
    {
      id: 3,
      started_at: "2026-01-02T02:00:00.000Z",
      outcome: "restricted",
      restrictions: [{ class: "plan_limit" }],
    },
  ]);
  const window = { from: "2026-01-01T22:04:05.000Z", to: "2026-01-02T03:04:05.000Z" };

  const profile = summarizeUsageProfile(
    readUsageWindowRows(databaseFile, "work", window),
    readRestrictionWindowRows(databaseFile, "work", window),
    { horizon: "PT5H", window },
  );

  assert.deepEqual(profile.restrictions_by_class, { plan_limit: 1, rate_limit: 2 });
});

test("summarizeUsageProfile totals observed cost per currency without converting", async () => {
  const { databaseFile, seed } = await makeSeededDatabase();
  // 0.0021 + 0.00035 + 1.5 = 1.50245 exactly; binary floating point would drift here.
  seed([
    {
      id: 1,
      started_at: "2026-01-02T01:00:00.000Z",
      slices: [{ cost_decimal: "0.0021", currency: "USD" }],
    },
    {
      id: 2,
      started_at: "2026-01-02T01:10:00.000Z",
      slices: [
        { cost_decimal: "0.00035", currency: "USD" },
        { cost_decimal: "1.5", currency: "USD" },
      ],
    },
    {
      id: 3,
      started_at: "2026-01-02T01:20:00.000Z",
      slices: [{ cost_decimal: "0.75", currency: "EUR" }],
    },
    { id: 4, started_at: "2026-01-02T01:30:00.000Z", slices: [{ cost_decimal: null }] },
  ]);
  const window = { from: "2026-01-01T22:04:05.000Z", to: "2026-01-02T03:04:05.000Z" };

  const profile = summarizeUsageProfile(readUsageWindowRows(databaseFile, "work", window), [], {
    horizon: "PT5H",
    window,
  });

  assert.deepEqual(profile.cost, {
    by_currency: { EUR: "0.75", USD: "1.50245" },
    sample_size: 4,
    missing: 1,
    complete: false,
  });
});

test("summarizeUsageProfile reports freshness and decayed eligible sample size", async () => {
  const { databaseFile, seed } = await makeSeededDatabase();
  seed([
    {
      id: 1,
      started_at: "2026-01-02T02:04:05.000Z",
      completed_at: "2026-01-02T02:04:10.000Z",
      outcome: "success",
    },
    {
      id: 2,
      started_at: "2026-01-02T01:04:05.000Z",
      completed_at: "2026-01-02T01:04:06.000Z",
      outcome: "restricted",
    },
    {
      id: 3,
      started_at: "2026-01-02T03:00:00.000Z",
      completed_at: "2026-01-02T03:00:00.000Z",
      outcome: "excluded",
    },
  ]);
  const window = { from: "2026-01-01T22:04:05.000Z", to: "2026-01-02T03:04:05.000Z" };

  const profile = summarizeUsageProfile(readUsageWindowRows(databaseFile, "work", window), [], {
    horizon: "PT5H",
    window,
    now: new Date("2026-01-02T03:04:05.000Z"),
    halfLifeSeconds: 3600,
  });

  // Freshness follows the newest observation of any outcome.
  assert.deepEqual(profile.freshness, { as_of: "2026-01-02T03:00:00.000Z", age_seconds: 245 });
  // Only eligible prompts decay into evidence: 0.5 (one hour old) + 0.25 (two hours old).
  assert.equal(profile.effective_sample_size, 0.75);
});

test("a late-arriving prompt yields the same profile as in-order ingestion", async () => {
  /** @type {SeedPrompt[]} */
  const prompts = [
    {
      id: 1,
      started_at: "2026-01-02T01:00:00.000Z",
      duration_ms: 120,
      slices: [{ input_tokens: 10, cost_decimal: "0.01", currency: "USD" }],
    },
    {
      id: 2,
      started_at: "2026-01-02T01:30:00.000Z",
      duration_ms: 500,
      outcome: "restricted",
      restrictions: [{ class: "rate_limit" }],
      slices: [{ input_tokens: 30 }],
    },
    {
      id: 3,
      started_at: "2026-01-02T02:00:00.000Z",
      duration_ms: 90,
      outcome: "excluded",
      slices: [{ input_tokens: 5, cost_decimal: "0.2", currency: "USD" }],
    },
    {
      id: 4,
      started_at: "2026-01-02T02:30:00.000Z",
      duration_ms: 310,
      slices: [{ output_tokens: 7 }],
    },
  ];
  const window = { from: "2026-01-01T22:04:05.000Z", to: "2026-01-02T03:04:05.000Z" };
  const options = {
    horizon: "PT5H",
    window,
    now: new Date("2026-01-02T03:04:05.000Z"),
    halfLifeSeconds: 3600,
  };

  /**
   * @param {SeedPrompt[]} order ingestion order
   * @param {(rows: import("../src/storage.js").UsageWindowRow[]) => import("../src/storage.js").UsageWindowRow[]} [reorder]
   */
  const profileFor = async (order, reorder = (rows) => rows) => {
    const { databaseFile, seed } = await makeSeededDatabase();
    for (const prompt of order) {
      seed([prompt]);
    }
    return summarizeUsageProfile(
      reorder(readUsageWindowRows(databaseFile, "work", window)),
      readRestrictionWindowRows(databaseFile, "work", window),
      options,
    );
  };

  const expected = await profileFor(prompts);

  await fc.assert(
    fc.asyncProperty(
      fc.shuffledSubarray(prompts, { minLength: 4 }),
      fc.shuffledSubarray([0, 1, 2, 3], { minLength: 4 }),
      async (ingestionOrder, readOrder) => {
        const profile = await profileFor(ingestionOrder, (rows) =>
          readOrder.map(
            (index) => /** @type {import("../src/storage.js").UsageWindowRow} */ (rows[index]),
          ),
        );
        assert.deepEqual(profile, expected);
      },
    ),
    { numRuns: 12 },
  );
});
