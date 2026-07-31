import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { afterEach, test } from "node:test";
import { promisify } from "node:util";

import Database from "better-sqlite3";

import { assignPressureBands } from "../src/analytics.js";
import { backtest } from "../src/calibration.js";
import { exportJsonChunks } from "../src/export.js";
import { resolvePaths } from "../src/paths.js";
import { PREDICTION_POLICY, buildForecast } from "../src/prediction.js";
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
 * @returns {Promise<{root: string, env: NodeJS.ProcessEnv, paths: import("../src/paths.js").SnackPaths, databaseFile: string}>}
 */
async function makeLargeHistory() {
  const root = await mkdtemp(join(tmpdir(), "snack-performance-"));
  temporaryRoots.push(root);
  const env = {
    XDG_CONFIG_HOME: join(root, "config"),
    XDG_DATA_HOME: join(root, "data"),
    XDG_CACHE_HOME: join(root, "cache"),
    XDG_STATE_HOME: join(root, "state"),
  };
  const paths = resolvePaths({ env, platform: "linux", home: root });
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
  return { root, env, paths, databaseFile: paths.databaseFile };
}

const executeFile = promisify(execFile);
const cliEntry = fileURLToPath(new URL("../src/cli.js", import.meta.url));

/** @param {Awaited<ReturnType<typeof makeLargeHistory>>} history */
async function writeStatusConfig(history) {
  await mkdir(history.paths.configDir, { recursive: true, mode: 0o700 });
  await writeFile(
    history.paths.configFile,
    `${JSON.stringify({
      schema_version: 1,
      sources: [
        {
          alias: "work",
          installation_id: "11111111-2222-4333-8444-555555555555",
          adapter: "opencode",
          database: join(history.root, "opencode.db"),
          provider: "anthropic",
          profile: "default",
          plan: "pro",
          plan_profile: "generic",
          fingerprint: "oc-sqlite-msgpart-v1",
        },
      ],
    })}\n`,
    { mode: 0o600 },
  );
}

/** @param {string[]} args @param {Awaited<ReturnType<typeof makeLargeHistory>>} history */
async function runCli(args, history) {
  return executeFile(process.execPath, [cliEntry, ...args], {
    env: { ...process.env, ...history.env, HOME: history.root },
  });
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
  const { databaseFile } = await makeLargeHistory();

  const read = timed(() =>
    readOutcomeRows(databaseFile, "work", { limit: PREDICTION_POLICY.evidence_window_prompts }),
  );
  assert.equal(read.result.length, PREDICTION_POLICY.evidence_window_prompts);

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
  const { databaseFile } = await makeLargeHistory();
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

test(`\`status --no-sync\` over ${PROMPTS.toLocaleString("en-US")} prompts stays inside its p95 budget`, async () => {
  const history = await makeLargeHistory();
  await writeStatusConfig(history);

  // Spawning the real binary is the only honest measure of this budget: it is what the user
  // waits for. Calling `run()` repeatedly in one process amortizes module loading away, which
  // hides roughly 100 ms of startup and would pass a budget the installed command misses.
  const samples = [];
  for (let index = 0; index < 20; index += 1) {
    const startedAt = process.hrtime.bigint();
    await runCli(["status", "--no-sync", "--json"], history);
    samples.push(Number(process.hrtime.bigint() - startedAt) / 1e6);
  }
  samples.sort((a, b) => a - b);
  const p95 = samples[Math.ceil(samples.length * 0.95) - 1] ?? Infinity;

  assert.ok(
    p95 < 250,
    `p95 ${p95.toFixed(0)}ms, p50 ${(samples[10] ?? 0).toFixed(0)}ms, min ${(samples[0] ?? 0).toFixed(0)}ms`,
  );
});

test(`backtesting the whole ${PROMPTS.toLocaleString("en-US")}-prompt history completes`, async () => {
  const { databaseFile } = await makeLargeHistory();
  const rows = readOutcomeRows(databaseFile, "work");
  assert.equal(rows.length, PROMPTS);

  const replay = timed(() => backtest(rows, { now, prior: { strength: 1, viability: 0.5 } }));

  assert.equal(replay.result.forecasts, PROMPTS - 10);
  assert.equal(replay.result.calibration.brier.sample_size, PROMPTS - 10);
  assert.ok(
    (replay.result.calibration.brier.value ?? 1) < 0.05,
    `brier ${replay.result.calibration.brier.value}`,
  );
  // Backtesting is an offline audit rather than a command on the interactive path, so the
  // budget is loose. What it must not be is quadratic: at 5,000 prompts the same replay
  // takes well under a second, and a rolling origin that rescanned the prefix at every
  // step would put a six-figure history out of reach entirely.
  assert.ok(replay.elapsedMs < 30_000, `backtest took ${replay.elapsedMs.toFixed(0)}ms`);
});

test(`exporting ${PROMPTS.toLocaleString("en-US")} prompts stays inside the memory budget`, async () => {
  const history = await makeLargeHistory();

  const before = process.memoryUsage().rss;
  let peak = before;
  let bytes = 0;
  let rows = 0;

  // Consuming the generator without joining the chunks is the point. Absolute resident memory
  // is a property of the whole process and carries whatever earlier tests left behind, so the
  // assertion is on growth instead: the export must cost less memory than the document it
  // produces, which is only possible if it never holds that document. Buffering the same
  // export measured about four times its own size.
  const chunks = exportJsonChunks(
    history.databaseFile,
    {},
    { command: "export", now, provenance: {} },
  );
  let step = chunks.next();
  while (step.done !== true) {
    bytes += step.value.length;
    if ((rows += 1) % 5_000 === 0) peak = Math.max(peak, process.memoryUsage().rss);
    step = chunks.next();
  }
  peak = Math.max(peak, process.memoryUsage().rss);

  assert.equal(step.value.prompts, PROMPTS);
  assert.ok(bytes > 10_000_000, `export produced only ${bytes} bytes`);
  assert.ok(
    peak - before < bytes,
    `export grew resident memory by ${((peak - before) / 1024 / 1024).toFixed(0)}MB while producing ${(bytes / 1024 / 1024).toFixed(0)}MB`,
  );
});
