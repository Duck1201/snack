import { Buffer } from "node:buffer";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { link, open, readdir, readFile, rename, rm, stat } from "node:fs/promises";
import { createRequire } from "node:module";
import { join } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import { isNotFound, isRecord } from "./guards.js";

const recentlyClosed = new Set();

/** @type {((value: unknown) => boolean) | null} */
let compiledSpoolEvent = null;

/**
 * The published schema is the definition of a valid event, so it is also the check.
 *
 * Both packages ship `schemas/spool-event.schema.json` byte for byte and the plugin writes against
 * it; a second, hand-written description of the same rules here was a third place for the three to
 * disagree, and a reader stricter than the contract reports a conforming plugin's events as
 * corruption rather than as disagreement.
 *
 * `date-time` is registered rather than pulled in from `ajv-formats`: the format is one predicate,
 * and it has to accept exactly what the reader accepted before -- RFC 3339 with an offset or `Z`,
 * in either case, and a date the calendar actually has.
 *
 * Loaded and compiled on the first event read rather than on import. Ajv costs about 20 ms to load
 * and another 45 ms to compile this schema, and `spool.js` is reachable from every command --
 * including `status`, which never opens a spool segment and whose whole budget is 250 ms. Paying
 * two thirds of a command's latency budget to build a validator it will not call is the kind of
 * cost that arrives at import time and is invisible at the call site.
 */
function spoolEventValidator() {
  const cached = compiledSpoolEvent;
  if (cached !== null) return cached;

  const Ajv2020 = createRequire(import.meta.url)("ajv/dist/2020.js");
  const compiled = new Ajv2020({
    allErrors: false,
    strict: true,
    formats: {
      "date-time": (/** @type {string} */ candidate) =>
        /^\d{4}-\d{2}-\d{2}[Tt]\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:[Zz]|[+-]\d{2}:\d{2})$/u.test(
          candidate,
        ) && !Number.isNaN(Date.parse(candidate)),
    },
  }).compile(
    JSON.parse(
      readFileSync(
        fileURLToPath(new URL("../schemas/spool-event.schema.json", import.meta.url)),
        "utf8",
      ),
    ),
  );
  compiledSpoolEvent = compiled;
  return compiled;
}

/** @param {unknown} value */
function isSpoolEvent(value) {
  return spoolEventValidator()(value);
}

/**
 * Read complete, validated events after independently committed segment offsets.
 * A newly closed unterminated tail gets one grace cycle for an in-flight writer, then is discarded.
 *
 * @param {{spoolDirectory: string, installationId: string, cursors: Map<string, number>, segmentPrefix?: string}} options
 */
export async function readSpoolEvents(options) {
  const newlyClosed = await closeOpenSegment(
    options.spoolDirectory,
    options.segmentPrefix === "_pending",
  );
  /** @type {string[]} */
  let names;
  try {
    names = (await readdir(options.spoolDirectory))
      .filter((name) => name.endsWith(".ndjson"))
      .sort((left, right) => left.localeCompare(right));
  } catch (error) {
    if (isNotFound(error)) return emptyBatch();
    throw error;
  }

  /** @type {import("./storage.js").Observation[]} */
  const observations = [];
  /** @type {{segment: string, byte_offset: number}[]} */
  const cursors = [];
  /** @type {{segment: string, line_offset: number}[]} */
  const rejected = [];
  /** @type {string[]} */
  const acknowledgedSegments = [];
  let read = 0;
  let truncated = 0;
  for (const name of names) {
    const segment = options.segmentPrefix ? `${options.segmentPrefix}/${name}` : name;
    const content = await readFile(join(options.spoolDirectory, name), "utf8");
    const completeEnd = content.lastIndexOf("\n") + 1;
    const hasTruncatedTail = completeEnd < content.length;
    if (hasTruncatedTail) truncated += 1;
    const previous = options.cursors.get(segment) ?? 0;
    const offset = previous > content.length ? 0 : previous;
    let lineOffset = offset;
    for (const line of content.slice(offset, completeEnd).split("\n")) {
      if (line === "") continue;
      read += 1;
      const event = parseEvent(line);
      if (!event) {
        rejected.push({ segment, line_offset: lineOffset });
      } else if (event.installation_id === options.installationId) {
        observations.push(toObservation(event));
      }
      lineOffset += Buffer.byteLength(line, "utf8") + 1;
    }
    const committedEnd = hasTruncatedTail && name !== newlyClosed ? content.length : completeEnd;
    if (hasTruncatedTail && name !== newlyClosed) {
      rejected.push({ segment, line_offset: completeEnd });
    }
    if (committedEnd > offset) cursors.push({ segment, byte_offset: committedEnd });
    if (name !== newlyClosed && committedEnd === content.length) acknowledgedSegments.push(name);
  }
  return { observations, cursors, rejected, acknowledgedSegments, read, truncated };
}

