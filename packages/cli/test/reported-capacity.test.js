import assert from "node:assert/strict";
import { test } from "node:test";

import {
  REPORTED_CAPACITY_POLICY,
  labelStatedBands,
  resolveStatedState,
  statedBand,
} from "../src/reported-capacity.js";

const AT = Date.parse("2026-01-02T03:04:05.000Z");
const CODEX = "11111111-1111-4111-8111-111111111111";
const OTHER = "22222222-2222-4222-8222-222222222222";

/** @param {number} secondsAgo */
const ago = (secondsAgo) => new Date(AT - secondsAgo * 1000).toISOString();
/** @param {number} secondsAhead */
const ahead = (secondsAhead) => new Date(AT + secondsAhead * 1000).toISOString();

/**
 * @param {Partial<import("../src/reported-capacity.js").Statement>} [overrides]
 * @returns {import("../src/reported-capacity.js").Statement}
 */
function statement(overrides = {}) {
  return {
    installation_id: CODEX,
    limit_id: "codex",
    observed_at: ago(60),
    windows: [
      { window_minutes: 300, used_percent: 40, resets_at: ahead(3600) },
      { window_minutes: 10080, used_percent: 20, resets_at: ahead(86400) },
    ],
    ...overrides,
  };
}

/**
 * @param {import("../src/reported-capacity.js").Statement[]} statements
 * @param {{periodStart?: string | null, foreign?: (installationId: string, statedAt: string) => boolean}} [options]
 */
function resolve(statements, options = {}) {
  return resolveStatedState({
    statements,
    at: AT,
    periodStart: options.periodStart ?? null,
    foreignPromptAfter: options.foreign ?? (() => false),
  });
}

test("the band edges sit at 80 and 100, and a figure above 100 is full", () => {
  assert.equal(statedBand(0), "clear");
  assert.equal(statedBand(79.99), "clear");
  assert.equal(statedBand(80), "near");
  assert.equal(statedBand(99.99), "near");
  assert.equal(statedBand(100), "full");
  assert.equal(statedBand(100.5), "full");
});

test("no statement binds nothing, and says so", () => {
  assert.deepEqual(resolve([]), { band: null, reason: "no_statement", binding: null });
});

test("a statement made before the active capacity period never binds", () => {
  const state = resolve([statement({ observed_at: ago(600) })], { periodStart: ago(300) });
  assert.equal(state.reason, "before_period");
  // At the period's start exactly it is in the period.
  assert.equal(
    resolve([statement({ observed_at: ago(300) })], { periodStart: ago(300) }).band,
    "clear",
  );
});

test("a statement exactly six hours old binds, and one second more does not", () => {
  const limit = REPORTED_CAPACITY_POLICY.max_age_seconds;
  assert.equal(resolve([statement({ observed_at: ago(limit) })]).band, "clear");
  assert.equal(resolve([statement({ observed_at: ago(limit + 1) })]).reason, "stale");
});

test("a full statement is not exempt from the age limit", () => {
  const full = statement({
    observed_at: ago(REPORTED_CAPACITY_POLICY.max_age_seconds + 1),
    windows: [{ window_minutes: 300, used_percent: 100, resets_at: ahead(3600) }],
  });
  assert.equal(resolve([full]).reason, "stale");
});

test("a window whose reset is now has passed; a null reset never passes", () => {
  const atReset = statement({
    windows: [{ window_minutes: 300, used_percent: 90, resets_at: new Date(AT).toISOString() }],
  });
  assert.equal(resolve([atReset]).reason, "windows_reset");
  const unresetting = statement({
    windows: [{ window_minutes: 300, used_percent: 90, resets_at: null }],
  });
  assert.equal(resolve([unresetting]).band, "near");
});

test("the highest live figure binds, and a tie goes to the shorter window", () => {
  const state = resolve([
    statement({
      windows: [
        { window_minutes: 300, used_percent: 30, resets_at: ahead(60) },
        { window_minutes: 10080, used_percent: 85, resets_at: ahead(86400) },
      ],
    }),
  ]);
  assert.equal(state.band, "near");
  assert.equal(state.binding?.window_minutes, 10080);

  const tie = resolve([
    statement({
      windows: [
        { window_minutes: 10080, used_percent: 50, resets_at: ahead(86400) },
        { window_minutes: 300, used_percent: 50, resets_at: ahead(60) },
      ],
    }),
  ]);
  assert.equal(tie.binding?.window_minutes, 300);
});

