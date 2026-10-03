import assert from "node:assert/strict";
import { afterEach, test } from "node:test";

import Database from "better-sqlite3";
import fc from "fast-check";

import { run } from "../src/main.js";
import { PREDICTION_POLICY, WEIGHTING_VARIANTS, buildForecast } from "../src/prediction.js";
import {
  attachShadows,
  createSourceStatus,
  createWeightingShadows,
  prepareForecastInput,
} from "../src/status.js";
import { cleanupRunFixtures, createCodexHistory, makeRunFixture } from "./fixtures/run-fixture.js";

afterEach(cleanupRunFixtures);

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
