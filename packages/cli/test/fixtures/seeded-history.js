import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import Database from "better-sqlite3";

import { resolvePaths } from "../../src/paths.js";
import { initializeDatabase } from "../../src/storage.js";

/**
 * A capacity source written straight into SNACK's tables, for the code that reads storage rather
 * than the code that fills it: `source-report.js` and the dash's recompute. Ingestion has its own
 * tests; here a history is whatever the test says it is, at the instants it names.
 *
 * Configured as an OpenCode source whose database does not exist, so `status --no-sync` reads it
 * and no synchronization can add anything a test did not plant.
 */

export const INSTALLATION = "11111111-2222-4333-8444-555555555555";

/**
 * @param {{origin: Date, roots: string[]}} options
 */
export async function makeSeededSource({ origin, roots }) {
  const root = await mkdtemp(join(tmpdir(), "snack-seeded-"));
  roots.push(root);
  const env = {
    XDG_CONFIG_HOME: join(root, "config"),
    XDG_DATA_HOME: join(root, "data"),
    XDG_CACHE_HOME: join(root, "cache"),
    XDG_STATE_HOME: join(root, "state"),
  };
  const paths = resolvePaths({ env, home: root });
  await initializeDatabase(paths, { applicationVersion: "1.6.0", now: origin });
  const source = {
    alias: "work",
    installation_id: INSTALLATION,
    adapter: "opencode",
    database: join(root, "opencode.db"),
    provider: "anthropic",
    profile: "default",
    plan: "pro",
    plan_profile: "generic",
    fingerprint: "oc-sqlite-msgpart-v1",
  };
  await mkdir(paths.configDir, { recursive: true, mode: 0o700 });
  await writeFile(
    paths.configFile,
    `${JSON.stringify({ schema_version: 1, sources: [source] })}\n`,
    { mode: 0o600 },
  );
  const database = new Database(paths.databaseFile);
  try {
    database.pragma("foreign_keys = ON");
    database
      .prepare("INSERT INTO capacity_source (alias, created_at) VALUES ('work', ?)")
      .run(origin.toISOString());
    database
      .prepare(
        `INSERT INTO capacity_period (id, source_alias, provider, profile, plan, started_at)
         VALUES (1, 'work', 'anthropic', 'default', 'pro', ?)`,
      )
      .run(origin.toISOString());
  } finally {
    database.close();
  }
  let next = 1;
  return {
    root,
    env,
    paths,
    source,
    /**
     * Plant prompts that started at the given instants, each with one usage slice.
     *
     * @param {{at: Date, restricted?: boolean, tokens?: number}[]} prompts
     */
    plant(prompts) {
      const db = new Database(paths.databaseFile);
      try {
        db.pragma("foreign_keys = ON");
        const insertPrompt = db.prepare(
          `INSERT INTO prompt_execution
             (id, source_alias, installation_id, capacity_period_id, source_prompt_id,
              source_session_fingerprint, source_revision, observation_hash, revision_domain,
              parser_version, started_at, completed_at, duration_ms, completion,
              first_observed_at, last_observed_at, estimated_input_tokens)
           VALUES (@id, 'work', NULL, 1, @prompt, 'session', '1', 'hash', 'opencode', 'p1',
                   @at, @at, 1000, 'completed', @at, @at, @tokens)`,
        );
        const insertOutcome = db.prepare(
          `INSERT INTO prompt_source_outcome (prompt_execution_id, outcome, policy_version)
           VALUES (?, ?, 'stage2-outcome-v1')`,
        );
        const insertSlice = db.prepare(
          `INSERT INTO prompt_usage_slice
             (prompt_execution_id, source_slice_id, provider, model, input_tokens, output_tokens,
              reasoning_tokens, cache_read_tokens, cache_write_tokens, cost_decimal, currency)
           VALUES (?, 'step-finish-1', 'anthropic', 'claude-sonnet', ?, 25, 5, 10, 2, '0.003', 'USD')`,
        );
        db.transaction(() => {
          for (const prompt of prompts) {
            const id = next;
            next += 1;
            const at = prompt.at.toISOString();
            const tokens = prompt.tokens ?? 100 + ((id * 37) % 900);
            insertPrompt.run({ id, prompt: `prompt-${id}`, at, tokens });
            insertOutcome.run(id, prompt.restricted === true ? "restricted" : "success");
            insertSlice.run(id, tokens);
          }
        })();
      } finally {
        db.close();
      }
    },
  };
}
