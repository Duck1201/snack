import assert from "node:assert/strict";
import * as nodeFs from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import process from "node:process";
import { afterEach, test } from "node:test";

import { acquireSpoolLock, appendEvent } from "../src/spool-writer.js";

/** @typedef {import("../src/spool-writer.js").SpoolFs} SpoolFs */

/** @type {string[]} */
const temporaryRoots = [];

afterEach(async () => {
  await Promise.all(
    temporaryRoots.splice(0).map((path) => nodeFs.rm(path, { recursive: true, force: true })),
  );
});

async function spoolDirectory() {
  const root = await nodeFs.mkdtemp(join(tmpdir(), "snack-spool-writer-"));
  temporaryRoots.push(root);
  return root;
}

/** @param {string} directory @param {string} token @param {number} ageMs */
async function plantLock(directory, token, ageMs) {
  const lock = join(directory, ".writer.lock");
  await nodeFs.writeFile(lock, `${JSON.stringify({ pid: process.pid, token })}\n`, {
    mode: 0o600,
  });
  const modified = new Date(Date.now() - ageMs);
  await nodeFs.utimes(lock, modified, modified);
  return lock;
}

function deferred() {
  /** @type {() => void} */
  let resolve = () => {};
  /** @type {Promise<void>} */
  const promise = new Promise((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

/**
 * A file system whose removals and renames wait for `gate`, and which reports its first read of the
 * lock through `onLockRead`.
 *
 * @param {Promise<void>} gate
 * @param {() => void} [onLockRead]
 * @returns {SpoolFs}
 */
function gatedFs(gate, onLockRead = () => {}) {
  return asFs({
    ...nodeFs,
    async readFile(/** @type {string} */ path) {
      const value = await nodeFs.readFile(path, "utf8");
      if (String(path).endsWith(".writer.lock")) onLockRead();
      return value;
    },
    async rename(/** @type {string} */ from, /** @type {string} */ to) {
      await gate;
      return nodeFs.rename(from, to);
    },
    async rm(
      /** @type {string} */ path,
      /** @type {import("node:fs").RmOptions | undefined} */ options,
    ) {
      await gate;
      return nodeFs.rm(path, options);
    },
  });
}

/** @param {object} value @returns {SpoolFs} */
function asFs(value) {
  return /** @type {SpoolFs} */ (/** @type {unknown} */ (value));
}

test("two writers taking over one abandoned lock never both hold it", async () => {
  // Both see the same abandoned lock. A takes it over and creates its own; B, judging the lock it
  // saw a moment earlier, then removed by path whatever was there -- A's new lock -- and created
  // its own: two writers appending at once, and A's truncate after a failed write could erase B's
  // line. Interleaved deterministically: A moves the old lock only after B has read it, and B acts
  // on its judgement only once A holds the lock.
  const directory = await spoolDirectory();
  const lock = await plantLock(directory, "abandoned", 10 * 60_000);
  const bJudged = deferred();
  const aHolds = deferred();

  const a = acquireSpoolLock(directory, gatedFs(bJudged.promise));
  const b = acquireSpoolLock(directory, gatedFs(aHolds.promise, bJudged.resolve));
  const held = await a;
  aHolds.resolve();

  await assert.rejects(b, /busy/u);
  assert.equal(await held.holds(), true);
  const owner = JSON.parse(await nodeFs.readFile(lock, "utf8"));
  assert.equal(owner.token === "abandoned", false);
  await held.release();
  assert.deepEqual(await nodeFs.readdir(directory), []);
});

/**
 * A file system whose open segment fails mid-write, after part of the line landed. `during` runs
 * between the partial write and the failure.
 *
 * @param {(file: string) => Promise<void>} [during]
 * @returns {SpoolFs}
 */
function failingMidWrite(during = async () => {}) {
  return asFs({
    ...nodeFs,
    /** @param {string} path @param {string} flags @param {number} mode */
    async open(path, flags, mode) {
      const handle = await nodeFs.open(path, flags, mode);
      if (!String(path).endsWith("current.open")) return handle;
      const wrapper = {
        stat: () => handle.stat(),
        /** @param {Buffer} buffer @param {number} offset @param {number} length @param {number} position */
        read: (buffer, offset, length, position) => handle.read(buffer, offset, length, position),
        /** @param {string} data */
        async writeFile(data) {
          await handle.write(data.slice(0, 12));
          await during(String(path));
          throw Object.assign(new Error("File too large"), { code: "EFBIG" });
        },
        sync: () => handle.sync(),
        /** @param {number} length */
        truncate: (length) => handle.truncate(length),
        close: () => handle.close(),
      };
      return /** @type {import("node:fs/promises").FileHandle} */ (
        /** @type {unknown} */ (wrapper)
      );
    },
  });
}

const event = { schema_version: 1, event_id: "e-2" };

test("a write that fails part-way is taken back to the line before it", async () => {
  const directory = await spoolDirectory();
  const file = join(directory, "current.open");
  await nodeFs.writeFile(file, '{"event_id":"e-1"}\n', { mode: 0o600 });

  await assert.rejects(appendEvent(directory, event, failingMidWrite()), /too large/u);

  assert.equal(await nodeFs.readFile(file, "utf8"), '{"event_id":"e-1"}\n');
  assert.deepEqual((await nodeFs.readdir(directory)).sort(), ["current.open"]);
});

test("a writer whose lock was taken over never truncates the line written after it", async () => {
  // A lock judged abandoned -- a clock that jumped, a laptop resumed mid-append -- is taken over
  // while its writer is still writing. Cutting the file back to where that writer started would
  // erase the line the new holder appended since; the stale writer checks the lock first.
  const directory = await spoolDirectory();
  const file = join(directory, "current.open");
  await nodeFs.writeFile(file, '{"event_id":"e-1"}\n', { mode: 0o600 });
  const takenOver = failingMidWrite(async (segment) => {
    const lock = join(directory, ".writer.lock");
    await nodeFs.rm(lock);
    await plantLock(directory, "successor", 0);
    await nodeFs.appendFile(segment, '\n{"event_id":"e-3"}\n');
  });

  await assert.rejects(appendEvent(directory, event, takenOver), /too large/u);

  const lines = (await nodeFs.readFile(file, "utf8")).split("\n");
  assert.ok(lines.includes('{"event_id":"e-3"}'), lines.join("\\n"));
  // Nor is the successor's lock released on its behalf.
  const owner = JSON.parse(await nodeFs.readFile(join(directory, ".writer.lock"), "utf8"));
  assert.equal(owner.token, "successor");
});

test("a writer whose fresh lock was moved aside and put back reclaims it", async () => {
  // A takeover that moved the wrong lock puts it back, but the writer that created it may have
  // checked for its token in between, found nothing and given up -- leaving a fresh lock under a
  // live pid that would block every writer for two minutes. Its own token marks it abandoned.
  const directory = await spoolDirectory();
  let hidden = false;
  const momentarilyMissing = asFs({
    ...nodeFs,
    async stat(/** @type {string} */ path) {
      if (!hidden && String(path).endsWith(".writer.lock")) {
        hidden = true;
        throw Object.assign(new Error("moved aside"), { code: "ENOENT" });
      }
      return nodeFs.stat(path);
    },
  });

  const held = await acquireSpoolLock(directory, momentarilyMissing);
  assert.equal(hidden, true);
  assert.equal(await held.holds(), true);
  await held.release();
  assert.deepEqual(await nodeFs.readdir(directory), []);
});
