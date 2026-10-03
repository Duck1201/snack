import assert from "node:assert/strict";
import { test } from "node:test";

import fc from "fast-check";

import {
  CALIBRATION_POLICY,
  backtest,
  backtestReported,
  backtestWeightings,
  liveByMethod,
  scoreVariant,
  summarizeCalibration,
} from "../src/calibration.js";
import { PREDICTION_POLICY, WEIGHTING_VARIANTS, buildForecast } from "../src/prediction.js";
import { backtestAsReleased } from "./fixtures/backtest-1.5.0.js";
import { labelStatedBands } from "../src/reported-capacity.js";

/**
 * The replay as `stats` runs it: each prompt labelled with the band it began in, as of its start.
 *
 * @param {Parameters<typeof labelStatedBands>[0]} rows
 * @param {import("../src/reported-capacity.js").Statement[]} timeline
 * @param {{prior: {strength: number, viability: number}, periodStart: string | null}} options
 */
function replayReported(rows, timeline, options) {
  return backtestReported(labelStatedBands(rows, timeline, { periodStart: options.periodStart }), {
    prior: options.prior,
    baseline: backtest(rows, { now: new Date(), prior: options.prior }).scored,
  });
}

/**
 * @param {number} point
 * @param {"success" | "restricted"} outcome
 * @param {number} [halfWidth]
 * @returns {import("../src/calibration.js").ScoredForecast}
 */
function scored(point, outcome, halfWidth = 0.1) {
  return {
    lower: Math.max(0, point - halfWidth),
    point,
    upper: Math.min(1, point + halfWidth),
    outcome,
  };
}

test("the Brier score is the mean squared error of the forecast probabilities", () => {
  // 0.9 vs 1 -> 0.01; 0.8 vs 0 -> 0.64; 0.5 vs 1 -> 0.25; 0.2 vs 0 -> 0.04.
  // The sum is 0.94, so the mean over four forecasts is 0.235.
  const result = summarizeCalibration([
    scored(0.9, "success"),
    scored(0.8, "restricted"),
    scored(0.5, "success"),
    scored(0.2, "restricted"),
  ]);

  assert.ok(
    Math.abs((result.brier.value ?? Number.NaN) - 0.235) < 1e-12,
    `brier ${result.brier.value}`,
  );
  assert.equal(result.brier.sample_size, 4);
});

test("calibration is not available rather than zero when nothing was forecast", () => {
  const result = summarizeCalibration([]);

  assert.equal(result.brier.value, null);
  assert.equal(result.brier.sample_size, 0);
  assert.equal(result.status, "not_available");
  assert.deepEqual(result.reliability, []);
  assert.equal(result.interval.coverage, null);
});

test("reliability buckets report the observed rate beside the forecast and its count", () => {
  // Three forecasts land in the half-open 0.8-0.9 bucket, two of which succeeded: the
  // bucket claims (0.81 + 0.85 + 0.89) / 3 = 0.85 on average and observes 2/3.
  const result = summarizeCalibration([
    scored(0.81, "success"),
    scored(0.85, "success"),
    scored(0.89, "restricted"),
    scored(0.1, "restricted"),
  ]);

  const busy = result.reliability.find((bucket) => bucket.sample_size === 3);
  assert.ok(busy, JSON.stringify(result.reliability));
  assert.equal(busy.bucket, "0.8-0.9");
  assert.ok(Math.abs(busy.forecast_mean - 0.85) < 1e-12, `mean ${busy.forecast_mean}`);
  assert.ok(Math.abs(busy.observed_rate - 2 / 3) < 1e-12, `rate ${busy.observed_rate}`);

  const sparse = result.reliability.find((bucket) => bucket.bucket === "0.1-0.2");
  assert.equal(sparse?.sample_size, 1);
  assert.equal(sparse?.observed_rate, 0);
  assert.equal(result.reliability.length, 2, "only populated buckets are reported");
});

