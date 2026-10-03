import assert from "node:assert/strict";
import { afterEach, test } from "node:test";

import Database from "better-sqlite3";
import fc from "fast-check";

import { rm } from "node:fs/promises";

import { backtestWeightings, scoreVariant } from "../src/calibration.js";
import { run } from "../src/main.js";
import { resolvePlanProfile } from "../src/plan-profile.js";
import { PREDICTION_POLICY, WEIGHTING_VARIANTS, buildForecast } from "../src/prediction.js";
import { renderStats } from "../src/render.js";
import { readOutcomeRows } from "../src/storage.js";
import {
  attachShadows,
  createSourceStatus,
  createWeightingShadows,
  prepareForecastInput,
} from "../src/status.js";
import { backtestAsReleased } from "./fixtures/backtest-1.5.0.js";
import {
  cleanupRunFixtures,
  createCodexHistory,
  makeRunFixture,
  sink,
} from "./fixtures/run-fixture.js";
import { makeSeededSource } from "./fixtures/seeded-history.js";

/** @type {string[]} */
const seededRoots = [];
afterEach(cleanupRunFixtures);
afterEach(async () => {
  await Promise.all(
    seededRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

const now = new Date("2026-02-01T00:00:00.000Z");
const source = { alias: "work", provider: "anthropic", profile: "default", plan: "pro" };
const observed = {
  prompts: 0,
  successes: 0,
  restrictions: 0,
  excluded: 0,
  as_of: null,
  active_period_started_at: "2026-01-01T00:00:00.000Z",
};

/** @param {number} ageMinutes */
const at = (ageMinutes) => new Date(now.getTime() - ageMinutes * 60_000).toISOString();

const history = fc.array(
  fc.record({
    ageMinutes: fc.integer({ min: 1, max: 20 * 24 * 60 }),
    outcome: fc.constantFrom("success", "success", "restricted", "excluded"),
    size_category: fc.constantFrom("small", "typical", "large"),
  }),
  { maxLength: 200, size: "max" },
);

/** @param {{ageMinutes: number, outcome: string, size_category: string}[]} rows */
const asOutcomes = (rows) =>
  rows
    .map((row) => ({
      started_at: at(row.ageMinutes),
      outcome: /** @type {"success" | "restricted" | "excluded"} */ (row.outcome),
      size_category: row.size_category,
    }))
    .sort((left, right) => left.started_at.localeCompare(right.started_at));

test("the variants read the answer's own prepared input, and only their weighting differs", () => {
  fc.assert(
    fc.property(history, fc.constantFrom("small", "typical", "large"), (rows, category) => {
      const historyInput = {
        outcomes: asOutcomes(rows),
        windowSeconds: 3600,
        category,
        completeness: {
          level: /** @type {const} */ ("complete"),
          reasons: [],
          policy_version: "stage5-evidence-v2",
        },
      };
      const pressure = { band: "moderate", policy_version: "stage4-analytics-v1" };
      const prepared = prepareForecastInput(source, observed, now, pressure, historyInput);
      // Prepared here or inside: the report is the same object either way.
      assert.deepEqual(
        createSourceStatus(source, observed, now, undefined, pressure, historyInput, { prepared }),
        createSourceStatus(source, observed, now, undefined, pressure, historyInput),
      );
      const report = createSourceStatus(source, observed, now, undefined, pressure, historyInput);
      const { views, rows: recorded } = createWeightingShadows(prepared);
      assert.deepEqual(
        views.map((view) => view.method),
        WEIGHTING_VARIANTS.map((variant) => variant.method),
      );
      for (const [index, view] of views.entries()) {
        const variant = /** @type {(typeof WEIGHTING_VARIANTS)[number]} */ (
          WEIGHTING_VARIANTS[index]
        );
        assert.equal(view.policy_version, variant.policy.version);
        if (!view.computed) continue;
        // Exactly the variant's forecast of the very input the answer read.
        const forecast = buildForecast({ ...prepared, policy: variant.policy });
        assert.deepEqual(view.viability, forecast.viability);
        assert.deepEqual(view.evidence, forecast.evidence);
        assert.equal(view.model_policy_version, variant.policy.version);
      }
      assert.equal(recorded.length, views.filter((view) => view.computed).length);
      // And the answer beside them is the answer's own: attaching only adds `shadows`, last.
      const attached = attachShadows(report, views);
      const { shadows, ...answer } = attached;
      assert.deepEqual(answer, report);
      assert.equal(Object.keys(attached).at(-1), "shadows");
      assert.deepEqual(shadows, views);
      assert.equal(report.model_policy_version, PREDICTION_POLICY.version);
    }),
    { numRuns: 120 },
  );
});

test("the variants never compute from the plan prior alone", () => {
  fc.assert(
    fc.property(fc.array(fc.integer({ min: 1, max: 20 * 24 * 60 }), { maxLength: 40 }), (ages) => {
      // No outcome, or only outcomes that are evidence of nothing: every ladder ends at the prior.
      const prepared = prepareForecastInput(
        source,
        observed,
        now,
        { band: "moderate" },
        {
          outcomes: ages.map((age) => ({
            started_at: at(age),
            outcome: /** @type {const} */ ("excluded"),
            size_category: "typical",
          })),
        },
      );
      const { views, rows } = createWeightingShadows(prepared);
      assert.deepEqual(rows, []);
      for (const view of views) {
        assert.deepEqual(view, {
          method: view.method,
          computed: false,
          reason: "no_local_outcomes",
          policy_version: view.policy_version,
        });
      }
      // The answer there is the initial heuristic, which no variant is credited with.
      assert.equal(buildForecast(prepared).method.id, "initial-generic");
    }),
  );
});

test("a source with no outcome of the user's records no variant and says why", async () => {
  // The canary-free Codex fixture's prompts include outcomes; a fresh source with none is the case.
  const fixture = await makeRunFixture("snack-weighting-prior-");
  fixture.options.env.CODEX_HOME = await createCodexHistory(fixture.root, [
    "version-0-159-3.jsonl",
  ]);
  await run(
    [
      "node",
      "snack",
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
    ],
    fixture.options,
  );
  await run(["node", "snack", "sync", "--full"], fixture.options);
  // Every prompt made evidence of nothing, as a client error would.
  const database = new Database(fixture.paths.databaseFile);
  try {
    database.exec("UPDATE prompt_source_outcome SET outcome = 'excluded'");
  } finally {
    database.close();
  }
  fixture.stdout.value = "";
  await run(["node", "snack", "status", "--no-sync", "--json"], fixture.options);
  const report = JSON.parse(fixture.stdout.value).data;
  assert.equal(report.method.id, "initial-generic");
  assert.deepEqual(
    report.shadows
      .slice(-2)
      .map((/** @type {{method: {id: string}, computed: boolean, reason: string}} */ entry) => [
        entry.method.id,
        entry.computed,
        entry.reason,
      ]),
    [
      ["bayesian-pressure-band-hl50", false, "no_local_outcomes"],
      ["bayesian-pressure-band-hl100", false, "no_local_outcomes"],
    ],
  );
  const reader = new Database(fixture.paths.databaseFile, { readonly: true });
  try {
    const counted = /** @type {{attempts: number, shadows: number}} */ (
      reader
        .prepare(
          `SELECT (SELECT COUNT(*) FROM prediction_attempt) AS attempts,
                  (SELECT COUNT(*) FROM prediction_shadow) AS shadows`,
        )
        .get()
    );
    assert.deepEqual(counted, { attempts: 1, shadows: 0 });
  } finally {
    reader.close();
  }
  fixture.stdout.value = "";
  await run(["node", "snack", "status", "--no-sync", "--verbose"], fixture.options);
  assert.match(
    fixture.stdout.value,
    /bayesian-pressure-band-hl50@1 and bayesian-pressure-band-hl100@1 not computed — no outcome of yours to read yet/u,
  );
});

test("stats wires each replay to its own entry: the answer's to the answer, each variant's to its own", async () => {
  // A history long enough that the replay scores, with refusals, so the answer and both variants
  // produce different doubles. The `1.5` corpus replays nothing (`forecasts: 0`), which let a
  // swapped or reordered replay through the whole suite.
  const origin = new Date("2026-01-01T00:00:00.000Z");
  const seeded = await makeSeededSource({ origin, roots: seededRoots });
  seeded.plant(
    Array.from({ length: 90 }, (_unused, index) => ({
      at: new Date(origin.getTime() + index * 7 * 60_000),
      restricted: index % 9 === 4 || (index > 70 && index % 3 === 0),
    })),
  );
  const stdout = sink();
  const code = await run(["node", "snack", "stats", "--json"], {
    stdout,
    stderr: sink(),
    env: seeded.env,
    home: seeded.root,
    now: new Date(origin.getTime() + 24 * 3_600_000),
  });
  assert.equal(code, 0);
  const { calibration } = JSON.parse(stdout.value).data;

  const outcomes = readOutcomeRows(seeded.paths.databaseFile, "work");
  const profile = resolvePlanProfile(seeded.source).profile;
  const prior = { strength: profile.prior_strength, viability: profile.prior_viability };
  const released = backtestAsReleased(outcomes, { now: new Date(), prior });
  assert.ok(released.forecasts > 0, "the replay scored nothing: the test would be vacuous");
  assert.ok(released.scored.some((forecast) => forecast.outcome === "restricted"));
  const answerBacktest = { ...released.calibration, forecasts: released.forecasts };
  assert.deepEqual(calibration.backtest, answerBacktest);

  const [answerEntry, ...variantEntries] = calibration.by_method;
  assert.equal(answerEntry.role, "answer");
  assert.deepEqual(answerEntry.backtest, answerBacktest);

  const [answerReplay] = backtestWeightings(outcomes, { prior, policies: [PREDICTION_POLICY] });
  assert.equal(variantEntries.length, WEIGHTING_VARIANTS.length);
  /** @type {unknown[]} */
  const seen = [];
  for (const [index, variant] of WEIGHTING_VARIANTS.entries()) {
    const entry = variantEntries[index];
    assert.equal(entry.id, variant.method.id);
    const [own] = backtestWeightings(outcomes, { prior, policies: [variant.policy] });
    const replayed = scoreVariant(
      /** @type {NonNullable<typeof own>} */ (own),
      /** @type {NonNullable<typeof answerReplay>} */ (answerReplay),
    );
    assert.ok(replayed.forecasts > 0);
    assert.deepEqual(entry.backtest, { ...replayed.calibration, forecasts: replayed.forecasts });
    assert.deepEqual(entry.paired.backtest, replayed.paired);
    seen.push(entry.backtest);
  }
  // Non-vacuity: every weighting's numbers differ, so a swap cannot pass by coincidence.
  assert.notDeepEqual(seen[0], seen[1]);
  assert.notDeepEqual(seen[0], answerBacktest);
});

test("plain stats prints, byte for byte, what the full report renders to without --verbose", async () => {
  // Plain `stats` prints only the snapshots headline of the calibration, so it does not replay the
  // history; what it prints must be exactly what the full report would have rendered.
  const origin = new Date("2026-01-01T00:00:00.000Z");
  const seeded = await makeSeededSource({ origin, roots: seededRoots });
  seeded.plant(
    Array.from({ length: 60 }, (_unused, index) => ({
      at: new Date(origin.getTime() + index * 11 * 60_000),
      restricted: index % 7 === 3,
    })),
  );
  // The seeded period names no plan profile; naming the one the source resolves to keeps the
  // planted prompts in the active period when `status` first runs, rather than retiring them.
  const setup = new Database(seeded.paths.databaseFile);
  try {
    setup.prepare("UPDATE capacity_period SET plan_profile_id = 'generic' WHERE id = 1").run();
  } finally {
    setup.close();
  }
  const now = new Date(origin.getTime() + 24 * 3_600_000);
  /** @param {string[]} argv */
  const snack = async (argv) => {
    const stdout = sink();
    const stderr = sink();
    const code = await run(["node", "snack", ...argv], {
      stdout,
      stderr,
      env: seeded.env,
      home: seeded.root,
      now,
    });
    assert.equal(code, 0, stderr.value);
    return { stdout: stdout.value, stderr: stderr.value };
  };
  await snack(["status"]);
  await snack(["status", "--sequence", "2"]);
  // An attempt never delivered, so the snapshots headline and the attempt count differ.
  const writer = new Database(seeded.paths.databaseFile);
  try {
    const columns = /** @type {{name: string}[]} */ (
      writer.prepare("PRAGMA table_info(prediction_attempt)").all()
    )
      .map((column) => column.name)
      .filter((name) => name !== "id");
    writer
      .prepare(
        `INSERT INTO prediction_attempt (${columns.join(", ")})
         SELECT ${columns
           .map((name) => (name === "generated_at" ? "'2026-01-01T23:00:00.000Z'" : name))
           .join(", ")}
         FROM prediction_attempt ORDER BY id LIMIT 1`,
      )
      .run();
  } finally {
    writer.close();
  }
  for (const extra of [[], ["--by-client"], ["--horizon", "PT5H"]]) {
    const full = JSON.parse((await snack(["stats", ...extra, "--json"])).stdout).data;
    assert.ok(full.calibration.snapshots > 0);
    assert.ok(full.calibration.undelivered_attempts > 0);
    assert.ok(full.calibration.backtest.forecasts > 0);
    const plain = await snack(["stats", ...extra]);
    assert.equal(plain.stdout, renderStats(full, { verbose: false }), extra.join(" "));
    assert.equal(plain.stderr, "");
    // `--verbose` still reads the full report.
    const verbose = await snack(["stats", ...extra, "--verbose"]);
    assert.equal(verbose.stdout, renderStats(full, { verbose: true }), extra.join(" "));
  }
});
