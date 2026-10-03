import {
  ANALYTICS_POLICY,
  PLOT_POLICY,
  TREND_POLICY,
  computeUsagePressure,
  computeUsageTrend,
  horizonWindow,
  parseHorizon,
  summarizeUsageProfile,
} from "./analytics.js";
import { isCodexSource } from "./codex-adapter.js";
import { defaultConfig } from "./config.js";
import { resolvePlanProfile } from "./plan-profile.js";
import {
  PREDICTION_POLICY,
  WEIGHTING_VARIANTS,
  classifyIngestionCompleteness,
} from "./prediction.js";
import { categorizeHistory } from "./prompt-features.js";
import { REPORTED_CAPACITY_POLICY, walkStatedHistory } from "./reported-capacity.js";
import {
  attachShadow,
  attachShadows,
  createShadowStatus,
  createSourceStatus,
  createWeightingShadows,
  describeReportedCapacity,
  prepareForecastInput,
} from "./status.js";
import {
  hasForeignPromptSince,
  linkPrimaryEvaluations,
  readCategorizationRows,
  readIngestionCursor,
  readOutcomeRows,
  readPendingMappingCount,
  readPendingSpoolObservations,
  readReportedCapacity,
  readSourceSummary,
  readSpoolIssueCount,
  readStatedBandProjection,
  readStatedBandRows,
  readStatedTimeline,
  readUsageWindowRows,
  recordPredictionAttempt,
  recordPredictionDelivery,
  writeSizeCategories,
  writeStatedBands,
} from "./storage.js";

/**
 * One capacity source's reading, from storage to the report a human surface draws: the code
 * `status` runs for each source, and the one `snack dash` runs once per synchronization.
 *
 * Extracted from `main.js` so the two commands share one path rather than two copies of it: the
 * report the dash draws is, byte for byte, the report `status --no-sync` would have printed at the
 * same instant. This module reads storage and writes the prediction rows; it never touches a
 * terminal, and it takes no lock -- every caller holds the storage operation lock around it.
 */

/**
 * @typedef {ReturnType<typeof createSourceStatus> & {reported_capacity?: ReturnType<typeof describeReportedCapacity>, shadow?: import("./status.js").ShadowView, shadows: (import("./status.js").ShadowView | import("./status.js").WeightingShadowView)[]}} SourceReport
 */

/**
 * @typedef {object} BuiltSource
 * @property {string} alias
 * @property {number | null} capacityPeriodId The active period, or null when the source has none
 *   yet; a source without one records no attempt.
 * @property {SourceReport} report
 * @property {(number | null)[]} series The dash's plot (`readPressure`); empty unless asked for.
 * @property {string} seriesHorizon
 * @property {ReturnType<typeof createSourceStatus>} answer The report before any shadow was added:
 *   what the attempt records.
 * @property {import("./storage.js").PredictionShadowRow | undefined} shadowRow
 * @property {import("./storage.js").WeightingShadowRow[]} weightingRows
 * @property {Date} now
 * @property {number | null} attemptId Set when `record` was asked for and an attempt was written.
 */

/** @typedef {import("./storage.js").ConfiguredSource & {plan_profile?: string}} ReportedSource */

/**
 * Build the report of every selected capacity source, in order.
 *
 * Per source, in this order: synchronize (through the caller's `synchronize`, which `status` points
 * at ingestion and the dash at the outcome of its own sync child), the projections a performed
 * synchronization owes, the summary, the pressure, the optional prospective prompt, the outcomes,
 * the answer, the weighting variants, the `reported-capacity` shadow, and -- with `record` -- the
 * attempt. One source is finished before the next is started, as `status` always did.
 *
 * @param {{
 *   databaseFile: string,
 *   config: Record<string, unknown>,
 *   selected: ReportedSource[],
 *   inScope: ReportedSource[],
 *   now: Date,
 *   synchronize: (source: ReportedSource) => Promise<{performed: boolean, status: string}>,
 *   prospective?: (alias: string) => Promise<{category: string, prospective: object} | null>,
 *   sequenceLength?: number,
 *   weightingVariants?: typeof WEIGHTING_VARIANTS,
 *   record?: boolean,
 *   includeSeries?: boolean,
 * }} input
 * @returns {Promise<{sources: BuiltSource[], warnings: {code: string, message: string}[]}>}
 */