test("interval coverage compares each bucket's observed rate with its own interval", () => {
  // The 0.8-0.9 bucket forecasts [0.75, 0.95] and observes 2/3 = 0.667, which falls
  // outside it. The 0.6-0.7 bucket forecasts [0.55, 0.75] and observes 0.667, inside it.
  const result = summarizeCalibration([
    scored(0.85, "success", 0.1),
    scored(0.85, "success", 0.1),
    scored(0.85, "restricted", 0.1),
    scored(0.65, "success", 0.1),
    scored(0.65, "success", 0.1),
    scored(0.65, "restricted", 0.1),
  ]);

  assert.equal(result.interval.buckets_evaluated, 2);
  assert.ok(
    Math.abs((result.interval.coverage ?? Number.NaN) - 0.5) < 1e-12,
    `coverage ${result.interval.coverage}`,
  );
  assert.ok(
    Math.abs((result.interval.mean_width ?? Number.NaN) - 0.2) < 1e-12,
    `width ${result.interval.mean_width}`,
  );
  assert.equal(result.interval.sample_size, 6);
});

test("excluded outcomes never enter a calibration figure", () => {
  const withExcluded = summarizeCalibration([
    scored(0.9, "success"),
    { ...scored(0.9, "success"), outcome: "excluded" },
  ]);
  const withoutExcluded = summarizeCalibration([scored(0.9, "success")]);

  assert.deepEqual(withExcluded.brier, withoutExcluded.brier);
  assert.equal(withExcluded.excluded, 1);
});

const backtestNow = new Date("2026-03-01T00:00:00.000Z");

/**
 * @param {("success" | "restricted")[]} outcomes
 * @returns {import("../src/prediction.js").OutcomeRow[]}
 */
function series(outcomes) {
  return outcomes.map((outcome, index) => ({
    started_at: new Date(Date.parse("2026-02-01T00:00:00.000Z") + index * 3_600_000).toISOString(),
    outcome,
    pressure_band: "moderate",
    size_category: "typical",
  }));
}

const backtestOptions = { now: backtestNow, prior: { strength: 1, viability: 0.5 } };

test("backtesting scores each prompt with a forecast built before it", () => {
  const outcomes = series(Array.from({ length: 30 }, () => "success"));

  const result = backtest(outcomes, backtestOptions);

  assert.equal(result.forecasts, 30 - CALIBRATION_POLICY.minimum_backtest_history);
  assert.equal(result.calibration.brier.sample_size, result.forecasts);
  assert.equal(result.calibration.status, "ok");
});

test("backtesting reports nothing rather than a figure it cannot support", () => {
  const result = backtest(series(["success", "restricted"]), backtestOptions);

  assert.equal(result.forecasts, 0);
  assert.equal(result.calibration.status, "not_available");
  assert.equal(result.calibration.brier.value, null);
});

// The defining property of rolling-origin evaluation: a forecast made at time t must be
// identical whether or not the observations after t exist yet.
test("no observation after a prompt can change the forecast made for it", () => {
  const early = series([
    "success",
    "restricted",
    "success",
    "success",
    "restricted",
    "success",
    "success",
    "success",
    "restricted",
    "success",
    "success",
    "success",
  ]);
  const late = [
    ...early,
    ...series(Array.from({ length: 20 }, () => "restricted")).map((row) => ({
      ...row,
      started_at: new Date(Date.parse(row.started_at) + 30 * 3_600_000).toISOString(),
    })),
  ];

  const withoutFuture = backtest(early, backtestOptions);
  const withFuture = backtest(late, backtestOptions);

  assert.deepEqual(withFuture.scored.slice(0, withoutFuture.scored.length), withoutFuture.scored);
});

