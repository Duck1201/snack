import { assignPressureBands } from "./analytics.js";
import { resolvePlanProfile } from "./plan-profile.js";
import { buildForecast } from "./prediction.js";

/**
 * Assemble the status document for one capacity source.
 *
 * The forecast itself comes from the prediction module; this function only shapes the
 * domain result for output.
 *
 * @param {{alias: string, provider: string, profile: string, plan: string, plan_profile?: string}} source
 * @param {{prompts: number, successes: number, restrictions: number, excluded: number, as_of: string | null, active_period_started_at: string | null}} observed
 * @param {Date} now
 * @param {{performed: boolean, status: string}} [synchronization]
 * @param {{band: string, policy_version: string}} [pressure] usage pressure for the primary horizon
 * @param {{outcomes?: import("./prediction.js").OutcomeRow[], windowSeconds?: number, category?: string, prospective?: object, completeness?: {level: "complete" | "partial" | "unknown", reasons: string[], policy_version: string}}} [history]
 */
export function createSourceStatus(
  source,
  observed,
  now,
  synchronization = { performed: false, status: "not_requested" },
  pressure = { band: "unknown", policy_version: "no-analytics" },
  history = {},
) {
  const planProfile = resolvePlanProfile(source).profile;
  const asOf = observed.as_of;
  const ageSeconds = asOf === null ? null : Math.max(0, (now.getTime() - Date.parse(asOf)) / 1000);

  const origin = observed.active_period_started_at ?? asOf ?? now.toISOString();
  const outcomes =
    history.outcomes && history.windowSeconds
      ? assignPressureBands(history.outcomes, { origin, windowSeconds: history.windowSeconds })
      : (history.outcomes ?? []);

  const expectedCategory = history.category ?? "typical";
  const completeness = history.completeness ?? {
    level: /** @type {"unknown"} */ ("unknown"),
    reasons: ["never_synchronized"],
    policy_version: "stage5-evidence-v1",
  };
  const forecast = buildForecast({
    now,
    prior: { strength: planProfile.prior_strength, viability: planProfile.prior_viability },
    expectedBand: pressure.band,
    expectedCategory,
    outcomes,
    dataCompleteness: completeness.level,
  });

  return {
    source: {
      alias: source.alias,
      provider: source.provider,
      profile: source.profile,
      plan: source.plan,
      active_period: { started_at: observed.active_period_started_at },
      plan_profile: {
        id: planProfile.id,
        version: planProfile.version,
        provenance: planProfile.provenance,
        as_of: planProfile.as_of,
      },
    },
    viability: forecast.viability,
    risk: forecast.risk,
    evidence: forecast.evidence,
    method: forecast.method,
    model_policy_version: forecast.model_policy_version,
    contributors: forecast.contributors,
    pressure,
    expected_prompt_category: expectedCategory,
    prospective: history.prospective ?? null,
    observed: {
      prompts: observed.prompts,
      successes: observed.successes,
      restrictions: observed.restrictions,
      excluded: observed.excluded,
    },
    freshness: { as_of: asOf, age_seconds: ageSeconds },
    completeness,
    synchronization,
    caveats: [
      forecast.contributors.backoff_level === "period_band_category"
        ? "The estimate is not yet calibrated against observed outcomes."
        : "Sparse history; the weak plan-profile prior still dominates this estimate.",
      "Real provider capacity is unknown.",
      "Usage pressure compares this window with local history; it is not a share of capacity.",
    ],
  };
}
