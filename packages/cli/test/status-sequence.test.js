import assert from "node:assert/strict";
import { afterEach, test } from "node:test";

import Database from "better-sqlite3";

import { run } from "../src/main.js";
import { createSourceStatus } from "../src/status.js";
import {
  cleanupRunFixtures,
  createCodexHistory,
  createOpenCodeDatabase,
  executeOpenCodeSql,
  makeRunFixture,
} from "./fixtures/run-fixture.js";

afterEach(cleanupRunFixtures);

/**
 * @param {string} client
 * @param {string} alias
 * @param {string} provider
 * @param {string} plan
 * @param {string} [profile]
 */
function setup(client, alias, provider, plan, profile = "default") {
  return [
    "node",
    "snack",
    "setup",
    client,
    "--non-interactive",
    "--source",
    alias,
    "--provider",
    provider,
    "--profile",
    profile,
    "--plan",
    plan,
  ];
}

/** Two synchronized sources: OpenCode as `work`, Codex CLI as `codex`. */
async function twoSources() {
  const fixture = await makeRunFixture("snack-status-sequence-");
  fixture.options.env.OPENCODE_DB = await createOpenCodeDatabase(fixture.root);
  fixture.options.env.CODEX_HOME = await createCodexHistory(fixture.root, [
    "version-0-159-3.jsonl",
    "version-0-147-0.jsonl",
  ]);
  await run(setup("opencode", "work", "anthropic", "pro"), fixture.options);
  await run(setup("codex", "codex", "openai", "plus"), fixture.options);
  await run(["node", "snack", "sync", "--full"], fixture.options);
  return fixture;
}

/**
 * @param {Awaited<ReturnType<typeof twoSources>>} fixture
 * @param {...string} argv
 */
async function snack(fixture, ...argv) {
  fixture.stdout.value = "";
  fixture.stderr.value = "";
  const code = await run(["node", "snack", ...argv], fixture.options);
  assert.equal(code, 0, `${argv.join(" ")}: ${fixture.stderr.value}`);
  return { stdout: fixture.stdout.value, stderr: fixture.stderr.value };
}

/**
 * @param {string} databaseFile
 * @param {string} sql
 * @returns {Record<string, unknown>[]}
 */
function rows(databaseFile, sql) {
  const database = new Database(databaseFile, { readonly: true });
  try {
    return /** @type {Record<string, unknown>[]} */ (database.prepare(sql).all());
  } finally {
    database.close();
  }
}

test("a sequence of one agrees with the single-prompt answer in JSON and on the panel", async () => {
  const fixture = await twoSources();
  const { stdout } = await snack(
    fixture,
    "status",
    "--no-sync",
    "--source",
    "work",
    "--sequence",
    "1",
    "--json",
  );
  const report = JSON.parse(stdout).data;

  for (const member of ["lower", "point", "upper", "coverage_target"]) {
    assert.ok(Object.is(report.sequence.viability[member], report.viability[member]), member);
  }
  assert.deepEqual(report.sequence.risk, report.risk);
  assert.deepEqual(report.sequence.evidence, report.evidence);
  assert.deepEqual(report.sequence.method, { id: `sequence-${report.method.id}`, version: "1" });
  assert.equal(report.sequence.length, 1);

  const human = (await snack(fixture, "status", "--no-sync", "--source", "work", "--sequence", "1"))
    .stdout;
  const [, single = "", sequence = ""] = human.split("\n");
  assert.match(single, /^ {2}next prompt {2}/u);
  assert.match(sequence, /^ {2}next 1 {7}/u);
  assert.equal(sequence.slice(15), single.slice(15));
});

test("without --sequence nothing about a sequence exists, in JSON or on the panel", async () => {
  const fixture = await twoSources();
  const plain = JSON.parse((await snack(fixture, "status", "--no-sync", "--json")).stdout);
  const asked = JSON.parse(
    (await snack(fixture, "status", "--no-sync", "--sequence", "7", "--json")).stdout,
  );

  for (const report of plain.data.sources) assert.ok(!("sequence" in report));
  for (const report of asked.data.sources) {
    assert.equal(report.sequence.length, 7);
    delete report.sequence;
    report.caveats = report.caveats.filter(
      (/** @type {string} */ caveat) => !caveat.startsWith("The 7-prompt "),
    );
  }
  assert.deepEqual(asked, plain);

  // On the panel: the same panels, less the row and the caveats.
  const panels = (await snack(fixture, "status", "--no-sync", "--verbose")).stdout;
  const sequencePanels = (
    await snack(fixture, "status", "--no-sync", "--verbose", "--sequence", "7")
  ).stdout;
  assert.equal(
    sequencePanels
      .split("\n")
      .filter(
        (line) =>
          !line.startsWith("  next 7 ") &&
          !line.includes("The 7-prompt ") &&
          !line.includes("sequence-bayesian-pressure-band@1"),
      )
      .join("\n"),
    panels,
  );
});

