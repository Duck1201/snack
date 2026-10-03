import {
  PREDICTION_POLICY,
  REPORTED_PREDICTION_POLICY,
  assembleForecast,
  chooseCell,
} from "./prediction.js";
import { REPORTED_CAPACITY_POLICY, REPORTED_EVIDENCE_RELEVANCE } from "./reported-capacity.js";

/**
 * Calibration of delivered forecasts against the outcomes that followed them.
 *
 * Accuracy is never the headline: restrictions are rare, so a constant "you are fine"
 * forecast would look accurate and be useless. What matters is whether a forecast of 0.8
 * is right about eight times in ten, and whether the interval it published contains the
 * frequency actually observed. Every figure carries its sample size so a sparse bucket
 * cannot read as authoritative.
 */

export const CALIBRATION_POLICY = Object.freeze({
  version: "stage5-calibration-v1",
  bucket_width: 0.1,
  /** Observations a rolling origin needs before its forecast is worth scoring. */
  minimum_backtest_history: 10,
});

/**
 * @typedef {object} ScoredForecast
 * @property {number} lower
 * @property {number} point
 * @property {number} upper
 * @property {"success" | "restricted" | "excluded"} outcome
 */

/**
 * @typedef {object} ReliabilityBucket
 * @property {string} bucket
 * @property {number} forecast_mean
 * @property {number} observed_rate
 * @property {number} sample_size
 */

/**
 * @param {number} point
 * @returns {number} index of the bucket a forecast belongs to
 */
function bucketIndex(point) {
  const width = CALIBRATION_POLICY.bucket_width;
  return Math.min(Math.floor(point / width), Math.round(1 / width) - 1);
}

/**
 * @param {number} index
 * @returns {string}
 */
function bucketLabel(index) {
  const width = CALIBRATION_POLICY.bucket_width;
  const low = index * width;
  return `${Number(low.toFixed(2))}-${Number((low + width).toFixed(2))}`;
}

/**
 * @param {number[]} values
 * @returns {number}
 */
function mean(values) {
  return values.reduce((total, value) => total + value, 0) / values.length;
}

/**
 * Summarize the predictive quality of a set of scored forecasts.
 *
 * @param {ScoredForecast[]} forecasts
 * @returns {{status: string, policy_version: string, excluded: number, brier: {value: number | null, sample_size: number}, reliability: ReliabilityBucket[], interval: {coverage: number | null, mean_width: number | null, sample_size: number, buckets_evaluated: number}}}
 */
export function summarizeCalibration(forecasts) {
  const eligible = forecasts.filter((forecast) => forecast.outcome !== "excluded");
  const excluded = forecasts.length - eligible.length;

  if (eligible.length === 0) {
    return {
      status: "not_available",
      policy_version: CALIBRATION_POLICY.version,
      excluded,
      brier: { value: null, sample_size: 0 },
      reliability: [],
      interval: { coverage: null, mean_width: null, sample_size: 0, buckets_evaluated: 0 },
    };
  }

  const observedOf = (/** @type {ScoredForecast} */ forecast) =>
    forecast.outcome === "success" ? 1 : 0;
  const brier = mean(eligible.map((forecast) => (forecast.point - observedOf(forecast)) ** 2));

  /** @type {Map<number, ScoredForecast[]>} */
  const grouped = new Map();
  for (const forecast of eligible) {
    const index = bucketIndex(forecast.point);
    const bucket = grouped.get(index);
    // Appending in place: rebuilding the bucket array per forecast is quadratic, and a
    // full-history audit scores six figures of them.
    if (bucket) bucket.push(forecast);
    else grouped.set(index, [forecast]);
  }

  const reliability = [...grouped.entries()]
    .sort(([left], [right]) => left - right)
    .map(([index, group]) => ({
      bucket: bucketLabel(index),
      forecast_mean: mean(group.map((forecast) => forecast.point)),
      observed_rate: mean(group.map(observedOf)),
      sample_size: group.length,
    }));

  // A binary outcome is never inside an interval on its own; what the interval claims is
  // the rate a group of comparable forecasts should show, so coverage is measured per
  // bucket against that bucket's own published interval.
  const covered = [...grouped.values()].filter((group) => {
    const rate = mean(group.map(observedOf));
    return rate >= mean(group.map((f) => f.lower)) && rate <= mean(group.map((f) => f.upper));
  }).length;

  return {
    status: "ok",
    policy_version: CALIBRATION_POLICY.version,
    excluded,
    brier: { value: brier, sample_size: eligible.length },
    reliability,
    interval: {
      coverage: covered / grouped.size,
      mean_width: mean(eligible.map((forecast) => forecast.upper - forecast.lower)),
      sample_size: eligible.length,
      buckets_evaluated: grouped.size,
    },
  };
}

