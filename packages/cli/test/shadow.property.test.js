import assert from "node:assert/strict";
import { copyFile } from "node:fs/promises";
import { afterEach, test } from "node:test";

import Database from "better-sqlite3";
import fc from "fast-check";

import { run } from "../src/main.js";
import {
  addCodexTurns,
  cleanupRunFixtures,
  createClaudeHistory,
  createCodexHistory,
  createOpenCodeDatabase,
  makeRunFixture,
  plantStatements,
} from "./fixtures/run-fixture.js";

afterEach(cleanupRunFixtures);

/**
 * Shadow mode, as a property (ADR-0007, amended 1.5.0): whatever Codex states, the answer `status`
 * gives for a Codex-fed source is the one the baseline alone gives. The statements are generated
 * fresh at the fixture clock -- inside the six-hour limit, in every band, resetting before and
 * after it -- so the shadow really is computed on most runs, and the property is checked through
 * the command a user runs: the JSON answer, the sequence, the envelope's status and warnings, and
 * the overview a reader sees.
 */

const NOW = Date.parse("2026-01-02T03:04:05.000Z");

const statedInstant = fc
  .integer({ min: NOW - 7 * 3600 * 1000, max: NOW })
  .map((ms) => new Date(ms).toISOString());
const resetInstant = fc.option(
  fc
    .integer({ min: NOW - 3600 * 1000, max: NOW + 10 * 86400 * 1000 })
    .map((ms) => new Date(ms).toISOString()),
  { nil: null },
);

const statedWindow = fc.record({
  window_minutes: fc.constantFrom(300, 10080, 43200),
  used_percent: fc.oneof(
    fc.constantFrom(0, 79.99, 80, 99.99, 100),
    fc.double({ min: 0, max: 100, noNaN: true }),
  ),
  resets_at: resetInstant,
});

const statedSnapshot = fc.record({
  observation_key: fc.stringMatching(/^[0-9a-f]{64}$/u),
  observed_at: statedInstant,
  limit_id: fc.option(fc.constantFrom("codex", "premium"), { nil: null }),
  plan_type: fc.option(fc.constantFrom("free", "plus"), { nil: null }),
  windows: fc.uniqueArray(statedWindow, {
    minLength: 1,
    maxLength: 2,
    selector: (window) => window.window_minutes,
  }),
  parser_version: fc.constant("codex-rate-limits-v1"),
  provider: fc.constant("openai"),
});

/**
 * A window stated full or nearly full `ageMs` before the clock, resetting an hour after it.
 *
 * @param {number} usedPercent
 * @param {number} n
 * @param {number} [ageMs]
 */
function fixedSnapshot(usedPercent, n, ageMs = 60_000) {
  return {
    observation_key: String(n).padStart(64, "a"),
    observed_at: new Date(NOW - ageMs).toISOString(),
    limit_id: /** @type {"codex" | "premium" | null} */ ("codex"),
    plan_type: /** @type {"free" | "plus" | null} */ ("plus"),
    windows: [
      {
        window_minutes: /** @type {300 | 10080 | 43200} */ (300),
        used_percent: usedPercent,
        resets_at: /** @type {string | null} */ (new Date(NOW + 3_600_000).toISOString()),
      },
    ],
    parser_version: /** @type {const} */ ("codex-rate-limits-v1"),
    provider: /** @type {const} */ ("openai"),
  };
}

/**
 * Everything the answer is made of. `reported_capacity`, `shadow` and the `reported-capacity` entry
 * of `shadows` are what a stated figure is allowed to add; nothing else may differ.
 *
 * @param {string} stdout
 */
function answerOf(stdout) {
  const document = JSON.parse(stdout);
  const { shadow, ...answer } = document.data;
  delete answer.reported_capacity;
  // From 1.6.0 `shadows` repeats `shadow` as its first entry, beside the weighting variants, which
  // read no statement: the variants alone must be what they were with no statement at all.
  answer.shadows = answer.shadows.filter(
    (/** @type {{method: {id: string}}} */ entry) => entry.method.id !== "reported-capacity",
  );
  return {
    answer,
    status: document.status,
    warnings: document.warnings,
    shadow: /** @type {{computed: boolean, binding: {band: string} | null} | undefined} */ (shadow),
  };
}

