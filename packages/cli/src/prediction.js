/**
 * Learned next-prompt viability forecast.
 *
 * The model is a weighted Beta-Binomial over source outcomes, seeded by the weak plan
 * profile prior. It consumes domain-shaped rows and never queries SQLite.
 */

import { betaQuantile } from "./beta.js";

/** Versioned model policy. Every forecast names the policy that produced it. */
export const PREDICTION_POLICY = Object.freeze({
  version: "stage5-prediction-v2",
  coverage_target: 0.8,
  decay_half_life_seconds: 604800,
  /**
   * How many later prompts in the same cell halve an observation's weight.
   *
   * Elapsed time alone cannot pace this. A user who prompts every six minutes buries a
   * fresh restriction under hundreds of older successes no matter how short the time
   * half-life is, while the same constant makes an occasional user forget everything.
   * Simulation measured the prompts needed to admit a collapse from 0.99 to 0.70
   * viability: with time decay alone, 80 prompts at a six-minute cadence and 10 at a
   * ten-hour cadence; with a 30-prompt recency half-life, 21 and 15. Below 30 the
   * interval widens without buying more safety; above 40 the intense cadence goes blind
   * again.
   */
  recency_half_life_prompts: 30,
  /**
   * How many recent prompts a forecast reads.
   *
   * Recency decay makes the tail worthless long before this: the two-thousandth prompt
   * back weighs 2^-66. Reading a six-figure history to add nothing dominated the status
   * budget, so the window is cut where the arithmetic stops mattering.
   */
  evidence_window_prompts: 2000,
  minimum_cell_samples: 5,
  backoff_levels: Object.freeze(["period_band_category", "period_band", "period", "prior"]),
});

/**
 * Versioned evidence gates. The weakest gate caps the reported level, so a rich history
 * with no observed restriction can never look strong.
 */
export const EVIDENCE_POLICY = Object.freeze({
  version: "stage5-evidence-v2",
  levels: Object.freeze(["very_low", "low", "moderate", "high"]),
  /**
   * Effective sample size needed to reach each level above `very_low`.
   *
   * Chosen from measured error, not intuition. Simulating forecasts against a known true
   * viability, the mean absolute error of the point estimate falls 0.194 below one
   * effective sample, 0.105 at two, 0.060 at six, 0.055 at ten, 0.036 at eighteen, and
   * 0.027 at twenty-six, flattening near 0.024 afterwards. `high` is set where the error
   * is within roughly a tenth of that floor. Recency decay saturates the effective sample
   * size near 44, so a threshold above that could never be reached at all.
   */
  sample_thresholds: Object.freeze({ low: 2, moderate: 10, high: 25 }),
  /**
   * Observed restrictions needed to reach each level.
   *
   * A history without a single restriction is capped below `high`: the model has never
   * seen the event it is predicting, however many successes it holds. Requiring more than
   * one was worse than useless — with the effective sample size saturating near 44, asking
   * for five restrictions means asking for an observed rate above 11%, which a source that
   * really refuses 4% of prompts only reaches on an unlucky stretch. Simulation showed
   * `high` forecasts landing further from the truth than `moderate` ones (0.045 against
   * 0.026 at a true viability of 0.96) purely from that selection effect.
   */
  restriction_thresholds: Object.freeze({ low: 0, moderate: 0, high: 1 }),
  /**
   * Highest level each backoff level may support.
   *
   * The period aggregate is capped at `very_low` because it pools cells that behave
   * differently. Simulating a source whose viability depends on the pressure band, the
   * aggregate's interval covered the truth only 26% of the time while the band and cell
   * levels stayed near their target. An aggregate forecast is a last resort, not evidence.
   */
  relevance_ceilings: Object.freeze({
    period_band_category: "high",
    period_band: "moderate",
    period: "very_low",
    prior: "very_low",
  }),
  /** Highest level each ingestion completeness may support. */
  completeness_ceilings: Object.freeze({
    complete: "high",
    partial: "moderate",
    unknown: "low",
  }),
});

/**
 * @typedef {object} OutcomeRow
 * @property {string} started_at ISO timestamp of the prompt start.
 * @property {"success" | "restricted" | "excluded"} outcome
 * @property {string} [pressure_band]
 * @property {string | null} [size_category]
 */

