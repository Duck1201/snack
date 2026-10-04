import { Buffer } from "node:buffer";
import { randomUUID } from "node:crypto";
import { chmod, mkdir, open, readFile, rename, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import process from "node:process";
import { setTimeout as delay } from "node:timers/promises";

const spoolFilename = "current.open";
const maxPendingWrites = 100;
const maxSegmentBytes = 1024 * 1024;
/** A lock is held for the milliseconds one append takes; one this old was abandoned. */
const staleLockMs = 120_000;

/**
 * Agents OpenCode runs on the side of a prompt, on models of their own: `title` names the session
 * with `small_model` on its first prompt, `compaction` and `summary` rewrite history. Their
 * `chat.params` describe a call the prompt did not ask for, so they never route one.
 */
const auxiliaryAgents = new Set(["title", "compaction", "summary"]);

/**
 * @typedef {object} PromptState
 * @property {string} promptId
 * @property {string | null} agent
 * @property {string | null} provider
 * @property {string | null} model
 * @property {string} spoolDirectory
 * @property {boolean} retried
 * @property {Record<string, unknown>[]} buffered
 */

/**
 * Fail-open OpenCode plugin entrypoint.
 *
 * @param {unknown} _context
 * @param {{installation_id?: unknown, spool_directory?: unknown, prospective_analysis?: unknown, source_bindings?: unknown} | null} [options]
 */
export async function SnackOpenCodePlugin(_context, options = {}) {
  // OpenCode passes whatever the configuration tuple holds, `null` and non-objects included; an
  // initializer that throws there takes the host down with it.
  const settings = recordOrNull(options) ?? {};
  const installationId = stringOrNull(settings.installation_id);
  const spoolDirectory = stringOrNull(settings.spool_directory);
  const captureFeatures = settings.prospective_analysis === true;
  const sourceBindings = bindingMap(settings.source_bindings);
  /** @type {Map<string, PromptState>} */
  const prompts = new Map();
  let writes = Promise.resolve();
  let pendingWrites = 0;
  let lastWarningAt = 0;

  const warn = () => {
    const now = Date.now();
    if (now - lastWarningAt < 60_000) return;
    lastWarningAt = now;
    try {
      globalThis.console.warn("SNACK live metadata capture is temporarily unavailable.");
    } catch {
      // Host logging must not affect prompt behavior.
    }
  };

  /** @param {Record<string, unknown>} event */
  /** @param {string} targetDirectory @param {Record<string, unknown>} event */
  const append = (targetDirectory, event) => {
    if (!installationId || !targetDirectory || !withinSchemaBounds(event)) {
      warn();
      return;
    }
    if (pendingWrites >= maxPendingWrites) {
      warn();
      return;
    }
    pendingWrites += 1;
    writes = writes
      .then(() => appendEvent(targetDirectory, event))
      .catch(warn)
      .finally(() => {
        pendingWrites -= 1;
      });
  };

  /**
   * Route a session's spool directory once its provider is known.
   *
   * OpenCode declares `model` optional on `chat.message` and does not send it on `1.18.10` or
   * `1.18.15`; the user message on the hook's output names it there, and older hosts may not. An
   * event written to `_pending` is never attributed and never revisited, so a prompt whose provider
   * is still unknown is held rather than misfiled, and released as soon as the prompt's own
   * `chat.params` names one. A prompt whose provider never arrives is released to `_pending` at
   * its terminal event, or when the next prompt of its session replaces it.
   *
   * @param {PromptState} prompt
   */
  const release = (prompt) => {
    for (const event of prompt.buffered.splice(0)) {
      append(prompt.spoolDirectory, { ...event, provider: prompt.provider, model: prompt.model });
    }
  };

  return {
    async dispose() {
      try {
        for (const prompt of prompts.values()) release(prompt);
        prompts.clear();
        await writes;
      } catch {
        // Capture must never change OpenCode shutdown behavior.
      }
    },
    async "chat.params"(/** @type {Record<string, unknown>} */ input) {
      try {
        const sessionId = stringOrNull(input.sessionID);
        const prompt = sessionId ? prompts.get(sessionId) : undefined;
        if (!prompt || prompt.provider || !spoolDirectory) return;
        // Only the call that answers this prompt routes it. On 1.18.15 the session title is
        // generated with `small_model` -- possibly another provider -- and its `chat.params`
        // arrives first, on the first prompt of every session.
        const agent = stringOrNull(input.agent);
        if (agent !== null && auxiliaryAgents.has(agent)) return;
        if (prompt.agent !== null && agent !== null && agent !== prompt.agent) return;
        const answered = stringOrNull(recordOrNull(input.message)?.id);
        if (answered !== null && answered !== prompt.promptId) return;
        const model = recordOrNull(input.model);
        const provider = stringOrNull(model?.providerID);
        if (!provider) return;
        prompt.provider = provider;
        // `chat.params` carries the provider's model record, which names the model `id`.
        prompt.model = stringOrNull(model?.id) ?? stringOrNull(model?.modelID);
        prompt.spoolDirectory = sourceBindings.get(provider) ?? join(spoolDirectory, "_pending");
        release(prompt);
      } catch {
        // Capture must never change OpenCode prompt behavior.
      }
    },
    async "chat.message"(
      /** @type {Record<string, unknown>} */ input,
      /** @type {unknown} */ output,
    ) {
      try {
        const sessionId = stringOrNull(input.sessionID);
        const outputMessage = recordOrNull(recordOrNull(output)?.message);
        const promptId = stringOrNull(input.messageID) ?? stringOrNull(outputMessage?.id);
        if (!sessionId || !promptId || !spoolDirectory) return;
        const model = recordOrNull(input.model) ?? recordOrNull(outputMessage?.model);
        const provider = stringOrNull(model?.providerID);
        const modelId = stringOrNull(model?.modelID);
        const targetDirectory = provider
          ? (sourceBindings.get(provider) ?? join(spoolDirectory, "_pending"))
          : join(spoolDirectory, "_pending");
        if (!targetDirectory) return;
        /** @type {PromptState} */
        const prompt = {
          promptId,
          agent: stringOrNull(input.agent) ?? stringOrNull(outputMessage?.agent),
          provider,
          model: modelId,
          spoolDirectory: targetDirectory,
          retried: false,
          buffered: [],
        };
        // A prompt queued behind one still held for its provider replaces it here; what the
        // earlier one buffered is released, to `_pending`, rather than dropped.
        const previous = prompts.get(sessionId);
        if (previous) release(previous);
        prompts.set(sessionId, prompt);
        const occurredAt = new Date().toISOString();
        const started = {
          schema_version: 1,
          event_id: `chat.message:${sessionId}:${promptId}:${occurredAt}`,
          installation_id: installationId,
          event_type: "prompt_started",
          source_prompt_id: promptId,
          source_session_id: sessionId,
          revision: `${occurredAt}:chat.message`,
          revision_domain: "opencode-plugin-v1",
          parser_version: "opencode-plugin-v1",
          occurred_at: occurredAt,
          provider,
          model: modelId,
          completion: "provisional",
          outcome: "excluded",
          usage_slices: [],
          restrictions: [],
          ...(captureFeatures ? { input_features: analyzePrompt(output) } : {}),
        };
        if (provider) append(targetDirectory, started);
        else prompt.buffered.push(started);
      } catch {
        // Capture must never change OpenCode prompt behavior.
      }
    },
    async event(/** @type {{event?: unknown}} */ input) {
      try {
        const event = recordOrNull(input.event);
        const type = stringOrNull(event?.type);
        if (type !== "session.idle" && type !== "session.error" && type !== "session.status")
          return;
        const properties = recordOrNull(event?.properties) ?? {};
        const sessionId = stringOrNull(properties.sessionID);
        const prompt = sessionId ? prompts.get(sessionId) : undefined;
        if (!sessionId || !prompt) return;
        if (type === "session.status") {
          // Only the status's type is read. Its `message` is the provider's free text and is
          // never kept, compared, or classified.
          if (stringOrNull(recordOrNull(properties.status)?.type) === "retry")
            prompt.retried = true;
          return;
        }
        // One terminal per prompt. 1.18.15 emits `session.idle` after `session.error`, twice after
        // an abort, and again after every later `/shell` or `/summarize`: a prompt still in the map
        // would be re-emitted, each time later than the last.
        prompts.delete(sessionId);
        release(prompt);
        // OpenCode retries a 429 itself and reports it only as `session.status` `retry`, which
        // carries no structured status code; the turn then ends in `session.idle` whether it
        // succeeded or was cancelled. `spool-event-v1` lets `session_idle` say only `success`, so a
        // retried turn states no terminal at all and backfill, which reads how it ended, decides.
        if (type === "session.idle" && prompt.retried) return;
        const occurredAt = timestampOrNow(properties.time);
        const error = recordOrNull(properties.error);
        const restricted = type === "session.error" && isExplicitRateLimit(error);
        append(prompt.spoolDirectory, {
          schema_version: 1,
          event_id: `${type}:${sessionId}:${prompt.promptId}:${occurredAt}`,
          installation_id: installationId,
          event_type: type === "session.idle" ? "session_idle" : "session_error",
          source_prompt_id: prompt.promptId,
          source_session_id: sessionId,
          revision: `${occurredAt}:${type}`,
          revision_domain: "opencode-plugin-v1",
          parser_version: "opencode-plugin-v1",
          occurred_at: occurredAt,
          provider: prompt.provider,
          model: prompt.model,
          completion: "completed",
          outcome: restricted ? "restricted" : type === "session.idle" ? "success" : "excluded",
          usage_slices: [],
          restrictions: restricted
            ? [
                {
                  class: "rate_limit",
                  source_code: "http_429",
                  observed_at: occurredAt,
                  classifier_version: "opencode-plugin-error-v1",
                },
              ]
            : [],
        });
      } catch {
        // Capture must never change OpenCode event behavior.
      }
    },
  };
}

/** @param {string} spoolDirectory @param {Record<string, unknown>} event */
async function appendEvent(spoolDirectory, event) {
  await mkdir(spoolDirectory, { recursive: true, mode: 0o700 });
  await chmod(spoolDirectory, 0o700);
  const release = await acquireSpoolLock(spoolDirectory);
  try {
    const file = join(spoolDirectory, spoolFilename);
    try {
      if ((await stat(file)).size >= maxSegmentBytes) {
        await rename(file, join(spoolDirectory, `segment-${Date.now()}-${randomUUID()}.ndjson`));
      }
    } catch (error) {
      if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
    }
    const handle = await open(file, "a+", 0o600);
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
        // Take back whatever part of this event landed, so the failure leaves no partial line.
        await handle.truncate(size).catch(() => {});
        throw error;
      }
    } finally {
      await handle.close();
    }
    await chmod(file, 0o600);
  } finally {
    await release();
  }
}

