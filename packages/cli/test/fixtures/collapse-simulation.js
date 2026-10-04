// The collapse test: the simulation the answer's 30-prompt recency half-life was chosen by, as a
// function of the policy, so the test that gates the answer and the promotion condition that gates
// a weighting variant (docs/history/specs/half-life-shadows/spec.md §6.1, condition 5) are one and
// the same computation. `npm run collapse:check` prints it for the answer and every variant.
//
// A source at 0.99 viability collapses to 0.70. Twenty prompts into the collapse the forecast has
// seen roughly six refusals; a run whose lower bound still sits above 0.9 there is still calling
// the collapsed source safe. Elapsed-time decay alone left every run doing so at both cadences.
import { buildForecast } from "../../src/prediction.js";

/** The test, fixed: changing any of it is a decision of the release that changes it. */
export const COLLAPSE_TEST = Object.freeze({
  seed: 20260809,
  start: "2026-01-01T00:00:00.000Z",
  /** Cadences gated, in minutes between prompts: an intense one and a two-hour one. */
  gated_cadences_minutes: Object.freeze([6, 120]),
  runs: 25,
  prompts_before: 200,
  viability_before: 0.99,
  viability_after: 0.7,
  /** The forecast is read at the start of the 21st collapsed prompt: twenty outcomes seen. */
  prompts_into_collapse: 20,
  safe_lower_bound: 0.9,
  /** At most this share of runs may still claim safety: 2 of 25. */
  max_still_safe_share: 0.08,
  prior: Object.freeze({ strength: 1, viability: 0.5 }),
});

/**
 * Deterministic PRNG so the simulation is reproducible.
 *
 * @param {number} seed
 */
export function mulberry32(seed) {
  let state = seed;
  return () => {
    state = (state + 0x6d2b79f5) | 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * How many runs still claim safety twenty prompts into a collapse, at one cadence.
 *
 * @param {import("../../src/prediction.js").WeightingPolicy} policy
 * @param {number} gapMinutes
 * @returns {number}
 */
export function stillSafeAfterCollapse(policy, gapMinutes) {
  const test = COLLAPSE_TEST;
  const start = Date.parse(test.start);
  const step = gapMinutes * 60_000;
  // Seeded afresh per cadence, so each cadence's runs are reproducible on their own.
  const random = mulberry32(test.seed);
  let stillSafe = 0;
  for (let repetition = 0; repetition < test.runs; repetition += 1) {
    /** @type {import("../../src/prediction.js").OutcomeRow[]} */
    const rows = [];
    for (let index = 0; index < test.prompts_before; index += 1) {
      rows.push({
        started_at: new Date(start + index * step).toISOString(),
        outcome: random() < test.viability_before ? "success" : "restricted",
        pressure_band: "moderate",
        size_category: "typical",
      });
    }
    for (let index = 0; index <= test.prompts_into_collapse; index += 1) {
      const at = new Date(start + (test.prompts_before + index) * step);
      if (index === test.prompts_into_collapse) {
        const forecast = buildForecast({
          now: at,
          prior: test.prior,
          expectedBand: "moderate",
          expectedCategory: "typical",
          outcomes: rows,
          dataCompleteness: "complete",
          policy,
        });
        if (forecast.viability.lower > test.safe_lower_bound) stillSafe += 1;
      }
      rows.push({
        started_at: at.toISOString(),
        outcome: random() < test.viability_after ? "success" : "restricted",
        pressure_band: "moderate",
        size_category: "typical",
      });
    }
  }
  return stillSafe;
}

/**
 * The collapse test for one policy: the count at every gated cadence, and whether it passes.
 *
 * @param {import("../../src/prediction.js").WeightingPolicy} policy
 * @returns {{policy_version: string, recency_half_life_prompts: number, runs: number, max_still_safe: number, cadences: {gap_minutes: number, still_safe: number, passes: boolean}[], passes: boolean}}
 */
export function runCollapseTest(policy) {
  const maxStillSafe = Math.floor(COLLAPSE_TEST.runs * COLLAPSE_TEST.max_still_safe_share);
  const cadences = COLLAPSE_TEST.gated_cadences_minutes.map((gapMinutes) => {
    const stillSafe = stillSafeAfterCollapse(policy, gapMinutes);
    return { gap_minutes: gapMinutes, still_safe: stillSafe, passes: stillSafe <= maxStillSafe };
  });
  return {
    policy_version: policy.version,
    recency_half_life_prompts: policy.recency_half_life_prompts,
    runs: COLLAPSE_TEST.runs,
    max_still_safe: maxStillSafe,
    cadences,
    passes: cadences.every((cadence) => cadence.passes),
  };
}