/**
 * Score a history by replaying it one prompt at a time.
 *
 * Each forecast is built from the observations that started strictly before the prompt it
 * predicts, with the clock set to that prompt's own start. This is what keeps a backtest
 * honest: nothing that happened later is visible to the forecast being scored, so adding
 * future history cannot change a past result.
 *
 * @param {import("./prediction.js").OutcomeRow[]} outcomes
 * @param {{now: Date, prior: {strength: number, viability: number}, policy?: typeof import("./prediction.js").PREDICTION_POLICY}} options
 * @returns {{forecasts: number, scored: ScoredForecast[], calibration: ReturnType<typeof summarizeCalibration>, policy_version: string}}
 */
export function backtest(outcomes, options) {
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
 * Replay the `reported-capacity` shadow method over a history, scoring a forecast only where it
 * would have been computed (spec §7.2).
 *
 * The same walk as `backtest`, keyed on the stated band each prompt began in: a forecast is scored
 * at a prompt whose start had a binding window, from the cells of the prompts before it. A prompt
 * where no window bound, or where a `clear`/`near` ladder would have ended at the plan prior, is
 * not scored -- so the sample is smaller than the baseline's, and is reported as what it is.
 *
 * The stated band each prompt began in arrives on the row (`stated_band`), already resolved as of
 * that prompt's start from statements strictly earlier -- the projection `labelStatedBands`
 * computes and storage keeps -- so the replay itself reads nothing from the future either.
 *
 * `baseline` is what `backtest` scored over the same outcomes, in its order: one forecast per
 * eligible prompt from the tenth on. At every prompt the shadow scores, the baseline's forecast for
 * that same prompt is taken from it rather than replayed a second time, so `paired` compares the
 * two methods on exactly the same outcomes. Nothing here changes `backtest`.
 *
 * @param {import("./prediction.js").StatedOutcomeRow[]} outcomes
 * @param {{prior: {strength: number, viability: number}, baseline: ScoredForecast[]}} options
 * @returns {{forecasts: number, scored: ScoredForecast[], calibration: ReturnType<typeof summarizeCalibration>, paired: PairedComparison, policy_version: string}}
 */
export function backtestReported(outcomes, options) {
  const policy = REPORTED_PREDICTION_POLICY;
  const ordered = [...outcomes].sort((left, right) =>
    left.started_at.localeCompare(right.started_at),
  );
  /** @type {Map<string, ReturnType<typeof createAccumulator>>} */
  const stated = new Map();
  /** @param {string} key */
  const accumulatorFor = (key) => {
    const existing = stated.get(key);
    if (existing) return existing;
    const created = createAccumulator();
    stated.set(key, created);
    return created;
  };

  /** @type {ScoredForecast[]} */
  const scored = [];
  /** @type {ScoredForecast[]} */
  const baselineScored = [];
  // The position of the current prompt among those `backtest` scored.
  let eligible = 0;
  for (const [index, row] of ordered.entries()) {
    const band = row.stated_band ?? null;
    const at = Date.parse(row.started_at);
    const category = row.size_category ?? "typical";

    if (index >= CALIBRATION_POLICY.minimum_backtest_history && row.outcome !== "excluded") {
      if (band !== null) {
        const full = band === "full";
        const candidates = [
          { level: "period_stated_category", key: `${band}\u0000${category}` },
          { level: "period_stated", key: band },
          ...(full ? [] : [{ level: "period", key: "" }]),
        ].map(({ level, key }) => ({
          level,
          cell: readAccumulator(accumulatorFor(key), at, policy.decay_half_life_seconds),
        }));
        const chosen = chooseCell(candidates, policy);
        if (chosen.level !== "prior" || full) {
          const forecast = assembleForecast({
            cell: chosen.cell,
            level: chosen.level === "prior" ? "stated_full_prior" : chosen.level,
            prior: full ? REPORTED_CAPACITY_POLICY.full_prior : options.prior,
            policy,
            dataCompleteness: "unknown",
            method: REPORTED_CAPACITY_POLICY.method,
            relevance: REPORTED_EVIDENCE_RELEVANCE,
          });
          scored.push(scoredOf(forecast, row.outcome));
          const paired = options.baseline[eligible];
          if (paired === undefined) {
            throw new Error("The baseline replay does not cover the shadow's prompts.");
          }
          baselineScored.push(paired);
        }
      }
      eligible += 1;
    }

    // Every prompt is history for the period aggregate; only a prompt that began in a stated band
    // is history for that band's cells.
    const keys = band === null ? [""] : [`${band}\u0000${category}`, band, ""];
    for (const key of keys) observe(accumulatorFor(key), row.outcome, at, policy);
  }

  return {
    forecasts: scored.length,
    scored,
    calibration: summarizeCalibration(scored),
    paired: comparePaired(scored, baselineScored),
    policy_version: CALIBRATION_POLICY.version,
  };
}

/**
 * @param {{viability: {lower: number, point: number, upper: number}}} forecast
 * @param {"success" | "restricted" | "excluded"} outcome
 * @returns {ScoredForecast}
 */
function scoredOf(forecast, outcome) {
  return {
    lower: forecast.viability.lower,
    point: forecast.viability.point,
    upper: forecast.viability.upper,
    outcome,
  };
}

/**
 * Two methods scored against the same outcomes, side by side.
 *
 * @typedef {object} PairedComparison
 * @property {number} sample_size Outcomes both forecasts were scored against, excluded ones aside.
 * @property {number} restrictions How many of them were observed restrictions.
 * @property {number | null} brier The shadow method's Brier score over them.
 * @property {number | null} baseline_brier The baseline's, over the very same outcomes.
 */

/**
 * @param {ScoredForecast[]} shadow
 * @param {ScoredForecast[]} baseline the same outcomes, in the same order
 * @returns {PairedComparison}
 */
export function comparePaired(shadow, baseline) {
  const shadowSummary = summarizeCalibration(shadow);
  const baselineSummary = summarizeCalibration(baseline);
  return {
    sample_size: shadowSummary.brier.sample_size,
    restrictions: shadow.filter((forecast) => forecast.outcome === "restricted").length,
    brier: shadowSummary.brier.value,
    baseline_brier: baselineSummary.brier.value,
  };
}

/**
 * Methods a calibration entry folds into the baseline's. `initial-generic@1` is the baseline
 * model's last rung -- the plan prior alone -- not a model of its own, so its forecasts belong to
 * the baseline's stream. Versions are never pooled: a future `reported-capacity@2` is its own entry.
 */
export const BASELINE_METHOD_FAMILY = Object.freeze([
  "bayesian-pressure-band@1",
  "initial-generic@1",
]);

/**
 * @typedef {object} MethodPair
 * @property {number} lower
 * @property {number} point
 * @property {number} upper
 * @property {"success" | "restricted" | "excluded"} outcome
 * @property {string} method_id
 * @property {string} method_version
 * @property {string | null} shadow_method_id
 * @property {string | null} shadow_method_version
 * @property {number | null} shadow_lower
 * @property {number | null} shadow_point
 * @property {number | null} shadow_upper
 */

/**
 * The live calibration stream of each method, from the same delivered pairs (spec §7.1).
 *
 * The baseline's entry reads every pair whose attempt it answered, with the attempt's numbers. A
 * shadow method's entry reads every pair it was computed for, with its own recorded numbers, and
 * carries `paired`: its Brier score and the answering baseline's over exactly those outcomes. Each
 * entry carries its own sample sizes; nothing is pooled across methods or versions.
 *
 * @param {MethodPair[]} pairs
 * @param {{id: string, version: string}} shadowMethod
 */
export function liveByMethod(pairs, shadowMethod) {
  const shadowKey = `${shadowMethod.id}@${shadowMethod.version}`;
  /** @type {ScoredForecast[]} */
  const baseline = [];
  /** @type {ScoredForecast[]} */
  const shadow = [];
  /** @type {ScoredForecast[]} */
  const pairedBaseline = [];
  for (const pair of pairs) {
    const answered = BASELINE_METHOD_FAMILY.includes(`${pair.method_id}@${pair.method_version}`);
    if (answered) baseline.push(pair);
    if (
      `${pair.shadow_method_id}@${pair.shadow_method_version}` === shadowKey &&
      pair.shadow_lower !== null &&
      pair.shadow_point !== null &&
      pair.shadow_upper !== null
    ) {
      shadow.push({
        lower: pair.shadow_lower,
        point: pair.shadow_point,
        upper: pair.shadow_upper,
        outcome: pair.outcome,
      });
      if (answered) pairedBaseline.push(pair);
    }
  }
  return {
    baseline: summarizeCalibration(baseline),
    shadow: summarizeCalibration(shadow),
    paired: comparePaired(shadow, pairedBaseline),
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
 * @returns {import("./prediction.js").ForecastCell}
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