test("a passed window never binds, even when its figure is the highest", () => {
  const state = resolve([
    statement({
      windows: [
        { window_minutes: 300, used_percent: 100, resets_at: ago(1) },
        { window_minutes: 10080, used_percent: 10, resets_at: ahead(86400) },
      ],
    }),
  ]);
  assert.equal(state.band, "clear");
  assert.equal(state.binding?.window_minutes, 10080);
});

test("the most recent statement wins across limits and installations, never combined", () => {
  const older = statement({
    limit_id: "premium",
    observed_at: ago(120),
    windows: [{ window_minutes: 300, used_percent: 100, resets_at: ahead(60) }],
  });
  const newer = statement({ observed_at: ago(30) });
  const state = resolve([older, newer]);
  assert.equal(state.band, "clear");
  assert.equal(state.binding?.limit_id, "codex");

  // A window absent from the latest statement is one the client stopped stating: an older
  // statement's window is never borrowed.
  const narrower = statement({
    observed_at: ago(10),
    windows: [{ window_minutes: 10080, used_percent: 5, resets_at: ahead(86400) }],
  });
  assert.equal(resolve([older, newer, narrower]).binding?.window_minutes, 10080);
});

test("a tie at one instant goes to the lexically first installation, then limit", () => {
  const instant = ago(30);
  const fromOther = statement({
    installation_id: OTHER,
    observed_at: instant,
    windows: [{ window_minutes: 300, used_percent: 90, resets_at: ahead(60) }],
  });
  const fromCodex = statement({ observed_at: instant });
  assert.equal(resolve([fromOther, fromCodex]).binding?.installation_id, CODEX);

  const premium = statement({
    limit_id: "premium",
    observed_at: instant,
    windows: [{ window_minutes: 300, used_percent: 90, resets_at: ahead(60) }],
  });
  assert.equal(resolve([premium, fromCodex]).binding?.limit_id, "codex");
});

test("another installation's prompt supersedes clear and near, never full", () => {
  /** @param {string} installationId */
  const foreign = (installationId) => installationId === CODEX;
  assert.equal(resolve([statement()], { foreign }).reason, "superseded");

  const near = statement({
    windows: [{ window_minutes: 300, used_percent: 95, resets_at: ahead(60) }],
  });
  assert.equal(resolve([near], { foreign }).reason, "superseded");

  const full = statement({
    windows: [{ window_minutes: 300, used_percent: 100, resets_at: ahead(60) }],
  });
  assert.equal(resolve([full], { foreign }).band, "full");
});

test("the stated band of each outcome is read at its own start, from earlier statements only", () => {
  const outcomes = [
    { started_at: ago(500), outcome: /** @type {const} */ ("success"), installation_id: CODEX },
    { started_at: ago(300), outcome: /** @type {const} */ ("success"), installation_id: CODEX },
    { started_at: ago(100), outcome: /** @type {const} */ ("restricted"), installation_id: CODEX },
  ];
  const timeline = [
    statement({
      observed_at: ago(400),
      windows: [{ window_minutes: 300, used_percent: 85, resets_at: ahead(60) }],
    }),
    // At the third prompt's start exactly: not strictly earlier, so it does not reach it.
    statement({
      observed_at: ago(100),
      windows: [{ window_minutes: 300, used_percent: 100, resets_at: ahead(60) }],
    }),
  ];
  const labelled = labelStatedBands(outcomes, timeline, { periodStart: null });
  assert.deepEqual(
    labelled.map((row) => row.stated_band),
    [null, "near", "near"],
  );
});

test("a prompt from another installation supersedes the statement for the prompts after it", () => {
  const outcomes = [
    { started_at: ago(300), outcome: /** @type {const} */ ("success"), installation_id: OTHER },
    { started_at: ago(200), outcome: /** @type {const} */ ("success"), installation_id: CODEX },
    { started_at: ago(100), outcome: /** @type {const} */ ("success"), installation_id: CODEX },
  ];
  const timeline = [statement({ observed_at: ago(400) }), statement({ observed_at: ago(150) })];
  const labelled = labelStatedBands(outcomes, timeline, { periodStart: null });
  // The first prompt reads the statement at -400. The second: the OTHER prompt at -300 came after
  // that statement, so it no longer describes the window. The third: the
  // statement at -150 is newer than any foreign prompt, so it binds again. Codex's own prompts
  // never supersede a Codex statement.
  assert.deepEqual(
    labelled.map((row) => row.stated_band),
    ["clear", null, "clear"],
  );
});
