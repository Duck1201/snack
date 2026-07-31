import assert from "node:assert/strict";
import { test } from "node:test";

import { CALIBRATION_POLICY, backtest, summarizeCalibration } from "../src/calibration.js";

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
