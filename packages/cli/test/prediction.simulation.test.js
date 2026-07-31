import assert from "node:assert/strict";
import { test } from "node:test";

import { PREDICTION_POLICY, buildForecast } from "../src/prediction.js";

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

const now = new Date("2026-02-01T00:00:00.000Z");
const day = 86_400_000;

/**
 * Draws a history of one cell at a fixed true restriction rate.
 *
 * @param {() => number} random
 * @param {number} count
 * @param {number} restrictionRate
 * @param {number} spanDays How far back the observations spread.
 * @param {number} [offsetDays] Age of the most recent observation.
 * @returns {import("../src/prediction.js").OutcomeRow[]}
 */
function drawHistory(random, count, restrictionRate, spanDays, offsetDays = 0) {
  return Array.from({ length: count }, (_unused, index) => ({
    started_at: new Date(
      now.getTime() - offsetDays * day - ((index + 1) / count) * spanDays * day,
    ).toISOString(),
    outcome: /** @type {"success" | "restricted"} */ (
      random() < restrictionRate ? "restricted" : "success"
    ),
    pressure_band: "moderate",
    size_category: "typical",
  }));
}

/**
 * @param {import("../src/prediction.js").OutcomeRow[]} outcomes
 * @returns {import("../src/prediction.js").Forecast}
 */
function forecastOf(outcomes) {
  return buildForecast({
    now,
    // The bundled generic plan profile carries prior_strength 1.
    prior: { strength: 1, viability: 0.5 },
    expectedBand: "moderate",
    expectedCategory: "typical",
    outcomes,
    dataCompleteness: "complete",
  });
}

// Evidence for PREDICTION_POLICY.coverage_target: the credible interval must contain the
// true viability at least as often as it claims, across the restriction rates a real
// source shows, and must not be so wide that it always contains it.
//
// Measured with this seed at 1500 trials per rate: coverage 0.911 / 0.880 / 0.863 / 0.864
// and mean width 0.090 / 0.123 / 0.162 / 0.230 for rates 0.02 / 0.05 / 0.1 / 0.25. The
// interval runs conservative — decay shrinks the effective sample size below the raw
// count — so the declared 0.8 target is a floor, not a promise of exactness.
test("simulation: interval coverage holds at the declared target", () => {
  const random = mulberry32(20260201);
  const trials = 1500;
  /** @type {Record<string, {covered: number, width: number}>} */
  const perRate = {};

  for (const restrictionRate of [0.02, 0.05, 0.1, 0.25]) {
    let covered = 0;
    let width = 0;
    for (let trial = 0; trial < trials; trial += 1) {
      const count = 10 + Math.floor(random() * 50);
      const result = forecastOf(drawHistory(random, count, restrictionRate, 7));
      const trueViability = 1 - restrictionRate;
      if (result.viability.lower <= trueViability && trueViability <= result.viability.upper) {
        covered += 1;
      }
      width += result.viability.upper - result.viability.lower;
    }
    perRate[String(restrictionRate)] = { covered: covered / trials, width: width / trials };
  }

  for (const [rate, { covered, width }] of Object.entries(perRate)) {
    assert.ok(
      covered >= PREDICTION_POLICY.coverage_target - 0.05,
      `rate ${rate} covered ${covered}, below target ${PREDICTION_POLICY.coverage_target}`,
    );
    assert.ok(width < 0.35, `rate ${rate} interval is uninformatively wide: ${width}`);
  }
});

// Evidence for PREDICTION_POLICY.decay_half_life_seconds: after a regime change, one week
// of fresh observations must dominate an equally sized stale history.
test("simulation: the decay half-life lets a regime change take over within a week", () => {
  const random = mulberry32(20260202);
  const halfLifeDays = PREDICTION_POLICY.decay_half_life_seconds / 86_400;
  const stale = drawHistory(random, 40, 0.5, halfLifeDays, 3 * halfLifeDays);
  const fresh = drawHistory(random, 40, 0.02, halfLifeDays);

  const before = forecastOf(stale);
  const after = forecastOf([...stale, ...fresh]);

  assert.ok(before.viability.point < 0.65, `stale regime point ${before.viability.point}`);
  assert.ok(after.viability.point > 0.85, `post-change point ${after.viability.point}`);
});

// Evidence for the weak plan-profile prior: it must steer the forecast while history is
// thin and stop mattering once a cell is populated.
test("simulation: the weak prior fades as local evidence accumulates", () => {
  const random = mulberry32(20260203);
  const optimistic = { strength: 1, viability: 0.95 };
  const pessimistic = { strength: 1, viability: 0.5 };

  /**
   * @param {number} count
   * @returns {number}
   */
  function priorSpread(count) {
    const outcomes = drawHistory(random, count, 0.05, 2);
    const shared = {
      now,
      expectedBand: "moderate",
      expectedCategory: "typical",
      outcomes,
      dataCompleteness: /** @type {"complete"} */ ("complete"),
    };
    return Math.abs(
      buildForecast({ ...shared, prior: optimistic }).viability.point -
        buildForecast({ ...shared, prior: pessimistic }).viability.point,
    );
  }

  assert.ok(priorSpread(1) > 0.05, `prior barely moves a nearly empty cell: ${priorSpread(1)}`);
  assert.ok(
    priorSpread(PREDICTION_POLICY.minimum_cell_samples * 8) < 0.02,
    `prior still dominates a populated cell: ${priorSpread(PREDICTION_POLICY.minimum_cell_samples * 8)}`,
  );
});
