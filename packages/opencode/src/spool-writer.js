import { Buffer } from "node:buffer";
import { randomUUID } from "node:crypto";
import * as nodeFs from "node:fs/promises";
import { join } from "node:path";
import process from "node:process";
import { setTimeout as delay } from "node:timers/promises";

const spoolFilename = "current.open";
const maxSegmentBytes = 1024 * 1024;
/**
 * A lock is held for the milliseconds one append takes; one this old was abandoned. Judged by the
 * wall clock against the lock's mtime, so a clock jump of more than this, or a laptop resumed
 * mid-append, can take over a lock still held. That costs at most one event; the takeover below
 * and the check before a truncate keep it from costing another writer's.
 */
const staleLockMs = 120_000;

/**
 * The file operations the writer performs, injectable so a test can interleave two writers.
 *
 * @typedef {Pick<typeof import("node:fs/promises"), "chmod" | "link" | "mkdir" | "open" | "readFile" | "rename" | "rm" | "stat">} SpoolFs
 */

/**
 * Append one event to a spool directory's open segment, under its writer lock.
 *
 * @param {string} spoolDirectory
 * @param {Record<string, unknown>} event
 * @param {SpoolFs} [fs]
 */
export async function appendEvent(spoolDirectory, event, fs = nodeFs) {
  await fs.mkdir(spoolDirectory, { recursive: true, mode: 0o700 });
  await fs.chmod(spoolDirectory, 0o700);
  const lock = await acquireSpoolLock(spoolDirectory, fs);
  try {
    const file = join(spoolDirectory, spoolFilename);
    try {
      if ((await fs.stat(file)).size >= maxSegmentBytes) {
        await fs.rename(file, join(spoolDirectory, `segment-${Date.now()}-${randomUUID()}.ndjson`));
      }
    } catch (error) {
      if (!hasCode(error, "ENOENT")) throw error;
    }
    const handle = await fs.open(file, "a+", 0o600);
    try {
      // A write cut short -- a full disk, a file-size limit, a killed host -- leaves a line with no
      // newline, and the next event appended to it is glued on and lost with it. Starting on a
      // fresh line confines the damage to the line that was already broken.
      const { size } = await handle.stat();
      const separator = size > 0 && !(await endsWithNewline(handle, size)) ? "\n" : "";
      try {
        await handle.writeFile(`${separator}${JSON.stringify(event)}\n`, "utf8");
        await handle.sync();
      } catch (error) {
        // Take back whatever part of this event landed, so the failure leaves no partial line --
        // only while this writer still holds the lock. One whose lock was taken over may share the
        // file with the writer that took it, and cutting back to `size` would erase that writer's
        // line; a partial line is the lesser loss, and it rejects only itself.
        if (await lock.holds()) await handle.truncate(size).catch(() => {});
        throw error;
      }
    } finally {
      await handle.close();
    }
    await fs.chmod(file, 0o600);
  } finally {
    await lock.release();
  }
}

/**
 * Take a spool directory's writer lock.
 *
 * A lock whose writer is gone, or which is older than any append, is taken over. Two writers can
 * judge the same lock abandoned at once, and removing it by path let the slower one delete the lock
 * the faster one had just created in its place, so both held it. A takeover therefore moves the
 * lock aside to a name of its own -- `rename` moves exactly one file -- and only proceeds when what
 * it moved is the lock it judged. Having moved a lock another writer took in the meantime, it puts
 * that lock back with `link`, which never replaces a lock created since.
 *
 * @param {string} spoolDirectory
 * @param {SpoolFs} [fs]
 * @returns {Promise<{holds: () => Promise<boolean>, release: () => Promise<void>}>}
 */