test("backtesting a long history stays linear in the number of prompts", () => {
  const short = series(
    Array.from({ length: 400 }, (_u, index) => (index % 40 === 0 ? "restricted" : "success")),
  );
  const long = series(
    Array.from({ length: 1600 }, (_u, index) => (index % 40 === 0 ? "restricted" : "success")),
  );

  const time = (/** @type {import("../src/prediction.js").OutcomeRow[]} */ rows) => {
    const startedAt = process.hrtime.bigint();
    backtest(rows, backtestOptions);
    return Number(process.hrtime.bigint() - startedAt) / 1e6;
  };

  // Both sizes are warmed, then measured interleaved, and each is read as its fastest run.
  //
  // The first version of this warmed only `short` and then timed `long` cold, so the larger input
  // paid JIT and allocation costs the smaller one had already paid, and the ratio it reported was
  // partly an artefact of the arrangement rather than of the algorithm. It measured 4.2-4.5 on an
  // idle machine against a threshold of 8 -- under two-fold headroom on a wall-clock comparison --
  // and a loaded macOS runner read 9.7 and failed the build on `main`.
  //
  // The second measured each size as a median of five consecutive runs, `short`'s all before
  // `long`'s, and still failed under CPU contention: a burst of load landing on `long`'s runs alone
  // moved its median and not `short`'s. Contention only ever adds time, so the fastest run is the
  // best estimate of what the replay costs, and alternating the two sizes makes a burst land on
  // both. The ratio of the minima is what is compared.
  //
  // The algorithm is linear, which is why this is a fix to the measurement rather than to the code:
  // measured across 400 to 6400 prompts the cost per prompt stays flat at 0.022-0.026 ms and each
  // doubling costs about 2.05x. The signal this test exists for -- a quadratic replay, 16x at four
  // times the input -- is nowhere near the noise floor once both sides are measured the same way.
  for (let run = 0; run < 3; run += 1) {
    time(short);
    time(long);
  }
  let shortMs = Number.POSITIVE_INFINITY;
  let longMs = Number.POSITIVE_INFINITY;
  for (let run = 0; run < 9; run += 1) {
    shortMs = Math.min(shortMs, time(short));
    longMs = Math.min(longMs, time(long));
  }
  shortMs = Math.max(shortMs, 1);

  // Four times the history must not cost sixteen times the work; a quadratic replay would.
  assert.ok(
    longMs / shortMs < 8,
    `400 prompts ${shortMs.toFixed(1)}ms, 1600 prompts ${longMs.toFixed(1)}ms`,
  );
});

test("the incremental replay scores exactly what a full recomputation would", () => {
  const rows = series(
    Array.from({ length: 60 }, (_u, index) => (index % 7 === 0 ? "restricted" : "success")),
  );

  const replay = backtest(rows, backtestOptions);
  const naive = rows.slice(CALIBRATION_POLICY.minimum_backtest_history).map((row, offset) => {
    const index = offset + CALIBRATION_POLICY.minimum_backtest_history;
    const forecast = buildForecast({
      now: new Date(Date.parse(row.started_at)),
      prior: backtestOptions.prior,
      expectedBand: row.pressure_band ?? "unknown",
      expectedCategory: row.size_category ?? "typical",
      outcomes: rows.slice(0, index),
      dataCompleteness: "unknown",
    });
    return {
      lower: forecast.viability.lower,
      point: forecast.viability.point,
      upper: forecast.viability.upper,
      outcome: row.outcome,
    };
  });

  // The replay accumulates decayed weights and re-anchors them; the recomputation sums the
  // whole prefix each time. The two are the same quantity in a different summation order,
  // so they agree to floating-point reassociation error, not bit for bit.
  assert.equal(replay.scored.length, naive.length);
  for (const [index, expected] of naive.entries()) {
    const actual = replay.scored[index];
    assert.equal(actual?.outcome, expected.outcome);
    for (const field of /** @type {const} */ (["lower", "point", "upper"])) {
      assert.ok(
        Math.abs((actual?.[field] ?? Number.NaN) - expected[field]) < 1e-12,
        `forecast ${index} ${field}: ${actual?.[field]} vs ${expected[field]}`,
      );
    }
  }
});

const PRIOR = { strength: 1, viability: 0.5 };
const START = Date.parse("2026-01-01T00:00:00.000Z");

