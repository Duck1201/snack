import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import Database from "better-sqlite3";
import fc from "fast-check";

import { initializeDatabase, storeObservations } from "../src/storage.js";

test("hybrid reconciliation converges under duplicate path orderings", async () => {
  await fc.assert(
    fc.asyncProperty(
      fc.record({
        spoolFirst: fc.boolean(),
        backfillDuplicates: fc.integer({ min: 1, max: 3 }),
        spoolDuplicates: fc.integer({ min: 1, max: 3 }),
      }),
      async ({ spoolFirst, backfillDuplicates, spoolDuplicates }) => {
        const root = await mkdtemp(join(tmpdir(), "snack-hybrid-property-"));
        const paths = {
          dataDir: join(root, "data"),
          stateDir: join(root, "state"),
          databaseFile: join(root, "data", "snack.sqlite3"),
          backupDir: join(root, "data", "backups"),
        };
        try {
          await initializeDatabase(paths, { now: new Date("2026-01-02T03:05:00.000Z") });
          const source = {
            alias: "personal",
            installation_id: "installation-1",
            adapter: "opencode",
            provider: "anthropic",
            profile: "personal",
            plan: "generic",
            fingerprint: "oc-sqlite-msgpart-v1",
          };
          const backfill = {
            source_prompt_id: "prompt-1",
            source_session_id: "session-1",
            revision: "1767323050000:assistant-1",
            revision_domain: "opencode-message-v1",
            parser_version: "opencode-adapter-v1",
            started_at: "2026-01-02T03:04:05.000Z",
            completed_at: "2026-01-02T03:04:10.000Z",
            duration_ms: 5000,
            completion: "completed",
            provider: "anthropic",
            model: "claude-sonnet",
            outcome: "success",
            usage_slices: [
              {
                source_slice_id: "assistant-1",
                provider: "anthropic",
                model: "claude-sonnet",
                input_tokens: 100,
                output_tokens: 25,
                reasoning_tokens: 5,
                cache_read_tokens: 10,
                cache_write_tokens: 2,
                cost_decimal: "0.003",
                currency: "USD",
              },
            ],
            restrictions: [],
          };
          const spool = {
            source_prompt_id: "prompt-1",
            source_session_id: "session-1",
            revision: "2026-01-02T03:04:10.000Z:session.error",
            revision_domain: "opencode-plugin-v1",
            parser_version: "opencode-plugin-v1",
            started_at: "2026-01-02T03:04:10.000Z",
            completed_at: "2026-01-02T03:04:10.000Z",
            duration_ms: null,
            completion: "completed",
            provider: "anthropic",
            model: "claude-sonnet",
            outcome: "restricted",
            usage_slices: [],
            restrictions: [
              {
                class: "rate_limit",
                source_code: "http_429",
                observed_at: "2026-01-02T03:04:10.000Z",
                classifier_version: "opencode-plugin-error-v1",
                provenance: "spool",
              },
            ],
          };
          const pathsInOrder = spoolFirst
            ? [
                ...Array(spoolDuplicates).fill([spool, "spool"]),
                ...Array(backfillDuplicates).fill([backfill, "backfill"]),
              ]
            : [
                ...Array(backfillDuplicates).fill([backfill, "backfill"]),
                ...Array(spoolDuplicates).fill([spool, "spool"]),
              ];
          for (const [observation, path] of pathsInOrder) {
            storeObservations(
              paths.databaseFile,
              source,
              { observations: [observation], cursor: null },
              new Date("2026-01-02T03:05:00.000Z"),
              {
                mappedProviders: new Set(["anthropic"]),
                providerMappingCounts: new Map([["anthropic", 1]]),
                path,
              },
            );
          }

          const database = new Database(paths.databaseFile, { readonly: true });
          try {
            const canonical = database
              .prepare(
                `SELECT prompt_execution.started_at, prompt_execution.completed_at,
                        prompt_execution.duration_ms, prompt_execution.completion,
                        prompt_source_outcome.outcome,
                        (SELECT COUNT(*) FROM prompt_usage_slice) AS usage_slices,
                        (SELECT COUNT(*) FROM restriction_observation) AS restrictions
                   FROM prompt_execution
                   JOIN prompt_source_outcome
                     ON prompt_source_outcome.prompt_execution_id = prompt_execution.id`,
              )
              .get();
            assert.deepEqual(canonical, {
              started_at: "2026-01-02T03:04:05.000Z",
              completed_at: "2026-01-02T03:04:10.000Z",
              duration_ms: 5000,
              completion: "completed",
              outcome: "restricted",
              usage_slices: 1,
              restrictions: 1,
            });
          } finally {
            database.close();
          }
        } finally {
          await rm(root, { recursive: true, force: true });
        }
      },
    ),
    { numRuns: 20 },
  );
});