export async function buildSourceReports(input) {
  const { databaseFile, now } = input;
  /** @type {BuiltSource[]} */
  const sources = [];
  /** @type {{code: string, message: string}[]} */
  const warnings = [];
  const horizon = primaryHorizon(input.config);
  for (const source of input.selected) {
    const synchronization = await input.synchronize(source);
    // Absent unless a Codex installation feeds this capacity source; a source no Codex
    // installation feeds never takes the branches below, and its report is the 1.4 one.
    const quotesCodex = input.inScope.some(
      (entry) => entry.alias === source.alias && isCodexSource(entry),
    );
    if (synchronization.performed) {
      recategorizeSource(databaseFile, source.alias);
      if (quotesCodex) {
        restateSource(databaseFile, source.alias);
      }
      linkPrimaryEvaluations(databaseFile, source.alias, "stage5-evaluation-v1");
    }
    const summary = readSourceSummary(databaseFile, source.alias);
    const { profile: planProfile, warnings: profileWarnings } = resolvePlanProfile(source);
    warnings.push(...profileWarnings);
    const { pressure, series } = readPressure({
      databaseFile,
      source,
      planProfile,
      horizon,
      now,
      // The usage-pressure sparkline is drawn from these window scores. They reach the
      // `--json` payload too, in the `pressure.trend` slot `status.schema.json` has declared
      // since the 0.9 freeze -- see the amended 1.1.0 exit criterion in PLAN.md.
      includeTrend: true,
      includeSeries: input.includeSeries === true,
    });
    /** @type {{category: string, prospective: object} | null} */
    let prospective = null;
    if (input.prospective !== undefined) {
      try {
        prospective = await input.prospective(source.alias);
      } catch {
        // The text is discarded either way; a missing or unreadable file must not
        // cost the user their forecast, and no part of the error is reported.
        warnings.push({
          code: "prospective_analysis_failed",
          message: "The prompt could not be analyzed; assuming a typical prompt.",
        });
      }
    }
    const outcomes = readOutcomeRows(databaseFile, source.alias, {
      limit: PREDICTION_POLICY.evidence_window_prompts,
    });
    const history = {
      outcomes,
      windowSeconds: parseHorizon(horizon),
      completeness: classifyIngestionCompleteness({
        synchronized: readIngestionCursor(databaseFile, source.alias) !== null,
        issues: readSpoolIssueCount(databaseFile, source.alias),
        pendingMappings: readPendingMappingCount(databaseFile, source),
        pendingSpoolObservations: readPendingSpoolObservations(databaseFile, source).length,
      }),
      ...(prospective
        ? { category: prospective.category, prospective: prospective.prospective }
        : {}),
    };
    // Prepared once: the answer and every weighting variant read this very input, so the
    // outcomes are banded once and a variant can differ from the answer only by its weights.
    const prepared = prepareForecastInput(source, summary, now, pressure, history);
    const sourceStatus = createSourceStatus(
      source,
      summary,
      now,
      synchronization,
      pressure,
      history,
      input.sequenceLength === undefined
        ? { prepared }
        : { sequenceLength: input.sequenceLength, prepared },
    );
    // The weighting variants, in shadow on every source: computed beside the answer from the
    // same prepared input, recorded with its attempt, and never the answer (1.6.0).
    const weighting = createWeightingShadows(
      prepared,
      input.weightingVariants ?? WEIGHTING_VARIANTS,
    );
    // Attached after the forecast is built, and beside it: what Codex states about its own
    // windows is quoted, never an input to the interval, the risk, the evidence or pressure
    // (ADR-0007).
    /** @type {import("./storage.js").PredictionShadowRow | undefined} */
    let shadowRow;
    /** @type {SourceReport} */
    let report;
    if (quotesCodex) {
      const latest = readReportedCapacity(databaseFile, source.alias);
      // The `reported-capacity` method, in shadow: computed and recorded beside the
      // baseline, never the answer (ADR-0007, amended 1.5.0). It reads the same evidence
      // window the baseline did and none of what the baseline produced.
      const shadow = createShadowStatus({
        now,
        latest,
        periodStart: summary.active_period_floor,
        foreignPromptAfter: (installationId, since) =>
          hasForeignPromptSince(databaseFile, source.alias, installationId, since),
        outcomes,
        expectedCategory: sourceStatus.expected_prompt_category,
        prior: {
          strength: planProfile.prior_strength,
          viability: planProfile.prior_viability,
        },
        dataCompleteness: sourceStatus.completeness.level,
      });
      shadowRow = shadow.row;
      report = attachShadows(
        attachShadow(sourceStatus, describeReportedCapacity(latest, now), shadow.view),
        weighting.views,
      );
    } else {
      report = attachShadows(sourceStatus, weighting.views);
    }
    /** @type {BuiltSource} */
    const built = {
      alias: source.alias,
      capacityPeriodId: summary.active_period_id,
      report,
      series,
      seriesHorizon: horizon,
      answer: sourceStatus,
      shadowRow,
      weightingRows: weighting.rows,
      now,
      attemptId: null,
    };
    if (input.record === true) built.attemptId = recordAttempt(databaseFile, built);
    sources.push(built);
  }
  return { sources, warnings };
}

