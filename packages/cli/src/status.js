import { assignPressureBands } from "./analytics.js";
import { resolvePlanProfile } from "./plan-profile.js";
import { assessSequence, buildForecast, buildReportedForecast } from "./prediction.js";
import {
  REPORTED_CAPACITY_POLICY,
  labelStatedBands,
  resolveStatedState,
} from "./reported-capacity.js";

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
 * @param {{sequenceLength?: number}} [request] what the user asked for beyond the next prompt:
 *   `sequenceLength` is the number passed to `--sequence`, already validated, and absent without it
 */
export function createSourceStatus(
  source,
  observed,
  now,
  synchronization = { performed: false, status: "not_requested" },
  pressure = { band: "unknown", policy_version: "no-analytics" },
  history = {},
  request = {},
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
  // The one call site. The length is the user's number and only ever travels inward: nothing
  // searches for a length that meets a probability (docs/specification/analysis.md §9.8).
  const sequence =
    request.sequenceLength === undefined
      ? undefined
      : assessSequence(forecast, request.sequenceLength);

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
    // Absent, never null, without `--sequence`: the document is then the one 1.3 emitted.
    ...(sequence === undefined ? {} : { sequence }),
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
      ...(sequence === undefined ? [] : sequenceCaveats(sequence)),
    ],
  };
}

/**
 * What a sequence estimate does not claim, said once per report.
 *
 * The first caveat is the assumption the evidence gates cannot see: every prompt is taken to meet
 * the band and category the next one does. A sequence of one has no next prompt to assume about,
 * so it is omitted there. The second is owed only when the interval is too wide to inform
 * (`SEQUENCE_WIDTH_POLICY`), so that a `0-79%` reads as an honest "not enough to say" rather than
 * as a broken tool. It states the rule and nothing more: the width `upper^N - lower^N` is not
 * monotone in `N`, and one more success can widen it, so no remedy holds in general -- and advice
 * to try another length would have the reader search `N` for a probability, the inversion SNACK
 * never performs. The length is written `N-prompt`, never `N prompts`, so no phrase here can be
 * read as a number of prompts a plan allows. At one, "all of them" is as wrong as "all 1", so the
 * width caveat speaks of the next prompt, as the `next prompt` row does.
 *
 * @param {import("./prediction.js").SequenceAssessment} sequence
 * @returns {string[]}
 */
function sequenceCaveats(sequence) {
  const length = sequence.length;
  return [
    ...(length === 1
      ? []
      : [
          `The ${length}-prompt estimate assumes each prompt meets the conditions the next one does; it does not model usage pressure rising as they are sent.`,
        ]),
    ...(sequence.width.too_wide
      ? [
          length === 1
            ? "The 1-prompt interval is too wide to say much; it cannot tell whether the next prompt is more likely to go through than not."
            : `The ${length}-prompt interval is too wide to say much; it cannot tell whether all of them going through is more likely than not.`,
        ]
      : []),
  ];
}

/**
 * Shape what Codex CLI stated about its own capacity windows for the status document.
 *
 * Kept apart from `createSourceStatus` on purpose: nothing here reaches the forecast, the risk
 * label, the evidence level, or usage pressure. A figure the client states is quoted beside the
 * estimate and never folded into it (ADR-0007). From 1.5 it informs one estimate only: the
 * `reported-capacity` shadow, which `createShadowStatus` computes and never shows as the answer.
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

/**
 * @typedef {object} ShadowView
 * @property {{id: string, version: string}} method
 * @property {boolean} computed
 * @property {string | null} reason Why it was not computed; null when it was.
 * @property {{installation_id: string, limit_id: string | null, window_minutes: number, resets_at: string | null, stated_at: string, band: "clear" | "near" | "full"} | null} binding
 *   The window it read, never with the stated figure: that is quoted once, in `reported_capacity`.
 * @property {string} policy_version
 * @property {import("./prediction.js").Forecast["viability"]} [viability]
 * @property {import("./prediction.js").Forecast["risk"]} [risk]
 * @property {import("./prediction.js").Forecast["evidence"]} [evidence]
 * @property {string} [model_policy_version]
 * @property {import("./prediction.js").Forecast["contributors"]} [contributors]
 */

