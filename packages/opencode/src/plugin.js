import { randomUUID } from "node:crypto";
import { chmod, mkdir, open, readFile, rename, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import process from "node:process";
import { setTimeout as delay } from "node:timers/promises";

const spoolFilename = "current.open";
const maxPendingWrites = 100;
const maxSegmentBytes = 1024 * 1024;

/**
 * Fail-open OpenCode plugin entrypoint.
 *
 * @param {unknown} _context
 * @param {{installation_id?: unknown, spool_directory?: unknown, prospective_analysis?: unknown, source_bindings?: unknown}} [options]
 */
export async function SnackOpenCodePlugin(_context, options = {}) {
  const installationId = stringOrNull(options.installation_id);
  const spoolDirectory = stringOrNull(options.spool_directory);
  const captureFeatures = options.prospective_analysis === true;
  const sourceBindings = bindingMap(options.source_bindings);
  /** @type {Map<string, {promptId: string, provider: string | null, model: string | null, spoolDirectory: string, buffered: Record<string, unknown>[]}>} */
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
    if (!installationId || !targetDirectory || !isSpoolEvent(event)) {
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
   * OpenCode declares `model` optional on `chat.message` and does not send it on `1.18.10`, so the
   * routing decision cannot be taken there. An event written to `_pending` is never attributed and
   * never revisited, so a prompt whose provider is still unknown is held rather than misfiled, and
   * released as soon as `chat.params` names one. A prompt whose provider never arrives is released
   * to `_pending` at the terminal event, which is where it would have gone anyway.
   *
   * @param {{provider: string | null, model: string | null, spoolDirectory: string, buffered: Record<string, unknown>[]}} prompt
   */
  const release = (prompt) => {
    for (const event of prompt.buffered.splice(0)) {
      append(prompt.spoolDirectory, { ...event, provider: prompt.provider, model: prompt.model });
    }
  };

  return {
    async dispose() {
      for (const prompt of prompts.values()) release(prompt);
      await writes;
    },
    async "chat.params"(/** @type {Record<string, unknown>} */ input) {
      try {
        const sessionId = stringOrNull(input.sessionID);
        const prompt = sessionId ? prompts.get(sessionId) : undefined;
        if (!prompt || prompt.provider || !spoolDirectory) return;
        const model = recordOrNull(input.model);
        const provider = stringOrNull(model?.providerID);
        if (!provider) return;
        prompt.provider = provider;
        prompt.model = stringOrNull(model?.modelID);
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
        const model = recordOrNull(input.model);
        const provider = stringOrNull(model?.providerID);
        const modelId = stringOrNull(model?.modelID);
        const targetDirectory = provider
          ? (sourceBindings.get(provider) ?? join(spoolDirectory, "_pending"))
          : join(spoolDirectory, "_pending");
        if (!targetDirectory) return;
        const prompt = {
          promptId,
          provider,
          model: modelId,
          spoolDirectory: targetDirectory,
          /** @type {Record<string, unknown>[]} */ buffered: [],
        };
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
        if (type !== "session.idle" && type !== "session.error") return;
        const properties = recordOrNull(event?.properties) ?? {};
        const sessionId = stringOrNull(properties.sessionID);
        const prompt = sessionId ? prompts.get(sessionId) : undefined;
        if (!sessionId || !prompt) return;
        const occurredAt = timestampOrNow(properties.time);
        const error = recordOrNull(properties.error);
        const restricted = type === "session.error" && isExplicitRateLimit(error);
        release(prompt);
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
    const handle = await open(file, "a", 0o600);
    try {
      await handle.writeFile(`${JSON.stringify(event)}\n`, "utf8");
      await handle.sync();
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
      if (owner !== null && !processIsAlive(owner.pid)) {
        await rm(lock, { force: true });
        continue;
      }
      if (owner === null && (await lockIsStale(lock))) {
        await rm(lock, { force: true });
        continue;
      }
      if (attempt < 3) await delay(2);
    }
  }
  throw new Error("Spool writer is busy.");
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
  if (typeof value === "string" && !Number.isNaN(Date.parse(value)))
    return new Date(value).toISOString();
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

/** @param {Record<string, unknown>} event */
function isSpoolEvent(event) {
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
  return (
    Object.keys(event).every((key) => allowed.has(key)) &&
    event.schema_version === 1 &&
    boundedString(event.event_id, 200) &&
    boundedString(event.installation_id, 200) &&
    boundedString(event.source_prompt_id, 200) &&
    boundedString(event.source_session_id, 200) &&
    boundedString(event.revision, 200) &&
    timestamp(event.occurred_at) &&
    nullableBoundedString(event.provider, 100) &&
    nullableBoundedString(event.model, 200) &&
    Array.isArray(event.usage_slices) &&
    event.usage_slices.length === 0 &&
    Array.isArray(event.restrictions) &&
    event.restrictions.length <= 20 &&
    event.restrictions.every((restriction) => {
      const record = recordOrNull(restriction);
      return (
        record !== null &&
        Object.keys(record).every((key) =>
          ["class", "source_code", "observed_at", "classifier_version"].includes(key),
        ) &&
        ["rate_limit", "usage_limit", "capacity_policy", "other_explicit_limit"].includes(
          String(record.class),
        ) &&
        boundedString(record.source_code, 100) &&
        timestamp(record.observed_at) &&
        record.classifier_version === "opencode-plugin-error-v1"
      );
    }) &&
    validEventState(event) &&
    (event.input_features === undefined || isInputFeatures(event.input_features))
  );
}

/** @param {unknown} value */
function isInputFeatures(value) {
  const record = recordOrNull(value);
  return (
    record !== null &&
    Object.keys(record).every((key) =>
      [
        "analyzer_version",
        "estimated_input_tokens",
        "line_count_bucket",
        "code_block_count_bucket",
        "attachment_count",
      ].includes(key),
    ) &&
    record.analyzer_version === "opencode-input-v1" &&
    Number.isSafeInteger(record.estimated_input_tokens) &&
    typeof record.estimated_input_tokens === "number" &&
    record.estimated_input_tokens >= 0 &&
    ["0", "1-10", "11-50", "51-200", "201+"].includes(String(record.line_count_bucket)) &&
    ["0", "1", "2-4", "5+"].includes(String(record.code_block_count_bucket)) &&
    Number.isSafeInteger(record.attachment_count) &&
    typeof record.attachment_count === "number" &&
    record.attachment_count >= 0
  );
}

/** @param {unknown} value @param {number} maximum */
function boundedString(value, maximum) {
  return typeof value === "string" && value.length > 0 && value.length <= maximum;
}

/** @param {unknown} value @param {number} maximum */
function nullableBoundedString(value, maximum) {
  return value === null || boundedString(value, maximum);
}

/** @param {unknown} value */
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
