import assert from "node:assert/strict";
import { test } from "node:test";

import { EVIDENCE_POLICY, PREDICTION_POLICY, buildForecast } from "../src/prediction.js";

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

const bands = ["low", "moderate", "elevated", "high"];
const MINUTE = 60_000;

/**
 * Replay a history one prompt at a time and score each forecast against the true viability
 * it was generated with.
 *
 * @param {{random: () => number, count: number, gapMinutes: number, viabilityOf: (band: string) => number}} setup
 * @returns {{rows: import("../src/prediction.js").OutcomeRow[], scored: {level: string, backoff: string, error: number, covered: boolean, ess: number}[]}}
 */
function replay(setup) {
  const start = Date.parse("2026-01-01T00:00:00.000Z");
  /** @type {(import("../src/prediction.js").OutcomeRow & {truth: number})[]} */
  const rows = [];
  for (let index = 0; index < setup.count; index += 1) {
    const band = bands[Math.floor(setup.random() * bands.length)] ?? "moderate";
    const truth = setup.viabilityOf(band);
    rows.push({
      started_at: new Date(start + index * setup.gapMinutes * MINUTE).toISOString(),
      outcome: setup.random() < truth ? "success" : "restricted",
      pressure_band: band,
      size_category: "typical",
      truth,
    });
  }

  const scored = rows.slice(10).map((row, offset) => {
    const forecast = buildForecast({
      now: new Date(Date.parse(row.started_at)),
      prior: { strength: 1, viability: 0.5 },
      expectedBand: row.pressure_band ?? "moderate",
      expectedCategory: "typical",
      outcomes: rows.slice(0, offset + 10),
      dataCompleteness: "complete",
    });
    return {
      level: forecast.evidence.level,
      backoff: forecast.contributors.backoff_level,
      error: Math.abs(forecast.viability.point - row.truth),
      covered: forecast.viability.lower <= row.truth && row.truth <= forecast.viability.upper,
      ess: forecast.contributors.cell.effective_samples,
    };
  });
  return { rows, scored };
}

// Evidence for EVIDENCE_POLICY.sample_thresholds: the ladder has to mean something. A
// level that claims more evidence must actually forecast better.
//
// The comparison is made within one true viability and one backoff level at a time. Across
// regimes it would be confounded: a very safe source produces almost no restrictions, so it
// stays capped low while also being the easiest regime to predict. Across backoff levels it
// would be confounded too: the period aggregate is capped at very_low because pooling
// unlike cells is dangerous, yet in a simulation where cells behave identically the
// aggregate is the best-informed estimate available.
test("simulation: a higher evidence level forecasts measurably better", () => {
  const random = mulberry32(20260807);
  /** @type {string[]} */
  const comparisons = [];

  for (const viability of [0.96, 0.9, 0.8]) {
    /** @type {Map<string, {n: number, error: number}>} */
    const byLevel = new Map();
    for (let repetition = 0; repetition < 8; repetition += 1) {
      for (const entry of replay({
        random,
        count: 400,
        gapMinutes: 20,
        viabilityOf: () => viability,
      }).scored) {
        // Controlled for specificity as well: a forecast from the period aggregate is
        // capped at very_low for a reason unrelated to how much evidence it has, and in a
        // homogeneous simulation the aggregate is the best-informed cell there is.
        if (entry.backoff !== "period_band_category") continue;
        const bucket = byLevel.get(entry.level) ?? { n: 0, error: 0 };
        bucket.n += 1;
        bucket.error += entry.error;
        byLevel.set(entry.level, bucket);
      }
    }

    const meanError = (/** @type {string} */ level) => {
      const bucket = byLevel.get(level);
      return bucket && bucket.n > 100 ? bucket.error / bucket.n : null;
    };
    const ladder = EVIDENCE_POLICY.levels
      .map((level) => ({ level, error: meanError(level) }))
      .filter((entry) => entry.error !== null);

    assert.ok(
      ladder.length >= 2,
      `viability ${viability} exercised only ${ladder.length} level(s)`,
    );
    for (let index = 1; index < ladder.length; index += 1) {
      const weaker = ladder[index - 1];
      const stronger = ladder[index];
      comparisons.push(
        `viability ${viability}: ${weaker?.level} ${weaker?.error?.toFixed(4)} -> ${stronger?.level} ${stronger?.error?.toFixed(4)}`,
      );
      assert.ok(
        (stronger?.error ?? 1) < (weaker?.error ?? 0),
        `at viability ${viability}, ${stronger?.level} (${stronger?.error}) did not beat ${weaker?.level} (${weaker?.error})`,
      );
    }
  }

  assert.ok(comparisons.length >= 3, comparisons.join("; "));
});