/**
 * @typedef {object} ForecastInput
 * @property {Date} now
 * @property {{strength: number, viability: number}} prior Weak plan-profile prior.
 * @property {string} expectedBand Pressure band assumed for the next prompt.
 * @property {string} expectedCategory Prompt-size category assumed for the next prompt.
 * @property {OutcomeRow[]} outcomes Eligible observations of the active capacity period.
 * @property {"complete" | "partial" | "unknown"} [dataCompleteness] Ingestion health.
 * @property {typeof PREDICTION_POLICY} [policy]
 */

/**
 * @typedef {object} EvidenceGate
 * @property {string} id
 * @property {string} level Highest level this gate supports.
 * @property {boolean} limiting Whether this gate caps the reported level.
 */

/**
 * @typedef {object} ForecastCell
 * @property {number} successes
 * @property {number} restrictions
 * @property {number} excluded
 * @property {number} weighted_successes
 * @property {number} weighted_restrictions
 * @property {number} effective_samples
 * @property {number} alpha
 * @property {number} beta
 */

/**
 * @typedef {object} Forecast
 * @property {{lower: number, point: number, upper: number, coverage_target: number}} viability
 * @property {{id: string, version: string}} method
 * @property {{label: string, policy_version: string}} risk
 * @property {{level: string, policy_version: string, gates: EvidenceGate[]}} evidence
 * @property {string} model_policy_version
 * @property {{backoff_level: string, cell: ForecastCell, prior: {alpha: number, beta: number}}} contributors
 */

/**
 * @typedef {object} IngestionSignals
 * @property {boolean} synchronized Whether the source has ever committed an ingestion cursor.
 * @property {number} issues Observations rejected during ingestion.
 * @property {number} pendingMappings Observations waiting for a provider mapping.
 * @property {number} pendingSpoolObservations Live events held back by an unknown mapping.
 */

/**
 * Judge how complete a source's observations are, for the evidence gate.
 *
 * A source that has never synchronized is `unknown` rather than incomplete: nothing is
 * known about what is missing. Anything held back or rejected makes it `partial`, because
 * the history the model reads is provably not the history that happened.
 *
 * @param {IngestionSignals} signals
 * @returns {{level: "complete" | "partial" | "unknown", reasons: string[], policy_version: string}}
 */
export function classifyIngestionCompleteness(signals) {
  if (!signals.synchronized) {
    return {
      level: "unknown",
      reasons: ["never_synchronized"],
      policy_version: EVIDENCE_POLICY.version,
    };
  }
  const reasons = [
    ...(signals.issues > 0 ? ["rejected_observations"] : []),
    ...(signals.pendingMappings > 0 ? ["unmapped_providers"] : []),
    ...(signals.pendingSpoolObservations > 0 ? ["withheld_live_events"] : []),
  ];
  return {
    level: reasons.length === 0 ? "complete" : "partial",
    reasons,
    policy_version: EVIDENCE_POLICY.version,
  };
}

/**
 * Risk label for a forecast.
 *
 * The label is derived from the lower bound of the interval, never from the point
 * estimate, so a wide interval reads conservatively.
 *
 * @param {number} lower
 * @returns {{label: "low" | "elevated" | "high", policy_version: "stage2-risk-v2"}}
 */
export function classifyRisk(lower) {
  return {
    label: lower >= 0.75 ? "low" : lower >= 0.5 ? "elevated" : "high",
    policy_version: "stage2-risk-v2",
  };
}

/**
 * Weight of one observation, decayed by elapsed time and by how many comparable prompts
 * came after it.
 *
 * Both matter. Time decay expresses that a provider's behaviour drifts; recency decay
 * expresses that evidence is superseded by what the user has done since. Recency is
 * counted within the cell, so a rarely used cell keeps its own history usable.
 *
 * @param {string} startedAt
 * @param {number} promptsAfter Observations in the same cell that started later.
 * @param {Date} now
 * @param {typeof PREDICTION_POLICY} policy
 * @returns {number}
 */
function decayWeight(startedAt, promptsAfter, now, policy) {
  const ageSeconds = (now.getTime() - Date.parse(startedAt)) / 1000;
  const timeWeight =
    !Number.isFinite(ageSeconds) || ageSeconds <= 0
      ? 1
      : 2 ** (-ageSeconds / policy.decay_half_life_seconds);
  return timeWeight * 2 ** (-promptsAfter / policy.recency_half_life_prompts);
}

