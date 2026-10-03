import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { afterEach, test } from "node:test";

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
 * The `1.4` corpus was captured at `v1.4.0` by exactly this sequence, on the same fixture clock.
 * Replaying it on today's tree and comparing bytes is the exit criterion of 1.5.0 written as a test:
 * the `reported-capacity` method runs in shadow, so every source's answer is the one 1.4 gave, and
 * a source no Codex installation feeds gets the very document 1.4 emitted.
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

/** @param {string} name */
async function captured(name) {
  return readFile(new URL(`./fixtures/contracts/1.4/${name}.json`, import.meta.url), "utf8");
}

/**
 * Replay the capture and return each document as 1.4 would have spelled it: the fixture root and
 * the installation identities -- fresh random UUIDs on every run -- mapped to the captured ones.
 */
async function replay() {
  const fixture = await makeRunFixture("snack-compat-1-4-");
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
  return documents;
}

/** @param {string} text @returns {Record<string, unknown>[]} */
function reportsOf(text) {
  const { data } = JSON.parse(text);
  return Array.isArray(data.sources) ? data.sources : [data];
}

/** @param {Record<string, unknown>} report */
const aliasOf = (report) => /** @type {{alias: string}} */ (report.source).alias;

test("the documents 1.4 emitted are emitted again, byte for byte, but for the shadow's two members", async () => {
  const today = await replay();

  // The documents that never describe a Codex estimate are byte-identical, whole.
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
      if (alias !== "codex") {
        // A source no Codex installation feeds: the very report 1.4 emitted.
        assert.equal(JSON.stringify(reportToday), JSON.stringify(reportThen), `${name} ${alias}`);
        assert.ok(!("shadow" in reportToday), `${name} ${alias} grew a shadow`);
        continue;
      }
      // The Codex source differs only by the additive members, and its answer not at all.
      const stripped = { ...reportToday };
      if (name === "stats") {
        const calibration = /** @type {Record<string, unknown>} */ (stripped.calibration);
        assert.ok(
          Array.isArray(calibration.by_method),
          "stats lost by_method for the Codex source",
        );
        const rest = { ...calibration };
        delete rest.by_method;
        stripped.calibration = rest;
      } else {
        const shadow = /** @type {{computed: boolean, reason: string}} */ (stripped.shadow);
        // Non-vacuity: the fixture's statements are fresh at the corpus clock, so the shadow really
        // was computed -- and the answer below is still the one 1.4 gave.
        assert.deepEqual([shadow.computed, shadow.reason], [true, null], name);
        delete stripped.shadow;
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
