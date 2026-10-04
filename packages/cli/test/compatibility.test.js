import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { afterEach, test } from "node:test";

import Database from "better-sqlite3";

import { run } from "../src/main.js";
import {
  cleanupRunFixtures,
  createClaudeHistory,
  createCodexHistory,
  createOpenCodeDatabase,
  makeRunFixture,
} from "./fixtures/run-fixture.js";

afterEach(cleanupRunFixtures);

/**
 * The `1.5` corpus was captured at `v1.5.0` by exactly this sequence, on the same fixture clock.
 * Replaying it on today's tree and comparing bytes is the exit criterion of 1.6.0 written as a test:
 * the weighting variants run in shadow on every source, so every source's answer is the one 1.5
 * gave, and each report differs from 1.5's only by the members 1.6.0 adds -- `shadows` on `status`,
 * the variant entries of `calibration.by_method` on `stats` -- and, on `status --sequence`, by the
 * one caveat 1.6.0 adds to the open `caveats` array (`sequence-prior-tail-v1`).
 */
const setup = (
  /** @type {string} */ client,
  /** @type {string} */ alias,
  provider = "anthropic",
  plan = "pro",
) => [
  "setup",
  client,
  "--non-interactive",
  "--source",
  alias,
  "--provider",
  provider,
  "--profile",
  "default",
  "--plan",
  plan,
  "--json",
];

const SEQUENCE = /** @type {const} */ ([
  ["setup-opencode", setup("opencode", "work")],
  ["setup-claude", setup("claude", "personal")],
  ["setup-codex", setup("codex", "codex", "openai", "plus")],
  ["sync", ["sync", "--full", "--json"]],
  ["stats", ["stats", "--verbose", "--json"]],
  ["status", ["status", "--no-sync", "--json"]],
  ["status-sequence", ["status", "--no-sync", "--sequence", "10", "--json"]],
]);

/** The `sequence-prior-tail-v1` diagnostic, the one caveat 1.6.0 adds. */
const PRIOR_TAIL =
  "Your recent history has no restriction to learn from, so the low end of this interval comes from SNACK's starting assumption rather than from your history.";

/** @param {string} name */
async function captured(name) {
  return readFile(new URL(`./fixtures/contracts/1.5/${name}.json`, import.meta.url), "utf8");
}

/**
 * Replay the capture and return each document as 1.5 would have spelled it: the fixture root and
 * the installation identities -- fresh random UUIDs on every run -- mapped to the captured ones.
 */
async function replay() {
  const fixture = await makeRunFixture("snack-compat-1-5-");
  fixture.options.env.OPENCODE_DB = await createOpenCodeDatabase(fixture.root);
  fixture.options.env.CLAUDE_CONFIG_DIR = await createClaudeHistory(fixture.root);
  fixture.options.env.CODEX_HOME = await createCodexHistory(fixture.root);
  /** @type {Map<string, string>} today's installation id -> the captured one */
  const identities = new Map();
  /** @type {Record<string, string>} */
  const documents = {};
  for (const [name, argv] of SEQUENCE) {
    fixture.stdout.value = "";
    fixture.stderr.value = "";
    const exitCode = await run(["node", "snack", ...argv], fixture.options);
    assert.equal(exitCode, 0, `${name}: ${fixture.stderr.value}`);
    let text = fixture.stdout.value.replaceAll(fixture.root, "{{root}}");
    if (name.startsWith("setup-")) {
      const today = JSON.parse(text).data.source.installation_id;
      const then = JSON.parse(await captured(name)).data.source.installation_id;
      identities.set(today, then);
    }
    for (const [today, then] of identities) text = text.replaceAll(today, then);
    documents[name] = text;
  }
  const database = new Database(fixture.paths.databaseFile, { readonly: true });
  try {
    const counted = /** @type {{attempts: number, shadows: number}} */ (
      database
        .prepare(
          `SELECT (SELECT COUNT(*) FROM prediction_attempt) AS attempts,
                  (SELECT COUNT(*) FROM prediction_shadow) AS shadows`,
        )
        .get()
    );
    return { documents, counted };
  } finally {
    database.close();
  }
}

/** @param {string} text @returns {Record<string, unknown>[]} */
function reportsOf(text) {
  const { data } = JSON.parse(text);
  return Array.isArray(data.sources) ? data.sources : [data];
}

/** @param {Record<string, unknown>} report */
const aliasOf = (report) => /** @type {{alias: string}} */ (report.source).alias;

