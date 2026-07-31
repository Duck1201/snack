/**
 * Learned next-prompt viability forecast.
 *
 * The model is a weighted Beta-Binomial over source outcomes, seeded by the weak plan
 * profile prior. It consumes domain-shaped rows and never queries SQLite.
 */

import { betaQuantile } from "./beta.js";

/** Versioned model policy. Every forecast names the policy that produced it. */
export const PREDICTION_POLICY = Object.freeze({
  version: "stage5-prediction-v1",
  coverage_target: 0.8,
  decay_half_life_seconds: 604800,
  minimum_cell_samples: 5,
  backoff_levels: Object.freeze(["period_band_category", "period_band", "period", "prior"]),
});

/**
 * Versioned evidence gates. The weakest gate caps the reported level, so a rich history
 * with no observed restriction can never look strong.
 */
export const EVIDENCE_POLICY = Object.freeze({
  version: "stage5-evidence-v1",
  levels: Object.freeze(["very_low", "low", "moderate", "high"]),
  /** Effective sample size needed to reach each level above `very_low`. */
  sample_thresholds: Object.freeze({ low: 2, moderate: 20, high: 50 }),
  /**
   * Observed restrictions needed to reach each level. A history with none is capped at
   * `low` however many successes it holds, but it is not by itself the weakest gate.
   */
  restriction_thresholds: Object.freeze({ low: 0, moderate: 1, high: 5 }),
  /** Highest level each backoff level may support. */
  relevance_ceilings: Object.freeze({
    period_band_category: "high",
    period_band: "moderate",
    period: "low",
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
 * @property {{label: string, policy_version: string}} risk
 * @property {{level: string, policy_version: string, gates: EvidenceGate[]}} evidence
 * @property {string} model_policy_version
 * @property {{backoff_level: string, cell: ForecastCell, prior: {alpha: number, beta: number}}} contributors
 */

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
 * Time-decay weight of one observation.
 *
 * @param {string} startedAt
 * @param {Date} now
 * @param {number} halfLifeSeconds
 * @returns {number}
 */
function decayWeight(startedAt, now, halfLifeSeconds) {
  const ageSeconds = (now.getTime() - Date.parse(startedAt)) / 1000;
  if (!Number.isFinite(ageSeconds) || ageSeconds <= 0) return 1;
  return 2 ** (-ageSeconds / halfLifeSeconds);
}

/**
 * Aggregates the eligible outcomes a backoff level owns.
 *
 * @param {OutcomeRow[]} rows
 * @param {Date} now
 * @param {number} halfLifeSeconds
 * @returns {ForecastCell}
 */
function summarizeCell(rows, now, halfLifeSeconds) {
  const cell = {
    successes: 0,
    restrictions: 0,
    excluded: 0,
    weighted_successes: 0,
    weighted_restrictions: 0,
    effective_samples: 0,
    alpha: 0,
    beta: 0,
  };

  for (const row of rows) {
    if (row.outcome === "excluded") {
      cell.excluded += 1;
      continue;
    }
    const weight = decayWeight(row.started_at, now, halfLifeSeconds);
    if (row.outcome === "success") {
      cell.successes += 1;
      cell.weighted_successes += weight;
    } else if (row.outcome === "restricted") {
      cell.restrictions += 1;
      cell.weighted_restrictions += weight;
    }
  }

  cell.effective_samples = cell.weighted_successes + cell.weighted_restrictions;
  return cell;
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
  const matchers = [
    (/** @type {OutcomeRow} */ row) =>
      row.pressure_band === input.expectedBand && row.size_category === input.expectedCategory,
    (/** @type {OutcomeRow} */ row) => row.pressure_band === input.expectedBand,
    () => true,
  ];

  /** @type {{level: string, cell: ForecastCell} | null} */
  let widest = null;
  for (const [index, matches] of matchers.entries()) {
    const cell = summarizeCell(
      input.outcomes.filter(matches),
      input.now,
      policy.decay_half_life_seconds,
    );
    widest = { level: policy.backoff_levels[index] ?? "prior", cell };
    if (cell.effective_samples >= policy.minimum_cell_samples) return widest;
  }

  // Reaching here means no level met the minimum. The period aggregate still carries every
  // eligible observation, and discarding it would throw away local evidence; the width of
  // the interval and the evidence gates carry that sparsity instead. Only a period without
  // any eligible outcome falls back to the weak prior alone.
  if (widest && widest.cell.effective_samples > 0) return widest;
  return {
    level: "prior",
    cell: summarizeCell([], input.now, policy.decay_half_life_seconds),
  };
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

  const alpha = input.prior.strength * input.prior.viability + cell.weighted_successes;
  const beta = input.prior.strength * (1 - input.prior.viability) + cell.weighted_restrictions;
  const tail = (1 - policy.coverage_target) / 2;
  const lower = betaQuantile(tail, alpha, beta);

  return {
    viability: {
      lower,
      point: alpha / (alpha + beta),
      upper: betaQuantile(1 - tail, alpha, beta),
      coverage_target: policy.coverage_target,
    },
    risk: classifyRisk(lower),
    evidence: assessEvidence(cell, level, input.dataCompleteness ?? "unknown"),
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
