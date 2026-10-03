/**
 * Which stated window binds, and in which stated band: the reading the `reported-capacity` shadow
 * method keys its cells on (docs/history/specs/reported-capacity-method/spec.md §4).
 *
 * Pure: it is handed what storage already read and never touches SQLite. Nothing here reaches the
 * estimate SNACK answers with. In 1.5 the method this module serves runs in shadow -- computed,
 * recorded and calibrated beside the baseline, never shown as the answer (ADR-0007, amended 1.5.0).
 */

/**
 * Versioned policy of the `reported-capacity` method. Changing an edge, the age limit or the full
 * prior moves `version`, so a stored forecast always names the rules that produced it.
 */
export const REPORTED_CAPACITY_POLICY = Object.freeze({
  version: "reported-capacity-v1",
  /**
   * The baseline policy whose decay, recency and evidence window this method inherits unchanged.
   * Kept as a literal rather than imported so this module stays free of the prediction module.
   */
  base_policy: "stage5-prediction-v2",
  method: Object.freeze({ id: "reported-capacity", version: "1" }),
  /**
   * A statement older than this binds nothing. Six hours is one 5-hour window plus slack; on the
   * maintainer's history the cut was insensitive anywhere between 2 h and 24 h (spec §1.3). A
   * statement that says its window is full is not exempt: a plan switch can end a full window
   * without any reset (spec §1.2).
   */
  max_age_seconds: 21_600,
  /**
   * Stated-band edges on the binding window's figure. `near` starts one p90 in-prompt movement (20
   * points, spec §1.3) below 100; `full` is the client's own statement that the window is spent,
   * and a figure above 100 is `full` too.
   */
  bands: Object.freeze({ near: 80, full: 100 }),
  /**
   * The prior a `full` statement starts from: Beta(0.2, 0.8), mean 0.2, the same strength as every
   * bundled plan profile. **No observation stands behind 0.2** -- the history the method was
   * specified from never stated a figure of 100 (spec §1.5, decision D2). It is a starting
   * assumption that leans toward refusal, and it is labelled as one wherever it shows.
   */
  full_prior: Object.freeze({ strength: 1, viability: 0.2 }),
  backoff_levels: Object.freeze([
    "period_stated_category",
    "period_stated",
    "period",
    "stated_full_prior",
  ]),
});

/**
 * Evidence ceilings for the `reported-capacity` method. The sample and restriction thresholds are
 * the baseline's; the relevance ceilings are capped at `low` because, unlike the baseline's, no
 * simulation and no meaningful calibration stand behind stated cells yet (spec §2.6).
 */
export const REPORTED_EVIDENCE_RELEVANCE = Object.freeze({
  version: "reported-capacity-evidence-v1",
  relevance_ceilings: Object.freeze({
    period_stated_category: "low",
    period_stated: "low",
    period: "very_low",
    stated_full_prior: "very_low",
    prior: "very_low",
  }),
});

/** Why no window binds: the closed set `shadow.reason` draws from. */
export const STATED_REASONS = Object.freeze([
  "no_statement",
  "before_period",
  "stale",
  "windows_reset",
  "superseded",
  "no_local_outcomes",
]);

/**
 * @typedef {object} StatedWindow
 * @property {number} window_minutes
 * @property {number} used_percent
 * @property {string | null} resets_at
 */

/**
 * One statement: every window one snapshot of one installation stated, for one limit.
 *
 * @typedef {object} Statement
 * @property {string} installation_id
 * @property {string | null} limit_id
 * @property {string} observed_at
 * @property {StatedWindow[]} windows
 */

/**
 * @typedef {object} BindingWindow
 * @property {"clear" | "near" | "full"} band
 * @property {string} installation_id
 * @property {string | null} limit_id
 * @property {number} window_minutes
 * @property {number} used_percent Stored with a shadow forecast; never printed with an estimate.
 * @property {string | null} resets_at
 * @property {string} stated_at
 */

