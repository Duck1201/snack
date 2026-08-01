import assert from "node:assert/strict";
import { mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, test } from "node:test";

import { readSampleRecords } from "../src/claude-adapter.js";

/** @type {string[]} */
const temporaryRoots = [];

afterEach(async () => {
  await Promise.all(
    temporaryRoots.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

/** @param {string} name @param {string} content */
async function writeTranscript(name, content) {
  const root = await mkdtemp(join(tmpdir(), "snack-claude-fingerprint-"));
  temporaryRoots.push(root);
  const file = join(root, name);
  await writeFile(file, content, "utf8");
  return file;
}

test("sampling a transcript reads a bounded prefix, not the whole file", async () => {
  // `hasSupportedStructure` inspects at most 200 records per file and then breaks -- but it broke
  // out of an array `readRecords` had already built by reading and `JSON.parse`ing the entire file.
  // Over a real 222 MB history that is what every `sync`, `status` and `doctor` paid: 238 MB of
  // process RSS on a sync with nothing to read, growing with the history and never levelling off.
  /** @param {number} index */
  const line = (index) =>
    JSON.stringify({
      type: "user",
      uuid: `u-${index}`,
      parentUuid: null,
      sessionId: "s",
      timestamp: "2026-01-02T03:04:05.000Z",
      filler: "x".repeat(4096),
    });
  const file = await writeTranscript(
    "big.jsonl",
    `${Array.from({ length: 5000 }, (_, index) => line(index)).join("\n")}\n`,
  );
  const size = (await stat(file)).size;
  assert.ok(size > 20_000_000, `fixture should be large, was ${size}`);

  const { records, bytesRead } = readSampleRecords(file, 10);

  assert.equal(records.length, 10);
  assert.ok(bytesRead < size / 100, `sampling 10 records read ${bytesRead} of ${size} bytes`);
});

test("sampling stops at the end of a file shorter than the sample", async () => {
  const file = await writeTranscript(
    "small.jsonl",
    `${JSON.stringify({ type: "user", uuid: "u-1" })}\n`,
  );

  const { records } = readSampleRecords(file, 200);

  assert.equal(records.length, 1);
});

test("a file that cannot be read samples nothing rather than throwing", async () => {
  const { records, bytesRead } = readSampleRecords(join(tmpdir(), "snack-absent.jsonl"), 200);

  assert.deepEqual(records, []);
  assert.equal(bytesRead, 0);
});