export async function acquireSpoolLock(spoolDirectory, fs = nodeFs) {
  const lock = join(spoolDirectory, ".writer.lock");
  const token = randomUUID();
  const holds = async () => (await inspectLock(fs, lock))?.owner?.token === token;
  for (let attempt = 0; attempt < 4; attempt += 1) {
    /** @type {import("node:fs/promises").FileHandle} */
    let handle;
    try {
      handle = await fs.open(lock, "wx", 0o600);
    } catch (error) {
      if (!hasCode(error, "EEXIST")) throw error;
      const held = await inspectLock(fs, lock);
      // Our own token in a lock we gave up on is a lock a takeover moved and put back while we
      // were checking it: it is abandoned by definition.
      if (held !== null && (held.owner?.token === token || isAbandoned(held))) {
        await takeOver(fs, lock, held);
        continue;
      }
      if (attempt < 3) await delay(2);
      continue;
    }
    await handle.writeFile(`${JSON.stringify({ pid: process.pid, token })}\n`, "utf8");
    await handle.sync();
    if (!(await holds())) {
      await handle.close();
      continue;
    }
    return {
      holds,
      async release() {
        await handle.close();
        const held = await inspectLock(fs, lock);
        if (held?.owner?.token === token) await takeOver(fs, lock, held);
      },
    };
  }
  throw new Error("Spool writer is busy.");
}

/**
 * Remove the lock `judged` described, and nothing else.
 *
 * @param {SpoolFs} fs
 * @param {string} lock
 * @param {LockState} judged
 */
async function takeOver(fs, lock, judged) {
  const tombstone = `${lock}.${randomUUID()}.stale`;
  try {
    await fs.rename(lock, tombstone);
  } catch (error) {
    // Another writer moved it first; whatever is there now is judged afresh.
    if (hasCode(error, "ENOENT")) return;
    throw error;
  }
  const moved = await inspectLock(fs, tombstone);
  if (
    moved !== null &&
    moved.ino === judged.ino &&
    moved.mtimeMs === judged.mtimeMs &&
    moved.owner?.token === judged.owner?.token
  ) {
    await fs.rm(tombstone, { force: true });
    return;
  }
  // Not the lock that was judged: a writer that took over first holds it. Put it back, unless a
  // lock was created in its place meanwhile, which then stands.
  try {
    await fs.link(tombstone, lock);
  } catch (error) {
    if (!hasCode(error, "EEXIST")) await fs.rename(tombstone, lock).catch(() => {});
  }
  await fs.rm(tombstone, { force: true });
}

/**
 * @typedef {{ino: number, mtimeMs: number, owner: {pid: number, token: string} | null}} LockState
 */

/**
 * @param {SpoolFs} fs
 * @param {string} lock
 * @returns {Promise<LockState | null>}
 */
async function inspectLock(fs, lock) {
  let stats;
  try {
    stats = await fs.stat(lock);
  } catch {
    return null;
  }
  return { ino: stats.ino, mtimeMs: stats.mtimeMs, owner: await readOwner(fs, lock) };
}

/**
 * Age decides before the pid does: a pid that answers `kill(pid, 0)` may have been reused, or
 * belong to another user, and a lock held that long is not being used by anyone.
 *
 * @param {LockState} held
 */
function isAbandoned(held) {
  return (
    (held.owner !== null && !processIsAlive(held.owner.pid)) ||
    Date.now() - held.mtimeMs > staleLockMs
  );
}

/** @param {SpoolFs} fs @param {string} lock */
async function readOwner(fs, lock) {
  try {
    const value = JSON.parse(await fs.readFile(lock, "utf8"));
    return typeof value === "object" &&
      value !== null &&
      typeof value.pid === "number" &&
      Number.isSafeInteger(value.pid) &&
      value.pid > 0 &&
      typeof value.token === "string"
      ? { pid: value.pid, token: value.token }
      : null;
  } catch {
    return null;
  }
}

/** @param {import("node:fs/promises").FileHandle} handle @param {number} size */
async function endsWithNewline(handle, size) {
  const last = Buffer.alloc(1);
  await handle.read(last, 0, 1, size - 1);
  return last[0] === 0x0a;
}

/** @param {number} pid */
function processIsAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return hasCode(error, "EPERM");
  }
}

/** @param {unknown} error @param {string} code */
function hasCode(error, code) {
  return error instanceof Error && "code" in error && error.code === code;
}
