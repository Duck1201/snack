import { Buffer } from "node:buffer";
import { randomUUID } from "node:crypto";
import { open, readdir, readFile, rename, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import process from "node:process";

const recentlyClosed = new Set();

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

/** @param {string} line */
function parseEvent(line) {
  try {
    const value = JSON.parse(line);
    return isSpoolEvent(value) ? value : null;
  } catch {
    return null;
  }
}

/** @param {unknown} value */
function isSpoolEvent(value) {
  if (!isRecord(value) || value.schema_version !== 1) return false;
  const allowed = new Set([
    "schema_version",
    "event_id",
    "installation_id",
    "event_type",
    "source_prompt_id",
    "source_session_id",
    "revision",
    "revision_domain",
    "parser_version",
    "occurred_at",
    "provider",
    "model",
    "completion",
    "outcome",
    "usage_slices",
    "restrictions",
    "input_features",
  ]);
  if (Object.keys(value).some((key) => !allowed.has(key))) return false;
  return (
    string(value.event_id) &&
    string(value.installation_id) &&
    oneOf(value.event_type, ["prompt_started", "session_idle", "session_error"]) &&
    string(value.source_prompt_id) &&
    string(value.source_session_id) &&
    string(value.revision) &&
    value.revision_domain === "opencode-plugin-v1" &&
    value.parser_version === "opencode-plugin-v1" &&
    timestamp(value.occurred_at) &&
    nullableBoundedString(value.provider, 100) &&
    nullableBoundedString(value.model, 200) &&
    oneOf(value.completion, ["provisional", "completed"]) &&
    oneOf(value.outcome, ["success", "restricted", "excluded"]) &&
    Array.isArray(value.usage_slices) &&
    Array.isArray(value.restrictions) &&
    value.usage_slices.length <= 100 &&
    value.restrictions.length <= 20 &&
    value.usage_slices.length === 0 &&
    value.restrictions.every(isRestriction) &&
    validEventState(value) &&
    (value.input_features === undefined || isInputFeatures(value.input_features))
  );
}

/** @param {unknown} value @returns {value is Record<string, unknown>} */
function isRestriction(value) {
  return (
    isRecord(value) &&
    Object.keys(value).every((key) =>
      ["class", "source_code", "observed_at", "classifier_version"].includes(key),
    ) &&
    oneOf(value.class, ["rate_limit", "usage_limit", "capacity_policy", "other_explicit_limit"]) &&
    boundedString(value.source_code, 100) &&
    timestamp(value.observed_at) &&
    value.classifier_version === "opencode-plugin-error-v1"
  );
}

/** @param {unknown} value */
function isInputFeatures(value) {
  return (
    isRecord(value) &&
    Object.keys(value).every((key) =>
      [
        "analyzer_version",
        "estimated_input_tokens",
        "line_count_bucket",
        "code_block_count_bucket",
        "attachment_count",
      ].includes(key),
    ) &&
    value.analyzer_version === "opencode-input-v1" &&
    Number.isSafeInteger(value.estimated_input_tokens) &&
    typeof value.estimated_input_tokens === "number" &&
    value.estimated_input_tokens >= 0 &&
    oneOf(value.line_count_bucket, ["0", "1-10", "11-50", "51-200", "201+"]) &&
    oneOf(value.code_block_count_bucket, ["0", "1", "2-4", "5+"]) &&
    Number.isSafeInteger(value.attachment_count) &&
    typeof value.attachment_count === "number" &&
    value.attachment_count >= 0
  );
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

/** @param {unknown} value @returns {value is Record<string, unknown>} */
function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** @param {unknown} value @returns {value is string} */
function string(value) {
  return boundedString(value, 200);
}

/** @param {unknown} value @param {number} maximum */
function boundedString(value, maximum) {
  return typeof value === "string" && value.length > 0 && value.length <= maximum;
}

/** @param {unknown} value @param {number} maximum */
function nullableBoundedString(value, maximum) {
  return value === null || boundedString(value, maximum);
}

/** @param {unknown} value @returns {value is string} */
function timestamp(value) {
  return (
    typeof value === "string" &&
    /^\d{4}-\d{2}-\d{2}[Tt]\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:[Zz]|[+-]\d{2}:\d{2})$/u.test(value) &&
    !Number.isNaN(Date.parse(value))
  );
}

/** @param {Record<string, unknown>} event */
function validEventState(event) {
  const restrictions = /** @type {unknown[]} */ (event.restrictions);
  if (event.event_type === "prompt_started") {
    return (
      event.completion === "provisional" &&
      event.outcome === "excluded" &&
      restrictions.length === 0
    );
  }
  if (event.event_type === "session_idle") {
    return (
      event.completion === "completed" && event.outcome === "success" && restrictions.length === 0
    );
  }
  return (
    event.event_type === "session_error" &&
    event.completion === "completed" &&
    ((event.outcome === "restricted" && restrictions.length > 0) ||
      (event.outcome === "excluded" && restrictions.length === 0))
  );
}

/** @param {unknown} value @param {string[]} choices */
function oneOf(value, choices) {
  return typeof value === "string" && choices.includes(value);
}

/** @param {unknown} error */
function isNotFound(error) {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}
