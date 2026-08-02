import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";

import Ajv2020 from "ajv/dist/2020.js";
import fc from "fast-check";

import { readSpoolEvents } from "../src/spool.js";

/** @type {string[]} */
const temporaryRoots = [];
after(async () => {
  await Promise.all(
    temporaryRoots.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

const INSTALLATION = "installation-1";

/** One event the plugin would really write, used as the thing the generators degrade. */
const validEvent = {
  schema_version: 1,
  event_id: "event-1",
  installation_id: INSTALLATION,
  event_type: "prompt_started",
  source_prompt_id: "prompt-1",
  source_session_id: "session-1",
  revision: "revision-1",
  revision_domain: "opencode-plugin-v1",
  parser_version: "opencode-plugin-v1",
  occurred_at: "2026-01-02T03:04:05.000Z",
  provider: "anthropic",
  model: "claude-sonnet",
  completion: "provisional",
  outcome: "excluded",
  usage_slices: [],
  restrictions: [],
};

/**
 * The ways a spool segment goes wrong in the field.
 *
 * The spool is the boundary between two packages that version independently, so its failures are
 * not only corruption: a plugin one release ahead writes an event this reader has never seen, and a
 * plugin one release behind writes one it no longer expects.
 */
const line = fc.oneof(
  fc.constant({ kind: "valid" }),
  fc.record({
    kind: fc.constant("drop-field"),
    field: fc.constantFrom(...Object.keys(validEvent)),
  }),
  fc.record({
    kind: fc.constant("wrong-type"),
    field: fc.constantFrom(...Object.keys(validEvent)),
  }),
  fc.record({
    kind: fc.constant("null-field"),
    field: fc.constantFrom(...Object.keys(validEvent)),
  }),
  fc.constant({ kind: "future-version" }),
  fc.constant({ kind: "extra-field" }),
  fc.constant({ kind: "unknown-event-type" }),
  fc.constant({ kind: "bad-occurred-at" }),
  fc.constant({ kind: "not-json" }),
  fc.constant({ kind: "json-array" }),
  fc.constant({ kind: "empty-object" }),
);

/** @param {{kind: string, field?: string}} spec @param {number} index */
function render(spec, index) {
  if (spec.kind === "not-json") return "{not json at all";
  if (spec.kind === "json-array") return "[1, 2, 3]";
  if (spec.kind === "empty-object") return "{}";
  const event = /** @type {Record<string, unknown>} */ (
    JSON.parse(JSON.stringify({ ...validEvent, event_id: `event-${index}` }))
  );
  if (spec.kind === "drop-field" && spec.field) delete event[spec.field];
  else if (spec.kind === "wrong-type" && spec.field) event[spec.field] = 42;
  else if (spec.kind === "null-field" && spec.field) event[spec.field] = null;
  else if (spec.kind === "future-version") event.schema_version = 2;
  else if (spec.kind === "extra-field") event.a_field_from_a_later_plugin = "value";
  else if (spec.kind === "unknown-event-type") event.event_type = "session_renamed";
  else if (spec.kind === "bad-occurred-at") event.occurred_at = "yesterday";
  return JSON.stringify(event);
}

test("no spool segment, however broken, is read as more or fewer events than it holds", async () => {
  // The spool is written by a package that versions independently of this one, so its reader has to
  // survive an event from a plugin one release ahead as calmly as a segment cut mid-write. Two
  // things must hold whatever arrives: nothing throws, and the arithmetic closes -- every line is
  // either an observation or a rejection, never dropped in silence. A quietly discarded line is a
  // prompt that happened and was never counted, which biases the forecast without saying so.
  let observedAny = 0;
  await fc.assert(
    fc.asyncProperty(
      fc.array(line, { minLength: 1, maxLength: 8 }),
      fc.boolean(),
      async (lines, truncateTail) => {
        const root = await mkdtemp(join(tmpdir(), "snack-spool-property-"));
        temporaryRoots.push(root);
        const directory = join(root, "spool");
        await mkdir(directory, { recursive: true, mode: 0o700 });
        const rendered = lines.map((spec, index) => render(spec, index));
        // A segment the plugin is still writing ends mid-line. The reader must not commit past it.
        const text = truncateTail
          ? `${rendered.slice(0, -1).join("\n")}\n${String(rendered.at(-1)).slice(0, 12)}`
          : `${rendered.join("\n")}\n`;
        await writeFile(join(directory, "segment-1.ndjson"), text, { mode: 0o600 });

        const batch = await readSpoolEvents({
          spoolDirectory: directory,
          installationId: INSTALLATION,
          cursors: new Map(),
        });
        observedAny += batch.observations.length;

        // Every complete line is accounted for. The truncated tail is reported separately, as a
        // rejection carrying the byte offset rather than the line number, so it is excluded here.
        const completeLines = truncateTail ? rendered.length - 1 : rendered.length;
        const lineRejections = batch.rejected.length - (truncateTail ? 1 : 0);
        assert.equal(batch.read, completeLines);
        assert.equal(
          batch.observations.length + lineRejections,
          completeLines,
          `${batch.observations.length} observations + ${lineRejections} rejections != ${completeLines} lines`,
        );

        for (const observation of batch.observations) {
          assert.ok(
            Number.isFinite(Date.parse(String(observation.started_at))),
            `unparseable started_at: ${observation.started_at}`,
          );
          assert.equal(typeof observation.source_prompt_id, "string");
          assert.notEqual(observation.source_prompt_id, "");
        }
      },
    ),
    { numRuns: 150 },
  );

  // Without this the property could pass by rejecting everything, and a validator that grew
  // stricter would turn a real test into a green one that reads nothing.
  assert.ok(observedAny > 0, "every generated segment was rejected; the read path went untested");
});

test("every event the published schema accepts is an event this reader reads", async () => {
  // The reader now validates the shipped schema directly, so this holds by construction on one
  // side. What it still pins is the wiring: the reader compiles the file both packages publish, in
  // the same strict mode, with a `date-time` format that accepts what the contract says it does. A
  // reader stricter than the contract drops events a conforming plugin was entitled to write, and
  // drops them as rejections -- so the count looks like corruption rather than like disagreement.
  const schema = JSON.parse(
    await readFile(new URL("../schemas/spool-event.schema.json", import.meta.url), "utf8"),
  );
  // `date-time` is declared as a pattern rather than pulled in from `ajv-formats`: the product's
  // Ajv runs in strict mode with no format package, and a schema it could not compile is not a
  // contract it can hold anyone to.
  const ajv = new Ajv2020.default({
    allErrors: true,
    strict: true,
    formats: { "date-time": /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/u },
  });
  const conforms = ajv.compile(schema);
  let accepted = 0;

  await fc.assert(
    fc.asyncProperty(fc.array(line, { minLength: 1, maxLength: 4 }), async (lines) => {
      const rendered = lines.map((spec, index) => render(spec, index));
      const conforming = rendered.filter((text) => {
        try {
          return conforms(JSON.parse(text));
        } catch {
          return false;
        }
      });
      if (conforming.length === 0) return;
      accepted += conforming.length;

      const root = await mkdtemp(join(tmpdir(), "snack-spool-contract-"));
      temporaryRoots.push(root);
      const directory = join(root, "spool");
      await mkdir(directory, { recursive: true, mode: 0o700 });
      await writeFile(join(directory, "segment-1.ndjson"), `${conforming.join("\n")}\n`, {
        mode: 0o600,
      });

      const batch = await readSpoolEvents({
        spoolDirectory: directory,
        installationId: INSTALLATION,
        cursors: new Map(),
      });

      assert.deepEqual(
        batch.rejected,
        [],
        `the reader refused an event the published schema accepts: ${JSON.stringify(batch.rejected)}`,
      );
      assert.equal(batch.observations.length, conforming.length);
    }),
    { numRuns: 150 },
  );

  assert.ok(accepted > 0, "no generated event conformed; the contract went unchecked");
});