/**
 * The `reported-capacity` shadow forecast for one capacity source a Codex installation feeds.
 *
 * Computed beside the baseline and never instead of it: in 1.5 the baseline is the answer for every
 * source, and this is what the figure-informed method would have said, recorded so its calibration
 * can be compared with the baseline's on the same prompts (ADR-0007, amended 1.5.0). Nothing here
 * reads, and nothing it returns is written into, the report `createSourceStatus` built; the one
 * place the two meet is `attachShadow`, which adds and never replaces.
 *
 * The stated timeline is read only when a window binds now -- a stale or absent statement costs
 * one row read and nothing else.
 *
 * @param {{now: Date, latest: {installation_id: string, limit_id: string | null, observed_at: string, windows: {window_minutes: number, used_percent: number, resets_at: string | null}[]}[],
 *   periodStart: string | null, foreignPromptAfter: (installationId: string, since: string) => boolean,
 *   readTimeline: (from: string) => import("./reported-capacity.js").Statement[],
 *   outcomes: import("./reported-capacity.js").StatedOutcome[], expectedCategory: string,
 *   prior: {strength: number, viability: number}, dataCompleteness: "complete" | "partial" | "unknown"}} input
 * @returns {{view: ShadowView, row: import("./storage.js").PredictionShadowRow | undefined}}
 */
export function createShadowStatus(input) {
  const method = { ...REPORTED_CAPACITY_POLICY.method };
  const nowMs = input.now.getTime();
  const state = resolveStatedState({
    // A statement stamped after the clock -- a test's injected `now`, or a skewed client -- has not
    // been made yet as far as this invocation knows.
    statements: input.latest.filter((entry) => Date.parse(entry.observed_at) <= nowMs),
    at: nowMs,
    periodStart: input.periodStart,
    foreignPromptAfter: input.foreignPromptAfter,
  });
  /** @param {string} reason @param {ShadowView["binding"]} binding */
  const notComputed = (reason, binding) => ({
    view: {
      method,
      computed: false,
      reason,
      binding,
      policy_version: REPORTED_CAPACITY_POLICY.version,
    },
    row: undefined,
  });
  if (state.band === null) return notComputed(state.reason, null);

  const { used_percent: usedPercent, ...binding } = state.binding;
  const oldest = input.outcomes[0]?.started_at;
  const timeline =
    oldest === undefined
      ? []
      : input.readTimeline(
          new Date(
            Date.parse(oldest) - REPORTED_CAPACITY_POLICY.max_age_seconds * 1000,
          ).toISOString(),
        );
  const forecast = buildReportedForecast({
    now: input.now,
    band: state.band,
    prior: input.prior,
    expectedCategory: input.expectedCategory,
    outcomes: labelStatedBands(input.outcomes, timeline, { periodStart: input.periodStart }),
    dataCompleteness: input.dataCompleteness,
  });
  if (forecast === null) return notComputed("no_local_outcomes", binding);

  return {
    view: {
      method,
      computed: true,
      reason: null,
      binding,
      policy_version: REPORTED_CAPACITY_POLICY.version,
      viability: forecast.viability,
      risk: forecast.risk,
      evidence: forecast.evidence,
      model_policy_version: forecast.model_policy_version,
      contributors: forecast.contributors,
    },
    row: {
      method_id: forecast.method.id,
      method_version: forecast.method.version,
      model_policy_version: forecast.model_policy_version,
      evidence_policy_version: forecast.evidence.policy_version,
      lower: forecast.viability.lower,
      point: forecast.viability.point,
      upper: forecast.viability.upper,
      coverage_target: forecast.viability.coverage_target,
      risk_label: forecast.risk.label,
      evidence_level: forecast.evidence.level,
      backoff_level: forecast.contributors.backoff_level,
      posterior_alpha: forecast.contributors.evidence_window.alpha,
      posterior_beta: forecast.contributors.evidence_window.beta,
      installation_id: binding.installation_id,
      limit_id: binding.limit_id,
      window_minutes: binding.window_minutes,
      used_percent: usedPercent,
      resets_at: binding.resets_at,
      stated_at: binding.stated_at,
      band: binding.band,
      policy_version: REPORTED_CAPACITY_POLICY.version,
    },
  };
}

/**
 * Add what a Codex installation states, and the shadow it informed, to a finished report.
 *
 * The one place a stated figure meets the report, and it only ever adds two members. Every member
 * `createSourceStatus` produced -- the interval, the risk, the evidence, the method, the sequence,
 * the caveats -- is passed through untouched, so the answer is the baseline's whether or not a
 * figure was stated (shadow mode, ADR-0007 amended 1.5.0).
 *
 * @template {object} T
 * @param {T} status
 * @param {ReturnType<typeof describeReportedCapacity>} reported
 * @param {ShadowView} shadow
 * @returns {T & {reported_capacity: ReturnType<typeof describeReportedCapacity>, shadow: ShadowView}}
 */
export function attachShadow(status, reported, shadow) {
  return { ...status, reported_capacity: reported, shadow };
}

/** @param {import("./prediction.js").Forecast["contributors"]} contributors */
function priorMass(contributors) {
  return contributors.prior.alpha + contributors.prior.beta;
}

/** @param {import("./prediction.js").Forecast["contributors"]} contributors */
function posteriorMass(contributors) {
  return contributors.evidence_window.alpha + contributors.evidence_window.beta;
}
