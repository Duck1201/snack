/**
 * Build the explicitly uncalibrated Stage 2 estimate.
 *
 * @param {{alias: string, provider: string, profile: string, plan: string}} source
 * @param {{prompts: number, successes: number, restrictions: number, excluded: number, as_of: string | null, active_period_started_at: string | null}} observed
 * @param {Date} now
 * @param {{performed: boolean, status: string}} [synchronization]
 */
export function createInitialStatus(
  source,
  observed,
  now,
  synchronization = { performed: false, status: "not_requested" },
) {
  const asOf = observed.as_of;
  const ageSeconds = asOf === null ? null : Math.max(0, (now.getTime() - Date.parse(asOf)) / 1000);
  const alpha = 1 + observed.successes;
  const beta = 1 + observed.restrictions;
  const point = alpha / (alpha + beta);
  const lower = Math.max(0.05, point - 0.4);
  return {
    source: {
      alias: source.alias,
      provider: source.provider,
      profile: source.profile,
      plan: source.plan,
      active_period: { started_at: observed.active_period_started_at },
      plan_profile: { id: source.plan, version: "stage2-v1" },
    },
    viability: {
      lower,
      point,
      upper: Math.min(0.95, point + 0.4),
      coverage_target: 0.8,
    },
    risk: classifyRisk(lower),
    evidence: "very_low",
    method: { id: "initial-generic", version: "1" },
    contributors: {
      prior: { alpha: 1, beta: 1 },
      observed: { successes: observed.successes, restrictions: observed.restrictions },
    },
    pressure: { band: "unknown", policy_version: "stage2-placeholder-v1" },
    expected_prompt_category: "typical",
    observed: {
      prompts: observed.prompts,
      successes: observed.successes,
      restrictions: observed.restrictions,
      excluded: observed.excluded,
    },
    freshness: { as_of: asOf, age_seconds: ageSeconds },
    completeness: "partial",
    synchronization,
    caveats: [
      "Initial heuristic; this is not a calibrated probability.",
      "Real provider capacity is unknown.",
      "Usage pressure analytics are not available in Stage 2.",
    ],
  };
}

/**
 * @param {number} lower
 * @returns {{label: "low" | "elevated" | "high", policy_version: "stage2-risk-v2"}}
 */
export function classifyRisk(lower) {
  return {
    label: lower >= 0.75 ? "low" : lower >= 0.5 ? "elevated" : "high",
    policy_version: "stage2-risk-v2",
  };
}