/**
 * Aggregate every backoff level in one pass.
 *
 * Walking newest first lets each level count how many of its own later observations
 * supersede the one being weighted, without filtering the history into separate arrays.
 * At a six-figure history the copies cost more than the arithmetic.
 *
 * @param {OutcomeRow[]} ordered Chronological, oldest first.
 * @param {{band: string, category: string}} expected
 * @param {Date} now
 * @param {typeof PREDICTION_POLICY} policy
 * @returns {{level: string, cell: ForecastCell}[]} most specific first
 */
function summarizeLevels(ordered, expected, now, policy) {
  const cells = [emptyCell(), emptyCell(), emptyCell()];
  const seen = [0, 0, 0];

  for (let index = ordered.length - 1; index >= 0; index -= 1) {
    const row = ordered[index];
    if (row === undefined) continue;
    const matches = [
      row.pressure_band === expected.band && row.size_category === expected.category,
      row.pressure_band === expected.band,
      true,
    ];
    for (let level = 0; level < cells.length; level += 1) {
      if (!matches[level]) continue;
      const cell = /** @type {ForecastCell} */ (cells[level]);
      if (row.outcome === "excluded") {
        cell.excluded += 1;
        continue;
      }
      const weight = decayWeight(row.started_at, seen[level] ?? 0, now, policy);
      seen[level] = (seen[level] ?? 0) + 1;
      if (row.outcome === "success") {
        cell.successes += 1;
        cell.weighted_successes += weight;
      } else if (row.outcome === "restricted") {
        cell.restrictions += 1;
        cell.weighted_restrictions += weight;
      }
    }
  }

  return cells.map((cell, level) => {
    cell.effective_samples = cell.weighted_successes + cell.weighted_restrictions;
    return { level: policy.backoff_levels[level] ?? "prior", cell };
  });
}

/**
 * @param {OutcomeRow[]} rows
 * @returns {boolean}
 */
function isChronological(rows) {
  for (let index = 1; index < rows.length; index += 1) {
    if ((rows[index - 1]?.started_at ?? "") > (rows[index]?.started_at ?? "")) return false;
  }
  return true;
}

/**
 * Pick the most specific level that carries enough evidence.
 *
 * Candidates arrive most specific first. A level below the minimum still beats the prior
 * alone, because discarding an observation would misstate the history; only a period with
 * no eligible outcome at all falls back to the weak prior.
 *
 * @param {{level: string, cell: ForecastCell}[]} candidates
 * @param {typeof PREDICTION_POLICY} policy
 * @returns {{level: string, cell: ForecastCell}}
 */
export function chooseCell(candidates, policy) {
  for (const candidate of candidates) {
    if (candidate.cell.effective_samples >= policy.minimum_cell_samples) return candidate;
  }
  const widest = candidates.at(-1);
  if (widest && widest.cell.effective_samples > 0) return widest;
  return { level: "prior", cell: emptyCell() };
}

/** @returns {ForecastCell} */
function emptyCell() {
  return {
    successes: 0,
    restrictions: 0,
    excluded: 0,
    weighted_successes: 0,
    weighted_restrictions: 0,
    effective_samples: 0,
    alpha: 0,
    beta: 0,
  };
}

/**
 * Walks the hierarchical backoff until a level carries enough evidence.
 *
 * The order is fixed: capacity period + pressure band + size category, then period +
 * band, then the period aggregate, then the weak prior alone.
 *
 * @param {ForecastInput} input
 * @param {typeof PREDICTION_POLICY} policy
 * @returns {{level: string, cell: ForecastCell}}
 */
function selectCell(input, policy) {
  // Recency is counted in observations, so the order has to be explicit rather than
  // inherited from whatever the caller happened to pass. Repository queries already return
  // chronological rows, and re-sorting a six-figure history costs more than the whole
  // forecast, so the common case is verified rather than redone.
  const ordered = isChronological(input.outcomes)
    ? input.outcomes
    : [...input.outcomes].sort((left, right) => left.started_at.localeCompare(right.started_at));
  const levels = summarizeLevels(
    ordered,
    { band: input.expectedBand, category: input.expectedCategory },
    input.now,
    policy,
  );

  // An unknown pressure band names no cell: matching on it would relabel the period
  // aggregate as band-specific evidence and inflate the relevance gate.
  return chooseCell(input.expectedBand === "unknown" ? levels.slice(2) : levels, policy);
}

