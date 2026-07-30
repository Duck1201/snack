import { ExitCode, SnackError } from "./errors.js";

const HORIZON_PATTERN = /^P(?!$)(?:(\d+)D)?(?:T(?=\d)(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?)?$/;

/**
 * Versioned analytics policy.
 *
 * These constants are provisional: Stage 4 Wave 2 promotes them to `v1` only against
 * simulation evidence. Every result that depends on them carries the version.
 */
export const ANALYTICS_POLICY = Object.freeze({
  version: "stage4-analytics-v0",
  decay_half_life_seconds: 86400,
});

/**
 * Token dimensions stay separate; they are never summed into a single consumption score.
 *
 * @type {readonly ("input_tokens" | "output_tokens" | "reasoning_tokens" | "cache_read_tokens" | "cache_write_tokens")[]}
 */
const TOKEN_DIMENSIONS = [
  "input_tokens",
  "output_tokens",
  "reasoning_tokens",
  "cache_read_tokens",
  "cache_write_tokens",
];

/**
 * Convert a configured analysis horizon into seconds.
 *
 * Accepts the same ISO-8601 duration subset that `schemas/config.schema.json` validates.
 *
 * @param {string} duration
 * @returns {number} horizon length in seconds
 */
export function parseHorizon(duration) {
  const match = HORIZON_PATTERN.exec(duration);
  if (match === null) {
    throw new SnackError(`Unsupported analysis horizon: ${duration}`, {
      code: ExitCode.usage,
      reason: "horizon_unsupported",
    });
  }
  const [, days, hours, minutes, seconds] = match;
  return (
    Number(days ?? 0) * 86400 +
    Number(hours ?? 0) * 3600 +
    Number(minutes ?? 0) * 60 +
    Number(seconds ?? 0)
  );
}

/**
 * Resolve the rolling analysis window that ends at the observation clock.
 *
 * The window is half-open: `from` is inclusive and `to` is exclusive.
 *
 * @param {Date} now
 * @param {number} horizonSeconds
 * @returns {{from: string, to: string}} RFC 3339 UTC bounds
 */
export function horizonWindow(now, horizonSeconds) {
  return {
    from: new Date(now.getTime() - horizonSeconds * 1000).toISOString(),
    to: now.toISOString(),
  };
}

/**
 * Describe observed usage for one capacity source over one analysis horizon.
 *
 * Only `success` and `restricted` outcomes are eligible; excluded observations still
 * count as observed prompts.
 *
 * @param {import("./storage.js").UsageWindowRow[]} rows
 * @param {{class: string}[]} restrictions
 * @param {{horizon: string, window: {from: string, to: string}, now?: Date, halfLifeSeconds?: number}} options
 */
export function summarizeUsageProfile(rows, restrictions, options) {
  const successes = rows.filter((row) => row.outcome === "success").length;
  const restricted = rows.filter((row) => row.outcome === "restricted").length;
  const excluded = rows.filter((row) => row.outcome === "excluded").length;
  const slices = rows.flatMap((row) => row.slices);
  const now = options.now ?? new Date(options.window.to);
  const halfLifeSeconds = options.halfLifeSeconds ?? ANALYTICS_POLICY.decay_half_life_seconds;
  const eligible = rows.filter((row) => row.outcome === "success" || row.outcome === "restricted");

  return {
    horizon: options.horizon,
    window: options.window,
    dimensions: Object.fromEntries(
      TOKEN_DIMENSIONS.map((dimension) => [dimension, summarizeTokenDimension(slices, dimension)]),
    ),
    cost: summarizeCost(slices),
    duration: summarizeDuration(rows),
    restrictions_by_class: countRestrictionClasses(restrictions),
    freshness: summarizeFreshness(rows, now),
    effective_sample_size: effectiveSampleSize(
      eligible.map((row) => row.started_at),
      now,
      halfLifeSeconds,
    ),
    policy_version: ANALYTICS_POLICY.version,
    prompts: {
      count: rows.length,
      eligible: successes + restricted,
      successes,
      restrictions: restricted,
      excluded,
    },
  };
}

/**
 * Weight observations by age so recent evidence counts more, without deleting history.
 *
 * Each observation contributes `2^(-age / halfLife)`, so an observation exactly one
 * half-life old counts as half a sample.
 *
 * @param {string[]} timestamps RFC 3339 UTC
 * @param {Date} now
 * @param {number} halfLifeSeconds
 * @returns {number} effective sample size, never above the raw count
 */
export function effectiveSampleSize(timestamps, now, halfLifeSeconds) {
  return timestamps.reduce((total, timestamp) => {
    const ageSeconds = Math.max(0, (now.getTime() - Date.parse(timestamp)) / 1000);
    return total + Math.pow(2, -ageSeconds / halfLifeSeconds);
  }, 0);
}

/**
 * Interpolate a percentile using the R-7 convention (numpy and Excel default).
 *
 * @param {number[]} sorted ascending, non-empty
 * @param {number} fraction between 0 and 1
 */
export function percentile(sorted, fraction) {
  const rank = fraction * (sorted.length - 1);
  const lowerIndex = Math.floor(rank);
  const upperIndex = Math.ceil(rank);
  const lower = /** @type {number} */ (sorted[lowerIndex]);
  const upper = /** @type {number} */ (sorted[upperIndex]);
  return lowerIndex === upperIndex ? lower : lower + (rank - lowerIndex) * (upper - lower);
}

/**
 * Report how recent the newest observation of any outcome is.
 *
 * @param {import("./storage.js").UsageWindowRow[]} rows
 * @param {Date} now
 */
function summarizeFreshness(rows, now) {
  const observations = rows.map((row) => row.completed_at ?? row.started_at);
  if (observations.length === 0) {
    return { as_of: null, age_seconds: null };
  }
  const asOf = observations.reduce((latest, value) => (value > latest ? value : latest));
  return { as_of: asOf, age_seconds: Math.max(0, (now.getTime() - Date.parse(asOf)) / 1000) };
}

/**
 * Total observed cost per currency in exact decimal arithmetic.
 *
 * Cost is observed metadata, not a capacity measure, and currencies are never converted
 * into each other.
 *
 * @param {import("./storage.js").UsageSliceRow[]} slices
 */
function summarizeCost(slices) {
  /** @type {Map<string, {scaled: bigint, scale: number}>} */
  const totals = new Map();
  let observed = 0;
  for (const slice of slices) {
    if (slice.cost_decimal === null || slice.currency === null) {
      continue;
    }
    observed += 1;
    const amount = parseDecimal(slice.cost_decimal);
    const running = totals.get(slice.currency) ?? { scaled: 0n, scale: 0 };
    const scale = Math.max(running.scale, amount.scale);
    totals.set(slice.currency, {
      scaled:
        rescale(running.scaled, running.scale, scale) + rescale(amount.scaled, amount.scale, scale),
      scale,
    });
  }

  /** @type {Record<string, string>} */
  const byCurrency = {};
  for (const currency of [...totals.keys()].sort()) {
    const total = /** @type {{scaled: bigint, scale: number}} */ (totals.get(currency));
    byCurrency[currency] = formatDecimal(total.scaled, total.scale);
  }
  const missing = slices.length - observed;
  return {
    by_currency: byCurrency,
    sample_size: observed,
    missing,
    complete: slices.length > 0 && missing === 0,
  };
}

/** @param {string} value @returns {{scaled: bigint, scale: number}} */
function parseDecimal(value) {
  const [whole, fraction = ""] = value.split(".");
  return { scaled: BigInt(`${whole}${fraction}`), scale: fraction.length };
}

/** @param {bigint} scaled @param {number} from @param {number} to */
function rescale(scaled, from, to) {
  return scaled * 10n ** BigInt(to - from);
}

/** @param {bigint} scaled @param {number} scale */
function formatDecimal(scaled, scale) {
  if (scale === 0) {
    return scaled.toString();
  }
  const digits = scaled.toString().padStart(scale + 1, "0");
  const trimmed = `${digits.slice(0, -scale)}.${digits.slice(-scale)}`.replace(/0+$/, "");
  return trimmed.endsWith(".") ? trimmed.slice(0, -1) : trimmed;
}

/**
 * @param {{class: string}[]} restrictions
 * @returns {Record<string, number>} counts keyed by explicit restriction class
 */
function countRestrictionClasses(restrictions) {
  /** @type {Record<string, number>} */
  const counts = {};
  for (const restriction of restrictions) {
    counts[restriction.class] = (counts[restriction.class] ?? 0) + 1;
  }
  return counts;
}

/**
 * @param {import("./storage.js").UsageWindowRow[]} rows
 */
function summarizeDuration(rows) {
  const observed = rows
    .map((row) => row.duration_ms)
    .filter((value) => value !== null)
    .sort((left, right) => left - right);
  const missing = rows.length - observed.length;
  const shared = {
    unit: "ms",
    sample_size: observed.length,
    missing,
    complete: rows.length > 0 && missing === 0,
  };
  return observed.length === 0
    ? { status: "unknown", ...shared }
    : { p50: percentile(observed, 0.5), p90: percentile(observed, 0.9), ...shared };
}

/**
 * Total one token dimension without inventing a value the source never reported.
 *
 * @param {import("./storage.js").UsageSliceRow[]} slices
 * @param {(typeof TOKEN_DIMENSIONS)[number]} dimension
 */
function summarizeTokenDimension(slices, dimension) {
  const observed = slices.map((slice) => slice[dimension]).filter((value) => value !== null);
  const missing = slices.length - observed.length;
  const shared = {
    unit: "tokens",
    sample_size: observed.length,
    missing,
    complete: slices.length > 0 && missing === 0,
  };
  return observed.length === 0
    ? { status: "unknown", ...shared }
    : { value: observed.reduce((total, value) => total + value, 0), ...shared };
}