test("whatever Codex states, the status answer is the one the baseline alone gives", async () => {
  const fixture = await makeRunFixture("snack-shadow-isolation-");
  fixture.options.env.CODEX_HOME = await createCodexHistory(fixture.root, [
    "version-0-159-3.jsonl",
    "version-0-147-0.jsonl",
    "restricted-usage-limit.jsonl",
    "restricted-reached-type.jsonl",
  ]);
  // Two hundred successes, one every 25 minutes until an hour before the clock: enough pressure
  // windows for the baseline to key on its own band rather than the period aggregate, so its risk
  // and evidence are values a leak could move (guarded below).
  await addCodexTurns(fixture.options.env.CODEX_HOME, {
    from: NOW - 3_600_000 - 200 * 25 * 60_000,
    count: 200,
    spacingMs: 25 * 60_000,
  });
  /** @param {string[]} argv */
  const invoke = async (...argv) => {
    fixture.stdout.value = "";
    fixture.stderr.value = "";
    const exitCode = await run(["node", "snack", ...argv], fixture.options);
    assert.equal(exitCode, 0, fixture.stderr.value);
    return fixture.stdout.value;
  };
  const setup = JSON.parse(
    await invoke(
      "setup",
      "codex",
      "--non-interactive",
      "--source",
      "codex",
      "--provider",
      "openai",
      "--profile",
      "default",
      "--plan",
      "plus",
      "--json",
    ),
  );
  await invoke("sync", "--full");

  // The baseline alone: the same history with every statement the fixture carried removed.
  const { databaseFile } = fixture.paths;
  const database = new Database(databaseFile);
  try {
    // With no statement, no prompt began in a stated band: the projection of an empty timeline.
    database.exec(
      `DELETE FROM reported_capacity_latest; DELETE FROM reported_capacity_observation;
       UPDATE prompt_execution SET stated_band = NULL`,
    );
  } finally {
    database.close();
  }
  const pristine = `${databaseFile}.pristine`;
  await copyFile(databaseFile, pristine);

  const installationId = setup.data.source.installation_id;

  /** @param {import("../src/storage.js").ReportedCapacitySnapshot[]} reported */
  const plant = (reported) =>
    plantStatements(databaseFile, "codex", installationId, reported, new Date(NOW));

  /** How many prompts the projection put in each stated band. */
  const projected = () => {
    const reader = new Database(databaseFile, { readonly: true });
    try {
      return Object.fromEntries(
        reader
          .prepare(
            `SELECT stated_band, COUNT(*) AS prompts FROM prompt_execution
              WHERE stated_band IS NOT NULL GROUP BY stated_band`,
          )
          .raw()
          .all()
          .map((row) => /** @type {[string, number]} */ (row)),
      );
    } finally {
      reader.close();
    }
  };

  /**
   * The statements are planted the way ingestion stores them, then a synchronization -- which
   * reads nothing new from the unchanged rollouts -- projects them onto the prompts after them, so
   * the stated band is on the very rows the baseline reads.
   *
   * @param {import("../src/storage.js").ReportedCapacitySnapshot[]} reported
   */
  const statusWith = async (reported) => {
    await copyFile(pristine, databaseFile);
    plant(reported);
    await invoke("sync");
    return {
      bands: projected(),
      single: answerOf(await invoke("status", "--no-sync", "--json")),
      sequence: answerOf(await invoke("status", "--no-sync", "--sequence", "3", "--json")),
      overview: await invoke("status", "--no-sync"),
    };
  };

  const baseline = await statusWith([]);
  assert.equal(baseline.single.shadow?.computed, false, "a shadow computed from no statement");
  assert.deepEqual(baseline.bands, {}, "a prompt in a stated band with no statement");
  // Non-vacuity: a baseline already at `high` risk, `very_low` evidence or the period aggregate
  // could not show a stated figure raising the risk, lowering the evidence or moving the cell.
  const answer =
    /** @type {{risk: {label: string}, evidence: {level: string}, contributors: {backoff_level: string}}} */ (
      baseline.single.answer
    );
  assert.equal(answer.risk.label, "low");
  assert.notEqual(answer.evidence.level, "very_low");
  assert.notEqual(answer.contributors.backoff_level, "period");

  const seen = { computed: 0, full: 0, fullPrompts: 0, nearPrompts: 0 };
  await fc.assert(
    fc.asyncProperty(
      fc.uniqueArray(statedSnapshot, {
        minLength: 1,
        maxLength: 5,
        selector: (snapshot) => snapshot.observation_key,
      }),
      async (reported) => {
        const stated = await statusWith(reported);
        if (stated.single.shadow?.computed === true) seen.computed += 1;
        if (stated.single.shadow?.binding?.band === "full") seen.full += 1;
        seen.fullPrompts += stated.bands.full ?? 0;
        seen.nearPrompts += stated.bands.near ?? 0;
        assert.deepEqual(stated.single.answer, baseline.single.answer);
        assert.deepEqual(stated.single.status, baseline.single.status);
        assert.deepEqual(stated.single.warnings, baseline.single.warnings);
        assert.deepEqual(stated.sequence.answer, baseline.sequence.answer);
        assert.equal(stated.overview, baseline.overview);
      },
    ),
    {
      numRuns: 40,
      // Always run, beside the random ones: a window stated full and one nearly full, a minute
      // before the clock and three hours before it -- early enough to bind the last prompts of the
      // history -- so the guards below never depend on what the generator happened to draw.
      examples: [
        [[fixedSnapshot(100, 1)]],
        [[fixedSnapshot(90, 2)]],
        [[fixedSnapshot(100, 3, 3 * 3_600_000)]],
        [[fixedSnapshot(90, 4, 3 * 3_600_000)]],
      ],
    },
  );
  // Non-vacuity: the property held while the shadow was really computed, in the full band too.
  assert.ok(seen.computed >= 5, `the shadow was computed on ${seen.computed} runs only`);
  assert.ok(seen.full >= 1, "no run bound a window stated full");
  // ...and while the prompts the baseline reads carried a stated band, in both upper bands.
  assert.ok(seen.fullPrompts >= 1, "no prompt was projected into the full band");
  assert.ok(seen.nearPrompts >= 1, "no prompt was projected into the near band");
});

