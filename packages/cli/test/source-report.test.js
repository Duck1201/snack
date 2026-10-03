import assert from "node:assert/strict";
import { rm } from "node:fs/promises";
import { afterEach, test } from "node:test";

import Database from "better-sqlite3";

import { PLOT_POLICY } from "../src/analytics.js";
import { readConfig } from "../src/config.js";
import { resolvePlanProfile } from "../src/plan-profile.js";
import { buildSourceReports, readPressure } from "../src/source-report.js";
import { makeSeededSource } from "./fixtures/seeded-history.js";

/** @type {string[]} */
const roots = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

const HOUR = 3_600_000;
const origin = new Date("2026-10-01T00:00:00.000Z");
const now = new Date(origin.getTime() + 40 * HOUR);

/** Forty hours of prompts, with three empty hours among the newest 24 and a busy last one. */
async function fortyHours() {
  const seeded = await makeSeededSource({ origin, roots });
  /** @type {{at: Date, restricted?: boolean}[]} */
  const prompts = [];
  for (let hour = 0; hour < 40; hour += 1) {
    if ([22, 30, 31].includes(hour)) continue;
    const count = hour === 39 ? 9 : 1 + (hour % 4);
    for (let index = 0; index < count; index += 1) {
      prompts.push({
        at: new Date(origin.getTime() + hour * HOUR + (index + 1) * 60_000),
        restricted: hour === 12 && index === 0,
      });
    }
  }
  seeded.plant(prompts);
  return seeded;
}

test("the plot series is the dash's 24 windows, on the one scale the current window is ranked on", async () => {
  const seeded = await fortyHours();
  const input = {
    databaseFile: seeded.paths.databaseFile,
    source: seeded.source,
    planProfile: resolvePlanProfile(seeded.source).profile,
    horizon: "PT1H",
    now,
    includeTrend: true,
  };
  const { pressure, series } = readPressure({ ...input, includeSeries: true });

  assert.equal(series.length, PLOT_POLICY.windows);
  // Oldest first, hour h at index h - 16: the empty hours 22, 30 and 31.
  assert.deepEqual(
    series.flatMap((score, index) => (score === null ? [index] : [])),
    [6, 14, 15],
  );
  for (const score of series) {
    // A sum of weighted shares, so float error can carry it a hair past one; the view clamps.
    if (score !== null) assert.ok(score >= 0 && score <= 1 + 1e-9, String(score));
  }
  // The newest window is the current one, ranked against the same baseline: the same number.
  assert.equal(series.at(-1), /** @type {{score: number}} */ (pressure).score);
  // The series never reaches the pressure object `status --json` serializes.
  assert.deepEqual(readPressure(input), { pressure, series: [] });
  assert.ok(!("series" in pressure));
});

test("with too little history to rank against, every window of the plot is absent", async () => {
  const seeded = await makeSeededSource({ origin, roots });
  seeded.plant([{ at: new Date(now.getTime() - 60_000) }]);
  const { pressure, series } = readPressure({
    databaseFile: seeded.paths.databaseFile,
    source: seeded.source,
    planProfile: resolvePlanProfile(seeded.source).profile,
    horizon: "PT1H",
    now,
    includeSeries: true,
  });
  assert.equal(pressure.score, null);
  assert.deepEqual(
    series,
    Array.from({ length: PLOT_POLICY.windows }, () => null),
  );
});

test("building the reports without recording writes no prediction row", async () => {
  const seeded = await fortyHours();
  const config = await readConfig(seeded.paths.configFile);
  const sources = /** @type {never[]} */ (config.sources);
  const built = await buildSourceReports({
    databaseFile: seeded.paths.databaseFile,
    config,
    selected: sources,
    inScope: sources,
    now,
    synchronize: async () => ({ performed: false, status: "ok" }),
    includeSeries: true,
  });
  assert.equal(built.sources.length, 1);
  const [source] = built.sources;
  assert.equal(source?.attemptId, null);
  assert.equal(source?.capacityPeriodId, 1);
  assert.equal(source?.series.length, PLOT_POLICY.windows);
  assert.equal(source?.report.synchronization.status, "ok");
  const database = new Database(seeded.paths.databaseFile, { readonly: true });
  try {
    assert.deepEqual(database.prepare("SELECT COUNT(*) AS n FROM prediction_attempt").get(), {
      n: 0,
    });
  } finally {
    database.close();
  }
});
