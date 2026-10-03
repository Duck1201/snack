// `backtest` exactly as `v1.5.0` shipped it, frozen here so the shared walk that replaced it can be
// held to the released doubles, bit for bit (docs/history/specs/half-life-shadows/spec.md §5.2).
// Copied from `git show v1.5.0:packages/cli/src/calibration.js`; only the JSDoc import paths and
// the policy type were adapted to where it lives now.
import { CALIBRATION_POLICY, summarizeCalibration } from "../../src/calibration.js";
import { PREDICTION_POLICY, assembleForecast, chooseCell } from "../../src/prediction.js";

/** @typedef {import("../../src/calibration.js").ScoredForecast} ScoredForecast */

/**
 * Score a history by replaying it one prompt at a time.
 *
 * Each forecast is built from the observations that started strictly before the prompt it
 * predicts, with the clock set to that prompt's own start. This is what keeps a backtest
 * honest: nothing that happened later is visible to the forecast being scored, so adding
 * future history cannot change a past result.
 *
 * @param {import("../../src/prediction.js").OutcomeRow[]} outcomes
 * @param {{now: Date, prior: {strength: number, viability: number}, policy?: import("../../src/prediction.js").WeightingPolicy}} options
 * @returns {{forecasts: number, scored: ScoredForecast[], calibration: ReturnType<typeof summarizeCalibration>, policy_version: string}}
 */
export function backtestAsReleased(outcomes, options) {
  const policy = options.policy ?? PREDICTION_POLICY;
  const ordered = [...outcomes].sort((left, right) =>
    left.started_at.localeCompare(right.started_at),
  );

  // Each backoff level keeps its own decayed counts. Advancing the clock multiplies every
  // weight by the same factor, so the accumulators can be re-anchored in O(1) instead of
  // re-weighting the whole prefix at every step.
  const levels = new Map([["", createAccumulator()]]);
  /** @param {string} key */
  const accumulatorFor = (key) => {
    const existing = levels.get(key);
    if (existing) return existing;
    const created = createAccumulator();
    levels.set(key, created);
    return created;
  };

  /** @type {ScoredForecast[]} */
  const scored = [];
  for (const [index, row] of ordered.entries()) {
    const at = Date.parse(row.started_at);
    const band = row.pressure_band ?? "unknown";
    const category = row.size_category ?? "typical";

    if (index >= CALIBRATION_POLICY.minimum_backtest_history && row.outcome !== "excluded") {
      const candidates = [
        { level: "period_band_category", key: `${band}\u0000${category}` },
        { level: "period_band", key: band },
        { level: "period", key: "" },
      ].map(({ level, key }) => ({
        level,
        cell: readAccumulator(accumulatorFor(key), at, policy.decay_half_life_seconds),
      }));
      const forecast = assembleForecast({
        ...chooseCell(candidates, policy),
        prior: options.prior,
        policy,
        dataCompleteness: "unknown",
      });
      scored.push({
        lower: forecast.viability.lower,
        point: forecast.viability.point,
        upper: forecast.viability.upper,
        outcome: row.outcome,
      });
    }

    for (const key of [`${band}\u0000${category}`, band, ""]) {
      observe(accumulatorFor(key), row.outcome, at, policy);
    }
  }

  return {
    forecasts: scored.length,
    scored,
    calibration: summarizeCalibration(scored),
    policy_version: CALIBRATION_POLICY.version,
  };
}

/**
 * Decayed counts for one backoff level, anchored at a point in time.
 *
 * @returns {{anchor: number, weightedSuccesses: number, weightedRestrictions: number, successes: number, restrictions: number, excluded: number}}
 */
function createAccumulator() {
  return {
    anchor: 0,
    weightedSuccesses: 0,
    weightedRestrictions: 0,
    successes: 0,
    restrictions: 0,
    excluded: 0,
  };
}

/**
 * Move an accumulator's anchor to a later time, decaying its weights by the shared factor.
 *
 * @param {ReturnType<typeof createAccumulator>} accumulator
 * @param {number} at
 * @param {number} halfLifeSeconds
 */
function reanchor(accumulator, at, halfLifeSeconds) {
  if (accumulator.anchor === 0 || at === accumulator.anchor) {
    accumulator.anchor = at;
    return;
  }
  const factor = 2 ** (-(at - accumulator.anchor) / 1000 / halfLifeSeconds);
  accumulator.weightedSuccesses *= factor;
  accumulator.weightedRestrictions *= factor;
  accumulator.anchor = at;
}

/**
 * Push every stored observation one position further into the past.
 *
 * Recency decay counts prompts, not seconds, so recording an observation is what ages the
 * ones before it. Applying the factor to the running totals is exactly equivalent to
 * re-weighting each observation individually.
 *
 * @param {ReturnType<typeof createAccumulator>} accumulator
 * @param {number} recencyHalfLifePrompts
 */
function supersede(accumulator, recencyHalfLifePrompts) {
  const factor = 2 ** (-1 / recencyHalfLifePrompts);
  accumulator.weightedSuccesses *= factor;
  accumulator.weightedRestrictions *= factor;
}

/**
 * @param {ReturnType<typeof createAccumulator>} accumulator
 * @param {"success" | "restricted" | "excluded"} outcome
 * @param {number} at
 * @param {{decay_half_life_seconds: number, recency_half_life_prompts: number}} policy
 */
function observe(accumulator, outcome, at, policy) {
  if (outcome === "excluded") {
    accumulator.excluded += 1;
    return;
  }
  reanchor(accumulator, at, policy.decay_half_life_seconds);
  supersede(accumulator, policy.recency_half_life_prompts);
  if (outcome === "success") {
    accumulator.successes += 1;
    accumulator.weightedSuccesses += 1;
  } else {
    accumulator.restrictions += 1;
    accumulator.weightedRestrictions += 1;
  }
}

/**
 * @param {ReturnType<typeof createAccumulator>} accumulator
 * @param {number} at
 * @param {number} halfLifeSeconds
 * @returns {import("../../src/prediction.js").ForecastCell}
 */
function readAccumulator(accumulator, at, halfLifeSeconds) {
  reanchor(accumulator, at, halfLifeSeconds);
  return {
    prompts_considered: accumulator.successes + accumulator.restrictions + accumulator.excluded,
    limit_prompts: PREDICTION_POLICY.evidence_window_prompts,
    successes: accumulator.successes,
    restrictions: accumulator.restrictions,
    excluded: accumulator.excluded,
    weighted_successes: accumulator.weightedSuccesses,
    weighted_restrictions: accumulator.weightedRestrictions,
    effective_samples: accumulator.weightedSuccesses + accumulator.weightedRestrictions,
    alpha: 0,
    beta: 0,
  };
}