/** @param {number} minutes */
const minute = (minutes) => new Date(START + minutes * 60_000).toISOString();

/**
 * @param {number} count
 * @param {(index: number) => "success" | "restricted" | "excluded"} [outcomeOf]
 */
function history(count, outcomeOf = (index) => (index % 9 === 4 ? "restricted" : "success")) {
  return Array.from({ length: count }, (_, index) => ({
    started_at: minute(index * 10),
    outcome: outcomeOf(index),
    size_category: "typical",
    installation_id: "codex-installation",
  }));
}

/**
 * @param {number} atMinute
 * @param {number} usedPercent
 * @returns {import("../src/reported-capacity.js").Statement}
 */
function stated(atMinute, usedPercent) {
  return {
    installation_id: "codex-installation",
    limit_id: "codex",
    observed_at: minute(atMinute),
    windows: [{ window_minutes: 300, used_percent: usedPercent, resets_at: null }],
  };
}

test("with no stated timeline the reported replay scores nothing, and the baseline's is unchanged", () => {
  fc.assert(
    fc.property(
      fc.array(fc.constantFrom("success", "restricted", "excluded"), { maxLength: 80 }),
      (outcomes) => {
        const rows = history(
          outcomes.length,
          (index) => /** @type {"success" | "restricted" | "excluded"} */ (outcomes[index]),
        );
        const before = backtest(rows, { now: new Date(), prior: PRIOR });
        const shadow = replayReported(rows, [], { prior: PRIOR, periodStart: null });
        assert.equal(shadow.forecasts, 0);
        assert.equal(shadow.paired.sample_size, 0);
        assert.deepEqual(backtest(rows, { now: new Date(), prior: PRIOR }), before);
      },
    ),
    { numRuns: 100 },
  );
});

test("the reported replay never reads a statement made at or after the prompt it scores", () => {
  const rows = history(60);
  // A statement a minute before every prompt, and one stamped exactly at every prompt's start.
  const timeline = rows
    .flatMap((row, index) => [
      {
        ...stated(0, (index * 13) % 101),
        observed_at: new Date(Date.parse(row.started_at) - 60_000).toISOString(),
      },
      { ...stated(0, 100), observed_at: row.started_at },
    ])
    .sort((left, right) => left.observed_at.localeCompare(right.observed_at));
  for (const length of [15, 30, 45, 60]) {
    const prefix = rows.slice(0, length);
    const last = /** @type {{started_at: string}} */ (prefix.at(-1)).started_at;
    const everything = replayReported(prefix, timeline, { prior: PRIOR, periodStart: null });
    const strictlyEarlier = replayReported(
      prefix,
      timeline.filter((statement) => statement.observed_at < last),
      { prior: PRIOR, periodStart: null },
    );
    assert.ok(everything.forecasts > 0, "vacuous: nothing was scored");
    assert.deepEqual(everything, strictlyEarlier, `prefix of ${length}`);
  }
});

test("the paired baseline in the reported replay is the baseline backtest at the same prompts", () => {
  const rows = history(80);
  // Fresh statements at every prompt but the first 40: the shadow replays the second half only.
  const timeline = rows.slice(40).map((row) => ({
    ...stated(0, 50),
    observed_at: new Date(Date.parse(row.started_at) - 60_000).toISOString(),
  }));
  const replay = replayReported(rows, timeline, { prior: PRIOR, periodStart: null });
  const baseline = backtest(rows, { now: new Date(), prior: PRIOR });
  assert.equal(replay.forecasts, 40);
  const tail = baseline.scored.slice(-40);
  assert.equal(replay.paired.sample_size, 40);
  assert.equal(replay.paired.baseline_brier, summarizeCalibration(tail).brier.value);
  assert.equal(replay.paired.restrictions, tail.filter((f) => f.outcome === "restricted").length);
});