// Evidence for EVIDENCE_POLICY.relevance_ceilings: pooling cells that behave differently
// produces an interval that misses the truth, so the aggregate cannot claim real evidence.
test("simulation: the period aggregate is unreliable when cells differ", () => {
  const random = mulberry32(20260808);
  /** @type {Map<string, {n: number, covered: number}>} */
  const byBackoff = new Map();
  const perBand = { low: 0.99, moderate: 0.96, elevated: 0.88, high: 0.62 };

  for (let repetition = 0; repetition < 10; repetition += 1) {
    for (const entry of replay({
      random,
      count: 600,
      gapMinutes: 6,
      viabilityOf: (band) => perBand[/** @type {keyof typeof perBand} */ (band)] ?? 0.9,
    }).scored) {
      const bucket = byBackoff.get(entry.backoff) ?? { n: 0, covered: 0 };
      bucket.n += 1;
      bucket.covered += entry.covered ? 1 : 0;
      byBackoff.set(entry.backoff, bucket);
    }
  }

  const aggregate = byBackoff.get("period");
  const cell = byBackoff.get("period_band_category");
  assert.ok(aggregate && cell, `backoff levels seen: ${[...byBackoff.keys()]}`);
  assert.ok(
    aggregate.covered / aggregate.n < 0.5,
    `the aggregate covered ${aggregate.covered / aggregate.n}, which would not justify capping it`,
  );
  assert.ok(cell.covered / cell.n > 0.75, `the cell covered only ${cell.covered / cell.n}`);
});

// Evidence for PREDICTION_POLICY.recency_half_life_prompts: the forecast must stop calling
// a collapsed source safe, and it must do so after a similar number of prompts whatever
// the user's cadence, which elapsed-time decay alone cannot deliver.
test("simulation: a collapse is admitted within a bounded number of prompts at any cadence", () => {
  const start = Date.parse("2026-01-01T00:00:00.000Z");

  for (const gapMinutes of [6, 120]) {
    const random = mulberry32(20260809);
    let stillSafeAfterTwenty = 0;
    const repetitions = 25;

    for (let repetition = 0; repetition < repetitions; repetition += 1) {
      /** @type {import("../src/prediction.js").OutcomeRow[]} */
      const rows = [];
      for (let index = 0; index < 200; index += 1) {
        rows.push({
          started_at: new Date(start + index * gapMinutes * MINUTE).toISOString(),
          outcome: random() < 0.99 ? "success" : "restricted",
          pressure_band: "moderate",
          size_category: "typical",
        });
      }
      for (let index = 0; index <= 20; index += 1) {
        const at = new Date(start + (200 + index) * gapMinutes * MINUTE);
        if (index === 20) {
          const forecast = buildForecast({
            now: at,
            prior: { strength: 1, viability: 0.5 },
            expectedBand: "moderate",
            expectedCategory: "typical",
            outcomes: rows,
            dataCompleteness: "complete",
          });
          if (forecast.viability.lower > 0.9) stillSafeAfterTwenty += 1;
        }
        rows.push({
          started_at: at.toISOString(),
          outcome: random() < 0.7 ? "success" : "restricted",
          pressure_band: "moderate",
          size_category: "typical",
        });
      }
    }

    // Twenty prompts into a collapse from 0.99 to 0.70 the run has seen roughly six
    // refusals, but an unlucky stretch can still show two, and a forecast that stays
    // optimistic on that evidence is defensible. What must not happen is the old
    // behaviour: with elapsed-time decay alone every single run still called the source
    // safe at both cadences. Measured here: 1/25 at six minutes, 0/25 at two hours.
    assert.ok(
      stillSafeAfterTwenty <= repetitions * 0.08,
      `at a ${gapMinutes}-minute cadence, ${stillSafeAfterTwenty}/${repetitions} runs still claimed a lower bound above 0.9 twenty prompts after viability fell to 0.7`,
    );
  }
});
