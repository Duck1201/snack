/**
 * Written-out `DashState`s for the dash widgets (`src/dash-view.js`).
 *
 * The view is a pure function of the state, so every pane, banner and header can be drawn here
 * without a database, a clock or a terminal -- the same reason `render.test.js` writes its status
 * views out instead of driving a command. The sequence wording is copied from `status.js`'s
 * `sequenceCaveats`, which is what the controller passes through.
 */

export const NOW = "2026-10-03T12:00:00.000Z";

/**
 * @param {number} secondsBefore
 */
export function ago(secondsBefore) {
  return new Date(Date.parse(NOW) - secondsBefore * 1000).toISOString();
}

/** A 24-window display series with absences and both ends of the scale. */
export const SERIES = [
  0.1,
  0.25,
  0.1,
  null,
  0.4,
  0.6,
  0.75,
  0.5,
  0.25,
  0.1,
  null,
  null,
  0.1,
  0.25,
  0.4,
  0.6,
  0.9,
  1,
  0.75,
  0.6,
  0.4,
  0.25,
  0,
  0.62,
];

/**
 * One source report, shaped as `createSourceStatus` builds it.
 *
 * @param {Record<string, unknown>} overrides
 */
export function reportFor(overrides = {}) {
  return {
    source: {
      alias: "work",
      provider: "anthropic",
      profile: "default",
      plan: "pro",
      active_period: { started_at: "2026-09-30T00:00:00.000Z" },
      plan_profile: { id: "generic", version: "1.0.0", provenance: "bundled", as_of: null },
    },
    viability: { lower: 0.951, point: 0.98, upper: 0.999, coverage_target: 0.8 },
    risk: { label: "low", policy_version: "1" },
    evidence: { level: "high", policy_version: "1", gates: [] },
    method: { id: "bayesian-pressure-band", version: "1" },
    model_policy_version: "stage5-prediction-v2",
    contributors: {
      backoff_level: "band_category",
      evidence_window: { alpha: 40, beta: 1, weighted_restrictions: 0.5 },
      prior: { alpha: 1, beta: 1 },
    },
    pressure: {
      horizon: "PT1H",
      score: 0.62,
      band: "moderate",
      contributors: [
        { dimension: "prompts", percentile: 0.7, contribution: 0.5 },
        { dimension: "output_tokens", percentile: 0.6, contribution: 0.3 },
        { dimension: "input_tokens", percentile: 0.2, contribution: 0.1 },
      ],
    },
    expected_prompt_category: "typical",
    freshness: { as_of: ago(120), age_seconds: 5 },
    synchronization: { performed: true, status: "ok" },
    caveats: [
      "The estimate is not yet calibrated against observed outcomes.",
      "Real provider capacity is unknown.",
      "Usage pressure compares this window with local history; it is not a share of capacity.",
    ],
    ...overrides,
  };
}

/**
 * @param {string} alias
 * @param {Record<string, unknown>} overrides
 */
function named(alias, overrides = {}) {
  const base = reportFor(overrides);
  return { ...base, source: { ...base.source, alias } };
}

/** A Codex-fed source: a stated figure on its own `reported` row. */
export const CODEX = named("codex", {
  viability: { lower: 0.612, point: 0.9, upper: 0.987, coverage_target: 0.8 },
  risk: { label: "elevated", policy_version: "1" },
  evidence: { level: "low", policy_version: "1", gates: [] },
  pressure: { horizon: "PT1H", score: 0.9, band: "high", contributors: [] },
  freshness: { as_of: ago(240), age_seconds: 0 },
  reported_capacity: [
    {
      limit_id: "codex",
      stated_at: ago(300),
      age_seconds: 300,
      windows: [
        {
          window_minutes: 300,
          used_percent: 40,
          resets_at: new Date(Date.parse(NOW) + 3_600_000).toISOString(),
          reset_passed: false,
        },
      ],
    },
  ],
});

/** A source with nothing but the plan profile behind it, and no baseline. */
export const FRESH = named("home", {
  viability: { lower: 0.02, point: 0.5, upper: 0.98, coverage_target: 0.8 },
  risk: { label: "high", policy_version: "1" },
  evidence: { level: "very_low", policy_version: "1", gates: [] },
  method: { id: "initial-generic", version: "1" },
  pressure: { horizon: "PT1H", band: "unknown", contributors: [] },
  freshness: { as_of: null, age_seconds: null },
  caveats: [
    "Sparse history; the weak plan-profile prior still dominates this estimate.",
    "Real provider capacity is unknown.",
    "Usage pressure compares this window with local history; it is not a share of capacity.",
  ],
});

/**
 * @param {Record<string, unknown>} overrides
 * @returns {import("../../src/dash-view.js").DashState}
 */
export function stateFor(overrides = {}) {
  return /** @type {import("../../src/dash-view.js").DashState} */ ({
    now: NOW,
    sources: [
      { alias: "work", report: reportFor(), series: SERIES, seriesHorizon: "PT1H", sync: "ok" },
      {
        alias: "codex",
        report: CODEX,
        series: SERIES.map((score) => (score === null ? null : 1 - score)),
        seriesHorizon: "PT1H",
        sync: "ok",
      },
      { alias: "home", report: FRESH, series: [], seriesHorizon: "PT1H", sync: "failed" },
    ],
    selected: 0,
    pane: "detail",
    sync: {
      phase: "idle",
      startedAt: ago(15),
      endedAt: ago(12),
      outcome: "ok",
      nextAt: new Date(Date.parse(NOW) + 48_000).toISOString(),
    },
    reading: { computedAt: ago(12), stale: false, storage: "ready", pendingMigrations: 0 },
    sequenceLength: null,
    ...overrides,
  });
}