/**
 * Record one built source's answer as a prediction attempt, with the rows its transaction carries:
 * the sequence the same invocation answered, the `reported-capacity` shadow and the weighting
 * variants. A source with no active period records nothing and returns null, as `status` always did.
 *
 * @param {string} databaseFile
 * @param {BuiltSource} built
 * @returns {number | null}
 */
export function recordAttempt(databaseFile, built) {
  if (built.capacityPeriodId === null) return null;
  return recordPredictionAttempt(
    databaseFile,
    // The baseline's forecast: the answer the user is shown. The shadow never is.
    toPredictionAttempt(built.alias, built.capacityPeriodId, built.answer, built.now),
    // The sequence the same invocation answered rides with its attempt, in its own
    // table: a `prediction_attempt` row is scored against one prompt, and a sequence
    // scored that way would corrupt the live calibration stream (ADR-0008).
    built.answer.sequence === undefined ? undefined : toPredictionSequence(built.answer),
    built.shadowRow,
    built.weightingRows,
  );
}

/**
 * Shape a status result as the immutable attempt row that records it.
 *
 * Only approved aggregates travel: the pressure contributors keep their dimension and
 * numbers, never anything derived from prompt content.
 *
 * @param {string} alias
 * @param {number} capacityPeriodId
 * @param {ReturnType<typeof createSourceStatus>} status
 * @param {Date} now
 * @returns {Record<string, unknown>}
 */
export function toPredictionAttempt(alias, capacityPeriodId, status, now) {
  return {
    source_alias: alias,
    capacity_period_id: capacityPeriodId,
    generated_at: now.toISOString(),
    method_id: status.method.id,
    method_version: status.method.version,
    model_policy_version: status.model_policy_version,
    risk_policy_version: status.risk.policy_version,
    evidence_policy_version: status.evidence.policy_version,
    weight_policy_version: status.pressure.policy_version,
    analytics_policy_version: status.pressure.policy_version,
    category_policy_version:
      /** @type {{policy_version?: string} | null} */ (status.prospective)?.policy_version ?? null,
    lower: status.viability.lower,
    point: status.viability.point,
    upper: status.viability.upper,
    coverage_target: status.viability.coverage_target,
    risk_label: status.risk.label,
    evidence_level: status.evidence.level,
    expected_size_category: status.expected_prompt_category,
    backoff_level: status.contributors.backoff_level,
    pressure_band: status.pressure.band,
    pressure_score: /** @type {{score?: number | null}} */ (status.pressure).score ?? null,
    pressure_contributors_json: JSON.stringify(
      /** @type {{contributors?: unknown[]}} */ (status.pressure).contributors ?? [],
    ),
    plan_profile_id: status.source.plan_profile.id,
    plan_profile_version: status.source.plan_profile.version,
    data_as_of: status.freshness.as_of,
    completeness: status.completeness.level,
  };
}

