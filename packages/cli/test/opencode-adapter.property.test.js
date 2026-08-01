import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";

import Database from "better-sqlite3";
import fc from "fast-check";

import { SnackError } from "../src/errors.js";
import { createSourceAdapter } from "../src/source-adapter.js";

/** @type {string[]} */
const temporaryRoots = [];
after(async () => {
  await Promise.all(
    temporaryRoots.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

/**
 * OpenCode's own DDL and a real conversation, degraded one mutation at a time.
 *
 * The interesting surface here is not the SQL schema -- the fingerprint already refuses a shape it
 * does not know -- but the JSON blobs inside `message.data` and `part.data`. Those are opaque to
 * SQLite, so nothing between OpenCode and the adapter checks them, and a client release changes
 * them without changing a single column.
 */
const fixtureSql = await readFile(
  new URL("./fixtures/opencode/supported-v1.sql", import.meta.url),
  "utf8",
);

/** A string that could only have come from the generated input. */
const CANARY = "PRIVATE_FUZZ_CANARY";

/** The ways a client release actually breaks a reader of these blobs. */
const mutation = fc.record({
  table: fc.constantFrom("message", "part"),
  kind: fc.constantFrom(
    "not-json",
    "empty-json",
    "json-array",
    "drop-time",
    "time-as-string",
    "time-as-canary",
    "null-time-column",
    "time-column-canary",
    "role-unknown",
    "tokens-as-string",
  ),
});

/** @typedef {{table: string, kind: string}} Mutation */

/**
 * Build a fixture database and apply the generated mutations to it.
 *
 * @param {Mutation[]} mutations
 */
async function readGenerated(mutations) {
  const root = await mkdtemp(join(tmpdir(), "snack-opencode-property-"));
  temporaryRoots.push(root);
  const databaseFile = join(root, "opencode.db");
  const database = new Database(databaseFile);
  try {
    database.exec(fixtureSql);
    for (const { table, kind } of mutations) {
      const statement = {
        "not-json": `UPDATE ${table} SET data = 'not json at all'`,
        "empty-json": `UPDATE ${table} SET data = '{}'`,
        "json-array": `UPDATE ${table} SET data = '[1, 2, 3]'`,
        "drop-time": `UPDATE ${table} SET data = json_remove(data, '$.time')`,
        "time-as-string": `UPDATE ${table} SET data = json_set(data, '$.time.created', 'yesterday')`,
        "time-as-canary": `UPDATE ${table} SET data = json_set(data, '$.time.created', '${CANARY}')`,
        "null-time-column": `UPDATE ${table} SET time_created = NULL`,
        "time-column-canary": `UPDATE ${table} SET time_created = '${CANARY}'`,
        "role-unknown": `UPDATE ${table} SET data = json_set(data, '$.role', 'a-role-from-a-later-release')`,
        "tokens-as-string": `UPDATE ${table} SET data = json_set(data, '$.tokens.input', 'many')`,
      }[kind];
      // A column the fixture's DDL does not have, or a value SQLite refuses for it, is the
      // generator asking for something this database cannot express. Skipping keeps the run about
      // inputs OpenCode could really produce.
      try {
        if (statement) database.exec(statement);
      } catch {
        continue;
      }
    }
  } finally {
    database.close();
  }
  return createSourceAdapter({ adapter: "opencode", database: databaseFile }).readAll();
}

test("no OpenCode database, however broken, makes the adapter throw or invent an observation", async () => {
  // Same invariant as the Claude property, asked of the other client: a parser either produces
  // observations it can stand behind or refuses. The blobs are where this one can go wrong, because
  // SQLite validates the column and nothing validates what is inside it.
  //
  // This adapter answers most of these by refusing: its fingerprint queries assert
  // `json_type(data, '$.time.created') = 'integer'`, so a blob whose time is missing or is not a
  // number never reaches the read at all. That is the check the Claude adapter did not have.
  let readThrough = 0;
  await fc.assert(
    // A hundred rather than two hundred: each case builds a SQLite database on disk, and the
    // mutation space is small enough that the second hundred only repeats the first.
    fc.asyncProperty(fc.array(mutation, { maxLength: 4 }), async (mutations) => {
      let result;
      try {
        result = await readGenerated(mutations);
      } catch (error) {
        // The one refusal a reader is allowed: this is not a database it recognizes.
        assert.ok(error instanceof SnackError, `${error}`);
        assert.equal(error.reason, "source_schema_unsupported");
        return;
      }
      readThrough += 1;

      for (const observation of result.observations) {
        assert.equal(typeof observation.source_prompt_id, "string");
        assert.notEqual(observation.source_prompt_id, "");
        assert.ok(
          Number.isFinite(Date.parse(String(observation.started_at))),
          `unparseable started_at: ${observation.started_at}`,
        );
        assert.ok(
          observation.completed_at === null ||
            Number.isFinite(Date.parse(String(observation.completed_at))),
          `unparseable completed_at: ${observation.completed_at}`,
        );
        // Token counts feed the pressure dimensions directly. A string that survived into one would
        // be summed as a string, which is how a plausible-looking wrong number gets published.
        for (const slice of observation.usage_slices ?? []) {
          for (const [field, value] of Object.entries(slice)) {
            if (!field.endsWith("_tokens")) continue;
            assert.ok(
              value === null || typeof value === "number",
              `${field} is ${typeof value}: ${JSON.stringify(value)}`,
            );
          }
        }
      }
    }),
    { numRuns: 100 },
  );

  // Without this the property could pass by refusing everything, and a fingerprint that grew
  // stricter would turn a real test into a green one that reads nothing. Roughly two in five
  // generated databases are read through today.
  assert.ok(readThrough > 0, "every generated database was refused; the read path went untested");
});