/**
 * Plant prompts on a source the way ingestion stores them: each a copy of one the source already
 * holds -- its period, installation, revision domain, parser and size-category policy -- at a new
 * start, with its own outcome. Written straight through SQLite because the property is about what
 * `status` reads, not about any client's on-disk shape.
 *
 * @param {string} databaseFile
 * @param {string} alias
 * @param {{started_at: string, outcome: "success" | "restricted" | "excluded", size_category: "small" | "typical" | "large"}[]} prompts
 */
function plantPrompts(databaseFile, alias, prompts) {
  const database = new Database(databaseFile);
  try {
    const template = /** @type {{id: number}} */ (
      database
        .prepare("SELECT id FROM prompt_execution WHERE source_alias = ? ORDER BY id LIMIT 1")
        .get(alias)
    );
    const insertPrompt = database.prepare(
      `INSERT INTO prompt_execution
         (source_alias, capacity_period_id, source_prompt_id, source_session_fingerprint,
          source_revision, observation_hash, revision_domain, parser_version, started_at,
          completed_at, duration_ms, completion, first_observed_at, last_observed_at,
          installation_id, size_category, category_policy_version)
       SELECT source_alias, capacity_period_id, @prompt, source_session_fingerprint,
              source_revision, @prompt, revision_domain, parser_version, @started_at,
              @started_at, 1000, 'completed', @started_at, @started_at,
              installation_id, @size_category, category_policy_version
         FROM prompt_execution WHERE id = @template`,
    );
    const insertOutcome = database.prepare(
      `INSERT INTO prompt_source_outcome (prompt_execution_id, outcome, policy_version)
       VALUES (?, ?, 'stage2-outcome-v1')`,
    );
    const insertSlice = database.prepare(
      `INSERT INTO prompt_usage_slice
         (prompt_execution_id, source_slice_id, provider, model, input_tokens, output_tokens)
       SELECT ?, 'planted', provider, model, 100, 20 FROM prompt_usage_slice
        WHERE prompt_execution_id = ? LIMIT 1`,
    );
    database.transaction(() => {
      for (const prompt of prompts) {
        const id = Number(
          insertPrompt.run({
            prompt: `planted-${prompt.started_at}-${Math.random()}`,
            started_at: prompt.started_at,
            size_category: prompt.size_category,
            template: template.id,
          }).lastInsertRowid,
        );
        insertOutcome.run(id, prompt.outcome);
        insertSlice.run(id, template.id);
      }
    })();
  } finally {
    database.close();
  }
}