/**
 * Shape a status result's sequence answer as the row recorded beside its attempt.
 *
 * The posterior is stored because the parent attempt does not carry it, and a later calibration
 * must be able to reproduce the answer without recalculating the past.
 *
 * @param {ReturnType<typeof createSourceStatus>} status
 * @returns {import("./storage.js").PredictionSequenceRow}
 */
export function toPredictionSequence(status) {
  const sequence = /** @type {import("./prediction.js").SequenceAssessment} */ (status.sequence);
  return {
    length: sequence.length,
    method_id: sequence.method.id,
    method_version: sequence.method.version,
    lower: sequence.viability.lower,
    point: sequence.viability.point,
    upper: sequence.viability.upper,
    coverage_target: sequence.viability.coverage_target,
    risk_label: sequence.risk.label,
    risk_policy_version: sequence.risk.policy_version,
    width_too_wide: sequence.width.too_wide ? 1 : 0,
    width_policy_version: sequence.width.policy_version,
    posterior_alpha: status.contributors.evidence_window.alpha,
    posterior_beta: status.contributors.evidence_window.beta,
  };
}

/**
 * Confirm that forecasts reached the user, promoting the attempts to snapshots.
 *
 * @param {string} databaseFile
 * @param {number[]} attemptIds
 * @param {{now: Date, format: string, invocationId: string}} delivery
 */
export function confirmPredictionDelivery(databaseFile, attemptIds, delivery) {
  for (const id of attemptIds) {
    recordPredictionDelivery(databaseFile, {
      prediction_attempt_id: id,
      delivered_at: delivery.now.toISOString(),
      channel: "stdout",
      format: delivery.format,
      invocation_id: delivery.invocationId,
    });
  }
}

/**
 * Recompute the derived size categories of a source after ingestion.
 *
 * ponytail: recategorizes the whole source on every sync. The chronological suffix from
 * the earliest changed prompt would be enough; narrow this if the sync budget demands it.
 *
 * @param {string} databaseFile
 * @param {string} alias
 */
export function recategorizeSource(databaseFile, alias) {
  const categorized = categorizeHistory(readCategorizationRows(databaseFile, alias));
  writeSizeCategories(
    databaseFile,
    categorized.map((row) => ({
      prompt_execution_id: row.prompt_execution_id,
      size_category: row.size_category,
      category_policy_version: row.category_policy_version,
      category_baseline_as_of: row.category_baseline_as_of,
    })),
  );
}

/**
 * Recompute the stated band the prompts of a source's active period began in, and store the ones
 * that moved.
 *
 * The projection the `reported-capacity` shadow reads (migration 018), recomputed in chronological
 * order as size categories are, because a statement read late -- a rollout file met for the first
 * time after newer ones -- moves the prompts after it, and so does a purge. Each band is resolved
 * at its prompt's own start from statements strictly earlier.
 *
 * Only the suffix that can have moved is recomputed: the prompts from the source's frontier, which
 * the ingestion and purge transactions lower as they commit, so a process stopped between a commit
 * and this call leaves the frontier where the next one finds it. Nothing older than one
 * statement-age limit before the frontier can bind a prompt after it, so the walk starts there. A
 * source never projected, or projected under another policy version, is recomputed whole; one
 * whose frontier is clear costs one primary-key read.
 *
 * @param {string} databaseFile
 * @param {string} alias
 */