test("each method's live stream has its own sample size, and the baseline folds in its heuristic", () => {
  /**
   * @param {string} method
   * @param {number | null} shadow
   * @param {"success" | "restricted"} outcome
   */
  const pair = (method, shadow, outcome) => ({
    lower: 0.6,
    point: 0.8,
    upper: 0.9,
    outcome,
    method_id: method,
    method_version: "1",
    shadow_method_id: shadow === null ? null : "reported-capacity",
    shadow_method_version: shadow === null ? null : "1",
    shadow_lower: shadow === null ? null : Math.max(0, shadow - 0.2),
    shadow_point: shadow,
    shadow_upper: shadow === null ? null : Math.min(1, shadow + 0.1),
  });
  const pairs = [
    pair("bayesian-pressure-band", 0.2, "restricted"),
    pair("initial-generic", null, "success"),
    pair("bayesian-pressure-band", 0.9, "success"),
    pair("bayesian-pressure-band", null, "success"),
    // A later version of the shadow is never pooled with version 1.
    { ...pair("bayesian-pressure-band", 0.5, "success"), shadow_method_version: "2" },
  ];
  const live = liveByMethod(pairs, { id: "reported-capacity", version: "1" });
  assert.equal(live.baseline.brier.sample_size, 5);
  assert.deepEqual(live.baseline, summarizeCalibration(pairs));
  assert.equal(live.shadow.brier.sample_size, 2);
  assert.equal(live.shadow.brier.value, ((0.2 - 0) ** 2 + (0.9 - 1) ** 2) / 2);
  assert.deepEqual(live.paired, {
    sample_size: 2,
    restrictions: 1,
    brier: live.shadow.brier.value,
    baseline_brier: ((0.8 - 0) ** 2 + (0.8 - 1) ** 2) / 2,
  });
});

test("the paired comparison scores the shadow and the baseline on the same outcomes", () => {
  /**
   * @param {string} method
   * @param {string} version
   * @param {number} shadow
   * @param {"success" | "restricted"} outcome
   */
  const pair = (method, version, shadow, outcome) => ({
    lower: 0.6,
    point: 0.8,
    upper: 0.9,
    outcome,
    method_id: method,
    method_version: version,
    shadow_method_id: "reported-capacity",
    shadow_method_version: "1",
    shadow_lower: Math.max(0, shadow - 0.2),
    shadow_point: shadow,
    shadow_upper: Math.min(1, shadow + 0.1),
  });
  const pairs = [
    pair("bayesian-pressure-band", "1", 0.9, "success"),
    pair("bayesian-pressure-band", "1", 0.3, "restricted"),
    // The shadow was computed beside an attempt no baseline version answered -- a later baseline
    // version, never pooled with this one. The shadow's own stream keeps it; the paired comparison
    // cannot, because the baseline has no forecast of its own on that outcome to set beside it.
    pair("bayesian-pressure-band", "2", 0.1, "restricted"),
  ];
  const live = liveByMethod(pairs, { id: "reported-capacity", version: "1" });
  assert.equal(live.shadow.brier.sample_size, 3);
  const both = pairs.slice(0, 2);
  assert.deepEqual(live.paired, {
    sample_size: 2,
    restrictions: 1,
    brier: ((0.9 - 1) ** 2 + (0.3 - 0) ** 2) / 2,
    baseline_brier: summarizeCalibration(both).brier.value,
  });
});

// --- Weighting variants: one walk, several weightings (1.6.0) ---

/** Arbitrary histories over two bands and three categories, out of order, with ties. */
const replayHistory = fc.array(
  fc.record({
    minute: fc.integer({ min: 0, max: 30 * 24 * 60 }),
    outcome: fc.constantFrom("success", "success", "success", "restricted", "excluded"),
    pressure_band: fc.option(fc.constantFrom("low", "moderate", "high"), { nil: undefined }),
    size_category: fc.option(fc.constantFrom("small", "typical", "large"), { nil: null }),
  }),
  // `size: "max"`, or fast-check's small default keeps most histories under the ten prompts a
  // replay needs before it scores anything, and the property holds over nothing.
  { minLength: 12, maxLength: 160, size: "max" },
);