/**
 * Highest level a threshold ladder supports for an observed amount.
 *
 * @param {number} value
 * @param {Record<string, number>} thresholds
 * @returns {string}
 */
function levelForThresholds(value, thresholds) {
  let level = EVIDENCE_POLICY.levels[0] ?? "very_low";
  for (const candidate of EVIDENCE_POLICY.levels) {
    const threshold = thresholds[candidate];
    if (threshold !== undefined && value >= threshold) level = candidate;
  }
  return level;
}

/**
 * Applies the composite evidence gates. The weakest gate wins.
 *
 * @param {ForecastCell} cell
 * @param {string} backoffLevel
 * @param {"complete" | "partial" | "unknown"} completeness
 * @returns {{level: string, policy_version: string, gates: EvidenceGate[]}}
 */
function assessEvidence(cell, backoffLevel, completeness) {
  const ranks = EVIDENCE_POLICY.levels;
  /** @type {{id: string, level: string}[]} */
  const raw = [
    {
      id: "sample",
      level: levelForThresholds(cell.effective_samples, EVIDENCE_POLICY.sample_thresholds),
    },
    {
      id: "restrictions",
      level: levelForThresholds(cell.restrictions, EVIDENCE_POLICY.restriction_thresholds),
    },
    {
      id: "relevance",
      level:
        EVIDENCE_POLICY.relevance_ceilings[
          /** @type {keyof typeof EVIDENCE_POLICY.relevance_ceilings} */ (backoffLevel)
        ],
    },
    { id: "completeness", level: EVIDENCE_POLICY.completeness_ceilings[completeness] },
  ];

  const weakest = Math.min(...raw.map((gate) => ranks.indexOf(gate.level)));
  return {
    level: ranks[weakest] ?? "very_low",
    policy_version: EVIDENCE_POLICY.version,
    gates: raw.map((gate) => ({ ...gate, limiting: ranks.indexOf(gate.level) === weakest })),
  };
}

/**
 * Builds the viability forecast for the next prompt.
 *
 * @param {ForecastInput} input
 * @returns {Forecast}
 */
export function buildForecast(input) {
  const policy = input.policy ?? PREDICTION_POLICY;
  const { level, cell } = selectCell(input, policy);
  return assembleForecast({
    cell,
    level,
    prior: input.prior,
    policy,
    dataCompleteness: input.dataCompleteness ?? "unknown",
  });
}

/**
 * Turn one aggregated cell into the published forecast.
 *
 * Kept separate so a replay that maintains its own decayed counts produces exactly the
 * same interval, risk, evidence, and method as a forecast built from raw rows.
 *
 * @param {{cell: ForecastCell, level: string, prior: {strength: number, viability: number}, policy: typeof PREDICTION_POLICY, dataCompleteness: "complete" | "partial" | "unknown"}} input
 * @returns {Forecast}
 */
export function assembleForecast(input) {
  const { cell, level, policy } = input;

  const alpha = input.prior.strength * input.prior.viability + cell.weighted_successes;
  const beta = input.prior.strength * (1 - input.prior.viability) + cell.weighted_restrictions;
  const tail = (1 - policy.coverage_target) / 2;
  const lower = betaQuantile(tail, alpha, beta);

  return {
    // A forecast the weak prior alone produced is named as the initial heuristic it is;
    // relabelling it as the learned method would dress a prior up as a calibrated result.
    method:
      level === "prior"
        ? { id: "initial-generic", version: "1" }
        : { id: "bayesian-pressure-band", version: "1" },
    viability: {
      lower,
      point: alpha / (alpha + beta),
      upper: betaQuantile(1 - tail, alpha, beta),
      coverage_target: policy.coverage_target,
    },
    risk: classifyRisk(lower),
    evidence: assessEvidence(cell, level, input.dataCompleteness),
    model_policy_version: policy.version,
    contributors: {
      backoff_level: level,
      cell: { ...cell, alpha, beta },
      prior: {
        alpha: input.prior.strength * input.prior.viability,
        beta: input.prior.strength * (1 - input.prior.viability),
      },
    },
  };
}