/**
 * @typedef {{band: BindingWindow["band"], reason: null, binding: BindingWindow} | {band: null, reason: string, binding: null}} StatedState
 */

/** @type {Map<string, number>} */
const instants = new Map();

/**
 * `Date.parse`, remembered. A replay resolves the binding window once per prompt from the same
 * handful of statements, and parsing their timestamps again each time was most of what it cost.
 *
 * @param {string} timestamp
 */
function instantOf(timestamp) {
  let ms = instants.get(timestamp);
  if (ms === undefined) {
    if (instants.size >= 50_000) instants.clear();
    ms = Date.parse(timestamp);
    instants.set(timestamp, ms);
  }
  return ms;
}

/**
 * The stated band a figure falls in.
 *
 * @param {number} usedPercent
 * @returns {"clear" | "near" | "full"}
 */
export function statedBand(usedPercent) {
  if (usedPercent >= REPORTED_CAPACITY_POLICY.bands.full) return "full";
  if (usedPercent >= REPORTED_CAPACITY_POLICY.bands.near) return "near";
  return "clear";
}

/**
 * Which window of the latest usable statement binds at an instant (spec §4, rules 1-7).
 *
 * `statements` are the latest per (installation, limit) visible at `at`. `foreignPromptAfter`
 * answers whether a prompt from an installation other than the stating one started on this source
 * after the statement: such a prompt has spent from the window since, so a figure below full no
 * longer describes it. Codex's own prompts never supersede a Codex statement.
 *
 * @param {{statements: Statement[], at: number, periodStart: string | null,
 *   foreignPromptAfter: (installationId: string, statedAt: string) => boolean,
 *   policy?: typeof REPORTED_CAPACITY_POLICY}} input
 * @returns {StatedState}
 */
export function resolveStatedState(input) {
  const policy = input.policy ?? REPORTED_CAPACITY_POLICY;
  if (input.statements.length === 0) return none("no_statement");

  // 1. Period: a statement made before the active capacity period began describes another regime.
  // `periodStart` is null for a source's first period, which absorbs all earlier history exactly
  // as it absorbs earlier prompts.
  const periodStartMs = input.periodStart === null ? null : instantOf(input.periodStart);
  const inPeriod =
    periodStartMs === null
      ? input.statements
      : input.statements.filter((statement) => instantOf(statement.observed_at) >= periodStartMs);
  if (inPeriod.length === 0) return none("before_period");

  // 2. Age: exactly `max_age_seconds` old still binds; one second more does not.
  const fresh = inPeriod.filter(
    (statement) => input.at - instantOf(statement.observed_at) <= policy.max_age_seconds * 1000,
  );
  if (fresh.length === 0) return none("stale");

  // 3. Limit: the most recent statement wins, across installations and limits. Two limits are
  // never combined (ADR-0007, 1.3.0 amendment); ties go to the lexically first installation, then
  // limit, so the choice is deterministic.
  const latest = fresh.reduce((best, candidate) =>
    compareStatements(candidate, best) < 0 ? candidate : best,
  );

  // 4. Window: only windows of that statement, and only those whose reset has not passed.
  const live = latest.windows.filter(
    (window) => window.resets_at === null || instantOf(window.resets_at) > input.at,
  );
  if (live.length === 0) return none("windows_reset");

  // 5. Binding: the highest stated figure; a tie goes to the shorter window, which refuses first.
  const binding = live.reduce((best, window) =>
    window.used_percent > best.used_percent ||
    (window.used_percent === best.used_percent && window.window_minutes < best.window_minutes)
      ? window
      : best,
  );
  const band = statedBand(binding.used_percent);

  // 7. Another client: within an unreset window a stated figure only rises, so a full statement
  // survives another client's prompt; anything below full is a lower bound it no longer describes.
  if (band !== "full" && input.foreignPromptAfter(latest.installation_id, latest.observed_at)) {
    return none("superseded");
  }

  return {
    band,
    reason: null,
    binding: {
      band,
      installation_id: latest.installation_id,
      limit_id: latest.limit_id,
      window_minutes: binding.window_minutes,
      used_percent: binding.used_percent,
      resets_at: binding.resets_at,
      stated_at: latest.observed_at,
    },
  };
}

