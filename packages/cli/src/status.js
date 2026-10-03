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
 * @param {{band: string, policy_version: string, contributors?: {dimension: string, percentile: number | null, contribution: number | null}[]}} [pressure] usage pressure for the primary horizon
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
      // Whether the prior still dominates is a question about mass, not about which cell the
      // forecast backed off to: a period-level estimate built from tens of thousands of prompts
      // is not sparse. Comparing the prior's pseudo-observations with the posterior they sit in
      // is the same arithmetic the interval itself uses.
      priorMass(forecast.contributors) * 2 >= posteriorMass(forecast.contributors)
        ? "Sparse history; the weak plan-profile prior still dominates this estimate."
        : "The estimate is not yet calibrated against observed outcomes.",
      "Real provider capacity is unknown.",
      "Usage pressure compares this window with local history; it is not a share of capacity.",
    ],
  };
}

/**
 * Shape what Codex CLI stated about its own capacity windows for the status document.
 *
 * Kept apart from `createSourceStatus` on purpose: nothing here reaches the forecast, the risk
 * label, the evidence level, or usage pressure. A figure the client states is quoted beside the
 * estimate and never folded into it (ADR-0007).
 *
 * @param {{installation_id: string, limit_id: string | null, plan_type: string | null, observed_at: string, windows: {window_minutes: number, used_percent: number, resets_at: string | null}[], parser_version: string}[]} rows
 *   one per installation and limit: its latest snapshot
 * @param {Date} now
 */
export function describeReportedCapacity(rows, now) {
  return rows.map((row) => ({
    client: /** @type {const} */ ("codex"),
    installation_id: row.installation_id,
    limit_id: row.limit_id,
    plan_type: row.plan_type,
    stated_at: row.observed_at,
    age_seconds: Math.max(0, Math.round((now.getTime() - Date.parse(row.observed_at)) / 1000)),
    windows: row.windows.map((window) => ({
      window_minutes: window.window_minutes,
      used_percent: window.used_percent,
      resets_at: window.resets_at,
      // A window whose reset has passed no longer describes anything: the figure was for a window
      // that has ended. It is kept so a reader can see when it ended, and is never repeated.
      reset_passed: window.resets_at !== null && Date.parse(window.resets_at) <= now.getTime(),
    })),
    parser_version: row.parser_version,
  }));
}

/** @param {import("./prediction.js").Forecast["contributors"]} contributors */
function priorMass(contributors) {
  return contributors.prior.alpha + contributors.prior.beta;
}

/** @param {import("./prediction.js").Forecast["contributors"]} contributors */
function posteriorMass(contributors) {
  return contributors.evidence_window.alpha + contributors.evidence_window.beta;
}