/** @param {string} spoolDirectory @param {string[]} segments */
export async function removeAcknowledgedSegments(spoolDirectory, segments) {
  await Promise.all(segments.map((segment) => rm(join(spoolDirectory, segment), { force: true })));
}

/**
 * Remove shared pending segments only after every configured source has committed through them.
 *
 * @param {{spoolDirectory: string, sourceCursors: Map<string, Map<string, number>>, segmentPrefix: string}} options
 */
export async function removeFullyConsumedSegments(options) {
  let names;
  try {
    names = (await readdir(options.spoolDirectory)).filter((name) => name.endsWith(".ndjson"));
  } catch (error) {
    if (isNotFound(error)) return;
    throw error;
  }
  for (const name of names) {
    const file = join(options.spoolDirectory, name);
    if (recentlyClosed.delete(file)) continue;
    const size = (await stat(file)).size;
    const segment = `${options.segmentPrefix}/${name}`;
    if (
      options.sourceCursors.size > 0 &&
      [...options.sourceCursors.values()].every((cursors) => (cursors.get(segment) ?? 0) >= size)
    ) {
      await rm(file, { force: true });
    }
  }
}

/** @param {string} spoolDirectory @param {boolean} protectFromSharedCleanup */
async function closeOpenSegment(spoolDirectory, protectFromSharedCleanup) {
  const name = `segment-sync-${Date.now()}-${randomUUID()}.ndjson`;
  const release = await acquireSpoolLock(spoolDirectory);
  if (release === null) return null;
  try {
    const closed = join(spoolDirectory, name);
    await rename(join(spoolDirectory, "current.open"), closed);
    if (protectFromSharedCleanup) recentlyClosed.add(closed);
    return name;
  } catch (error) {
    if (isNotFound(error)) return null;
    throw error;
  } finally {
    await release();
  }
}

/**
 * A writer holds `.writer.lock` for the milliseconds one append takes, so a lock older than this
 * was abandoned whatever its pid says. Exported for `doctor`, which reports one.
 */
export const STALE_SPOOL_LOCK_MS = 120_000;

/**
 * The file operations the lock performs, injectable so a test can interleave two takers.
 *
 * @typedef {Pick<typeof import("node:fs/promises"), "link" | "open" | "readFile" | "rename" | "rm" | "stat">} SpoolLockFs
 */

/** @type {SpoolLockFs} */
const lockFs = { link, open, readFile, rename, rm, stat };

/**
 * Take the spool's writer lock, or report that a live writer holds it.
 *
 * An abandoned lock is taken over and the lock taken in the same call: returning empty-handed after
 * clearing it cost a whole sync interval for nothing.
 *
 * Two takers -- this sync and a plugin, or two syncs -- can judge the same lock abandoned at once,
 * and removing it by path let the slower one delete the lock the faster one had just created in
 * its place, so both held it. A takeover therefore moves the lock aside to a name of its own --
 * `rename` moves exactly one file -- and proceeds only when what it moved is the lock it judged;
 * having moved a lock another writer took in the meantime, it puts that lock back with `link`,
 * which never replaces a lock created since. The plugin takes its lock the same way.
 *
 * @param {string} spoolDirectory
 * @param {SpoolLockFs} [fs]
 * @returns {Promise<(() => Promise<void>) | null>}
 */
export async function acquireSpoolLock(spoolDirectory, fs = lockFs) {
  const lock = join(spoolDirectory, ".writer.lock");
  const token = randomUUID();
  for (let attempt = 0; attempt < 3; attempt += 1) {
    /** @type {import("node:fs/promises").FileHandle} */
    let handle;
    try {
      handle = await fs.open(lock, "wx", 0o600);
    } catch (error) {
      if (isNotFound(error)) return null;
      if (!(error instanceof Error && "code" in error && error.code === "EEXIST")) throw error;
      const held = await inspectLock(fs, lock);
      // Our own token in a lock we gave up on is one a takeover moved and put back while we were
      // checking it: abandoned by definition.
      if (held !== null && (held.owner?.token === token || isAbandoned(held))) {
        await takeOverLock(fs, lock, held);
        continue;
      }
      return null;
    }
    await handle.writeFile(`${JSON.stringify({ pid: process.pid, token })}\n`, "utf8");
    await handle.sync();
    if ((await inspectLock(fs, lock))?.owner?.token !== token) {
      // Gone or another writer's: give it up. If a takeover had only moved it aside, it comes back
      // under our token and the next attempt removes it as abandoned.
      await handle.close();
      continue;
    }
    return async () => {
      await handle.close();
      const held = await inspectLock(fs, lock);
      if (held?.owner?.token === token) await takeOverLock(fs, lock, held);
    };
  }
  return null;
}