export function restateSource(databaseFile, alias) {
  const version = REPORTED_CAPACITY_POLICY.version;
  const { frontier, stale_from: read } = readStatedBandProjection(databaseFile, alias, version);
  if (frontier === null) return;
  const lookback =
    frontier === ""
      ? ""
      : new Date(
          Date.parse(frontier) - REPORTED_CAPACITY_POLICY.max_age_seconds * 1000,
        ).toISOString();
  // NaN for the whole period, which no start is before.
  const frontierMs = Date.parse(frontier);
  const floor = readSourceSummary(databaseFile, alias).active_period_floor;
  const rows = readStatedBandRows(databaseFile, alias, { from: lookback });
  const timeline =
    rows.length === 0
      ? []
      : readStatedTimeline(databaseFile, alias, {
          from: floor !== null && floor > lookback ? floor : lookback,
        });
  /** @type {{prompt_execution_id: number, stated_band: string | null, stated_band_policy_version: string}[]} */
  const moved = [];
  walkStatedHistory(
    rows.map((row) => ({ ...row, outcome: /** @type {const} */ ("success") })),
    timeline,
    { periodStart: floor },
    (row, state) => {
      // Before the frontier the lookback is incomplete, and nothing there can have moved. Compared
      // as instants: a start stored with an offset can sort before the frontier as text.
      if (Date.parse(row.started_at) < frontierMs) return;
      if (row.stated_band !== state.band || row.stated_band_policy_version !== version) {
        moved.push({
          prompt_execution_id: row.prompt_execution_id,
          stated_band: state.band,
          stated_band_policy_version: version,
        });
      }
    },
  );
  writeStatedBands(databaseFile, alias, moved, version, read);
}

/**
 * The first configured horizon drives the pressure shown alongside a forecast.
 *
 * @param {Record<string, unknown>} config
 * @returns {string}
 */
export function primaryHorizon(config) {
  const configured = /** @type {{horizons?: unknown}} */ (config.analysis)?.horizons;
  return Array.isArray(configured) && typeof configured[0] === "string"
    ? configured[0]
    : /** @type {string} */ (defaultConfig.analysis.horizons[0]);
}

/**
 * Rank the current analysis window against the preceding windows of the same length.
 *
 * The trend is reported by `stats` only. `status` answers whether the next prompt is viable,
 * and a direction over past windows is not part of that answer.
 *
 * With `includeSeries`, the same read and the same buckets also give the dash's plot
 * (`pressureSeries`): the newest `PLOT_POLICY.windows` windows, oldest first, each scored against
 * the one baseline the current window is ranked against, so every score sits on one scale. A window
 * with no prompt is `null` -- absence of observation, never zero -- and with too few baseline
 * windows to rank against, every window is. The series is returned beside the pressure, never
 * inside it: the pressure object is what `status --json` serializes.
 *
 * @param {{databaseFile: string, source: {alias: string}, planProfile: import("./plan-profile.js").PlanProfile, horizon: string, now: Date, includeTrend?: boolean, includeSeries?: boolean}} input
 */
