import { Buffer } from "node:buffer";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { open, readdir, readFile, rename, rm, stat } from "node:fs/promises";
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

/** @param {string} spoolDirectory */
async function acquireSpoolLock(spoolDirectory) {
  const lock = join(spoolDirectory, ".writer.lock");
  const token = randomUUID();
  try {
    const handle = await open(lock, "wx", 0o600);
    await handle.writeFile(`${JSON.stringify({ pid: process.pid, token })}\n`, "utf8");
    await handle.sync();
    if ((await readSpoolLock(lock))?.token !== token) {
      await handle.close();
      return null;
    }
    return async () => {
      await handle.close();
      if ((await readSpoolLock(lock))?.token === token) await rm(lock, { force: true });
    };
  } catch (error) {
    if (isNotFound(error)) return null;
    if (!(error instanceof Error && "code" in error && error.code === "EEXIST")) throw error;
    const owner = await readSpoolLock(lock);
    if (owner !== null && !processIsAlive(owner.pid)) {
      await rm(lock, { force: true });
    }
    if (owner === null && (await lockIsStale(lock))) await rm(lock, { force: true });
    return null;
  }
}

/** @param {string} lock */
async function lockIsStale(lock) {
  try {
    return Date.now() - (await stat(lock)).mtimeMs > 120_000;
  } catch {
    return false;
  }
}

/** @param {string} lock */
async function readSpoolLock(lock) {
  try {
    const value = JSON.parse(await readFile(lock, "utf8"));
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
