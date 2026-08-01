import { betaQuantile } from "./beta.js";
import { ExitCode, SnackError } from "./errors.js";

const HORIZON_PATTERN = /^P(?!$)(?:(\d+)D)?(?:T(?=\d)(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?)?$/;

/**
 * Versioned analytics policy.
 *
 * Every result that depends on these constants carries the version, so a later policy
 * can be told apart from this one. The simulations in `test/analytics.test.js` are the
 * evidence behind the current values:
 *
 * - `decay_half_life_seconds` and `weight_blend_equivalent_samples` together decide how
 *   fast local evidence displaces the plan profile. At one day and ten samples, an
 *   occasional user (1 prompt/day) keeps leaning on the profile while a moderate user
 *   (10 prompts/day) is mostly driven by local data.
 * - `pressure_bands` decide how often each band fires. Under stationary usage a window
 *   ranks uniformly against its own history, so these boundaries target a 50/25/15/10
 *   split across low, moderate, elevated, and high.
 */
export const ANALYTICS_POLICY = Object.freeze({
  version: "stage4-analytics-v1",
  decay_half_life_seconds: 86400,
  weight_blend_equivalent_samples: 10,
  pressure_bands: Object.freeze({ moderate: 0.5, elevated: 0.75, high: 0.9 }),
  pressure_baseline_windows: 30,
  pressure_minimum_baseline_windows: 5,
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
    by_model: summarizeByModel(slices),
    duration: summarizeDuration(rows),
    restrictions: {
      by_class: countRestrictionClasses(restrictions),
      unit: "restrictions",
      sample_size: restrictions.length,
    },
    freshness: summarizeFreshness(rows, now),
    effective_sample_size: {
      value: effectiveSampleSize(
        eligible.map((row) => row.started_at),
        now,
        halfLifeSeconds,
      ),
      unit: "prompts",
      sample_size: eligible.length,
      half_life_seconds: halfLifeSeconds,
    },
    policy_version: ANALYTICS_POLICY.version,
    prompts: {
      count: rows.length,
      eligible: successes + restricted,
      successes,
      restrictions: restricted,
      excluded,
      unit: "prompts",
    },
  };
}

/**
 * Rank observed usage against local history for each dimension.
 *
 * Usage pressure is a relative signal: it says how this window compares with previous
 * windows of the same length. It is never a fraction of real provider capacity, which
 * SNACK treats as unknown.
 *
 * @param {{current: Record<string, number>, baselines: Record<string, number[]>, profileWeights: Record<string, number>, effectiveSampleSize: number}} input
 */
export function computeUsagePressure(input) {
  const dimensions = Object.keys(input.current);
  const weights = blendWeights(dimensions, input.profileWeights, input.effectiveSampleSize);
  const contributors = dimensions.map((dimension) => {
    const baseline = input.baselines[dimension] ?? [];
    const percentile = percentileRank(baseline, /** @type {number} */ (input.current[dimension]));
    const weight = /** @type {number} */ (weights[dimension]);
    return {
      dimension,
      observed: /** @type {number} */ (input.current[dimension]),
      baseline_sample: baseline.length,
      percentile,
      weight,
      /** @type {number | null} */
      contribution: null,
    };
  });

  // Only ranked dimensions can carry the score; an unranked one stays unknown rather
  // than silently contributing zero pressure. Contributions are shares of the score,
  // so they always add up to it.
  const ranked = contributors.filter((contributor) => contributor.percentile !== null);
  const rankedWeight = ranked.reduce((total, contributor) => total + contributor.weight, 0);
  for (const contributor of ranked) {
    const percentile = /** @type {number} */ (contributor.percentile);
    contributor.contribution = (percentile * contributor.weight) / rankedWeight;
  }
  const score =
    ranked.length === 0
      ? null
      : ranked.reduce(
          (total, contributor) => total + /** @type {number} */ (contributor.contribution),
          0,
        );

  return {
    score,
    band: classifyPressureBand(score),
    policy_version: ANALYTICS_POLICY.version,
    baseline_kind: ranked.length === 0 ? "none" : "local",
    completeness: ranked.length === contributors.length ? "complete" : "partial",
    contributors: contributors.sort(
      (left, right) => (right.contribution ?? -1) - (left.contribution ?? -1),
    ),
  };
}

/**
 * Versioned trend policy.
 *
 * Deliberately separate from `ANALYTICS_POLICY`: that version is stamped onto every stored
 * prediction attempt, and bumping it for something that does not affect a forecast would put a
 * false signal into the audit trail permanently.
 *
 * The simulation in `test/analytics.test.js` is the evidence behind these values. Measured as
 * the share of stationary runs reporting `steady`, and the share of rising runs reported as
 * `rising` at 10% / 20% / 50% growth per window:
 *
 *   windows 3 -> 0.744 | 0.416 / 0.819 / 0.997
 *   windows 4 -> 0.181 | 0.758 / 0.992 / 1.000
 *   windows 5 -> 0.689 | 0.652 / 0.986 / 0.994
 *   windows 6 -> 0.243 | 0.863 / 1.000 / 0.993
 *   windows 7 -> 0.678 | 0.801 / 0.999 / 0.000
 *
 * An even window count leaves an odd number of steps, where no tie is possible and a strict
 * majority arises by chance: those rows report a direction on stationary usage four times out
 * of five. Among the odd counts, three under-reports a gentle rise, and seven collapses on a
 * steep one because the percentile saturates at 1 once a window clears the whole baseline,
 * making every later step zero. Five is the only count that neither misses a slow climb nor
 * goes blind on a fast one.
 */
export const TREND_POLICY = Object.freeze({
  version: "stage6-trend-v1",
  windows: 5,
  minimum_windows: 3,
});

/**
 * Describe which way usage pressure has been moving, without claiming where it is going.
 *
 * Each compared window is ranked against **one shared baseline** rather than against its own
 * preceding history. Ranking each window against a different baseline would put the scores on
 * different scales, and the sequence between them would mean nothing.
 *
 * Direction comes from counting the sign of the steps between consecutive scores: a strict
 * majority rising or falling names that direction, anything else is `steady`. Below the
 * minimum evidence the direction is `null` — `steady` is a claim, and absence of observation
 * must never be reported as one.
 *
 * @param {{windows: Record<string, number>[], baselines: Record<string, number[]>, profileWeights: Record<string, number>, effectiveSampleSize: number}} input windows ordered oldest to newest
 */
export function computeUsageTrend(input) {
  const baselineWindows = Math.max(
    0,
    ...Object.values(input.baselines).map((values) => values.length),
  );
  const base = {
    windows_compared: input.windows.length,
    baseline_windows: baselineWindows,
    /** @type {number[]} */
    scores: [],
    policy_version: TREND_POLICY.version,
    /** @type {"observed" | "not_available"} */
    status: "not_available",
    /** @type {string | null} */
    reason: null,
    /** @type {"rising" | "falling" | "steady" | null} */
    direction: null,
  };
  if (baselineWindows < ANALYTICS_POLICY.pressure_minimum_baseline_windows) {
    return { ...base, reason: "insufficient_baseline" };
  }
  if (input.windows.length < TREND_POLICY.minimum_windows) {
    return { ...base, reason: "insufficient_windows" };
  }

  const scores = input.windows.map(
    (current) =>
      computeUsagePressure({
        current,
        baselines: input.baselines,
        profileWeights: input.profileWeights,
        effectiveSampleSize: input.effectiveSampleSize,
      }).score,
  );
  if (scores.some((score) => score === null)) {
    return { ...base, reason: "insufficient_baseline" };
  }

  const ranked = /** @type {number[]} */ (scores);
  // A percentile cannot exceed 1, so once every compared window clears the whole baseline the
  // steps between them are all zero no matter how steeply usage is still climbing. Reporting
  // `steady` there would read as reassurance about the one case that deserves it least.
  if (ranked.every((score) => score >= 1)) {
    return { ...base, scores: ranked, reason: "above_baseline" };
  }
  let rising = 0;
  let falling = 0;
  for (let index = 1; index < ranked.length; index += 1) {
    const step = /** @type {number} */ (ranked[index]) - /** @type {number} */ (ranked[index - 1]);
    if (step > 0) rising += 1;
    if (step < 0) falling += 1;
  }
  const steps = ranked.length - 1;
  const direction = rising * 2 > steps ? "rising" : falling * 2 > steps ? "falling" : "steady";

  return { ...base, scores: ranked, status: "observed", direction };
}

/**
 * Assign a versioned pressure band.
 *
 * Bands describe intensity relative to local history. They are not a share of real
 * provider capacity.
 *
 * @param {number | null} score
 */
function classifyPressureBand(score) {
  if (score === null) return "unknown";
  const { pressure_bands: bands } = ANALYTICS_POLICY;
  if (score < bands.moderate) return "low";
  if (score < bands.elevated) return "moderate";
  if (score < bands.high) return "elevated";
  return "high";
}

/**
 * Blend plan-profile weights toward an equal-weight vector as local evidence accumulates.
 *
 * A plan profile is a weak assumption; local observations must dominate once there are
 * enough of them. The blend is `w_profile * (1 - t) + w_neutral * t` with
 * `t = ess / (ess + k)`.
 *
 * @param {string[]} dimensions
 * @param {Record<string, number>} profileWeights
 * @param {number} effectiveSampleSize
 * @returns {Record<string, number>} weights summing to one
 */
function blendWeights(dimensions, profileWeights, effectiveSampleSize) {
  const neutral = 1 / dimensions.length;
  const profileTotal = dimensions.reduce(
    (total, dimension) => total + (profileWeights[dimension] ?? 0),
    0,
  );
  const blend =
    effectiveSampleSize / (effectiveSampleSize + ANALYTICS_POLICY.weight_blend_equivalent_samples);
  /** @type {Record<string, number>} */
  const weights = {};
  for (const dimension of dimensions) {
    const fromProfile =
      profileTotal > 0 ? (profileWeights[dimension] ?? 0) / profileTotal : neutral;
    weights[dimension] = fromProfile * (1 - blend) + neutral * blend;
  }
  return weights;
}

/**
 * Fraction of baseline samples at or below the observed value, counting ties as half.
 *
 * @param {number[]} baseline
 * @param {number} observed
 * @returns {number | null} null when there is no baseline to rank against
 */
function percentileRank(baseline, observed) {
  if (baseline.length === 0) {
    return null;
  }
  const below = baseline.filter((value) => value < observed).length;
  const ties = baseline.filter((value) => value === observed).length;
  return (below + ties / 2) / baseline.length;
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
    if (slice.cost_decimal === null) {
      continue;
    }
    // A source may report a cost without naming a currency. Dropping it would hide
    // observed usage, so it is grouped under an explicit unknown currency and never
    // merged with a named one.
    const currency = slice.currency ?? "unknown";
    observed += 1;
    const amount = parseDecimal(slice.cost_decimal);
    const running = totals.get(currency) ?? { scaled: 0n, scale: 0 };
    const scale = Math.max(running.scale, amount.scale);
    totals.set(currency, {
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
 * Split observed usage by the model that produced it.
 *
 * The unit is usage slices rather than prompts, because one prompt can span several models and
 * counting it once per model would report more prompts than were made. A slice whose model the
 * source never named is grouped under an explicit `unknown`, the same way an unnamed currency
 * is kept rather than dropped.
 *
 * @param {import("./storage.js").UsageSliceRow[]} slices
 */
function summarizeByModel(slices) {
  /** @type {Map<string, import("./storage.js").UsageSliceRow[]>} */
  const groups = new Map();
  for (const slice of slices) {
    const model = slice.model ?? "unknown";
    // Appending in place rather than rebuilding the group. Spreading the accumulated array once
    // per slice is quadratic in the slices a window holds, which a dense week of usage reaches:
    // it cost 26 s and 928 MB at a hundred thousand prompts.
    const group = groups.get(model);
    if (group === undefined) groups.set(model, [slice]);
    else group.push(slice);
  }
  return [...groups.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([model, group]) => ({
      model,
      slices: { count: group.length, unit: "usage slices" },
      dimensions: Object.fromEntries(
        TOKEN_DIMENSIONS.map((dimension) => [dimension, summarizeTokenDimension(group, dimension)]),
      ),
      cost: summarizeCost(group),
    }));
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

/**
 * Assign the usage-pressure band that was in force when each prompt started.
 *
 * The forecast model needs the band a prompt belonged to, not today's band. Prompts are
 * bucketed into fixed windows counted from the capacity-period origin — the same discrete
 * windows the pressure calculation uses — and each window is ranked against the windows
 * that preceded it only. A window without enough preceding windows stays `unknown`, so a
 * band never depends on observations that arrived after the prompt it describes.
 *
 * @template {{started_at: string}} Row
 * @param {Row[]} rows
 * @param {{origin: string, windowSeconds: number}} options
 * @returns {(Row & {pressure_band: string})[]}
 */
export function assignPressureBands(rows, options) {
  const originMs = Date.parse(options.origin);
  const windowMs = options.windowSeconds * 1000;

  /** @type {Map<number, number>} */
  const counts = new Map();
  const windowOf = (/** @type {Row} */ row) =>
    Math.floor((Date.parse(row.started_at) - originMs) / windowMs);
  for (const row of rows) {
    const index = windowOf(row);
    counts.set(index, (counts.get(index) ?? 0) + 1);
  }

  // Rank every populated window against the populated windows before it. An empty window
  // is absence of observation, not a zero, so it never enters a baseline.
  const ordered = [...counts.keys()].sort((left, right) => left - right);
  /** @type {Map<number, string>} */
  const bands = new Map();
  /** @type {number[]} */
  const baseline = [];
  for (const index of ordered) {
    const count = counts.get(index) ?? 0;
    const band =
      baseline.length >= ANALYTICS_POLICY.pressure_minimum_baseline_windows
        ? classifyPressureBand(
            percentileRank(baseline.slice(-ANALYTICS_POLICY.pressure_baseline_windows), count),
          )
        : "unknown";
    bands.set(index, band);
    baseline.push(count);
  }

  return rows.map((row) => ({ ...row, pressure_band: bands.get(windowOf(row)) ?? "unknown" }));
}

/**
 * Versioned policy for comparing groups of observations against each other.
 *
 * `minimum_eligible` is the point below which a share is not worth reading as a rate. Under it the
 * answer is that the groups cannot be compared, which is a different statement from finding no
 * difference and has to stay tellable apart from it.
 */
export const COMPARISON_POLICY = Object.freeze({
  version: "stage8-comparison-v1",
  coverage_target: 0.8,
  minimum_eligible: 30,
});

/**
 * Compare the refusal rate of each group of observations against the other groups.
 *
 * The question this answers is whether one group is systematically refused more than the rest --
 * on a shared capacity source, whether one client fares worse than the others against the same real
 * capacity. It knows nothing about what a group is: a group is a key and its observations, so the
 * same comparison serves a third client without a line changing here.
 *
 * The whole test is whether two credible intervals are disjoint. There is no model, no p-value and
 * nothing fitted: each group's refusal share gets a Beta interval, the same construction and the
 * same coverage language the forecast already speaks, and a difference is reported only when the
 * group's interval and the interval of everything else do not overlap. Overlapping intervals are
 * reported as no difference detected, never as no difference.
 *
 * Each group is compared against the complement rather than against the pooled rate. The pool
 * contains the group being tested, so comparing to it drags every answer toward "no difference" --
 * and does so hardest exactly where one group dominates the data, which is where a real difference
 * matters most.
 *
 * Groups arrive already counted rather than as observations. Counting is a single pass a caller can
 * do while it is reading rows it already holds, and handing whole observation arrays over instead
 * would make the caller keep every row of the widest analysis window alive until this returns --
 * which on a real history is a hundred thousand objects retained for three numbers per client.
 * `countOutcomes` does the counting for a caller that does have the rows.
 *
 * @param {{key: string, prompts: number, eligible: number, restricted: number}[]} groups
 * @param {{policy?: typeof COMPARISON_POLICY}} [options]
 */
export function compareOutcomeGroups(groups, options = {}) {
  const policy = options.policy ?? COMPARISON_POLICY;
  const counted = groups;
  const comparable = counted.filter((group) => group.eligible >= policy.minimum_eligible);

  if (counted.length < 2) {
    return {
      policy_version: policy.version,
      status: /** @type {"ok" | "not_comparable"} */ ("not_comparable"),
      // Nothing to compare and one thing to compare are different situations, and a consumer
      // reading only the reason should not be told there was a single group when there were none.
      reason: /** @type {string | null} */ (counted.length === 0 ? "no_groups" : "single_group"),
      groups: counted.map((group) => describeGroup(group, null, policy)),
    };
  }
  if (comparable.length < 2) {
    return {
      policy_version: policy.version,
      status: /** @type {"ok" | "not_comparable"} */ ("not_comparable"),
      reason: /** @type {string | null} */ ("insufficient_evidence"),
      groups: counted.map((group) => describeGroup(group, null, policy)),
    };
  }

  return {
    policy_version: policy.version,
    status: /** @type {"ok" | "not_comparable"} */ ("ok"),
    reason: /** @type {string | null} */ (null),
    groups: counted.map((group) => {
      if (group.eligible < policy.minimum_eligible) return describeGroup(group, null, policy);
      const others = comparable.filter((candidate) => candidate.key !== group.key);
      const complement = {
        eligible: others.reduce((total, candidate) => total + candidate.eligible, 0),
        restricted: others.reduce((total, candidate) => total + candidate.restricted, 0),
      };
      return describeGroup(group, complement, policy);
    }),
  };
}

/**
 * @param {{key: string, eligible: number, restricted: number, prompts: number}} group
 * @param {{eligible: number, restricted: number} | null} complement
 * @param {typeof COMPARISON_POLICY} policy
 */
function describeGroup(group, complement, policy) {
  const share = restrictionShare(group.restricted, group.eligible, policy);
  let difference = /** @type {string} */ ("not_comparable");
  if (complement !== null) {
    const other = restrictionShare(complement.restricted, complement.eligible, policy);
    difference =
      share.lower > other.upper
        ? "higher_than_others"
        : share.upper < other.lower
          ? "lower_than_others"
          : "not_detected";
  }
  return {
    key: group.key,
    prompts: group.prompts,
    eligible: group.eligible,
    restricted: group.restricted,
    restriction_share: share,
    difference,
  };
}

/**
 * A refusal share with the interval that says how firmly it is known.
 *
 * The prior is Beta(1, 1) -- uniform, and the weakest thing that still produces an interval at all.
 * A share reported without one would read as a measurement of a real refusal rate, when at thirty
 * observations it is an estimate wide enough to overlap almost anything.
 *
 * @param {number} restricted
 * @param {number} eligible
 * @param {typeof COMPARISON_POLICY} policy
 */
function restrictionShare(restricted, eligible, policy) {
  const tail = (1 - policy.coverage_target) / 2;
  const alpha = 1 + restricted;
  const beta = 1 + (eligible - restricted);
  return {
    value: eligible === 0 ? null : restricted / eligible,
    lower: betaQuantile(tail, alpha, beta),
    upper: betaQuantile(1 - tail, alpha, beta),
    coverage_target: policy.coverage_target,
  };
}

/**
 * Count observations the way the comparison reads them.
 *
 * Excluded observations are not evidence either way, so they count toward what was seen and not
 * toward what was refused. Exported because the rule belongs here rather than in whichever caller
 * happens to be holding the rows.
 *
 * @param {import("./prediction.js").OutcomeRow[]} outcomes
 */
export function countOutcomes(outcomes) {
  let eligible = 0;
  let restricted = 0;
  for (const outcome of outcomes) {
    if (outcome.outcome === "excluded") continue;
    eligible += 1;
    if (outcome.outcome === "restricted") restricted += 1;
  }
  return { prompts: outcomes.length, eligible, restricted };
}