/**
 * Remove the lock `judged` described, and nothing else.
 *
 * @param {SpoolLockFs} fs
 * @param {string} lock
 * @param {LockState} judged
 */
async function takeOverLock(fs, lock, judged) {
  const tombstone = `${lock}.${randomUUID()}.stale`;
  try {
    await fs.rename(lock, tombstone);
  } catch (error) {
    // Another taker moved it first; whatever is there now is judged afresh.
    if (isNotFound(error)) return;
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
    if (!(error instanceof Error && "code" in error && error.code === "EEXIST")) {
      await fs.rename(tombstone, lock).catch(() => {});
    }
  }
  await fs.rm(tombstone, { force: true });
}

/**
 * @typedef {{ino: number, mtimeMs: number, owner: {pid: number, token: string} | null}} LockState
 */

/**
 * @param {SpoolLockFs} fs
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
  return { ino: stats.ino, mtimeMs: stats.mtimeMs, owner: await readSpoolLock(fs, lock) };
}

/**
 * Age decides before the pid does: a pid that answers `kill(pid, 0)` may have been reused, or
 * belong to another user, and a lock held this long is not being used by anyone. Age is read
 * against the wall clock, so a clock jump of more than `STALE_SPOOL_LOCK_MS`, or a machine resumed
 * from suspend mid-append, can take over a lock still held; locks are held for milliseconds, and
 * the takeover above keeps that from putting two holders on one lock.
 *
 * @param {LockState} held
 */
function isAbandoned(held) {
  return (
    (held.owner !== null && !processIsAlive(held.owner.pid)) ||
    Date.now() - held.mtimeMs > STALE_SPOOL_LOCK_MS
  );
}

/** @param {string} lock @param {number} [now] */
export async function lockIsStale(lock, now = Date.now()) {
  try {
    return now - (await stat(lock)).mtimeMs > STALE_SPOOL_LOCK_MS;
  } catch {
    return false;
  }
}

/** @param {SpoolLockFs} fs @param {string} lock */
async function readSpoolLock(fs, lock) {
  try {
    const value = JSON.parse(await fs.readFile(lock, "utf8"));
    return isRecord(value) &&
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

/** @param {number} pid */
function processIsAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error instanceof Error && "code" in error && error.code === "EPERM";
  }
}

function emptyBatch() {
  return {
    observations: [],
    cursors: [],
    rejected: [],
    acknowledgedSegments: [],
    read: 0,
    truncated: 0,
  };
}

/** @param {string} line @returns {Record<string, unknown> | null} */
function parseEvent(line) {
  try {
    const value = JSON.parse(line);
    return isSpoolEvent(value) ? /** @type {Record<string, unknown>} */ (value) : null;
  } catch {
    return null;
  }
}

/** @param {Record<string, unknown>} event @returns {import("./storage.js").Observation} */
function toObservation(event) {
  const features = isRecord(event.input_features) ? event.input_features : null;
  return {
    source_prompt_id: /** @type {string} */ (event.source_prompt_id),
    source_session_id: /** @type {string} */ (event.source_session_id),
    revision: /** @type {string} */ (event.revision),
    revision_domain: "opencode-plugin-v1",
    parser_version: "opencode-plugin-v1",
    started_at: /** @type {string} */ (event.occurred_at),
    completed_at:
      event.completion === "completed" ? /** @type {string} */ (event.occurred_at) : null,
    duration_ms: null,
    completion: /** @type {string} */ (event.completion),
    provider: /** @type {string | null} */ (event.provider),
    model: /** @type {string | null} */ (event.model),
    outcome: /** @type {string} */ (event.outcome),
    input_features:
      features === null
        ? null
        : {
            analyzer_version: /** @type {string} */ (features.analyzer_version),
            estimated_input_tokens: /** @type {number} */ (features.estimated_input_tokens),
            line_count_bucket: /** @type {string} */ (features.line_count_bucket),
            code_block_count_bucket: /** @type {string} */ (features.code_block_count_bucket),
            attachment_count: /** @type {number} */ (features.attachment_count),
          },
    usage_slices: [],
    restrictions:
      /** @type {Array<{class: string, source_code: string, observed_at: string, classifier_version: string}>} */ (
        event.restrictions
      ).map((restriction) => ({ ...restriction, provenance: "spool" })),
  };
}