export function readPressure(input) {
  const horizonSeconds = parseHorizon(input.horizon);
  const windowCount = ANALYTICS_POLICY.pressure_baseline_windows;
  // One read covers the current window and every baseline window behind it. Reading each
  // window separately meant one SQLite connection and one scan per window.
  const span = horizonWindow(input.now, horizonSeconds * (windowCount + 1));
  const rows = readUsageWindowRows(input.databaseFile, input.source.alias, span);

  /** @type {import("./storage.js").UsageWindowRow[][]} */
  const buckets = Array.from({ length: windowCount + 1 }, () => []);
  for (const row of rows) {
    // Windows are half-open as `[start, end)`, so an age of exactly one horizon still
    // belongs to the newer window.
    const ageSeconds = (input.now.getTime() - Date.parse(row.started_at)) / 1000;
    const bucket = Math.ceil(ageSeconds / horizonSeconds) - 1;
    buckets[bucket]?.push(row);
  }

  const current = summarizeWindow(/** @type {typeof rows} */ (buckets[0]), input.now);
  /** @type {Record<string, number[]>} */
  const baselines = {};
  /** @type {Record<string, number[]>} */
  const trendBaselines = {};
  /** @type {Record<string, number>[]} */
  const trendWindows = [];
  let observedWindows = 0;
  for (let offset = 1; offset <= windowCount; offset += 1) {
    const past = summarizeWindow(/** @type {typeof rows} */ (buckets[offset]), input.now);
    // A window with no prompts means the tool was not used then, which is absence of
    // observation rather than evidence of low usage. Ranking against it would call a
    // brand new user's first prompt the heaviest window on record.
    if (past.values.prompts === 0) continue;
    observedWindows += 1;
    for (const [dimension, value] of Object.entries(past.values)) {
      (baselines[dimension] ??= []).push(value);
      // The trend ranks the recent windows against what came before all of them, so the
      // windows it compares are excluded from the baseline it compares them against.
      if (offset > TREND_POLICY.windows) (trendBaselines[dimension] ??= []).push(value);
    }
  }
  for (let offset = TREND_POLICY.windows - 1; offset >= 0; offset -= 1) {
    const window = summarizeWindow(/** @type {typeof rows} */ (buckets[offset]), input.now);
    if ((window.values.prompts ?? 0) > 0) trendWindows.push(window.values);
  }
  const trend =
    input.includeTrend === true
      ? {
          trend: computeUsageTrend({
            windows: trendWindows,
            baselines: trendBaselines,
            profileWeights: input.planProfile.weights,
            effectiveSampleSize: current.effectiveSampleSize,
          }),
        }
      : {};
  const insufficient = observedWindows < ANALYTICS_POLICY.pressure_minimum_baseline_windows;
  /** @type {(number | null)[]} */
  const series = [];
  if (input.includeSeries === true) {
    for (let offset = PLOT_POLICY.windows - 1; offset >= 0; offset -= 1) {
      const window = summarizeWindow(/** @type {typeof rows} */ (buckets[offset] ?? []), input.now);
      series.push(
        insufficient || window.values.prompts === 0
          ? null
          : computeUsagePressure({
              current: window.values,
              baselines,
              profileWeights: input.planProfile.weights,
              effectiveSampleSize: window.effectiveSampleSize,
            }).score,
      );
    }
  }
  if (insufficient) {
    const pressure = {
      horizon: input.horizon,
      score: null,
      band: "unknown",
      policy_version: ANALYTICS_POLICY.version,
      baseline_kind: "insufficient",
      completeness: "partial",
      contributors: [],
      baseline_windows: observedWindows,
      ...trend,
    };
    return { pressure, series };
  }
  const pressure = {
    horizon: input.horizon,
    baseline_windows: observedWindows,
    ...trend,
    ...computeUsagePressure({
      current: current.values,
      baselines,
      profileWeights: input.planProfile.weights,
      effectiveSampleSize: current.effectiveSampleSize,
    }),
  };
  return { pressure, series };
}

/**
 * The pressure alone, as `status` and `stats` report it.
 *
 * @param {Parameters<typeof readPressure>[0]} input
 */
export function computeSourcePressure(input) {
  return readPressure(input).pressure;
}

/**
 * @param {import("./storage.js").UsageWindowRow[]} rows
 * @param {Date} now
 */
function summarizeWindow(rows, now) {
  const profile = summarizeUsageProfile(rows, [], {
    horizon: "",
    window: { from: "", to: "" },
    now,
  });
  /** @type {Record<string, number>} */
  const values = { prompts: profile.prompts.count };
  for (const [dimension, summary] of Object.entries(profile.dimensions)) {
    if ("value" in summary) {
      values[dimension] = summary.value;
    }
  }
  return { values, effectiveSampleSize: profile.effective_sample_size.value };
}