/**
 * The answer a report gives, without the shadow estimates beside it.
 *
 * @param {Record<string, unknown>} report
 */
function withoutShadows(report) {
  const { shadows, ...answer } = report;
  return {
    answer,
    shadows:
      /** @type {{method: {id: string}, computed: boolean, viability?: {lower: number}}[]} */ (
        shadows
      ),
  };
}

test("whatever the weighting variants say, every source's answer is the one the answer alone gives", async () => {
  const fixture = await makeRunFixture("snack-weighting-isolation-");
  fixture.options.env.OPENCODE_DB = await createOpenCodeDatabase(fixture.root);
  fixture.options.env.CLAUDE_CONFIG_DIR = await createClaudeHistory(fixture.root);
  fixture.options.env.CODEX_HOME = await createCodexHistory(fixture.root, [
    "version-0-159-3.jsonl",
  ]);
  /** @param {string[]} argv */
  const invoke = async (
    argv,
    variants = /** @type {typeof import("../src/prediction.js").WEIGHTING_VARIANTS | undefined} */ (
      undefined
    ),
  ) => {
    fixture.stdout.value = "";
    fixture.stderr.value = "";
    const exitCode = await run(["node", "snack", ...argv], {
      ...fixture.options,
      ...(variants === undefined ? {} : { weightingVariants: variants }),
    });
    assert.equal(exitCode, 0, fixture.stderr.value);
    return fixture.stdout.value;
  };
  for (const [client, alias, provider, plan] of [
    ["opencode", "work", "anthropic", "pro"],
    ["claude", "personal", "anthropic", "pro"],
    ["codex", "codex", "openai", "plus"],
  ]) {
    await invoke([
      "setup",
      String(client),
      "--non-interactive",
      "--source",
      String(alias),
      "--provider",
      String(provider),
      "--profile",
      "default",
      "--plan",
      String(plan),
    ]);
  }
  await invoke(["sync", "--full"]);
  const { databaseFile } = fixture.paths;
  // Two hundred successes per source, one every 25 minutes until an hour before the clock: enough
  // pressure windows for the answer to key on its own band rather than the period aggregate, so
  // its risk, its evidence and its cell are values a leaking variant could move (guarded below).
  for (const alias of ["work", "personal", "codex"]) {
    plantPrompts(
      databaseFile,
      alias,
      Array.from({ length: 200 }, (_unused, index) => ({
        started_at: new Date(NOW - 3_600_000 - (200 - index) * 25 * 60_000).toISOString(),
        outcome: /** @type {const} */ ("success"),
        size_category: /** @type {const} */ ("typical"),
      })),
    );
  }
  const pristine = `${databaseFile}.weighting-pristine`;
  await copyFile(databaseFile, pristine);

  /**
   * The same database, read with the variants beside the answer and with none: `status`, its
   * `--sequence 3` answer and the overview, each from its own copy so an attempt one records is
   * never history for the other.
   *
   * @param {typeof import("../src/prediction.js").WEIGHTING_VARIANTS | undefined} variants
   */
  const read = async (variants) => {
    await copyFile(`${databaseFile}.weighting-case`, databaseFile);
    const single = JSON.parse(await invoke(["status", "--no-sync", "--json"], variants));
    await copyFile(`${databaseFile}.weighting-case`, databaseFile);
    const sequence = JSON.parse(
      await invoke(["status", "--no-sync", "--sequence", "3", "--json"], variants),
    );
    await copyFile(`${databaseFile}.weighting-case`, databaseFile);
    const overview = await invoke(["status", "--no-sync"], variants);
    return { single, sequence, overview };
  };

  // Non-vacuity: an answer already at `high` risk, `very_low` evidence, the period aggregate or the
  // prior could not show a variant raising the risk, lowering the evidence or moving the cell.
  await copyFile(pristine, `${databaseFile}.weighting-case`);
  const baseline = await read(undefined);
  for (const report of baseline.single.data.sources) {
    const alias = report.source.alias;
    assert.equal(report.risk.label, "low", alias);
    assert.notEqual(report.evidence.level, "very_low", alias);
    assert.ok(
      !["period", "prior"].includes(report.contributors.backoff_level),
      `${alias} reads ${report.contributors.backoff_level}`,
    );
  }

  const outcome = fc.constantFrom("success", "success", "restricted", "restricted", "excluded");
  const tail = fc.array(
    fc.record({
      outcome,
      size_category: fc.constantFrom("small", "typical", "large"),
      gapMinutes: fc.integer({ min: 1, max: 90 }),
    }),
    { maxLength: 30, size: "max" },
  );
  const seen = { computed: 0, differs: 0, runs: 0 };
  await fc.assert(
    fc.asyncProperty(fc.tuple(tail, tail, tail), async (tails) => {
      await copyFile(pristine, `${databaseFile}.weighting-case`);
      for (const [index, alias] of ["work", "personal", "codex"].entries()) {
        const rows = /** @type {(typeof tails)[0]} */ (tails[index]);
        let at = NOW - 3_600_000;
        plantPrompts(
          `${databaseFile}.weighting-case`,
          alias,
          rows.map((row) => {
            at += row.gapMinutes * 60_000 * (55 / 90);
            return {
              started_at: new Date(Math.min(at, NOW - 1000)).toISOString(),
              outcome: /** @type {"success" | "restricted" | "excluded"} */ (row.outcome),
              size_category: /** @type {"small" | "typical" | "large"} */ (row.size_category),
            };
          }),
        );
      }
      const today = await read(undefined);
      const alone = await read([]);
      seen.runs += 1;
      for (const [index, report] of today.single.data.sources.entries()) {
        const { answer: reportAnswer, shadows } = withoutShadows(report);
        const answer = /** @type {{viability: {lower: number}}} */ (reportAnswer);
        const { answer: aloneAnswer, shadows: aloneShadows } = withoutShadows(
          alone.single.data.sources[index],
        );
        assert.deepEqual(answer, aloneAnswer, report.source.alias);
        // The answer alone carries no variant: only the `reported-capacity` entry, where it runs.
        assert.ok(aloneShadows.every((entry) => entry.method.id === "reported-capacity"));
        for (const entry of shadows.slice(-2)) {
          if (!entry.computed || entry.viability === undefined) continue;
          seen.computed += 1;
          if (entry.viability.lower !== answer.viability.lower) seen.differs += 1;
        }
        const sequence = withoutShadows(today.sequence.data.sources[index]).answer;
        const aloneSequence = withoutShadows(alone.sequence.data.sources[index]).answer;
        assert.deepEqual(sequence, aloneSequence, `${report.source.alias} --sequence 3`);
      }
      assert.deepEqual(
        [today.single.status, today.single.warnings],
        [alone.single.status, alone.single.warnings],
      );
      assert.deepEqual(
        [today.sequence.status, today.sequence.warnings],
        [alone.sequence.status, alone.sequence.warnings],
      );
      assert.equal(today.overview, alone.overview);
    }),
    { numRuns: 25 },
  );
  // Non-vacuity: the variants really ran, on every source, and said something other than the
  // answer -- so a variant that replaced the answer would have been seen.
  assert.ok(seen.computed >= seen.runs * 3, `variants computed ${seen.computed} times only`);
  assert.ok(seen.differs >= seen.runs, `variants differed from the answer ${seen.differs} times`);
});