/**
 * The sequence caveats `status.js` writes for a length, with the prior-tail diagnostic when asked.
 *
 * @param {number} length
 * @param {{tooWide: boolean, priorTail?: boolean}} options
 */
export function sequenceCaveatsFor(length, options) {
  return {
    assumption:
      length === 1
        ? null
        : `The ${length}-prompt estimate assumes each prompt meets the conditions the next one does; it does not model usage pressure rising as they are sent.`,
    tooWide: !options.tooWide
      ? null
      : length === 1
        ? "The 1-prompt interval is too wide to say much; it cannot tell whether the next prompt is more likely to go through than not."
        : `The ${length}-prompt interval is too wide to say much; it cannot tell whether all of them going through is more likely than not.`,
    priorTail:
      options.priorTail === true
        ? "Your recent history has no restriction to learn from, so the low end of this interval comes from SNACK's starting assumption rather than from your history."
        : null,
  };
}

/**
 * A state with the sequence row on at `length`, informative or too wide for the selected source.
 *
 * @param {number} length
 * @param {{tooWide: boolean, priorTail?: boolean}} options
 */
export function sequenceStateFor(length, options) {
  const state = stateFor({ sequenceLength: length });
  const viability = options.tooWide
    ? { lower: 0.013, point: 0.6, upper: 0.97, coverage_target: 0.8 }
    : { lower: 0.523, point: 0.8, upper: 0.999, coverage_target: 0.8 };
  return {
    ...state,
    sources: state.sources.map((source) => ({
      ...source,
      sequence: {
        assessment: {
          length,
          viability,
          risk: { label: options.tooWide ? "high" : "elevated", policy_version: "1" },
          evidence: source.report?.evidence ?? { level: "low", policy_version: "1", gates: [] },
          method: { id: "sequence-bayesian-pressure-band", version: "1" },
          width: {
            too_wide: options.tooWide,
            max_width: 0.5,
            policy_version: "sequence-width-v1",
          },
        },
        caveats: sequenceCaveatsFor(length, options),
      },
    })),
  };
}

/**
 * Every state a widget can be drawn from, named, so a failure says which pane broke.
 *
 * @returns {[string, import("../../src/dash-view.js").DashState][]}
 */
export function everyDashState() {
  const base = stateFor();
  return [
    ["detail", base],
    ["codex selected", stateFor({ selected: 1 })],
    ["heuristic selected", stateFor({ selected: 2 })],
    ["help", stateFor({ pane: "help" })],
    ["help with the sequence row", { ...sequenceStateFor(10, { tooWide: false }), pane: "help" }],
    ["sequence informative", sequenceStateFor(10, { tooWide: false })],
    ["sequence informative at 100", sequenceStateFor(100, { tooWide: false })],
    ["sequence too wide", sequenceStateFor(10, { tooWide: true })],
    ["sequence too wide at 100", sequenceStateFor(100, { tooWide: true, priorTail: true })],
    ["sequence too wide at 1", sequenceStateFor(1, { tooWide: true, priorTail: true })],
    ["sequence waiting", stateFor({ sequenceLength: 7 })],
    [
      "synchronizing",
      stateFor({
        sync: {
          phase: "running",
          startedAt: ago(3),
          endedAt: ago(70),
          outcome: "ok",
          nextAt: null,
        },
      }),
    ],
    ["sync busy", stateFor({ sync: { ...base.sync, outcome: "storage_busy" } })],
    ["sync failed", stateFor({ sync: { ...base.sync, outcome: "failed" } })],
    [
      "stale reading",
      stateFor({ reading: { ...base.reading, computedAt: ago(240), stale: true } }),
    ],
    [
      "storage missing",
      stateFor({
        sources: base.sources.map((source) => ({ ...source, report: null, sync: "waiting" })),
        sync: { phase: "running", startedAt: ago(1), endedAt: null, outcome: null, nextAt: null },
        reading: { computedAt: null, stale: false, storage: "missing", pendingMigrations: 0 },
      }),
    ],
    [
      "storage pending",
      stateFor({
        sources: base.sources.map((source) => ({ ...source, report: null, sync: "waiting" })),
        sync: { phase: "running", startedAt: ago(1), endedAt: null, outcome: null, nextAt: null },
        reading: { computedAt: null, stale: false, storage: "pending", pendingMigrations: 2 },
      }),
    ],
    [
      "storage unprepared",
      stateFor({
        sources: base.sources.map((source) => ({ ...source, report: null, sync: "failed" })),
        sync: { ...base.sync, outcome: "failed" },
        reading: { computedAt: null, stale: false, storage: "unprepared", pendingMigrations: 0 },
      }),
    ],
    [
      "storage newer",
      stateFor({
        sync: { ...base.sync, outcome: "storage_newer", nextAt: null },
        reading: { ...base.reading, stale: true, storage: "newer" },
      }),
    ],
  ];
}
