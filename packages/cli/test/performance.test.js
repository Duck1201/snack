import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, test } from "node:test";

import Database from "better-sqlite3";

import { assignPressureBands } from "../src/analytics.js";
import { backtest } from "../src/calibration.js";
import { resolvePaths } from "../src/paths.js";
import { buildForecast } from "../src/prediction.js";
import { categorizeHistory } from "../src/prompt-features.js";
import { initializeDatabase, readOutcomeRows, writeSizeCategories } from "../src/storage.js";

/** @type {string[]} */
const temporaryRoots = [];

afterEach(async () => {
  while (temporaryRoots.length > 0) {
    const root = temporaryRoots.pop();
    if (root !== undefined) await rm(root, { recursive: true, force: true });
  }
});

const PROMPTS = 100_000;
const origin = Date.parse("2026-01-01T00:00:00.000Z");
const now = new Date(origin + PROMPTS * 60_000);

/**
 * Build a database holding a six-figure history, written straight through SQLite because
 * the point of this test is the read and compute path, not ingestion.
 *
 * @returns {Promise<string>}
 */
async function makeLargeHistory() {
  const root = await mkdtemp(join(tmpdir(), "snack-performance-"));
  temporaryRoots.push(root);
  const paths = resolvePaths({
    env: { XDG_DATA_HOME: join(root, "data"), XDG_STATE_HOME: join(root, "state") },
    platform: "linux",
    home: root,
  });
  await initializeDatabase(paths, { applicationVersion: "0.5.0", now: new Date(origin) });

  const database = new Database(paths.databaseFile);
  try {
    database.pragma("foreign_keys = ON");
    database
      .prepare("INSERT INTO capacity_source (alias, created_at) VALUES ('work', ?)")
      .run(new Date(origin).toISOString());
    database
      .prepare(
        `INSERT INTO capacity_period (id, source_alias, provider, profile, plan, started_at)
         VALUES (1, 'work', 'anthropic', 'default', 'pro', ?)`,
      )
      .run(new Date(origin).toISOString());
    const insertPrompt = database.prepare(
      `INSERT INTO prompt_execution
         (id, source_alias, capacity_period_id, source_prompt_id, source_session_fingerprint,
          source_revision, observation_hash, revision_domain, parser_version, started_at,
          completed_at, duration_ms, completion, first_observed_at, last_observed_at,
          estimated_input_tokens)
       VALUES (@id, 'work', 1, @source_prompt_id, 'session', '1', 'hash', 'opencode', 'p1',
               @started_at, @started_at, 1000, 'completed', @started_at, @started_at, @tokens)`,
    );
    const insertOutcome = database.prepare(
      `INSERT INTO prompt_source_outcome (prompt_execution_id, outcome, policy_version)
       VALUES (?, ?, 'stage2-outcome-v1')`,
    );
    database.transaction(() => {
      for (let index = 1; index <= PROMPTS; index += 1) {
        const startedAt = new Date(origin + index * 60_000).toISOString();
        insertPrompt.run({
          id: index,
          source_prompt_id: `prompt-${index}`,
          started_at: startedAt,
          tokens: 100 + (index % 900),
        });
        insertOutcome.run(index, index % 97 === 0 ? "restricted" : "success");
      }
    })();
  } finally {
    database.close();
  }
  return paths.databaseFile;
}

/**
 * @template T
 * @param {() => T} work
 * @returns {{result: T, elapsedMs: number}}
 */
function timed(work) {
  const startedAt = process.hrtime.bigint();
  const result = work();
  return { result, elapsedMs: Number(process.hrtime.bigint() - startedAt) / 1e6 };
}

test(`forecasting a ${PROMPTS.toLocaleString("en-US")}-prompt history stays inside the status budget`, async () => {
  const databaseFile = await makeLargeHistory();

  const read = timed(() => readOutcomeRows(databaseFile, "work"));
  assert.equal(read.result.length, PROMPTS);

  const banded = timed(() =>
    assignPressureBands(read.result, {
      origin: new Date(origin).toISOString(),
      windowSeconds: 3600,
    }),
  );
  const forecast = timed(() =>
    buildForecast({
      now,
      prior: { strength: 1, viability: 0.5 },
      expectedBand: "moderate",
      expectedCategory: "typical",
      outcomes: banded.result,
      dataCompleteness: "complete",
    }),
  );

  const total = read.elapsedMs + banded.elapsedMs + forecast.elapsedMs;
  assert.ok(
    Number.isFinite(forecast.result.viability.lower) && forecast.result.viability.lower >= 0,
    JSON.stringify(forecast.result.viability),
  );
  // The published budget is a p95 of 250 ms for `status --no-sync`; this measures the read
  // and compute path that dominates it, leaving headroom for process start and output.
  assert.ok(
    total < 250,
    `read ${read.elapsedMs.toFixed(0)}ms + bands ${banded.elapsedMs.toFixed(0)}ms + forecast ${forecast.elapsedMs.toFixed(0)}ms = ${total.toFixed(0)}ms`,
  );
});

test(`recategorizing a ${PROMPTS.toLocaleString("en-US")}-prompt history stays inside the sync budget`, async () => {
  const databaseFile = await makeLargeHistory();
  const rows = readOutcomeRows(databaseFile, "work").map((row, index) => ({
    prompt_execution_id: row.prompt_execution_id,
    started_at: row.started_at,
    estimated_input_tokens: 100 + (index % 900),
  }));

  const categorized = timed(() => categorizeHistory(rows));
  const written = timed(() =>
    writeSizeCategories(
      databaseFile,
      categorized.result.map((row) => ({
        prompt_execution_id: row.prompt_execution_id,
        size_category: row.size_category,
        category_policy_version: row.category_policy_version,
        category_baseline_as_of: row.category_baseline_as_of,
      })),
    ),
  );

  assert.equal(written.result, PROMPTS);
  // Incremental synchronization has a p95 budget of 2 seconds; the whole-source
  // recategorization runs inside it on every sync.
  const total = categorized.elapsedMs + written.elapsedMs;
  assert.ok(
    total < 2000,
    `categorize ${categorized.elapsedMs.toFixed(0)}ms + write ${written.elapsedMs.toFixed(0)}ms = ${total.toFixed(0)}ms`,
  );
});

test(`backtesting a large history completes without quadratic blowup`, async () => {
  const databaseFile = await makeLargeHistory();
  const rows = readOutcomeRows(databaseFile, "work").slice(0, 5000);

  const replay = timed(() => backtest(rows, { now, prior: { strength: 1, viability: 0.5 } }));

  assert.equal(replay.result.forecasts, 5000 - 10);
  // Backtesting is an offline audit, not a command budget, but a rolling origin that
  // rescans the whole prefix each step would make even 5,000 prompts unusable.
  assert.ok(replay.elapsedMs < 10_000, `backtest took ${replay.elapsedMs.toFixed(0)}ms`);
});