test("--sequence with several sources takes the panel shape, one row each", async () => {
  const fixture = await twoSources();
  const overview = (await snack(fixture, "status", "--no-sync")).stdout;
  const text = (await snack(fixture, "status", "--no-sync", "--sequence", "5")).stdout;

  assert.match(overview, /^ {2}SOURCE /mu, "the overview is a table with a header");
  assert.doesNotMatch(text, /^ {2}SOURCE /mu);
  assert.match(text, /^work$/mu);
  assert.match(text, /^codex$/mu);
  assert.equal(text.split("\n").filter((line) => line.startsWith("  next 5 ")).length, 2);
  assert.match(text, /chance all 5 go through/u);

  const document = JSON.parse(
    (await snack(fixture, "status", "--no-sync", "--sequence", "5", "--json")).stdout,
  );
  assert.deepEqual(
    document.data.sources.map(
      (/** @type {{sequence: {length: number}}} */ report) => report.sequence.length,
    ),
    [5, 5],
  );
});

test("--json is byte-identical with and without --verbose when a sequence is asked for", async () => {
  const fixture = await twoSources();
  const quiet = (await snack(fixture, "status", "--no-sync", "--sequence", "12", "--json")).stdout;
  const verbose = (
    await snack(fixture, "status", "--no-sync", "--sequence", "12", "--verbose", "--json")
  ).stdout;
  assert.equal(verbose, quiet);
});

test("an initial-generic source names its sequence method and stays degraded", async () => {
  const fixture = await twoSources();
  // A new plan opens a new capacity period, and evidence from the closed one does not train it.
  fixture.options.now = new Date("2026-01-02T04:00:00.000Z");
  await run(setup("opencode", "work", "anthropic", "generic-max", "personal"), fixture.options);

  const { stdout, stderr } = await snack(
    fixture,
    "status",
    "--no-sync",
    "--sequence",
    "10",
    "--json",
  );
  const document = JSON.parse(stdout);
  const work = document.data.sources.find(
    (/** @type {{source: {alias: string}}} */ report) => report.source.alias === "work",
  );
  assert.equal(work.method.id, "initial-generic");
  assert.deepEqual(work.sequence.method, { id: "sequence-initial-generic", version: "1" });
  assert.equal(work.sequence.evidence.level, "very_low");
  assert.equal(work.sequence.risk.label, "high");
  assert.equal(document.status, "degraded");
  assert.equal(
    document.warnings.filter(
      (/** @type {{code: string}} */ warning) => warning.code === "very_low_evidence",
    ).length,
    1,
  );
  assert.equal(stderr, "");

  const panel = (
    await snack(fixture, "status", "--no-sync", "--source", "work", "--sequence", "10")
  ).stdout;
  assert.match(panel, / {2}method {7}initial heuristic — /u);
  assert.match(panel, /\n {2}next 10 {6}0-\d+% chance all 10 go through · risk high\n/u);
  // The interval is too wide to inform, and the panel says so in words.
  assert.equal(work.sequence.width.too_wide, true);
  assert.match(
    panel,
    /! The 10-prompt interval is too wide to say much; it cannot tell whether all of them going through\s+is more likely than not\./u,
  );
});