/** @param {string} spoolDirectory */
async function acquireSpoolLock(spoolDirectory) {
  const lock = join(spoolDirectory, ".writer.lock");
  const token = randomUUID();
  for (let attempt = 0; attempt < 4; attempt += 1) {
    try {
      const handle = await open(lock, "wx", 0o600);
      await handle.writeFile(`${JSON.stringify({ pid: process.pid, token })}\n`, "utf8");
      await handle.sync();
      if ((await readSpoolLock(lock))?.token !== token) {
        await handle.close();
        if (attempt < 3) continue;
        throw new Error("Spool writer lost lock ownership.");
      }
      return async () => {
        await handle.close();
        if ((await readSpoolLock(lock))?.token === token) await rm(lock, { force: true });
      };
    } catch (error) {
      if (!(error instanceof Error && "code" in error && error.code === "EEXIST")) throw error;
      const owner = await readSpoolLock(lock);
      // Age decides before the pid does: a pid that answers `kill(pid, 0)` may have been reused,
      // or belong to another user, and a lock held that long is not being used by anyone.
      if ((owner !== null && !processIsAlive(owner.pid)) || (await lockIsStale(lock))) {
        await rm(lock, { force: true });
        continue;
      }
      if (attempt < 3) await delay(2);
    }
  }
  throw new Error("Spool writer is busy.");
}