/** @param {{minute: number, outcome: string, pressure_band?: string | undefined, size_category: string | null}[]} rows */
const asOutcomes = (rows) =>
  rows.map((row) => ({
    started_at: minute(row.minute),
    outcome: /** @type {"success" | "restricted" | "excluded"} */ (row.outcome),
    ...(row.pressure_band === undefined ? {} : { pressure_band: row.pressure_band }),
    size_category: row.size_category,
  }));

const POLICIES = [PREDICTION_POLICY, ...WEIGHTING_VARIANTS.map((variant) => variant.policy)];
/**
 * Not a shipped weighting: one whose time half-life differs from the answer's, so a walk that
 * re-anchored every slot with slot 0's time decay would score it wrongly and be seen to.
 */
const ONE_HOUR = Object.freeze({
  ...PREDICTION_POLICY,
  version: "test-time-1h",
  decay_half_life_seconds: 3600,
});

test("the shared walk scores every weighting exactly as the released backtest does, double for double", () => {
  const policies = [...POLICIES, ONE_HOUR];
  fc.assert(
    fc.property(replayHistory, (rows) => {
      const outcomes = asOutcomes(rows);
      const results = backtestWeightings(outcomes, { prior: PRIOR, policies });
      assert.equal(results.length, policies.length);
      for (const [index, policy] of policies.entries()) {
        const released = backtestAsReleased(outcomes, { now: new Date(), prior: PRIOR, policy });
        const result = /** @type {(typeof results)[number]} */ (results[index]);
        // Bit for bit: `deepStrictEqual` compares doubles with Object.is.
        assert.deepEqual(
          {
            forecasts: result.forecasts,
            scored: result.scored,
            calibration: result.calibration,
            policy_version: result.policy_version,
          },
          released,
          policy.version,
        );
        assert.deepEqual(backtest(outcomes, { now: new Date(), prior: PRIOR, policy }), released);
      }
    }),
    { numRuns: 200 },
  );
});

test("the shared walk is not vacuous: the weightings it scores really differ", () => {
  const outcomes = history(400, (index) =>
    index % 13 === 5 || index > 360 ? "restricted" : "success",
  );
  const [answer, hl50, hl100] = backtestWeightings(outcomes, { prior: PRIOR, policies: POLICIES });
  assert.ok(answer && hl50 && hl100);
  assert.equal(answer.forecasts, hl50.forecasts);
  assert.notDeepEqual(answer.scored, hl50.scored);
  assert.notDeepEqual(hl50.scored, hl100.scored);
});

test("a variant is scored only where its own ladder reads an outcome, paired with the answer there", () => {
  fc.assert(
    fc.property(replayHistory, (rows) => {
      const outcomes = asOutcomes(rows);
      const [answer, ...variants] = backtestWeightings(outcomes, {
        prior: PRIOR,
        policies: POLICIES,
      });
      assert.ok(answer);
      for (const variant of variants) {
        const scored = scoreVariant(variant, answer);
        const kept = variant.scored.filter((_forecast, index) => !variant.from_prior[index]);
        assert.deepEqual(scored.scored, kept);
        assert.equal(scored.forecasts, kept.length);
        assert.deepEqual(scored.calibration, summarizeCalibration(kept));
        /** @type {import("../src/calibration.js").ScoredForecast[]} */
        const baseline = answer.scored.filter((_forecast, index) => !variant.from_prior[index]);
        // The same outcomes on both sides, in the same order.
        assert.deepEqual(
          scored.paired,
          comparePairedOf(kept, baseline),
          "paired is not the answer at the variant's own prompts",
        );
        assert.deepEqual(
          kept.map((forecast) => forecast.outcome),
          baseline.map((forecast) => forecast.outcome),
        );
      }
    }),
    { numRuns: 150 },
  );
  // Non-vacuity: a history whose early prompts are all excluded scores prompts at the prior,
  // which the answer keeps (as `initial-generic@1`) and every variant leaves out.
  const outcomes = history(30, (index) => (index < 20 ? "excluded" : "success"));
  const [answer, hl50] = backtestWeightings(outcomes, { prior: PRIOR, policies: POLICIES });
  assert.ok(answer && hl50);
  assert.ok(hl50.from_prior.some(Boolean), "no prompt was scored at the prior");
  const scored = scoreVariant(hl50, answer);
  assert.ok(scored.forecasts < answer.forecasts);
});