test("a sequence is recorded beside its attempt, and the attempt is the one a plain run records", async () => {
  const plainFixture = await twoSources();
  const sequenceFixture = await twoSources();

  await snack(plainFixture, "status", "--no-sync", "--json");
  const { stdout } = await snack(
    sequenceFixture,
    "status",
    "--no-sync",
    "--sequence",
    "8",
    "--json",
  );
  const document = JSON.parse(stdout);

  const attempts = (/** @type {string} */ databaseFile) =>
    rows(databaseFile, "SELECT * FROM prediction_attempt ORDER BY id");
  assert.deepEqual(
    attempts(sequenceFixture.paths.databaseFile),
    attempts(plainFixture.paths.databaseFile),
  );
  assert.deepEqual(rows(plainFixture.paths.databaseFile, "SELECT * FROM prediction_sequence"), []);

  const recorded = rows(
    sequenceFixture.paths.databaseFile,
    `SELECT prediction_sequence.*, prediction_attempt.source_alias AS alias
       FROM prediction_sequence
       JOIN prediction_attempt ON prediction_attempt.id = prediction_sequence.prediction_attempt_id
      ORDER BY prediction_attempt.id`,
  );
  assert.equal(recorded.length, document.data.sources.length);
  for (const report of document.data.sources) {
    const row = recorded.find((entry) => entry.alias === report.source.alias);
    assert.ok(row, report.source.alias);
    assert.equal(row.length, 8);
    assert.equal(row.method_id, report.sequence.method.id);
    assert.equal(row.method_version, report.sequence.method.version);
    assert.equal(row.lower, report.sequence.viability.lower);
    assert.equal(row.point, report.sequence.viability.point);
    assert.equal(row.upper, report.sequence.viability.upper);
    assert.equal(row.coverage_target, report.sequence.viability.coverage_target);
    assert.equal(row.risk_label, report.sequence.risk.label);
    assert.equal(row.risk_policy_version, report.sequence.risk.policy_version);
    assert.equal(row.width_too_wide, report.sequence.width.too_wide ? 1 : 0);
    assert.equal(row.width_policy_version, report.sequence.width.policy_version);
    assert.equal(row.posterior_alpha, report.contributors.evidence_window.alpha);
    assert.equal(row.posterior_beta, report.contributors.evidence_window.beta);
  }
});

test("without an active capacity period the sequence is answered and nothing is recorded", async () => {
  const fixture = await makeRunFixture("snack-status-sequence-no-period-");
  fixture.options.env.OPENCODE_DB = await createOpenCodeDatabase(fixture.root);
  await run(setup("opencode", "work", "anthropic", "pro"), fixture.options);
  await run(["node", "snack", "sync", "--full"], fixture.options);
  // No command closes a period without opening the next, so the state is reached by hand.
  const database = new Database(fixture.paths.databaseFile);
  try {
    const closed = database
      .prepare(
        "UPDATE capacity_period SET ended_at = '2026-01-02T03:00:00.000Z' WHERE ended_at IS NULL",
      )
      .run();
    assert.ok(closed.changes > 0);
  } finally {
    database.close();
  }

  const { stdout } = await snack(fixture, "status", "--no-sync", "--sequence", "5", "--json");
  const report = JSON.parse(stdout).data;
  assert.deepEqual(report.source.active_period, { started_at: null });
  assert.equal(report.sequence.length, 5);
  assert.ok(report.sequence.viability.lower <= report.sequence.viability.upper);
  assert.deepEqual(
    rows(fixture.paths.databaseFile, "SELECT COUNT(*) AS total FROM prediction_attempt"),
    [{ total: 0 }],
  );
  assert.deepEqual(
    rows(fixture.paths.databaseFile, "SELECT COUNT(*) AS total FROM prediction_sequence"),
    [{ total: 0 }],
  );
});

test("stats and export are byte-identical whether or not --sequence was ever used", async () => {
  const plainFixture = await twoSources();
  const sequenceFixture = await twoSources();
  for (const length of ["1", "10", "100"]) {
    await snack(plainFixture, "status", "--no-sync");
    await snack(sequenceFixture, "status", "--no-sync", "--sequence", length);
  }
  // Later prompts link to the snapshots delivered before them, which is where a sequence answer
  // scored as a single-prompt forecast would enter the calibration stream.
  for (const fixture of [plainFixture, sequenceFixture]) {
    const created = Date.parse("2026-01-02T04:00:00.000Z");
    const completed = created + 4000;
    executeOpenCodeSql(
      /** @type {string} */ (fixture.options.env.OPENCODE_DB),
      `INSERT INTO message (id, session_id, time_created, time_updated, data) VALUES
         ('user-later', 'session-1', ${created}, ${created},
          '{"role":"user","time":{"created":${created}},"agent":"build","model":{"providerID":"anthropic","modelID":"claude-sonnet"}}'),
         ('assistant-later', 'session-1', ${created + 1000}, ${completed},
          '{"role":"assistant","time":{"created":${created + 1000},"completed":${completed}},"parentID":"user-later","providerID":"anthropic","modelID":"claude-sonnet","finish":"stop","cost":0.003,"tokens":{"input":100,"output":25,"reasoning":5,"cache":{"read":10,"write":2}}}');
       INSERT INTO part (id, message_id, session_id, time_created, time_updated, data) VALUES
         ('step-later', 'assistant-later', 'session-1', ${completed}, ${completed},
          '{"type":"step-finish","reason":"stop","cost":0.003,"tokens":{"input":100,"output":25,"reasoning":5,"cache":{"read":10,"write":2}}}');`,
    );
    fixture.options.now = new Date("2026-01-02T05:00:00.000Z");
    await snack(fixture, "status", "--source", "work");
  }

  // Installation ids are random per fixture; they are the one thing two histories cannot share.
  const comparable = (/** @type {string} */ text) =>
    text.replaceAll(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gu, "{{id}}");
  for (const argv of [
    ["stats", "--verbose", "--json"],
    ["stats", "--verbose"],
    ["stats", "--by-client", "--json"],
    ["export", "--format", "json", "--output", "-"],
  ]) {
    assert.equal(
      comparable((await snack(sequenceFixture, ...argv)).stdout),
      comparable((await snack(plainFixture, ...argv)).stdout),
      argv.join(" "),
    );
  }
  assert.ok(
    rows(sequenceFixture.paths.databaseFile, "SELECT * FROM prediction_sequence").length > 0,
    "no sequence was recorded, so nothing was compared",
  );
  // And the later prompt was really scored against a delivered forecast, so the calibration figures
  // compared above are not empty on both sides.
  assert.ok(
    rows(sequenceFixture.paths.databaseFile, "SELECT * FROM prediction_evaluation").length > 0,
    "no outcome was evaluated, so calibration was never exercised",
  );
});

