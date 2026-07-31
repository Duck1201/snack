import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, test } from "node:test";

import Database from "better-sqlite3";

import { resolvePaths } from "../src/paths.js";
import {
  initializeDatabase,
  readCategorizationRows,
  readOutcomeRows,
  writeSizeCategories,
} from "../src/storage.js";

/** @type {string[]} */
const temporaryRoots = [];

afterEach(async () => {
  while (temporaryRoots.length > 0) {
    const root = temporaryRoots.pop();
    if (root !== undefined) {
      await rm(root, { recursive: true, force: true });
    }
  }
});

/**
 * A migrated database with one source, an active period, and a closed earlier period.
 *
 * @returns {Promise<{databaseFile: string, seed: (rows: SeedOutcome[]) => void}>}
 */
async function makeDatabase() {
  const root = await mkdtemp(join(tmpdir(), "snack-prediction-storage-"));
  temporaryRoots.push(root);
  const paths = resolvePaths({
    env: { XDG_DATA_HOME: join(root, "data"), XDG_STATE_HOME: join(root, "state") },
    platform: "linux",
    home: root,
  });
  await initializeDatabase(paths, {
    applicationVersion: "0.5.0",
    now: new Date("2026-01-01T00:00:00.000Z"),
  });

  const database = new Database(paths.databaseFile);
  database.pragma("foreign_keys = ON");
  database
    .prepare("INSERT INTO capacity_source (alias, created_at) VALUES ('work', ?)")
    .run("2026-01-01T00:00:00.000Z");
  database
    .prepare(
      `INSERT INTO capacity_period (id, source_alias, provider, profile, plan, started_at, ended_at)
       VALUES (1, 'work', 'anthropic', 'default', 'free', '2026-01-01T00:00:00.000Z',
               '2026-01-05T00:00:00.000Z')`,
    )
    .run();
  database
    .prepare(
      `INSERT INTO capacity_period (id, source_alias, provider, profile, plan, started_at)
       VALUES (2, 'work', 'anthropic', 'default', 'pro', '2026-01-05T00:00:00.000Z')`,
    )
    .run();
  database.close();

  return {
    databaseFile: paths.databaseFile,
    seed(rows) {
      const connection = new Database(paths.databaseFile);
      connection.pragma("foreign_keys = ON");
      const insertPrompt = connection.prepare(
        `INSERT INTO prompt_execution
           (id, source_alias, capacity_period_id, source_prompt_id, source_session_fingerprint,
            source_revision, observation_hash, revision_domain, parser_version, started_at,
            completed_at, duration_ms, completion, first_observed_at, last_observed_at,
            estimated_input_tokens)
         VALUES (@id, 'work', @period, @source_prompt_id, 'session', '1', 'hash', 'opencode',
                 'p1', @started_at, @started_at, NULL, 'completed', @started_at, @started_at,
                 @estimated_input_tokens)`,
      );
      const insertOutcome = connection.prepare(
        `INSERT INTO prompt_source_outcome (prompt_execution_id, outcome, policy_version)
         VALUES (?, ?, 'stage2-outcome-v1')`,
      );
      connection.transaction(() => {
        for (const row of rows) {
          insertPrompt.run({
            id: row.id,
            period: row.period ?? 2,
            source_prompt_id: `prompt-${row.id}`,
            started_at: row.started_at,
            estimated_input_tokens: row.estimated_input_tokens ?? null,
          });
          insertOutcome.run(row.id, row.outcome ?? "success");
        }
      })();
      connection.close();
    },
  };
}

/**
 * @typedef {object} SeedOutcome
 * @property {number} id
 * @property {string} started_at
 * @property {number} [period]
 * @property {number | null} [estimated_input_tokens]
 * @property {"success" | "restricted" | "excluded"} [outcome]
 */

test("readOutcomeRows returns the active period in chronological order", async () => {
  const { databaseFile, seed } = await makeDatabase();
  seed([
    { id: 1, period: 1, started_at: "2026-01-02T00:00:00.000Z" },
    { id: 2, started_at: "2026-01-07T00:00:00.000Z", outcome: "restricted" },
    { id: 3, started_at: "2026-01-06T00:00:00.000Z" },
    { id: 4, started_at: "2026-01-08T00:00:00.000Z", outcome: "excluded" },
  ]);

  const rows = readOutcomeRows(databaseFile, "work");

  // The closed period is another provider/plan combination and never trains the active one.
  assert.deepEqual(
    rows.map((row) => [row.started_at, row.outcome]),
    [
      ["2026-01-06T00:00:00.000Z", "success"],
      ["2026-01-07T00:00:00.000Z", "restricted"],
      ["2026-01-08T00:00:00.000Z", "excluded"],
    ],
  );
  assert.deepEqual(
    rows.map((row) => row.capacity_period_id),
    [2, 2, 2],
  );
});

test("readOutcomeRows reports an empty history rather than failing", async () => {
  const { databaseFile } = await makeDatabase();

  assert.deepEqual(readOutcomeRows(databaseFile, "work"), []);
  assert.deepEqual(readOutcomeRows(databaseFile, "absent"), []);
});

test("size categories round-trip through storage and reach the forecast rows", async () => {
  const { databaseFile, seed } = await makeDatabase();
  seed([
    { id: 1, started_at: "2026-01-06T00:00:00.000Z" },
    { id: 2, started_at: "2026-01-07T00:00:00.000Z" },
  ]);

  // Ingestion writes the allowlisted input features; categorization is a derived
  // projection the CLI writes back after computing it with only prior observations.
  writeSizeCategories(databaseFile, [
    {
      prompt_execution_id: 1,
      size_category: "small",
      category_policy_version: "stage5-category-v1",
      category_baseline_as_of: null,
    },
    {
      prompt_execution_id: 2,
      size_category: "large",
      category_policy_version: "stage5-category-v1",
      category_baseline_as_of: "2026-01-06T00:00:00.000Z",
    },
  ]);

  assert.deepEqual(
    readOutcomeRows(databaseFile, "work").map((row) => [row.started_at, row.size_category]),
    [
      ["2026-01-06T00:00:00.000Z", "small"],
      ["2026-01-07T00:00:00.000Z", "large"],
    ],
  );
});

test("an uncategorized prompt reports an unknown category rather than a guess", async () => {
  const { databaseFile, seed } = await makeDatabase();
  seed([{ id: 1, started_at: "2026-01-06T00:00:00.000Z" }]);

  assert.equal(readOutcomeRows(databaseFile, "work")[0]?.size_category, null);
});

test("readCategorizationRows exposes the input features and the prompts after a cutoff", async () => {
  const { databaseFile, seed } = await makeDatabase();
  seed([
    { id: 1, started_at: "2026-01-06T00:00:00.000Z", estimated_input_tokens: 100 },
    { id: 2, started_at: "2026-01-07T00:00:00.000Z", estimated_input_tokens: null },
    { id: 3, started_at: "2026-01-08T00:00:00.000Z", estimated_input_tokens: 900 },
  ]);

  assert.deepEqual(
    readCategorizationRows(databaseFile, "work").map((row) => [
      row.prompt_execution_id,
      row.estimated_input_tokens,
    ]),
    [
      [1, 100],
      [2, null],
      [3, 900],
    ],
  );
});
