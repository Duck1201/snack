import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, test } from "node:test";

import Database from "better-sqlite3";
import fc from "fast-check";

import {
  ANALYTICS_POLICY,
  COMPARISON_POLICY,
  TREND_POLICY,
  assignPressureBands,
  compareOutcomeGroups,
  computeUsagePressure,
  computeUsageTrend,
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
    unit: "prompts",
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

  assert.deepEqual(profile.restrictions.by_class, { plan_limit: 1, rate_limit: 2 });
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
  assert.equal(profile.effective_sample_size.value, 0.75);
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

test("computeUsagePressure ranks each dimension against its own local baseline", () => {
  // percentile rank = (below + ties / 2) / n, the mean convention.
  // prompts: baseline [10, 20, 30, 40], observed 30 -> (2 + 0.5) / 4 = 0.625
  // input_tokens: baseline [100, 200], observed 50 -> (0 + 0) / 2 = 0
  const pressure = computeUsagePressure({
    current: { prompts: 30, input_tokens: 50 },
    baselines: { prompts: [10, 20, 30, 40], input_tokens: [100, 200] },
    profileWeights: { prompts: 1, input_tokens: 1 },
    effectiveSampleSize: 0,
  });

  assert.deepEqual(
    pressure.contributors.map(({ dimension, percentile, baseline_sample }) => ({
      dimension,
      percentile,
      baseline_sample,
    })),
    [
      { dimension: "prompts", percentile: 0.625, baseline_sample: 4 },
      { dimension: "input_tokens", percentile: 0, baseline_sample: 2 },
    ],
  );
});

test("plan profile weights blend toward neutral as local evidence grows", () => {
  // Normalized profile weights are 0.75 / 0.25; the neutral vector is 0.5 / 0.5.
  // t = ess / (ess + k) with k = 10, so ess 0 -> t 0 and ess 10 -> t 0.5.
  const input = {
    current: { prompts: 1, input_tokens: 1 },
    baselines: { prompts: [0], input_tokens: [0] },
    profileWeights: { prompts: 3, input_tokens: 1 },
  };

  const withoutEvidence = computeUsagePressure({ ...input, effectiveSampleSize: 0 });
  const withEvidence = computeUsagePressure({ ...input, effectiveSampleSize: 10 });

  assert.deepEqual(
    withoutEvidence.contributors.map(({ dimension, weight }) => ({ dimension, weight })),
    [
      { dimension: "prompts", weight: 0.75 },
      { dimension: "input_tokens", weight: 0.25 },
    ],
  );
  assert.deepEqual(
    withEvidence.contributors.map(({ dimension, weight }) => ({ dimension, weight })),
    [
      { dimension: "prompts", weight: 0.625 },
      { dimension: "input_tokens", weight: 0.375 },
    ],
  );
});

test("more local evidence never moves a weight away from neutral", () => {
  fc.assert(
    fc.property(
      fc.double({ min: 0, max: 10_000, noNaN: true }),
      fc.double({ min: 0, max: 10_000, noNaN: true }),
      (first, second) => {
        const [lower, higher] = first <= second ? [first, second] : [second, first];
        const input = {
          current: { prompts: 1, input_tokens: 1 },
          baselines: { prompts: [0], input_tokens: [0] },
          profileWeights: { prompts: 3, input_tokens: 1 },
        };
        const weightAt = (/** @type {number} */ ess) =>
          /** @type {number} */ (
            computeUsagePressure({ ...input, effectiveSampleSize: ess }).contributors[0]?.weight
          );

        // The dominant profile weight starts above neutral and only ever descends toward it.
        assert.ok(weightAt(higher) <= weightAt(lower) + Number.EPSILON);
        assert.ok(weightAt(higher) >= 0.5 - Number.EPSILON);
      },
    ),
    { numRuns: 100 },
  );
});

test("computeUsagePressure combines ranked dimensions into a versioned band", () => {
  // percentiles 0.625 and 0, equal weights 0.5 -> score 0.3125, which is the low band.
  const pressure = computeUsagePressure({
    current: { prompts: 30, input_tokens: 50 },
    baselines: { prompts: [10, 20, 30, 40], input_tokens: [100, 200] },
    profileWeights: { prompts: 1, input_tokens: 1 },
    effectiveSampleSize: 0,
  });

  assert.equal(pressure.score, 0.3125);
  assert.equal(pressure.band, "low");
  assert.equal(pressure.policy_version, "stage4-analytics-v1");
  assert.equal(pressure.baseline_kind, "local");
  assert.equal(pressure.completeness, "complete");
  assert.deepEqual(
    pressure.contributors.map(({ dimension, contribution }) => ({ dimension, contribution })),
    [
      { dimension: "prompts", contribution: 0.3125 },
      { dimension: "input_tokens", contribution: 0 },
    ],
  );
});

test("a dimension without local history is reported, not scored as zero", () => {
  const pressure = computeUsagePressure({
    current: { prompts: 30, input_tokens: 50 },
    baselines: { prompts: [10, 20, 30, 40] },
    profileWeights: { prompts: 1, input_tokens: 1 },
    effectiveSampleSize: 0,
  });

  // Only the ranked dimension can carry the score; the unranked one stays unknown.
  assert.equal(pressure.score, 0.625);
  assert.equal(pressure.completeness, "partial");
  assert.deepEqual(
    pressure.contributors.map(({ dimension, percentile, contribution }) => ({
      dimension,
      percentile,
      contribution,
    })),
    [
      { dimension: "prompts", percentile: 0.625, contribution: 0.625 },
      { dimension: "input_tokens", percentile: null, contribution: null },
    ],
  );
});

test("usage pressure with no local history reports an unknown band", () => {
  const pressure = computeUsagePressure({
    current: { prompts: 30 },
    baselines: {},
    profileWeights: { prompts: 1 },
    effectiveSampleSize: 0,
  });

  assert.equal(pressure.band, "unknown");
  assert.equal(pressure.score, null);
  assert.equal(pressure.baseline_kind, "none");
});

test("pressure bands follow the versioned boundaries", () => {
  /** @param {number} percentile */
  const bandFor = (percentile) =>
    computeUsagePressure({
      current: { prompts: percentile },
      baselines: { prompts: [percentile - 1, percentile + 1] },
      profileWeights: { prompts: 1 },
      effectiveSampleSize: 0,
    }).band;

  // A two-sample baseline puts the observed value at exactly 0.5.
  assert.equal(bandFor(10), "moderate");
  assert.deepEqual(
    [0.49, 0.5, 0.74, 0.75, 0.89, 0.9].map((score) => bandForScore(score)),
    ["low", "moderate", "moderate", "elevated", "elevated", "high"],
  );
});

/** @param {number} score */
function bandForScore(score) {
  // Rank one observation against a baseline built so its percentile equals `score`.
  const below = Math.round(score * 100);
  const baseline = Array.from({ length: 100 }, (_, index) => (index < below ? 0 : 2));
  return computeUsagePressure({
    current: { prompts: 1 },
    baselines: { prompts: baseline },
    profileWeights: { prompts: 1 },
    effectiveSampleSize: 0,
  }).band;
}

test("usage pressure output never claims a share of real provider capacity", () => {
  const pressure = computeUsagePressure({
    current: { prompts: 30, input_tokens: 50 },
    baselines: { prompts: [10, 20, 30, 40], input_tokens: [100, 200] },
    profileWeights: { prompts: 1, input_tokens: 1 },
    effectiveSampleSize: 4,
  });

  // CONTEXT.md forbids these words for usage pressure; real capacity stays unknown.
  assert.doesNotMatch(
    JSON.stringify(pressure),
    /quota|capacity|remaining|utilization|percentage/iu,
  );
  assert.ok(/** @type {number} */ (pressure.score) >= 0);
  assert.ok(/** @type {number} */ (pressure.score) <= 1);
});

test("pressure never leaves [0, 1] and never falls when observed usage rises", () => {
  fc.assert(
    fc.property(
      fc.array(fc.double({ min: 0, max: 1e6, noNaN: true }), { minLength: 1, maxLength: 60 }),
      fc.double({ min: 0, max: 1e6, noNaN: true }),
      fc.double({ min: 0, max: 1e6, noNaN: true }),
      fc.double({ min: 0, max: 1e4, noNaN: true }),
      (baseline, observed, increase, ess) => {
        const scoreFor = (/** @type {number} */ value) =>
          /** @type {number} */ (
            computeUsagePressure({
              current: { prompts: value },
              baselines: { prompts: baseline },
              profileWeights: { prompts: 1 },
              effectiveSampleSize: ess,
            }).score
          );

        const score = scoreFor(observed);
        assert.ok(score >= 0 && score <= 1, `score ${score} outside [0, 1]`);
        assert.ok(scoreFor(observed + increase) >= score - Number.EPSILON);
      },
    ),
    { numRuns: 200 },
  );
});

test("steady usage sits in the middle bands instead of alarming", () => {
  // A stationary history: 30 windows of the same size, then one more of that size.
  const baseline = Array.from({ length: 30 }, () => 100);

  const pressure = computeUsagePressure({
    current: { prompts: 100 },
    baselines: { prompts: baseline },
    profileWeights: { prompts: 1 },
    effectiveSampleSize: 30,
  });

  assert.equal(pressure.score, 0.5);
  assert.equal(pressure.band, "moderate");
});

test("a window far above every past window reaches the high band", () => {
  const baseline = Array.from({ length: 30 }, (_, index) => 10 + index);

  const pressure = computeUsagePressure({
    current: { prompts: 1000 },
    baselines: { prompts: baseline },
    profileWeights: { prompts: 1 },
    effectiveSampleSize: 30,
  });

  assert.equal(pressure.score, 1);
  assert.equal(pressure.band, "high");
});

/**
 * Deterministic PRNG so simulation evidence is reproducible.
 *
 * @param {number} seed
 */
function mulberry32(seed) {
  let state = seed;
  return () => {
    state = (state + 0x6d2b79f5) | 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

test("simulation: the decay half-life keeps a steady user's evidence near its daily rate", () => {
  // Prompts spaced d days apart form a geometric series with ratio 2^(-d / H), so the
  // settled effective sample size is 1 / (1 - 2^(-d / H)). With H = 1 day and rate r per
  // day, d = 1 / r.
  const now = new Date("2026-02-01T00:00:00.000Z");
  const halfLife = ANALYTICS_POLICY.decay_half_life_seconds;

  for (const perDay of [1, 5, 10, 40]) {
    const timestamps = [];
    for (let promptIndex = 0; promptIndex < perDay * 60; promptIndex += 1) {
      const secondsAgo = (promptIndex / perDay) * 86400;
      timestamps.push(new Date(now.getTime() - secondsAgo * 1000).toISOString());
    }
    const ess = effectiveSampleSize(timestamps, now, halfLife);
    const spacingInHalfLives = 86400 / perDay / halfLife;
    const expected = 1 / (1 - Math.pow(2, -spacingInHalfLives));

    assert.ok(
      Math.abs(ess - expected) / expected < 0.01,
      `rate ${perDay}/day settled at ESS ${ess}, expected about ${expected}`,
    );
  }
});

test("simulation: a moderate daily rate moves pressure weights off the plan profile", () => {
  // Evidence that the half-life and blend constant work together: an occasional user
  // keeps leaning on the profile, while a moderate user is mostly driven by local data.
  const now = new Date("2026-02-01T00:00:00.000Z");
  /** @param {number} perDay */
  const blendFor = (perDay) => {
    const timestamps = Array.from({ length: perDay * 60 }, (_, index) =>
      new Date(now.getTime() - (index / perDay) * 86400 * 1000).toISOString(),
    );
    const ess = effectiveSampleSize(timestamps, now, ANALYTICS_POLICY.decay_half_life_seconds);
    return ess / (ess + ANALYTICS_POLICY.weight_blend_equivalent_samples);
  };

  assert.ok(blendFor(1) < 0.2, `an occasional user blended ${blendFor(1)} away from the profile`);
  assert.ok(blendFor(10) > 0.5, `a moderate user only blended ${blendFor(10)}`);
  assert.ok(blendFor(40) > 0.8, `a heavy user only blended ${blendFor(40)}`);
});

test("simulation: band boundaries produce a sane alarm rate on stationary usage", () => {
  // Under stationary usage a new window ranks uniformly against its own history, so the
  // boundaries decide how often each band fires. 0.5 / 0.75 / 0.9 target 50/25/15/10.
  const random = mulberry32(20260201);
  /** @type {Record<string, number>} */
  const counts = { low: 0, moderate: 0, elevated: 0, high: 0 };
  const trials = 4000;

  for (let trial = 0; trial < trials; trial += 1) {
    const baseline = Array.from({ length: 40 }, () => random());
    const { band } = computeUsagePressure({
      current: { prompts: random() },
      baselines: { prompts: baseline },
      profileWeights: { prompts: 1 },
      effectiveSampleSize: 40,
    });
    counts[band] = (counts[band] ?? 0) + 1;
  }

  const share = (/** @type {string} */ band) => (counts[band] ?? 0) / trials;
  assert.ok(Math.abs(share("low") - 0.5) < 0.03, `low fired ${share("low")}`);
  assert.ok(Math.abs(share("moderate") - 0.25) < 0.03, `moderate fired ${share("moderate")}`);
  assert.ok(Math.abs(share("elevated") - 0.15) < 0.03, `elevated fired ${share("elevated")}`);
  assert.ok(Math.abs(share("high") - 0.1) < 0.03, `high fired ${share("high")}`);
});

test("observed cost without a reported currency is kept under an unknown currency", async () => {
  const { databaseFile, seed } = await makeSeededDatabase();
  // OpenCode reports a cost but never a currency, so requiring one would drop the cost.
  seed([
    {
      id: 1,
      started_at: "2026-01-02T01:00:00.000Z",
      slices: [{ cost_decimal: "0.003", currency: null }],
    },
    {
      id: 2,
      started_at: "2026-01-02T01:10:00.000Z",
      slices: [{ cost_decimal: "0.007", currency: null }],
    },
    {
      id: 3,
      started_at: "2026-01-02T01:20:00.000Z",
      slices: [{ cost_decimal: "1.5", currency: "USD" }],
    },
  ]);
  const window = { from: "2026-01-01T22:04:05.000Z", to: "2026-01-02T03:04:05.000Z" };

  const profile = summarizeUsageProfile(readUsageWindowRows(databaseFile, "work", window), [], {
    horizon: "PT5H",
    window,
  });

  // Unknown-currency costs total together but never merge with a named currency.
  assert.deepEqual(profile.cost, {
    by_currency: { USD: "1.5", unknown: "0.01" },
    sample_size: 3,
    missing: 0,
    complete: true,
  });
});

test("every reported statistic declares its unit and sample size", async () => {
  const { databaseFile, seed } = await makeSeededDatabase();
  seed([
    { id: 1, started_at: "2026-01-02T01:00:00.000Z", duration_ms: 100 },
    {
      id: 2,
      started_at: "2026-01-02T01:10:00.000Z",
      outcome: "restricted",
      restrictions: [{ class: "rate_limit" }],
    },
    { id: 3, started_at: "2026-01-02T01:20:00.000Z", outcome: "excluded" },
  ]);
  const window = { from: "2026-01-01T22:04:05.000Z", to: "2026-01-02T03:04:05.000Z" };

  const profile = summarizeUsageProfile(
    readUsageWindowRows(databaseFile, "work", window),
    readRestrictionWindowRows(databaseFile, "work", window),
    { horizon: "PT5H", window, now: new Date("2026-01-02T03:04:05.000Z"), halfLifeSeconds: 3600 },
  );

  assert.equal(profile.prompts.unit, "prompts");
  assert.deepEqual(profile.restrictions, {
    by_class: { rate_limit: 1 },
    unit: "restrictions",
    sample_size: 1,
  });
  assert.equal(profile.effective_sample_size.unit, "prompts");
  assert.equal(profile.effective_sample_size.sample_size, 2);
  assert.ok(profile.effective_sample_size.value < 2);

  // No statistic may be a bare number without a declared unit.
  for (const [name, value] of Object.entries(profile)) {
    if (typeof value === "number") {
      assert.fail(`${name} is a bare number without a unit`);
    }
  }
});

test("pressure contributors reproduce from the published policy", () => {
  fc.assert(
    fc.property(
      fc.array(fc.double({ min: 0, max: 1000, noNaN: true }), { minLength: 3, maxLength: 40 }),
      fc.double({ min: 0, max: 1000, noNaN: true }),
      fc.double({ min: 0, max: 1000, noNaN: true }),
      fc.double({ min: 0, max: 500, noNaN: true }),
      (baseline, observedPrompts, observedTokens, ess) => {
        const pressure = computeUsagePressure({
          current: { prompts: observedPrompts, input_tokens: observedTokens },
          baselines: { prompts: baseline, input_tokens: baseline },
          profileWeights: { prompts: 3, input_tokens: 1 },
          effectiveSampleSize: ess,
        });

        // The score is exactly the sum of the published contributions.
        const summed = pressure.contributors.reduce(
          (total, contributor) => total + (contributor.contribution ?? 0),
          0,
        );
        assert.ok(
          Math.abs(summed - /** @type {number} */ (pressure.score)) < 1e-9,
          `contributions ${summed} do not reproduce score ${pressure.score}`,
        );

        // The band follows from the score and the boundaries the policy publishes,
        // independently of how the code classified it.
        const { moderate, elevated, high } = ANALYTICS_POLICY.pressure_bands;
        const score = /** @type {number} */ (pressure.score);
        const expected =
          score < moderate
            ? "low"
            : score < elevated
              ? "moderate"
              : score < high
                ? "elevated"
                : "high";
        assert.equal(pressure.band, expected);
        assert.equal(pressure.policy_version, ANALYTICS_POLICY.version);
      },
    ),
    { numRuns: 200 },
  );
});

const bandOrigin = "2026-01-01T00:00:00.000Z";
const bandWindowSeconds = 3600;

/**
 * Builds prompts placed in fixed hourly windows counted from the origin.
 *
 * @param {number[]} countsPerWindow
 * @returns {{started_at: string}[]}
 */
function promptsInWindows(countsPerWindow) {
  /** @type {{started_at: string}[]} */
  const rows = [];
  for (const [windowIndex, count] of countsPerWindow.entries()) {
    for (let index = 0; index < count; index += 1) {
      const offset = (windowIndex * bandWindowSeconds + index) * 1000;
      rows.push({ started_at: new Date(Date.parse(bandOrigin) + offset).toISOString() });
    }
  }
  return rows;
}

test("historical pressure bands rank a window against the windows before it", () => {
  // Six quiet windows establish the baseline, then a burst arrives.
  const counts = [1, 1, 1, 1, 1, 1, 20];
  const banded = assignPressureBands(promptsInWindows(counts), {
    origin: bandOrigin,
    windowSeconds: bandWindowSeconds,
  });

  const bandOf = (/** @type {number} */ windowIndex) => {
    const before = counts.slice(0, windowIndex).reduce((sum, value) => sum + value, 0);
    return banded[before]?.pressure_band;
  };

  // The first windows cannot be ranked: fewer baseline windows than the policy requires.
  assert.equal(bandOf(0), "unknown");
  assert.equal(bandOf(ANALYTICS_POLICY.pressure_minimum_baseline_windows - 1), "unknown");
  assert.equal(bandOf(6), "high");
  assert.equal(
    banded.length,
    counts.reduce((sum, value) => sum + value, 0),
  );
});

test("a pressure band never depends on prompts that came after it", () => {
  const counts = [2, 2, 2, 2, 2, 2, 3, 1];
  const rows = promptsInWindows(counts);
  const options = { origin: bandOrigin, windowSeconds: bandWindowSeconds };

  const prefix = rows.slice(0, -1);
  const withFuture = assignPressureBands(rows, options).slice(0, prefix.length);
  const withoutFuture = assignPressureBands(prefix, options);

  assert.deepEqual(withFuture, withoutFuture);
});

test("pressure bands are independent of the order rows arrive in", () => {
  const rows = promptsInWindows([1, 3, 1, 4, 1, 5, 9, 2]);
  const options = { origin: bandOrigin, windowSeconds: bandWindowSeconds };
  const shuffled = [...rows].reverse();

  const direct = assignPressureBands(rows, options);
  const reordered = assignPressureBands(shuffled, options);

  assert.deepEqual(
    [...reordered].sort((left, right) => left.started_at.localeCompare(right.started_at)),
    [...direct].sort((left, right) => left.started_at.localeCompare(right.started_at)),
  );
});

test("a usage trend ranks every compared window against one shared baseline", () => {
  // Scoring each window against its own preceding history would rank them on different
  // scales, and the sequence would not mean anything. Identical windows must score
  // identically, which is only true when the baseline is shared.
  const baseline = Array.from({ length: 20 }, (_unused, index) => 100 + index);
  const identical = Array.from({ length: TREND_POLICY.windows }, () => ({ prompts: 110 }));

  const trend = computeUsageTrend({
    windows: identical,
    baselines: { prompts: baseline },
    profileWeights: { prompts: 1 },
    effectiveSampleSize: 0,
  });

  assert.equal(trend.status, "observed");
  assert.equal(trend.direction, "steady");
  assert.equal(new Set(trend.scores).size, 1);
  assert.equal(trend.windows_compared, TREND_POLICY.windows);
  assert.equal(trend.baseline_windows, 20);
  assert.equal(trend.policy_version, TREND_POLICY.version);
});

test("a usage trend reports direction from the sequence of comparable scores", () => {
  const baseline = Array.from({ length: 20 }, (_unused, index) => 100 + index * 5);
  /** @param {number[]} levels */
  const directionFor = (levels) =>
    computeUsageTrend({
      windows: levels.map((prompts) => ({ prompts })),
      baselines: { prompts: baseline },
      profileWeights: { prompts: 1 },
      effectiveSampleSize: 0,
    }).direction;

  assert.equal(directionFor([100, 120, 140, 160, 180]), "rising");
  assert.equal(directionFor([180, 160, 140, 120, 100]), "falling");
  assert.equal(directionFor([150, 150, 150, 150, 150]), "steady");
  // A single step out of line does not make a direction; a strict majority does.
  assert.equal(directionFor([100, 120, 110, 160, 180]), "rising");
});

test("a usage trend admits it cannot see past the top of its own baseline", () => {
  // Every compared window clears the whole baseline, so every percentile saturates at 1 and
  // the steps between them are all zero. Reporting `steady` here would read as reassurance
  // while usage was in fact climbing hard; the direction is simply not observable.
  const baseline = Array.from({ length: 20 }, () => 100);
  const climbing = [200, 400, 800, 1600, 3200].map((prompts) => ({ prompts }));

  const trend = computeUsageTrend({
    windows: climbing,
    baselines: { prompts: baseline },
    profileWeights: { prompts: 1 },
    effectiveSampleSize: 0,
  });

  assert.equal(trend.status, "not_available");
  assert.equal(trend.direction, null);
  assert.equal(trend.reason, "above_baseline");
});

test("a usage trend refuses to invent a direction it cannot see", () => {
  const baseline = Array.from({ length: 20 }, (_unused, index) => 100 + index);

  const tooFewWindows = computeUsageTrend({
    windows: [{ prompts: 150 }, { prompts: 160 }],
    baselines: { prompts: baseline },
    profileWeights: { prompts: 1 },
    effectiveSampleSize: 0,
  });
  const noBaseline = computeUsageTrend({
    windows: Array.from({ length: TREND_POLICY.windows }, () => ({ prompts: 150 })),
    baselines: { prompts: [] },
    profileWeights: { prompts: 1 },
    effectiveSampleSize: 0,
  });

  // `steady` is a claim. Absence of evidence reports itself instead of borrowing one.
  assert.equal(tooFewWindows.status, "not_available");
  assert.equal(tooFewWindows.direction, null);
  assert.equal(tooFewWindows.reason, "insufficient_windows");
  assert.equal(noBaseline.status, "not_available");
  assert.equal(noBaseline.direction, null);
  assert.equal(noBaseline.reason, "insufficient_baseline");
});

test("simulation: a usage trend stays steady on stationary usage and rises on a real rise", () => {
  // Evidence for TREND_POLICY.windows and the strict-majority rule. A gentle rise is the case
  // that decides the window count: three windows report it barely more often than a coin, and
  // seven go blind on a steep one once the percentile saturates.
  const random = mulberry32(20260501);
  const trials = 2000;
  let steadyOnStationary = 0;
  /** @type {Record<string, number>} */
  const risingOnRise = { 0.1: 0, 0.2: 0, 0.5: 0 };

  for (let trial = 0; trial < trials; trial += 1) {
    const baseline = Array.from({ length: 20 }, () => 100 * (0.5 + random()));
    const directionFor = (/** @type {number[]} */ levels) =>
      computeUsageTrend({
        windows: levels.map((prompts) => ({ prompts })),
        baselines: { prompts: baseline },
        profileWeights: { prompts: 1 },
        effectiveSampleSize: 0,
      }).direction;

    const stationary = Array.from({ length: TREND_POLICY.windows }, () => 100 * (0.5 + random()));
    if (directionFor(stationary) === "steady") steadyOnStationary += 1;

    for (const growth of [0.1, 0.2, 0.5]) {
      // Starts below the baseline median so it has room to climb through it.
      const rising = Array.from(
        { length: TREND_POLICY.windows },
        (_unused, index) => 55 * (0.95 + 0.1 * random()) * Math.pow(1 + growth, index),
      );
      if (directionFor(rising) === "rising") {
        risingOnRise[String(growth)] = (risingOnRise[String(growth)] ?? 0) + 1;
      }
    }
  }

  assert.ok(
    steadyOnStationary / trials > 0.6,
    `stationary usage reported a direction too often: steady ${steadyOnStationary / trials}`,
  );
  assert.ok(
    (risingOnRise["0.1"] ?? 0) / trials > 0.6,
    `a gentle rise went unreported: ${(risingOnRise["0.1"] ?? 0) / trials}`,
  );
  for (const growth of ["0.2", "0.5"]) {
    assert.ok(
      (risingOnRise[growth] ?? 0) / trials > 0.9,
      `a ${growth} rise went unreported: ${(risingOnRise[growth] ?? 0) / trials}`,
    );
  }
});

test("a usage profile breaks usage down by model without losing the unknowns", () => {
  const rows = [
    {
      prompt_execution_id: 1,
      capacity_period_id: 1,
      started_at: "2026-01-02T01:00:00.000Z",
      completed_at: "2026-01-02T01:00:05.000Z",
      duration_ms: 5000,
      outcome: "success",
      installation_id: null,
      slices: [
        sliceOf({ model: "sonnet", input_tokens: 100, output_tokens: 20, cost_decimal: "0.003" }),
        sliceOf({ model: "haiku", input_tokens: 10, output_tokens: 5, cost_decimal: "0.0001" }),
      ],
    },
    {
      prompt_execution_id: 2,
      capacity_period_id: 1,
      started_at: "2026-01-02T02:00:00.000Z",
      completed_at: "2026-01-02T02:00:05.000Z",
      duration_ms: 5000,
      outcome: "success",
      installation_id: null,
      slices: [
        sliceOf({ model: "sonnet", input_tokens: 300, output_tokens: null, cost_decimal: null }),
        sliceOf({ model: null, input_tokens: 7, output_tokens: 1, cost_decimal: "0.5" }),
      ],
    },
  ];

  const profile = summarizeUsageProfile(rows, [], {
    horizon: "PT5H",
    window: { from: "2026-01-02T00:00:00.000Z", to: "2026-01-02T05:00:00.000Z" },
    now: new Date("2026-01-02T05:00:00.000Z"),
  });
  const byModel = Object.fromEntries(profile.by_model.map((entry) => [entry.model, entry]));

  // A prompt can span several models, so the unit is usage slices rather than prompts.
  assert.deepEqual(Object.keys(byModel).sort(), ["haiku", "sonnet", "unknown"]);
  assert.equal(byModel.sonnet?.slices.count, 2);
  assert.equal(byModel.sonnet?.slices.unit, "usage slices");
  assert.deepEqual(byModel.sonnet?.dimensions.input_tokens, {
    value: 400,
    unit: "tokens",
    sample_size: 2,
    missing: 0,
    complete: true,
  });
  // A model that reported one of two output counts says so instead of totalling to a number
  // that looks complete.
  assert.deepEqual(byModel.sonnet?.dimensions.output_tokens, {
    value: 20,
    unit: "tokens",
    sample_size: 1,
    missing: 1,
    complete: false,
  });
  assert.deepEqual(byModel.sonnet?.cost.by_currency, { unknown: "0.003" });
  // A slice whose model the source never named is grouped explicitly, never dropped.
  assert.equal(byModel.unknown?.slices.count, 1);
  assert.deepEqual(byModel.unknown?.cost.by_currency, { unknown: "0.5" });
  // The per-model totals must still add up to the profile totals.
  const inputTokens = (/** @type {unknown} */ dimension) =>
    Number(/** @type {{value?: number}} */ (dimension)?.value ?? 0);
  assert.equal(
    profile.by_model.reduce(
      (total, entry) => total + inputTokens(entry.dimensions.input_tokens),
      0,
    ),
    inputTokens(profile.dimensions.input_tokens),
  );
});

test("two clients refused at the same rate on one source show no detected difference", () => {
  // Two clients competing for one real capacity should look alike, and saying so is the useful
  // answer most of the time. A comparison that flagged a difference here would flag one on every
  // shared source, which is the same as reporting nothing at all.
  const comparison = compareOutcomeGroups([
    { key: "installation-opencode", outcomes: outcomesWith({ restricted: 10, success: 90 }) },
    { key: "installation-claude", outcomes: outcomesWith({ restricted: 10, success: 90 }) },
  ]);

  assert.equal(comparison.policy_version, COMPARISON_POLICY.version);
  assert.equal(comparison.status, "ok");
  assert.deepEqual(
    comparison.groups.map((group) => group.difference),
    ["not_detected", "not_detected"],
  );
  assert.deepEqual(
    comparison.groups.map((group) => ({ eligible: group.eligible, restricted: group.restricted })),
    [
      { eligible: 100, restricted: 10 },
      { eligible: 100, restricted: 10 },
    ],
  );
});

test("a client refused far more often than the others is flagged beside its interval and sample size", () => {
  // The reportable case: one client is refused at four times the rate of the other on the same
  // capacity, with enough observations behind both that the intervals separate. The verdict is
  // never delivered bare -- the count, the denominator and the interval travel with it, so a reader
  // can see how much evidence produced it instead of taking the label on faith.
  const comparison = compareOutcomeGroups([
    { key: "installation-opencode", outcomes: outcomesWith({ restricted: 5, success: 195 }) },
    { key: "installation-claude", outcomes: outcomesWith({ restricted: 40, success: 160 }) },
  ]);

  assert.equal(comparison.status, "ok");
  const claude = comparison.groups.find((group) => group.key === "installation-claude");
  const openCode = comparison.groups.find((group) => group.key === "installation-opencode");
  assert.equal(claude?.difference, "higher_than_others");
  assert.equal(openCode?.difference, "lower_than_others");
  assert.equal(claude?.restricted, 40);
  assert.equal(claude?.eligible, 200);
  assert.equal(claude?.restriction_share.value, 0.2);
  // The interval brackets the observed share rather than restating it, and the two do not overlap.
  assert.ok(claude.restriction_share.lower < 0.2 && claude.restriction_share.upper > 0.2);
  assert.ok(claude.restriction_share.lower > openCode.restriction_share.upper);
});

test("a client with too few eligible prompts is reported as not comparable, not as no difference", () => {
  // "No difference detected" is a finding; "not enough evidence to look" is not the same finding,
  // and collapsing the two would let a client nobody has data about read as a client that behaves
  // like the rest. The prompts it did contribute are still reported, because they are real.
  const comparison = compareOutcomeGroups([
    { key: "installation-opencode", outcomes: outcomesWith({ restricted: 20, success: 180 }) },
    { key: "installation-claude", outcomes: outcomesWith({ restricted: 1, success: 3 }) },
  ]);

  assert.equal(comparison.status, "not_comparable");
  assert.equal(comparison.reason, "insufficient_evidence");
  const claude = comparison.groups.find((group) => group.key === "installation-claude");
  assert.equal(claude?.difference, "not_comparable");
  assert.equal(claude?.eligible, 4);
  assert.equal(claude?.restricted, 1);
});

test("observations that were excluded count as seen but never as refused", () => {
  // An excluded observation is one the product could not read as evidence either way. Counting it
  // as a refusal would invent restrictions the provider never issued; dropping it from the prompt
  // count would hide work the client really did.
  const comparison = compareOutcomeGroups([
    {
      key: "installation-opencode",
      outcomes: outcomesWith({ restricted: 10, success: 90, excluded: 50 }),
    },
    { key: "installation-claude", outcomes: outcomesWith({ restricted: 10, success: 90 }) },
  ]);

  const openCode = comparison.groups.find((group) => group.key === "installation-opencode");
  assert.equal(openCode?.prompts, 150);
  assert.equal(openCode?.eligible, 100);
  assert.equal(openCode?.restricted, 10);
  assert.equal(openCode?.difference, "not_detected");
});

/**
 * Build outcomes in the shape the readers produce, with only the fields the comparison reads.
 *
 * @param {{restricted: number, success: number, excluded?: number}} counts
 */
function outcomesWith(counts) {
  /** @type {import("../src/prediction.js").OutcomeRow[]} */
  const outcomes = [];
  let at = Date.parse("2026-01-02T00:00:00.000Z");
  /** @param {"restricted" | "success" | "excluded"} outcome @param {number} total */
  const push = (outcome, total) => {
    for (let index = 0; index < total; index += 1) {
      at += 60_000;
      outcomes.push({ started_at: new Date(at).toISOString(), outcome });
    }
  };
  push("restricted", counts.restricted);
  push("success", counts.success);
  push("excluded", counts.excluded ?? 0);
  return outcomes;
}

/** @param {Partial<import("../src/storage.js").UsageSliceRow>} overrides */
function sliceOf(overrides) {
  return {
    source_slice_id: `slice-${Math.random()}`,
    provider: "anthropic",
    model: null,
    input_tokens: null,
    output_tokens: null,
    reasoning_tokens: null,
    cache_read_tokens: null,
    cache_write_tokens: null,
    cost_decimal: null,
    currency: null,
    ...overrides,
  };
}
