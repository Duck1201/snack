import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";

import fc from "fast-check";

import { createClaudeAdapter } from "../src/claude-adapter.js";
import { SnackError } from "../src/errors.js";

/** @type {string[]} */
const temporaryRoots = [];
after(async () => {
  await Promise.all(
    temporaryRoots.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

/**
 * A real record from the supported fixture, used as the thing the generators degrade.
 *
 * Generating a Claude record from nothing would only ever produce shapes nobody has seen, and the
 * adapter would refuse them all for the wrong reason. Starting from a record Claude Code actually
 * wrote and breaking it one way at a time is the shape of the drift that really happens: a client
 * release renames a field, changes a type, or starts writing a record type SNACK has not met.
 */
const baseRecords = (
  await readFile(new URL("./fixtures/claude/version-2-1-220.jsonl", import.meta.url), "utf8")
)
  .split("\n")
  .filter((line) => line.trim() !== "")
  .map((line) => JSON.parse(line));

/** A string that could only have come from the generated input, never from the adapter. */
const CANARY = "PRIVATE_FUZZ_CANARY";

/** Every field name any generated record carries, so a mutation can target one that exists. */
const fieldNames = [...new Set(baseRecords.flatMap((record) => Object.keys(record)))];

/** @typedef {{kind: string, field: string, index: number}} Mutation */

/** The ways a client release actually breaks a reader, one per generated mutation. */
const mutation = fc.record({
  kind: fc.constantFrom(
    "drop-field",
    "wrong-type",
    "null-field",
    "unknown-type",
    "orphan-parent",
    "self-parent",
    "canary-field",
    "empty-object",
  ),
  field: fc.constantFrom(...fieldNames),
  index: fc.nat({ max: baseRecords.length - 1 }),
});

/**
 * @param {Mutation[]} mutations
 * @returns {unknown[]}
 */
function mutate(mutations) {
  // Round-tripped rather than `structuredClone`, which the lint configuration does not know as a
  // global. These records came from JSON a moment ago, so nothing survives the trip that matters.
  const records = baseRecords.map((record) => JSON.parse(JSON.stringify(record)));
  for (const { kind, field, index } of mutations) {
    const record = /** @type {Record<string, unknown>} */ (records[index]);
    if (!record) continue;
    if (kind === "drop-field") delete record[field];
    else if (kind === "wrong-type") record[field] = 42;
    else if (kind === "null-field") record[field] = null;
    else if (kind === "unknown-type") record.type = "a-record-type-from-a-later-release";
    else if (kind === "orphan-parent") record.parentUuid = "00000000-0000-4000-8000-00000000dead";
    else if (kind === "self-parent") record.parentUuid = record.uuid;
    else if (kind === "canary-field") record[field] = CANARY;
    else if (kind === "empty-object") records[index] = {};
  }
  return records;
}

/**
 * Write generated records as a Claude projects directory and read them back through the adapter.
 *
 * @param {unknown[]} records
 * @param {boolean} truncateLastLine
 */
async function readGenerated(records, truncateLastLine) {
  const root = await mkdtemp(join(tmpdir(), "snack-claude-property-"));
  temporaryRoots.push(root);
  const projects = join(root, "projects");
  await mkdir(join(projects, "-fixture-project"), { recursive: true, mode: 0o700 });
  let text = records.map((record) => JSON.stringify(record)).join("\n");
  // A file the client is still writing ends mid-line. It is the one malformed input that arrives
  // by timing rather than by drift, so it is generated rather than left to chance.
  text = truncateLastLine ? text.slice(0, Math.max(0, text.length - 7)) : `${text}\n`;
  await writeFile(
    join(projects, "-fixture-project", "aaaaaaaa-0000-4000-8000-000000000001.jsonl"),
    text,
    { mode: 0o600 },
  );
  return createClaudeAdapter({ projectsDirectory: projects }).readAll();
}

test("no Claude history, however broken, makes the adapter throw or invent an observation", async () => {
  // The invariant CLAUDE.md calls fail closed on data, stated once: a parser either produces
  // observations it can stand behind or refuses. Anything else -- a crash, or a plausible-looking
  // observation assembled from a record it did not understand -- is worse than reading nothing,
  // because an under-counted history biases the forecast without saying so.
  let readThrough = 0;
  await fc.assert(
    fc.asyncProperty(
      fc.array(mutation, { maxLength: 6 }),
      fc.boolean(),
      async (mutations, truncated) => {
        let result;
        try {
          result = await readGenerated(mutate(mutations), truncated);
        } catch (error) {
          // The one refusal a reader is allowed: this is not a history it recognizes. Every other
          // failure is the adapter falling over rather than deciding.
          assert.ok(error instanceof SnackError, `${error}`);
          assert.equal(error.reason, "source_schema_unsupported");
          return;
        }
        readThrough += 1;

        for (const observation of result.observations) {
          assert.equal(typeof observation.source_prompt_id, "string");
          assert.notEqual(observation.source_prompt_id, "");
          // The times are the fields worth pinning here: they are stored verbatim, and every
          // window, freshness and horizon is computed over them. A value that is not a time makes
          // all of that arithmetic over a string, and `sync` reports it inserted.
          assert.ok(
            Number.isFinite(Date.parse(String(observation.started_at))),
            `unparseable started_at: ${observation.started_at}`,
          );
          assert.ok(
            observation.completed_at === null ||
              Number.isFinite(Date.parse(String(observation.completed_at))),
            `unparseable completed_at: ${observation.completed_at}`,
          );
        }
        // Deliberately not asserted here: that no generated value reaches the observation. Source
        // identifiers leave the adapter raw by design and are hashed on the way into storage, so
        // this seam is the wrong place to ask. `privacy.test.js` asks it of the bytes on disk,
        // which is where the answer actually matters.
      },
    ),
    { numRuns: 200 },
  );

  // Without this the property could pass by refusing everything, and a reader that grew stricter
  // would turn a real test into a green one that reads nothing.
  assert.ok(readThrough > 0, "every generated history was refused; the read path went untested");
});