/** @param {import("node:fs/promises").FileHandle} handle @param {number} size */
async function endsWithNewline(handle, size) {
  const last = Buffer.alloc(1);
  await handle.read(last, 0, 1, size - 1);
  return last[0] === 0x0a;
}

/** @param {string} lock */
async function lockIsStale(lock) {
  try {
    return Date.now() - (await stat(lock)).mtimeMs > staleLockMs;
  } catch {
    return false;
  }
}

/** @param {string} lock */
async function readSpoolLock(lock) {
  try {
    const value = JSON.parse(await readFile(lock, "utf8"));
    return recordOrNull(value) &&
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

/** @param {unknown} output */
function analyzePrompt(output) {
  const parts = recordOrNull(output)?.parts;
  const records = Array.isArray(parts) ? parts.map(recordOrNull).filter(Boolean) : [];
  const text = records
    .filter((part) => part?.type === "text" && typeof part.text === "string")
    .map((part) => String(part?.text))
    .join("\n");
  const lines = text === "" ? 0 : text.split("\n").length;
  const blocks = (text.match(/```/gu) ?? []).length / 2;
  return {
    analyzer_version: "opencode-input-v1",
    estimated_input_tokens: Math.round(text.length / 100) * 25,
    line_count_bucket: lineBucket(lines),
    code_block_count_bucket: codeBlockBucket(blocks),
    attachment_count: records.filter((part) => part?.type === "file").length,
  };
}

/** @param {number} lines */
function lineBucket(lines) {
  if (lines === 0) return "0";
  if (lines <= 10) return "1-10";
  if (lines <= 50) return "11-50";
  if (lines <= 200) return "51-200";
  return "201+";
}

/** @param {number} blocks */
function codeBlockBucket(blocks) {
  if (blocks === 0) return "0";
  if (blocks === 1) return "1";
  if (blocks <= 4) return "2-4";
  return "5+";
}

/** @param {unknown} value */
function bindingMap(value) {
  const bindings = new Map();
  if (!Array.isArray(value)) return bindings;
  for (const binding of value) {
    const record = recordOrNull(binding);
    const provider = stringOrNull(record?.provider);
    const sourceAlias = stringOrNull(record?.source_alias);
    const directory = stringOrNull(record?.spool_directory);
    if (provider && sourceAlias && directory) bindings.set(provider, directory);
  }
  return bindings;
}

/** @param {Record<string, unknown> | null} error */
function isExplicitRateLimit(error) {
  const data = recordOrNull(error?.data);
  return stringOrNull(error?.name) === "APIError" && data?.statusCode === 429;
}

/** @param {unknown} value */
function timestampOrNow(value) {
  if (typeof value === "string") {
    const parsed = new Date(value);
    const year = parsed.getUTCFullYear();
    // `toISOString` spells a year outside 0000-9999 with a sign and six digits, which the schema's
    // `date-time` refuses -- the line would be read back as corruption.
    if (!Number.isNaN(parsed.getTime()) && year >= 0 && year <= 9999) return parsed.toISOString();
  }
  return new Date().toISOString();
}

/** @param {unknown} value */
function stringOrNull(value) {
  return typeof value === "string" && value.length > 0 ? value : null;
}

/** @param {unknown} value */
function recordOrNull(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? /** @type {Record<string, unknown>} */ (value)
    : null;
}

/**
 * Refuse an event whose host-supplied identifiers do not fit the published schema.
 *
 * This is the whole of what a writer can get wrong. Every other field of an event -- the versions,
 * the domains, the event type and the completion/outcome/restrictions triple the schema constrains
 * per type -- is a literal written a few lines above, so re-deriving it from the assembled object
 * only restated the constructor. What OpenCode supplies is different: session and message ids, a
 * provider and a model name, none of them bounded by the host. An id longer than the schema allows
 * cannot be written, because `spool.js` validates the same schema on the way back in and would
 * report the line as corruption rather than as a prompt that was never representable.
 *
 * @param {Record<string, unknown>} event
 */
function withinSchemaBounds(event) {
  return (
    bounded(event.event_id, 200) &&
    bounded(event.installation_id, 200) &&
    bounded(event.source_prompt_id, 200) &&
    bounded(event.source_session_id, 200) &&
    bounded(event.revision, 200) &&
    (event.provider === null || bounded(event.provider, 100)) &&
    (event.model === null || bounded(event.model, 200))
  );
}

/** @param {unknown} value @param {number} maximum */
function bounded(value, maximum) {
  return typeof value === "string" && value.length > 0 && value.length <= maximum;
}
