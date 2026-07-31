import { buildForecast } from "./prediction.js";

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
    grouped.set(index, [...(grouped.get(index) ?? []), forecast]);
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
  const ordered = [...outcomes].sort((left, right) =>
    left.started_at.localeCompare(right.started_at),
  );

  /** @type {ScoredForecast[]} */
  const scored = [];
  for (const [index, row] of ordered.entries()) {
    if (index < CALIBRATION_POLICY.minimum_backtest_history) continue;
    if (row.outcome === "excluded") continue;
    const forecast = buildForecast({
      now: new Date(Date.parse(row.started_at)),
      prior: options.prior,
      expectedBand: row.pressure_band ?? "unknown",
      expectedCategory: row.size_category ?? "typical",
      outcomes: ordered.slice(0, index),
      dataCompleteness: "unknown",
      ...(options.policy ? { policy: options.policy } : {}),
    });
    scored.push({
      lower: forecast.viability.lower,
      point: forecast.viability.point,
      upper: forecast.viability.upper,
      outcome: row.outcome,
    });
  }

  return {
    forecasts: scored.length,
    scored,
    calibration: summarizeCalibration(scored),
    policy_version: CALIBRATION_POLICY.version,
  };
}
