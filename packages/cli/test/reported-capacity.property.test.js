import assert from "node:assert/strict";
import { copyFile } from "node:fs/promises";
import { afterEach, test } from "node:test";

import fc from "fast-check";

import { run } from "../src/main.js";
import { storeObservations } from "../src/storage.js";
import {
  cleanupRunFixtures,
  createOpenCodeDatabase,
  makeRunFixture,
} from "./fixtures/run-fixture.js";

afterEach(cleanupRunFixtures);

const CODEX_INSTALLATION = "33333333-4444-4555-8666-777777777777";

/** A Codex installation feeding the same capacity source the OpenCode history describes. */
const codexOnWork = {
  alias: "work",
  installation_id: CODEX_INSTALLATION,
  adapter: "codex",
  provider: "anthropic",
  profile: "default",
  plan: "pro",
  fingerprint: "cx-rollout-usagerecord-v1",
};

const instant = fc
  .integer({ min: Date.parse("2025-12-01T00:00:00.000Z"), max: Date.parse("2026-01-03T00:00:00Z") })
  .map((ms) => new Date(ms).toISOString());

const statedWindow = fc.record({
  window_minutes: fc.constantFrom(300, 10080, 43200, 1, 525600),
  used_percent: fc.oneof(
    fc.integer({ min: 0, max: 100 }),
    fc.double({ min: 0, max: 100, noNaN: true }),
  ),
  resets_at: fc.option(instant, { nil: null }),
});

const statedSnapshot = fc.record({
  observation_key: fc.stringMatching(/^[0-9a-f]{64}$/u),
  observed_at: instant,
  limit_id: fc.option(fc.constantFrom("codex", "premium"), { nil: null }),
  plan_type: fc.option(fc.constantFrom("free", "plus", "pro"), { nil: null }),
  windows: fc.uniqueArray(statedWindow, {
    minLength: 1,
    maxLength: 2,
    selector: (window) => window.window_minutes,
  }),
  parser_version: fc.constant("codex-rate-limits-v1"),
  provider: fc.constant(codexOnWork.provider),
});

/**
 * Everything `status` says about the estimate, with the stated figures set aside: the quoted figure
 * may be shown beside the estimate, and nothing else in the report may move because of it.
 *
 * @param {string} stdout
 */
function estimateOf(stdout) {
  const { data } = JSON.parse(stdout);
  // One configured source is reported as the document's data; several, as a list of reports.
  /** @type {Record<string, unknown>[]} */
  const reports = Array.isArray(data.sources) ? data.sources : [data];
  return reports.map((report) => {
    const estimate = { ...report };
    delete estimate.reported_capacity;
    return estimate;
  });
}

test("a stated figure never moves the estimate: interval, risk, evidence and pressure stay identical", async () => {
  // ADR-0007: SNACK quotes what Codex states and never lets it inform the forecast. That is
  // asserted here on the whole report rather than on the code paths that happen not to read the
  // table today, so a later change that wires the figure into an estimate fails here first.
  const fixture = await makeRunFixture("snack-reported-isolation-");
  fixture.options.env.OPENCODE_DB = await createOpenCodeDatabase(fixture.root);
  await run(
    [
      "node",
      "snack",
      "setup",
      "opencode",
      "--non-interactive",
      "--source",
      "work",
      "--provider",
      "anthropic",
      "--profile",
      "default",
      "--plan",
      "pro",
    ],
    fixture.options,
  );
  assert.equal(await run(["node", "snack", "sync", "--full"], fixture.options), 0);
  const { databaseFile } = fixture.paths;
  // Both sides carry the Codex binding, so the only difference between them is the figures.
  storeObservations(
    databaseFile,
    codexOnWork,
    { observations: [], cursor: null, reported_capacity: [] },
    fixture.options.now,
  );
  const pristine = `${databaseFile}.pristine`;
  await copyFile(databaseFile, pristine);

  /** @param {import("../src/storage.js").ReportedCapacitySnapshot[]} reported */
  const statusWith = async (reported) => {
    await copyFile(pristine, databaseFile);
    if (reported.length > 0) {
      const counts = storeObservations(
        databaseFile,
        codexOnWork,
        { observations: [], cursor: null, reported_capacity: reported },
        fixture.options.now,
      );
      // Non-vacuity: the figures really are in the database the estimate is computed from.
      assert.ok((counts.reported_capacity?.inserted ?? 0) > 0);
    }
    fixture.stdout.value = "";
    const exitCode = await run(["node", "snack", "status", "--no-sync", "--json"], fixture.options);
    assert.equal(exitCode, 0, fixture.stdout.value.slice(0, 300));
    return estimateOf(fixture.stdout.value);
  };

  const baseline = await statusWith([]);
  // Non-vacuity: there is an estimate to move, with an interval, a risk label and evidence.
  assert.equal(baseline.length, 1);
  const [report] = /** @type {{viability: {point: unknown}, pressure: unknown}[]} */ (
    /** @type {unknown} */ (baseline)
  );
  assert.equal(typeof report?.viability.point, "number");
  assert.ok(report?.pressure);

  await fc.assert(
    fc.asyncProperty(
      fc.uniqueArray(statedSnapshot, {
        minLength: 1,
        maxLength: 6,
        selector: (snapshot) => snapshot.observation_key,
      }),
      async (reported) => {
        assert.deepEqual(await statusWith(reported), baseline);
      },
    ),
    { numRuns: 25 },
  );
});