/**
 * Most recent first; a tie at one instant is broken by installation, then limit, lexically.
 *
 * @param {Statement} left
 * @param {Statement} right
 */
function compareStatements(left, right) {
  const leftMs = instantOf(left.observed_at);
  const rightMs = instantOf(right.observed_at);
  if (leftMs !== rightMs) return rightMs - leftMs;
  if (left.installation_id !== right.installation_id) {
    return left.installation_id < right.installation_id ? -1 : 1;
  }
  const leftLimit = left.limit_id ?? "";
  const rightLimit = right.limit_id ?? "";
  if (leftLimit === rightLimit) return 0;
  return leftLimit < rightLimit ? -1 : 1;
}

/** @param {string} reason @returns {StatedState} */
function none(reason) {
  return { band: null, reason, binding: null };
}

/**
 * @typedef {object} StatedOutcome
 * @property {string} started_at
 * @property {"success" | "restricted" | "excluded"} outcome
 * @property {string | null} [size_category]
 * @property {string | null} [installation_id]
 */

/**
 * Walk a chronological outcome history with the stated timeline merged in, calling `visit` with
 * each outcome and the stated state in force **at its own start**: built only from statements
 * strictly earlier and from prompts that started strictly earlier. This is the as-of discipline
 * `backtest` keeps, applied to the figure; a later statement can never reach an earlier prompt.
 *
 * @template {StatedOutcome} T
 * @param {T[]} outcomes chronological, oldest first
 * @param {Statement[]} timeline chronological, oldest first
 * @param {{periodStart: string | null, policy?: typeof REPORTED_CAPACITY_POLICY}} options
 * @param {(row: T, state: StatedState) => void} visit
 */
export function walkStatedHistory(outcomes, timeline, options, visit) {
  /** @type {Map<string, Statement>} */
  const latest = new Map();
  /** @type {Map<string, number>} latest start per installation */
  const lastStart = new Map();
  let cursor = 0;
  /** @param {string} installationId @param {string} statedAt */
  const foreignPromptAfter = (installationId, statedAt) => {
    const statedMs = instantOf(statedAt);
    for (const [installation, start] of lastStart) {
      if (installation !== installationId && start > statedMs) return true;
    }
    return false;
  };
  for (const row of outcomes) {
    const at = Date.parse(row.started_at);
    while (cursor < timeline.length) {
      const statement = /** @type {Statement} */ (timeline[cursor]);
      if (!(instantOf(statement.observed_at) < at)) break;
      latest.set(`${statement.installation_id}\u0000${statement.limit_id ?? ""}`, statement);
      cursor += 1;
    }
    visit(
      row,
      resolveStatedState({
        statements: [...latest.values()],
        at,
        periodStart: options.periodStart,
        foreignPromptAfter,
        ...(options.policy ? { policy: options.policy } : {}),
      }),
    );
    if (typeof row.installation_id === "string") {
      lastStart.set(row.installation_id, Math.max(lastStart.get(row.installation_id) ?? 0, at));
    }
  }
}

/**
 * The stated band each outcome began in, as a new row carrying `stated_band` -- null where no
 * window bound at its start.
 *
 * @template {StatedOutcome} T
 * @param {T[]} outcomes chronological, oldest first
 * @param {Statement[]} timeline chronological, oldest first
 * @param {{periodStart: string | null}} options
 * @returns {(T & {stated_band: "clear" | "near" | "full" | null})[]}
 */
export function labelStatedBands(outcomes, timeline, options) {
  /** @type {(T & {stated_band: "clear" | "near" | "full" | null})[]} */
  const labelled = [];
  walkStatedHistory(outcomes, timeline, options, (row, state) => {
    labelled.push({ ...row, stated_band: state.band });
  });
  return labelled;
}
