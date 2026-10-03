import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";

import fc from "fast-check";

import { CODEX_FIELD_ALLOWLIST, createCodexAdapter } from "../src/codex-adapter.js";
import { SnackError } from "../src/errors.js";

/**
 * For any generated input, the reader either produces observations it can stand behind or refuses.
 * Anything else -- a crash, or a plausible-looking observation assembled from something it did not
 * understand -- is worse than reading nothing, because an under-counted or mis-timed history biases
 * the forecast without saying so.
 */

/** @type {string[]} */
const temporaryRoots = [];
after(async () => {
  await Promise.all(
    temporaryRoots.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

/** @param {string} name */
async function fixtureRecords(name) {
  return (await readFile(new URL(`./fixtures/codex/${name}`, import.meta.url), "utf8"))
    .split("\n")
    .filter((line) => line.trim() !== "")
    .map((line) => JSON.parse(line));
}

/** Real records, degraded one way at a time: the shape client-release drift actually takes. */
const usageRecordBase = await fixtureRecords("version-0-159-3.jsonl");
const tokenCountBase = await fixtureRecords("version-0-147-0.jsonl");
const subagentBase = await fixtureRecords("subagent-0-159-3.jsonl");

/**
 * Every allowlisted path, as a list of keys from the line's root. `{a,b}` paths are already
 * expanded in the constant, so the list is exactly the paths the reader may touch.
 */
const allowlistedPaths = [...new Set(Object.values(CODEX_FIELD_ALLOWLIST).flat())].map((path) =>
  path.split("."),
);

/**
 * Every slot the reader must never look at, by record kind. A value planted in one of these must
 * not reach anything the adapter returns.
 *
 * @type {[(record: Record<string, any>) => boolean, string[]][]}
 */
const neverRead = [
  [(r) => r.type === "session_meta", ["payload", "cwd"]],
  [(r) => r.type === "session_meta", ["payload", "git", "branch"]],
  [(r) => r.type === "session_meta", ["payload", "base_instructions", "text"]],
  [(r) => r.type === "session_meta", ["payload", "originator"]],
  [(r) => r.type === "session_meta", ["payload", "timestamp"]],
  [(r) => r.type === "turn_context", ["payload", "cwd"]],
  [(r) => r.type === "turn_context", ["payload", "current_date"]],
  [(r) => r.type === "response_item", ["payload", "content"]],
  [(r) => r.type === "response_item", ["payload", "arguments"]],
  [(r) => r.type === "response_item", ["payload", "output"]],
  [(r) => r.type === "world_state", ["payload", "cwd"]],
  [(r) => r.type === "retained_context", ["payload", "questions"]],
  [(r) => r.payload?.type === "task_complete", ["payload", "last_agent_message"]],
  [(r) => r.payload?.type === "item_completed", ["payload", "item"]],
  [(r) => r.payload?.type === "token_count", ["payload", "rate_limits", "credits", "balance"]],
  [(r) => r.payload?.type === "token_count", ["payload", "info", "model_context_window"]],
];

/** @param {Record<string, any>} record @param {string[]} path @param {unknown} value */
function setPath(record, path, value) {
  let target = record;
  for (const key of path.slice(0, -1)) {
    if (typeof target[key] !== "object" || target[key] === null) return false;
    target = target[key];
  }
  const last = /** @type {string} */ (path.at(-1));
  target[last] = value;
  return true;
}

/** @param {Record<string, any>} record @param {string[]} path */
function getPath(record, path) {
  /** @type {any} */
  let value = record;
  for (const key of path) {
    if (typeof value !== "object" || value === null) return undefined;
    value = value[key];
  }
  return value;
}

/**
 * @param {unknown[][]} files each a list of records
 * @param {{truncateAt?: number}} [options]
 */
async function readGenerated(files, options = {}) {
  const root = await mkdtemp(join(tmpdir(), "snack-codex-property-"));
  temporaryRoots.push(root);
  const day = join(root, "sessions", "2026", "01", "02");
  await mkdir(day, { recursive: true });
  for (const [index, records] of files.entries()) {
    let text = `${records.map((record) => JSON.stringify(record)).join("\n")}\n`;
    if (options.truncateAt !== undefined && index === 0) {
      text = text.slice(0, Math.min(text.length, options.truncateAt));
    }
    await writeFile(join(day, `rollout-2026-01-02T02-00-0${index}-generated.jsonl`), text);
  }
  return createCodexAdapter({ sessionsDirectory: join(root, "sessions") }).readAll();
}

/** @param {unknown} error */
function assertRefusal(error) {
  assert.ok(error instanceof SnackError, `${error}`);
  assert.equal(error.reason, "source_schema_unsupported");
}

/** @param {Awaited<ReturnType<typeof readGenerated>>} result */
function assertWellFormed(result) {
  for (const observation of result.observations) {
    assert.equal(typeof observation.source_prompt_id, "string");
    assert.notEqual(observation.source_prompt_id, "");
    assert.ok(Number.isFinite(Date.parse(observation.started_at)), observation.started_at);
    assert.ok(
      observation.completed_at === null || Number.isFinite(Date.parse(observation.completed_at)),
    );
    assert.match(observation.revision, /^\d+:[0-9a-f]{16}:\d+$/u);
    for (const slice of observation.usage_slices) {
      // A number stood in every one of these on the way in; a null here would be a field the
      // reader did not understand stored as "unknown".
      for (const value of [
        slice.input_tokens,
        slice.output_tokens,
        slice.reasoning_tokens,
        slice.cache_read_tokens,
      ]) {
        assert.ok(Number.isSafeInteger(value) && value >= 0, `token part ${value}`);
      }
      assert.ok(
        slice.cache_write_tokens === null ||
          (Number.isSafeInteger(slice.cache_write_tokens) && slice.cache_write_tokens >= 0),
      );
    }
  }
  for (const snapshot of result.reported_capacity) {
    assert.ok(snapshot.windows.length >= 1 && snapshot.windows.length <= 2);
    for (const window of snapshot.windows) {
      assert.ok(window.used_percent >= 0 && window.used_percent <= 100);
      assert.ok(Number.isSafeInteger(window.window_minutes) && window.window_minutes > 0);
    }
  }
}

const CANARY = "PRIVATE_CODEX_FUZZ_CANARY";

test("(1) arbitrary text in a never-read slot never leaves the adapter", async () => {
  let readThrough = 0;
  await fc.assert(
    fc.asyncProperty(
      fc.array(
        fc.record({
          slot: fc.nat({ max: neverRead.length - 1 }),
          index: fc.nat({ max: usageRecordBase.length - 1 }),
          suffix: fc.string({ maxLength: 12 }),
        }),
        { minLength: 1, maxLength: 8 },
      ),
      async (plants) => {
        const records = usageRecordBase.map((record) => JSON.parse(JSON.stringify(record)));
        for (const { slot, index, suffix } of plants) {
          const [applies, path] = /** @type {(typeof neverRead)[number]} */ (neverRead[slot]);
          const record = records[index];
          if (applies(record)) setPath(record, path, `${CANARY}${suffix}`);
        }
        const result = await readGenerated([records]);
        readThrough += 1;
        const text = JSON.stringify(result);
        assert.ok(!text.includes(CANARY), "a never-read slot reached the adapter's output");
      },
    ),
    { numRuns: 60 },
  );
  assert.ok(readThrough > 0, "every generated input was refused; the read path went untested");
});

test("(2) a changed JSON type in an allowlisted field refuses or rejects, never yields a null", async () => {
  let readThrough = 0;
  let refused = 0;
  const replacements = fc.constantFrom(null, "7", true, [], {}, -1, 1.5, 1e300);
  await fc.assert(
    fc.asyncProperty(
      fc.nat({ max: usageRecordBase.length + tokenCountBase.length - 1 }),
      fc.nat({ max: allowlistedPaths.length - 1 }),
      replacements,
      async (position, pathIndex, replacement) => {
        const tokenCount = position >= usageRecordBase.length;
        const base = tokenCount ? tokenCountBase : usageRecordBase;
        const records = base.map((record) => JSON.parse(JSON.stringify(record)));
        const index = tokenCount ? position - usageRecordBase.length : position;
        const record = records[index];
        const path = /** @type {string[]} */ (allowlistedPaths[pathIndex]);
        const before = getPath(record, path);
        // Only a field that is really on this record and holds a value can change type.
        if (before === undefined) return;
        if (!setPath(record, path, replacement)) return;
        let result;
        try {
          result = await readGenerated([records]);
        } catch (error) {
          assertRefusal(error);
          refused += 1;
          return;
        }
        readThrough += 1;
        assertWellFormed(result);
      },
    ),
    { numRuns: 300 },
  );
  assert.ok(readThrough > 0, "every generated input was refused; the read path went untested");
  assert.ok(refused > 0, "no type change was ever refused; the drift path went untested");
});

test("(3) normalized token parts are non-negative and sum to the source's input + output", async () => {
  const usage = fc
    .record({
      input: fc.nat({ max: 1_000_000 }),
      output: fc.nat({ max: 1_000_000 }),
      cachedShare: fc.double({ min: 0, max: 1, noNaN: true }),
      writeShare: fc.double({ min: 0, max: 1, noNaN: true }),
      reasoningShare: fc.double({ min: 0, max: 1, noNaN: true }),
      withWrite: fc.boolean(),
    })
    .map(({ input, output, cachedShare, writeShare, reasoningShare, withWrite }) => {
      const cached = Math.floor(input * cachedShare);
      const write = withWrite ? Math.floor((input - cached) * writeShare) : undefined;
      return {
        input_tokens: input,
        cached_input_tokens: cached,
        ...(write === undefined ? {} : { cache_write_input_tokens: write }),
        output_tokens: output,
        reasoning_output_tokens: Math.floor(output * reasoningShare),
        total_tokens: input + output,
      };
    });
  await fc.assert(
    fc.asyncProperty(fc.array(usage, { minLength: 1, maxLength: 4 }), async (usages) => {
      const records = usageRecordBase
        .filter((record) => record.type !== "token_usage_record")
        .map((record) => JSON.parse(JSON.stringify(record)));
      const end = records.findIndex((record) => record.payload?.type === "task_complete");
      const inserted = usages.map((value, index) => ({
        timestamp: "2026-01-02T02:00:30.000Z",
        type: "token_usage_record",
        payload: {
          turn_id: "00000000-0000-7000-8000-000000000111",
          root_turn_id: "00000000-0000-7000-8000-000000000110",
          response_id: `resp_generated_${index}`,
          usage: value,
        },
        ordinal: 0,
      }));
      records.splice(end, 0, ...inserted);
      records.forEach((record, ordinal) => {
        record.ordinal = ordinal;
      });
      const { observations } = await readGenerated([records]);
      const slices = observations.flatMap((observation) => observation.usage_slices);
      assert.equal(slices.length, usages.length);
      for (const [index, slice] of slices.entries()) {
        const source = /** @type {(typeof usages)[number]} */ (usages[index]);
        const parts = [
          slice.input_tokens,
          slice.cache_read_tokens,
          slice.cache_write_tokens ?? 0,
          slice.output_tokens,
          slice.reasoning_tokens,
        ];
        assert.ok(parts.every((part) => Number.isSafeInteger(part) && part >= 0));
        assert.equal(
          parts.reduce((sum, part) => sum + part, 0),
          source.input_tokens + source.output_tokens,
        );
      }
    }),
    { numRuns: 100 },
  );
});

test("(4) reading twice is identical, and appending lines never lowers a revision", async () => {
  await fc.assert(
    fc.asyncProperty(
      fc.nat({ max: usageRecordBase.length - 2 }),
      fc.boolean(),
      async (cut, tokenCount) => {
        const base = tokenCount ? tokenCountBase : usageRecordBase;
        const prefix = base.slice(0, Math.min(base.length - 1, cut + 2));
        const first = await readGenerated([prefix]);
        const again = await readGenerated([prefix]);
        assert.deepEqual(again.observations, first.observations);
        assert.deepEqual(again.reported_capacity, first.reported_capacity);

        const whole = await readGenerated([base]);
        for (const observation of first.observations) {
          const later = whole.observations.find(
            (candidate) => candidate.source_prompt_id === observation.source_prompt_id,
          );
          assert.ok(later, "a prompt disappeared when its rollout grew");
          const [beforeAt] = observation.revision.split(":");
          const [laterAt] = later.revision.split(":");
          assert.ok(Number(laterAt) >= Number(beforeAt), "a revision went backwards");
        }
      },
    ),
    { numRuns: 60 },
  );
});

test("(5) a fork replay never changes the total tokens of a family", async () => {
  /** @param {Awaited<ReturnType<typeof readGenerated>>} result */
  const total = (result) =>
    result.observations
      .flatMap((observation) => observation.usage_slices)
      .reduce(
        (sum, slice) =>
          sum +
          slice.input_tokens +
          slice.output_tokens +
          slice.reasoning_tokens +
          slice.cache_read_tokens +
          (slice.cache_write_tokens ?? 0),
        0,
      );
  const ownSubagent = subagentBase.filter(
    (record) =>
      record.ordinal === 0 ||
      record.ordinal >= subagentBase[0].payload.subagent_history_start_ordinal,
  );
  await fc.assert(
    fc.asyncProperty(fc.subarray(usageRecordBase.slice(1), { minLength: 0 }), async (replayed) => {
      // The subagent's replay region is whatever subset of the parent it copied.
      const subagent = [
        {
          ...subagentBase[0],
          payload: {
            ...subagentBase[0].payload,
            subagent_history_start_ordinal: 1 + replayed.length,
          },
        },
        ...replayed.map((record) => ({ ...record })),
        ...ownSubagent.slice(1).map((record) => ({ ...record })),
      ].map((record, ordinal) => ({ ...record, ordinal }));
      const baseline = await readGenerated([
        usageRecordBase,
        ownSubagent.map((record, ordinal) => ({
          ...record,
          ordinal,
          payload:
            ordinal === 0
              ? { ...record.payload, subagent_history_start_ordinal: 1 }
              : record.payload,
        })),
      ]);
      const withReplay = await readGenerated([usageRecordBase, subagent]);
      assert.equal(total(withReplay), total(baseline));
    }),
    { numRuns: 60 },
  );
});

test("(6) truncating a rollout at any byte never throws past the partial-line rule", async () => {
  const text = `${usageRecordBase.map((record) => JSON.stringify(record)).join("\n")}\n`;
  let readThrough = 0;
  await fc.assert(
    fc.asyncProperty(fc.nat({ max: text.length }), async (at) => {
      let result;
      try {
        result = await readGenerated([usageRecordBase], { truncateAt: at });
      } catch (error) {
        // A cut can only ever leave the last line partial, which is the rollout being written.
        // Refusing it would make a live Codex session unreadable mid-write.
        assert.fail(`truncation at byte ${at} threw: ${error}`);
      }
      readThrough += 1;
      assertWellFormed(result);
      assert.deepEqual(result.rejected, []);
    }),
    { numRuns: 200 },
  );
  assert.ok(readThrough > 0);
});