/**
 * One source with no history at all, so the posterior is the plan-profile prior: its interval is
 * too wide to inform at `N = 1` and at `N = 10`, and narrow (near zero) at `N = 100`.
 *
 * @param {number} sequenceLength
 */
function priorOnlyCaveats(sequenceLength) {
  const status = createSourceStatus(
    { alias: "work", provider: "anthropic", profile: "default", plan: "pro" },
    {
      prompts: 0,
      successes: 0,
      restrictions: 0,
      excluded: 0,
      as_of: null,
      active_period_started_at: null,
    },
    new Date("2026-01-01T00:00:00.000Z"),
    undefined,
    undefined,
    undefined,
    { sequenceLength },
  );
  const plain = createSourceStatus(
    { alias: "work", provider: "anthropic", profile: "default", plan: "pro" },
    {
      prompts: 0,
      successes: 0,
      restrictions: 0,
      excluded: 0,
      as_of: null,
      active_period_started_at: null,
    },
    new Date("2026-01-01T00:00:00.000Z"),
  );
  assert.deepEqual(status.caveats.slice(0, plain.caveats.length), plain.caveats);
  return { status, own: status.caveats.slice(plain.caveats.length) };
}

test("the too-wide caveat states the rule, the same for every length above one, and recommends nothing", () => {
  // Width `upper^N - lower^N` is not monotone in N, and one more success can widen it: neither a
  // shorter sequence nor more history is a remedy that always holds. Advising either would also
  // have the reader sweep N by hand until a probability looks right -- the inversion SNACK never
  // performs.
  for (const length of [2, 10]) {
    const { status, own } = priorOnlyCaveats(length);
    assert.equal(status.sequence?.width.too_wide, true, String(length));
    const caveat = own.at(-1) ?? "";
    assert.equal(
      caveat,
      `The ${length}-prompt interval is too wide to say much; it cannot tell whether all of them going through is more likely than not.`,
    );
    assert.doesNotMatch(caveat, /shorter|more history|narrow/iu);
  }
  // One prompt is not "all of them", as it is not "all 1": at one the caveat says what the `next
  // prompt` row says, about the next prompt.
  const single = priorOnlyCaveats(1);
  assert.equal(single.status.sequence?.width.too_wide, true);
  assert.equal(
    single.own.at(-1),
    "The 1-prompt interval is too wide to say much; it cannot tell whether the next prompt is more likely to go through than not.",
  );
  assert.doesNotMatch(single.own.join(" "), /all of them|all 1\b|shorter|more history|narrow/iu);
  const { status, own } = priorOnlyCaveats(100);
  assert.equal(status.sequence?.width.too_wide, false);
  assert.ok(!own.some((caveat) => caveat.includes("too wide")), JSON.stringify(own));
});

test("a sequence of one carries no assumption caveat: one prompt has no next one to assume about", () => {
  const assumption = (/** @type {number} */ length) =>
    `The ${length}-prompt estimate assumes each prompt meets the conditions the next one does; it does not model usage pressure rising as they are sent.`;
  assert.ok(!priorOnlyCaveats(1).own.includes(assumption(1)));
  assert.equal(priorOnlyCaveats(1).own.length, 1);
  assert.equal(priorOnlyCaveats(2).own[0], assumption(2));
  assert.equal(priorOnlyCaveats(100).own[0], assumption(100));
});