/**
 * @param {import("../src/calibration.js").ScoredForecast[]} shadow
 * @param {import("../src/calibration.js").ScoredForecast[]} baseline
 */
function comparePairedOf(shadow, baseline) {
  return {
    sample_size: summarizeCalibration(shadow).brier.sample_size,
    restrictions: shadow.filter((forecast) => forecast.outcome === "restricted").length,
    brier: summarizeCalibration(shadow).brier.value,
    baseline_brier: summarizeCalibration(baseline).brier.value,
  };
}

test("a weighting variant's live stream reads its own rows, joined to the answer's pairs by attempt", () => {
  /**
   * @param {number} id
   * @param {string} method
   * @param {"success" | "restricted" | "excluded"} outcome
   */
  const pair = (id, method, outcome, version = "1") => ({
    prediction_attempt_id: id,
    lower: 0.6,
    point: 0.8,
    upper: 0.9,
    outcome,
    method_id: method,
    method_version: version,
    shadow_method_id: null,
    shadow_method_version: null,
    shadow_lower: null,
    shadow_point: null,
    shadow_upper: null,
  });
  const pairs = [
    pair(1, "bayesian-pressure-band", "success"),
    pair(2, "bayesian-pressure-band", "restricted"),
    pair(3, "initial-generic", "success"),
    pair(4, "bayesian-pressure-band", "success", "2"),
    pair(5, "bayesian-pressure-band", "excluded"),
  ];
  /** @param {number} id @param {string} method @param {number} point */
  const row = (id, method, point, version = "1") => ({
    prediction_attempt_id: id,
    method_id: method,
    method_version: version,
    lower: point - 0.1,
    point,
    upper: point + 0.05,
  });
  const rows = [
    row(1, "bayesian-pressure-band-hl50", 0.9),
    row(1, "bayesian-pressure-band-hl100", 0.7),
    row(2, "bayesian-pressure-band-hl50", 0.4),
    // Beside an attempt no baseline version answered: in the variant's own stream, not paired.
    row(4, "bayesian-pressure-band-hl50", 0.5),
    // A later version of the variant is never pooled with version 1.
    row(2, "bayesian-pressure-band-hl50", 0.1, "2"),
    row(5, "bayesian-pressure-band-hl50", 0.95),
  ];
  const method = { id: "bayesian-pressure-band-hl50", version: "1" };
  const live = liveByMethod(pairs, method, rows);
  // The answer's entry is the answer's whole stream, whatever the shadow rows.
  assert.deepEqual(live.baseline, summarizeCalibration(pairs.slice(0, 3).concat(pairs.slice(4))));
  assert.deepEqual(live.baseline, liveByMethod(pairs, method).baseline);
  assert.equal(live.shadow.brier.sample_size, 3);
  assert.equal(live.shadow.excluded, 1);
  assert.equal(live.shadow.brier.value, ((0.9 - 1) ** 2 + (0.4 - 0) ** 2 + (0.5 - 1) ** 2) / 3);
  assert.deepEqual(live.paired, {
    sample_size: 2,
    restrictions: 1,
    brier: ((0.9 - 1) ** 2 + (0.4 - 0) ** 2) / 2,
    baseline_brier: ((0.8 - 1) ** 2 + (0.8 - 0) ** 2) / 2,
  });
  // The other variant reads only its own row.
  const hl100 = liveByMethod(pairs, { id: "bayesian-pressure-band-hl100", version: "1" }, rows);
  assert.equal(hl100.shadow.brier.sample_size, 1);
  assert.equal(hl100.paired.sample_size, 1);
});