test("the documents 1.5 emitted are emitted again, byte for byte, but for what 1.6.0 adds", async () => {
  const { documents: today, counted } = await replay();
  // Non-vacuity: the variants really ran beside every attempt the replay recorded -- two status
  // invocations over three sources, both variants each -- and the answers below are still 1.5's.
  assert.equal(counted.attempts, 6);
  assert.equal(counted.shadows, 12);

  // The documents that never describe an estimate are byte-identical, whole.
  for (const name of ["setup-opencode", "setup-claude", "setup-codex", "sync"]) {
    assert.equal(today[name], await captured(name), name);
  }

  for (const name of ["status", "status-sequence", "stats"]) {
    const then = await captured(name);
    const reportsThen = reportsOf(then);
    const reportsToday = reportsOf(/** @type {string} */ (today[name]));
    assert.equal(reportsToday.length, reportsThen.length, name);
    assert.equal(
      reportsToday.length,
      3,
      `${name}: three sources, or the comparison is thinner than it claims`,
    );
    for (const [index, reportToday] of reportsToday.entries()) {
      const reportThen = /** @type {Record<string, unknown>} */ (reportsThen[index]);
      const alias = aliasOf(reportToday);
      assert.equal(alias, aliasOf(reportThen));
      const stripped = { ...reportToday };
      if (name === "stats") {
        const calibration =
          /** @type {{by_method: {id: string, live: unknown, backtest: unknown}[]}} */ (
            stripped.calibration
          );
        const calibrationThen =
          /** @type {{live: unknown, backtest: unknown, by_method?: unknown[]}} */ (
            /** @type {{calibration: unknown}} */ (reportThen).calibration
          );
        const methodsThen = calibrationThen.by_method ?? [];
        if (methodsThen.length > 0) {
          // The entries 1.5 emitted come first, byte for byte; the two variants are appended.
          assert.equal(
            JSON.stringify(calibration.by_method.slice(0, methodsThen.length)),
            JSON.stringify(methodsThen),
            `${name} ${alias} by_method`,
          );
        } else {
          // New on a source no Codex installation feeds: the answer's entry is the top-level
          // streams 1.5 published, the same numbers under the answer's name.
          const [answer] = calibration.by_method;
          assert.equal(answer?.id, "bayesian-pressure-band");
          assert.equal(JSON.stringify(answer?.live), JSON.stringify(calibrationThen.live));
          assert.equal(JSON.stringify(answer?.backtest), JSON.stringify(calibrationThen.backtest));
        }
        assert.deepEqual(
          calibration.by_method.slice(Math.max(methodsThen.length, 1)).map((entry) => entry.id),
          ["bayesian-pressure-band-hl50", "bayesian-pressure-band-hl100"],
          `${name} ${alias}`,
        );
        const rest = /** @type {Record<string, unknown>} */ ({ ...calibration });
        if (methodsThen.length === 0) delete rest.by_method;
        else rest.by_method = methodsThen;
        stripped.calibration = rest;
      } else {
        const shadows = /** @type {{method: {id: string}, computed: boolean}[]} */ (
          stripped.shadows
        );
        assert.equal(Object.keys(reportToday).at(-1), "shadows", `${name} ${alias}`);
        // Non-vacuity: both variants computed, so the answer beside them is the one 1.5 gave
        // while they really ran.
        assert.deepEqual(
          shadows.slice(-2).map((entry) => [entry.method.id, entry.computed]),
          [
            ["bayesian-pressure-band-hl50", true],
            ["bayesian-pressure-band-hl100", true],
          ],
          `${name} ${alias}`,
        );
        if ("shadow" in reportToday) {
          // The 1.5 member, unchanged, and the first entry of `shadows`.
          assert.equal(JSON.stringify(shadows[0]), JSON.stringify(reportToday.shadow));
          assert.equal(shadows.length, 3);
        } else {
          assert.equal(shadows.length, 2);
        }
        delete stripped.shadows;
        if (name === "status-sequence") {
          // Every source here is too wide at ten with no restriction behind it, so each gains the
          // diagnostic, last, and nothing else moves.
          const caveats = /** @type {string[]} */ (stripped.caveats);
          const sequence = /** @type {{width: {too_wide: boolean}}} */ (stripped.sequence);
          const window = /** @type {{evidence_window: {weighted_restrictions: number}}} */ (
            stripped.contributors
          ).evidence_window;
          assert.equal(sequence.width.too_wide && window.weighted_restrictions < 0.05, true);
          assert.equal(caveats.at(-1), PRIOR_TAIL, `${name} ${alias}`);
          stripped.caveats = caveats.slice(0, -1);
        }
      }
      assert.equal(JSON.stringify(stripped), JSON.stringify(reportThen), `${name} ${alias}`);
    }
    // The envelope around the reports -- status, warnings, errors -- is unchanged too.
    const envelopeThen = JSON.parse(then);
    const envelopeToday = JSON.parse(/** @type {string} */ (today[name]));
    delete envelopeThen.data;
    delete envelopeToday.data;
    assert.deepEqual(envelopeToday, envelopeThen, name);
  }
});
