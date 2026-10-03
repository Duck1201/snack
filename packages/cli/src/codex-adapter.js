import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";
import { closeSync, openSync, readFileSync, readSync, readdirSync, statSync } from "node:fs";
import { homedir as systemHomedir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";

import { ExitCode, SnackError } from "./errors.js";

/**
 * The two Codex rollout families this adapter reads.
 *
 * `cx-rollout-tokencount-v1` is Codex `0.145`–`0.147`: per-turn usage exists only on token counts.
 * `cx-rollout-usagerecord-v1` is Codex `0.159`: a `token_usage_record` per model response and a
 * `root_turn_id` on every turn. One sessions tree holds both at once, and a rollout resumed by a
 * later Codex holds both in one file, so a turn's slice source is decided per turn and a directory
 * is supported when every turn belongs to one of them.
 */
export const CODEX_FAMILIES = Object.freeze(
  /** @type {const} */ (["cx-rollout-tokencount-v1", "cx-rollout-usagerecord-v1"]),
);

const TOKENCOUNT = CODEX_FAMILIES[0];
const USAGERECORD = CODEX_FAMILIES[1];

const usageFields = [
  "input_tokens",
  "cached_input_tokens",
  "cache_write_input_tokens",
  "output_tokens",
  "reasoning_output_tokens",
  "total_tokens",
];

const windowFields = ["used_percent", "window_minutes", "resets_at"];

/**
 * Every path the reader is permitted to look at, per record kind. Nothing else is ever read.
 *
 * Codex rollouts carry the user's messages, the model's answers and reasoning, tool calls and their
 * output, the working directory, git remotes, and workspace roots in the very same files as the
 * usage figures. Reading by exclusion would mean every new field Codex adds is read until someone
 * notices; reading by allowlist means a new field is never read until someone decides to. So the
 * list is the reader's only way in: `field()` refuses a path that is not on it, which makes this
 * constant the enforcement rather than the documentation of it.
 *
 * `payload.forked_from_id` is read for presence only, `payload.rate_limits.spend_control_reached`
 * for null-ness only, and `payload.error.codex_error_info` for its string or the single key of its
 * object — never that object's value. `rate_limits.credits` is deliberately absent: it states money,
 * not capacity.
 */
export const CODEX_FIELD_ALLOWLIST = Object.freeze({
  every_line: Object.freeze(["type", "ordinal", "timestamp", "payload.type"]),
  session_meta: Object.freeze([
    "payload.id",
    "payload.cli_version",
    "payload.model_provider",
    "payload.thread_source",
    "payload.parent_thread_id",
    "payload.forked_from_id",
    "payload.subagent_history_start_ordinal",
  ]),
  turn_context: Object.freeze(["payload.turn_id", "payload.model"]),
  task_started: Object.freeze(["payload.turn_id", "payload.root_turn_id"]),
  task_complete: Object.freeze([
    "payload.turn_id",
    "payload.duration_ms",
    "payload.error",
    "payload.error.codex_error_info",
  ]),
  turn_aborted: Object.freeze(["payload.turn_id", "payload.reason"]),
  token_count: Object.freeze([
    "payload.info",
    "payload.info.last_token_usage",
    ...usageFields.map((name) => `payload.info.last_token_usage.${name}`),
    "payload.info.total_token_usage",
    ...usageFields.map((name) => `payload.info.total_token_usage.${name}`),
    "payload.rate_limits",
    "payload.rate_limits.limit_id",
    "payload.rate_limits.plan_type",
    "payload.rate_limits.rate_limit_reached_type",
    "payload.rate_limits.spend_control_reached",
    "payload.rate_limits.primary",
    ...windowFields.map((name) => `payload.rate_limits.primary.${name}`),
    "payload.rate_limits.secondary",
    ...windowFields.map((name) => `payload.rate_limits.secondary.${name}`),
  ]),
  token_usage_record: Object.freeze([
    "payload.turn_id",
    "payload.root_turn_id",
    "payload.response_id",
    "payload.usage",
    ...usageFields.map((name) => `payload.usage.${name}`),
  ]),
});

/**
 * Codex writes `rate_limit_reached_type` when a usage condition was reached. These three name the
 * provider refusing more usage; the `*_credits_depleted` values name money running out.
 */
const reachedRestrictions = new Set([
  "rate_limit_reached",
  "workspace_owner_usage_limit_reached",
  "workspace_member_usage_limit_reached",
]);

/** `codex_error_info` values that are the provider refusing usage, not an operational failure. */
const errorRestrictions = new Set(["usage_limit_exceeded", "rate_limit_exceeded"]);

/**
 * A code Codex wrote, reduced to something that can only be a code.
 *
 * Every value this adapter stores as a classification comes from an enumeration Codex defines, but
 * an enumeration is a promise the file cannot keep for SNACK. A value that is not shaped like an
 * identifier is stored as `unrecognized` rather than verbatim, so the classification path can never
 * carry text into the database.
 */
const codePattern = /^[a-z0-9_]{1,64}$/u;

/** A limit or plan label: stored and shown, so it is held to an identifier's shape. */
const labelPattern = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u;

const CLASSIFIER_VERSION = "codex-error-v1";
const PARSER_VERSION = "codex-rollout-v1";
const RATE_LIMITS_PARSER_VERSION = "codex-rate-limits-v1";

/**
 * Resolve Codex CLI's sessions directory without opening anything else Codex keeps.
 *
 * `CODEX_HOME` is Codex's own variable for relocating its home. Only `<home>/sessions` and its
 * sibling `<home>/archived_sessions` are ever listed; the home directory itself is not, which is
 * what keeps the prompt-history file Codex writes beside them out of reach.
 *
 * A relative `CODEX_HOME` is resolved against the working directory, because that is what Codex
 * does (`find_codex_home` canonicalizes the value); an empty one is unset, as it is to Codex.
 * Setup records the resolved path, so a later `sync` from another directory reads the same history.
 *
 * @param {{env?: NodeJS.ProcessEnv, home?: string, cwd?: string}} [options]
 */
export function resolveCodexSessionsDirectory(options = {}) {
  const env = options.env ?? process.env;
  const configured = env.CODEX_HOME;
  const codexHome = configured
    ? resolve(options.cwd ?? process.cwd(), configured)
    : join(options.home ?? systemHomedir(), ".codex");
  return join(codexHome, "sessions");
}

/**
 * Whether a configured source is read from Codex CLI.
 *
 * @param {{adapter: string}} source
 */
export function isCodexSource(source) {
  return source.adapter === "codex";
}

/**
 * @typedef {object} ReportedCapacityWindow
 * @property {number} window_minutes   positive integer
 * @property {number} used_percent     0..100 inclusive
 * @property {string | null} resets_at ISO-8601 UTC, from epoch seconds
 */
/**
 * @typedef {object} ReportedCapacitySnapshot
 * @property {string} observation_key  64 hex chars; stable across re-reads and file moves
 * @property {string} observed_at      ISO-8601 UTC (the token count's timestamp)
 * @property {string | null} limit_id
 * @property {string | null} plan_type
 * @property {ReportedCapacityWindow[]} windows  1..2 entries, distinct window_minutes
 * @property {string} parser_version   "codex-rate-limits-v1"
 * @property {string} provider         the thread's `model_provider`, which routes the snapshot
 */
/**
 * @typedef {{files: Record<string, number>, threads: Record<string, {thread: string, parent: string | null}>}} CodexCursor
 */

/**
 * Create the internal Codex CLI source-adapter port.
 *
 * @param {{sessionsDirectory: string}} options
 */
export function createCodexAdapter(options) {
  const home = dirname(options.sessionsDirectory);
  return {
    detect() {
      const versions = new Set();
      for (const file of listRolloutFiles(home).files) {
        const meta = readFirstRecord(file);
        const version = readObject(meta, "payload")?.cli_version;
        if (typeof version === "string") versions.add(version);
      }
      return { detected: true, client: "codex", versions: [...versions].sort() };
    },
    fingerprint() {
      try {
        return fingerprintOf(scan(home));
      } catch (error) {
        // Drift is an answer to the fingerprint's question, not a failure to ask it. An unreadable
        // sessions directory still throws `source_unavailable`, as it does for Claude Code.
        if (!(error instanceof SnackError) || error.reason !== "source_schema_unsupported") {
          throw error;
        }
        return {
          adapter: "codex-jsonl",
          fingerprint_version: 1,
          family: null,
          families: [],
          supported: false,
        };
      }
    },
    readAll() {
      return this.readSince(null);
    },
    /** @param {CodexCursor | null} cursor */
    readSince(cursor) {
      return read(home, cursor);
    },
    health() {
      try {
        const scanned = scan(home);
        const fingerprint = fingerprintOf(scanned);
        return {
          status: fingerprint.supported ? "compatible" : "incompatible",
          accessible: true,
          fingerprint: {
            family: fingerprint.family,
            families: fingerprint.families,
            supported: fingerprint.supported,
          },
          skipped_fork_files: scanned.skippedForkFiles,
          skipped_subagent_turns: scanned.skippedSubagentTurns,
          dropped_reported_snapshots: scanned.droppedSnapshots,
          compressed_files: scanned.compressedFiles,
        };
      } catch (error) {
        const drifted = error instanceof SnackError && error.reason === "source_schema_unsupported";
        return {
          status: drifted ? "incompatible" : "inaccessible",
          accessible: drifted,
          fingerprint: { family: null, families: [], supported: false },
          skipped_fork_files: 0,
          skipped_subagent_turns: 0,
          dropped_reported_snapshots: 0,
          compressed_files: 0,
        };
      }
    },
  };
}

/**
 * Parse every rollout once and say what was found, without assembling prompts.
 *
 * @param {string} home
 */
function scan(home) {
  const listing = listRolloutFiles(home);
  /** @type {ParsedFile[]} */
  const parsed = [];
  for (const file of listing.files) {
    const result = parseFile(home, file, []);
    if (result !== null) parsed.push(result);
  }
  return {
    parsed,
    skippedForkFiles: parsed.filter((file) => file.skippedFork || file.partlySkippedFork).length,
    skippedSubagentTurns: parsed.reduce((sum, file) => sum + file.skippedSubagentTurns, 0),
    droppedSnapshots: parsed.reduce(
      (sum, file) => sum + (file.skippedFork ? 0 : file.droppedSnapshots),
      0,
    ),
    compressedFiles: listing.compressed,
  };
}

/** @param {ReturnType<typeof scan>} scanned */
function fingerprintOf(scanned) {
  const families = [...new Set(scanned.parsed.flatMap((file) => file.families))].sort();
  const newest = scanned.parsed.toSorted((left, right) => right.mtimeMs - left.mtimeMs)[0];
  // Drift throws before this point, so whatever is present is supported -- including nothing.
  // A history with no rollout yet is one `sync` reads without complaint, and calling it
  // unsupported would send someone to update SNACK for a directory Codex has not written to.
  // `family` stays null there, which is what setup refuses: it has no family to record.
  return {
    adapter: "codex-jsonl",
    fingerprint_version: 1,
    family: newest ? newest.family : null,
    families,
    supported: true,
  };
}

/**
 * Read a Codex home, skipping thread families none of whose files has moved since the cursor.
 *
 * The unit of skipping is the thread family — a user thread and every subagent thread beneath it —
 * not the file. A root prompt's revision depends on what its subagents wrote, so a subagent file
 * that moved re-reads its parent's prompts too; reading only the moved file would emit a prompt
 * missing the parent's own turns.
 *
 * @param {string} home
 * @param {CodexCursor | null} cursor
 */
function read(home, cursor) {
  /** @type {{segment: string, line_offset: number}[]} */
  const rejected = [];
  const listing = listRolloutFiles(home);
  /** @type {Map<string, ParsedFile>} */
  const parsedByKey = new Map();
  /** @type {{key: string, file: string, mtimeMs: number, thread: string, parent: string | null, changed: boolean}[]} */
  const entries = [];
  for (const file of listing.files) {
    const key = fileKey(home, file);
    const mtimeMs = modifiedAt(file);
    const known = cursor?.threads?.[key];
    const changed = cursor === null || (cursor.files?.[key] ?? -1) < mtimeMs || !known;
    if (!changed && known) {
      entries.push({ key, file, mtimeMs, thread: known.thread, parent: known.parent, changed });
      continue;
    }
    const parsed = parseFile(home, file, rejected);
    // A file with no complete first line is a rollout Codex has only just opened. It is not
    // recorded in the cursor, so the next read looks at it again.
    if (parsed === null) continue;
    parsedByKey.set(key, parsed);
    entries.push({
      key,
      file,
      mtimeMs,
      thread: hashThread(parsed.thread),
      parent: parsed.parent === null ? null : hashThread(parsed.parent),
      changed,
    });
  }

  const rootOf = familyRoots(entries);
  const changedFamilies = new Set(
    entries.filter((entry) => entry.changed).map((entry) => rootOf(entry.thread)),
  );
  /** @type {Map<string, ParsedFile[]>} */
  const families = new Map();
  for (const entry of entries) {
    const family = rootOf(entry.thread);
    if (!changedFamilies.has(family)) continue;
    let parsed = parsedByKey.get(entry.key);
    if (parsed === undefined) {
      const reparsed = parseFile(home, entry.file, rejected);
      if (reparsed === null) continue;
      parsed = reparsed;
    }
    const members = families.get(family);
    if (members) members.push(parsed);
    else families.set(family, [parsed]);
  }

  const observations = [];
  /** @type {ReportedCapacitySnapshot[]} */
  const reportedCapacity = [];
  for (const members of families.values()) {
    const readable = members.filter((file) => !file.skippedFork);
    observations.push(...assemblePrompts(readable));
    for (const file of readable) reportedCapacity.push(...readSnapshots(file));
  }

  /** @type {CodexCursor} */
  const nextCursor = { files: {}, threads: {} };
  for (const entry of entries) {
    nextCursor.files[entry.key] = entry.mtimeMs;
    nextCursor.threads[entry.key] = { thread: entry.thread, parent: entry.parent };
  }
  return {
    observations,
    rejected,
    cursor: nextCursor,
    reported_capacity: reportedCapacity,
  };
}

/**
 * Map each thread to the root of its family by following parent links among present threads.
 *
 * A parent that is not present makes its child the root of a family of its own: the child's turns
 * then form orphan prompts, which is the reading `assemblePrompts` gives them.
 *
 * @param {{thread: string, parent: string | null}[]} entries
 */
function familyRoots(entries) {
  /** @type {Map<string, string | null>} */
  const parents = new Map();
  for (const entry of entries) parents.set(entry.thread, entry.parent);
  /** @param {string} thread */
  return (thread) => {
    let current = thread;
    const seen = new Set([current]);
    for (;;) {
      const parent = parents.get(current);
      if (parent === null || parent === undefined || !parents.has(parent) || seen.has(parent)) {
        return current;
      }
      seen.add(parent);
      current = parent;
    }
  };
}

/**
 * @typedef {object} ParsedFile
 * @property {string} key
 * @property {number} mtimeMs
 * @property {string} thread
 * @property {string | null} parent
 * @property {boolean} subagent
 * @property {string} provider
 * @property {string} family the newest writer's family: usage-record once any turn carries one
 * @property {string[]} families every family a turn of this file belongs to
 * @property {Set<string>} usageTurns turns whose usage Codex recorded per response
 * @property {boolean} skippedFork
 * @property {boolean} partlySkippedFork a resumed legacy fork whose token-count turns are not read
 * @property {number} droppedSnapshots token counts whose stated figure was not one, so not quoted
 * @property {number} skippedSubagentTurns subagent turns that name no root, so belong to no prompt
 * @property {Projected[]} records records at or past the fork-replay boundary, in file order
 */
/**
 * @typedef {{kind: "session_meta", ordinal: number, at: number, meta: SessionMeta}
 *   | {kind: "turn_context", ordinal: number, at: number, turn_id: string, model: string | null}
 *   | {kind: "task_started", ordinal: number, at: number, turn_id: string, root_turn_id: string | null}
 *   | {kind: "task_complete", ordinal: number, at: number, turn_id: string, duration_ms: number | null, error_code: string | null}
 *   | {kind: "turn_aborted", ordinal: number, at: number, turn_id: string, reason: string}
 *   | {kind: "token_count", ordinal: number, at: number, last: Usage | null, total: Usage | null, rate_limits: RateLimits | null}
 *   | {kind: "token_usage_record", ordinal: number, at: number, turn_id: string, root_turn_id: string, response_id: string, usage: Usage}} Projected
 */
/**
 * @typedef {{id: string | null, cli_version: string | null, model_provider: string | null, thread_source: "user" | "subagent" | null, parent_thread_id: string | null, forked: boolean, history_start: number | null}} SessionMeta
 * @typedef {{input_tokens: number, cached_input_tokens: number, cache_write_input_tokens: number | null, output_tokens: number, reasoning_output_tokens: number, total_tokens: number}} Usage
 * @typedef {{limit_id: string | null, plan_type: string | null, reached: string | null, spend_control_reached: boolean, windows: ReportedCapacityWindow[], invalid: boolean}} RateLimits
 */

/**
 * Parse one rollout into projected records, refusing it on drift.
 *
 * Each line is parsed, projected to the allowlist, and the parsed object dropped before the next
 * line is touched. Nothing downstream ever holds a raw record.
 *
 * @param {string} home
 * @param {string} file
 * @param {{segment: string, line_offset: number}[]} rejected
 * @returns {ParsedFile | null} null for a file with no complete first line
 */
function parseFile(home, file, rejected) {
  let content;
  let mtimeMs;
  try {
    content = readFileSync(file, "utf8");
    mtimeMs = statSync(file).mtimeMs;
  } catch (error) {
    // A rollout archived or deleted between listing and reading is absence of evidence. Anything
    // else -- a file SNACK may not read, one too large to hold -- is a history that cannot be read
    // in full, and a read that skipped it would report a quietly smaller history as complete.
    if (isMissing(error)) return null;
    throw unavailable();
  }
  const key = fileKey(home, file);
  const lines = content.split("\n");
  /** @type {Projected[]} */
  const records = [];
  /** @type {SessionMeta | null} */
  let meta = null;
  /** @type {Set<string>} */
  const usageTurns = new Set();
  /** @type {string[]} */
  const startedTurns = [];
  for (const [index, line] of lines.entries()) {
    if (line === "") continue;
    const last = index === lines.length - 1;
    const projected = projectLine(line);
    if (projected === "unparseable") {
      // The last line of a file that does not end in a newline is a rollout Codex is writing
      // right now. Any other line that does not parse is damage, and a history that skipped it
      // would be quietly incomplete.
      if (last) continue;
      throw drift();
    }
    if (meta === null) {
      if (
        projected === null ||
        projected === "reject" ||
        projected.kind !== "session_meta" ||
        projected.ordinal !== 0
      ) {
        throw drift();
      }
      if (
        projected.meta.id === null ||
        projected.meta.cli_version === null ||
        projected.meta.model_provider === null
      ) {
        throw drift();
      }
      meta = projected.meta;
      continue;
    }
    if (projected === "reject") {
      rejected.push({ segment: key, line_offset: index + 1 });
      continue;
    }
    if (projected === null) continue;
    if (projected.kind === "token_usage_record") usageTurns.add(projected.turn_id);
    if (projected.kind === "task_started") {
      startedTurns.push(projected.turn_id);
      if (projected.root_turn_id !== null) usageTurns.add(projected.turn_id);
    }
    records.push(projected);
  }
  if (meta === null) return null;
  // Codex never rewrites a rollout, but it does append to one: a thread started by 0.147 and
  // resumed by 0.159 holds turns of both families in one file. So the family is a property of each
  // turn, and the file reports every family its turns belong to. The file's own family is the one
  // its newest writer used, which is the usage-record family as soon as any turn carries one.
  const families = new Set(
    startedTurns.map((turnId) => (usageTurns.has(turnId) ? USAGERECORD : TOKENCOUNT)),
  );
  if (usageTurns.size > 0) families.add(USAGERECORD);
  if (families.size === 0) families.add(TOKENCOUNT);
  const family = families.has(USAGERECORD) ? USAGERECORD : TOKENCOUNT;
  const subagent = meta.thread_source === "subagent";
  // The replay boundary of a forked subagent is not recoverable in the token-count family: Codex
  // set it to the file's length, so honouring it drops the subagent's own turn and ignoring it
  // re-counts the parent. Undercounting a superseded family's subagents is the bounded error.
  const skippedFork = family === TOKENCOUNT && subagent && meta.forked;
  const start = meta.history_start ?? 0;
  // The same boundary in a legacy fork that a later Codex resumed: the new turns are read, but the
  // token-count turns below the boundary are not, and nothing here can say which of them were the
  // subagent's own. Counted with the skipped forks, so doctor does not go quiet about them.
  const partlySkippedFork =
    !skippedFork &&
    subagent &&
    meta.forked &&
    records.some(
      (record) =>
        record.kind === "task_started" && record.ordinal < start && !usageTurns.has(record.turn_id),
    );
  // A forked subagent begins with a verbatim copy of its parent's history. Counting it would
  // charge every forked agent with its parent's usage again.
  const kept = records.filter((record) => record.ordinal >= start);
  return {
    key,
    mtimeMs,
    thread: /** @type {string} */ (meta.id),
    parent: meta.parent_thread_id,
    subagent,
    provider: /** @type {string} */ (meta.model_provider),
    family,
    families: [...families].sort(),
    usageTurns,
    skippedFork,
    partlySkippedFork,
    droppedSnapshots: kept.filter(
      (record) => record.kind === "token_count" && record.rate_limits?.invalid === true,
    ).length,
    skippedSubagentTurns:
      subagent && !skippedFork
        ? kept.filter((record) => opensNoPrompt(record, subagent)).length
        : 0,
    records: kept,
  };
}

/**
 * Whether a turn is a subagent's that names no root turn.
 *
 * Only a user thread's `task_started` opens a prompt. A subagent turn joins the prompt its
 * `root_turn_id` names; in the token-count family there is no such field, and nothing else in the
 * rollout says which of the parent's turns spawned the agent, so the turn belongs to no prompt.
 * Opening one would count every subagent turn as a submission the user never made.
 *
 * @param {Projected} record
 * @param {boolean} subagent
 */
function opensNoPrompt(record, subagent) {
  return subagent && record.kind === "task_started" && record.root_turn_id === null;
}

/**
 * Parse one line and project it, so the parsed object never outlives this call.
 *
 * @param {string} line
 * @returns {Projected | null | "reject" | "unparseable"}
 */
function projectLine(line) {
  /** @type {unknown} */
  let raw;
  try {
    raw = JSON.parse(line);
  } catch {
    return "unparseable";
  }
  return project(raw);
}

/**
 * Project one parsed line onto the allowlist.
 *
 * @param {unknown} raw
 * @returns {Projected | null | "reject"} null for a record type this reader does not read;
 *   "reject" for a line that is not a record at all
 */
function project(raw) {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return "reject";
  const line = /** @type {Record<string, unknown>} */ (raw);
  if (typeof line.type !== "string") return "reject";
  let kind = line.type;
  if (kind === "event_msg") {
    const payload = line.payload;
    if (typeof payload !== "object" || payload === null || Array.isArray(payload)) return "reject";
    const inner = /** @type {Record<string, unknown>} */ (payload).type;
    // A discriminator that is not a string is not a record type from a later release, which is
    // what skipping exists for. It is a line this reader cannot classify.
    if (typeof inner !== "string") return "reject";
    kind = inner;
  }
  if (!Object.hasOwn(CODEX_FIELD_ALLOWLIST, kind) || kind === "every_line") return null;
  const allowed = /** @type {keyof typeof CODEX_FIELD_ALLOWLIST} */ (kind);
  const field = reader(line, allowed);
  const ordinal = field("ordinal");
  const at = Date.parse(String(field("timestamp")));
  if (!Number.isSafeInteger(ordinal) || Number(ordinal) < 0 || !Number.isFinite(at)) throw drift();
  const base = { ordinal: Number(ordinal), at };
  switch (allowed) {
    case "session_meta":
      return { kind: "session_meta", ...base, meta: projectMeta(field) };
    case "turn_context": {
      const model = field("payload.model");
      if (model !== undefined && typeof model !== "string") throw drift();
      return {
        kind: "turn_context",
        ...base,
        turn_id: requireString(field("payload.turn_id")),
        model: typeof model === "string" ? model : null,
      };
    }
    case "task_started": {
      const root = field("payload.root_turn_id");
      if (root !== undefined && typeof root !== "string") throw drift();
      return {
        kind: "task_started",
        ...base,
        turn_id: requireString(field("payload.turn_id")),
        root_turn_id: typeof root === "string" ? root : null,
      };
    }
    case "task_complete": {
      const duration = field("payload.duration_ms");
      if (duration !== undefined && (typeof duration !== "number" || !(duration >= 0))) {
        throw drift();
      }
      return {
        kind: "task_complete",
        ...base,
        turn_id: requireString(field("payload.turn_id")),
        duration_ms: typeof duration === "number" ? duration : null,
        error_code: projectErrorCode(field),
      };
    }
    case "turn_aborted":
      return {
        kind: "turn_aborted",
        ...base,
        turn_id: requireString(field("payload.turn_id")),
        reason: code(requireString(field("payload.reason"))),
      };
    case "token_count": {
      const info = field("payload.info");
      let last = null;
      let total = null;
      if (info !== undefined && info !== null) {
        if (!isObject(info)) throw drift();
        last = projectUsage(field, "payload.info.last_token_usage");
        total = projectUsage(field, "payload.info.total_token_usage");
      }
      return {
        kind: "token_count",
        ...base,
        last,
        total,
        rate_limits: projectRateLimits(field),
      };
    }
    case "token_usage_record":
      return {
        kind: "token_usage_record",
        ...base,
        turn_id: requireString(field("payload.turn_id")),
        root_turn_id: requireString(field("payload.root_turn_id")),
        response_id: requireString(field("payload.response_id")),
        usage: projectUsage(field, "payload.usage"),
      };
  }
  return null;
}

/**
 * Build the only accessor a projection may use: one that reads a dotted path, and only a path the
 * allowlist names for this record kind or for every line.
 *
 * @param {Record<string, unknown>} line
 * @param {keyof typeof CODEX_FIELD_ALLOWLIST} kind
 */
function reader(line, kind) {
  const allowed = new Set([...CODEX_FIELD_ALLOWLIST.every_line, ...CODEX_FIELD_ALLOWLIST[kind]]);
  /** @param {string} path @returns {unknown} */
  return (path) => {
    if (!allowed.has(path)) {
      throw new Error(`Codex reader asked for a field outside its allowlist: ${kind}/${path}`);
    }
    /** @type {unknown} */
    let value = line;
    for (const part of path.split(".")) {
      if (!isObject(value)) return undefined;
      value = /** @type {Record<string, unknown>} */ (value)[part];
    }
    return value;
  };
}

/** @param {(path: string) => unknown} field @returns {SessionMeta} */
function projectMeta(field) {
  const source = field("payload.thread_source");
  if (source !== undefined && source !== "user" && source !== "subagent") throw drift();
  const start = field("payload.subagent_history_start_ordinal");
  if (start !== undefined && (!Number.isSafeInteger(start) || Number(start) < 0)) throw drift();
  const parent = field("payload.parent_thread_id");
  return {
    id: stringOrNull(field("payload.id")),
    cli_version: stringOrNull(field("payload.cli_version")),
    model_provider: stringOrNull(field("payload.model_provider")),
    thread_source: source === "subagent" ? "subagent" : source === "user" ? "user" : null,
    parent_thread_id: typeof parent === "string" && parent !== "" ? parent : null,
    forked: (() => {
      const forked = field("payload.forked_from_id");
      return forked !== undefined && forked !== null;
    })(),
    history_start: start === undefined ? null : Number(start),
  };
}

/**
 * The classification key of a turn's error: `codex_error_info` when it is a string, the single key
 * of its object form otherwise. The object's value, and the error's `message`, are never read.
 *
 * @param {(path: string) => unknown} field
 */
function projectErrorCode(field) {
  const error = field("payload.error");
  if (error === undefined || error === null) return null;
  if (!isObject(error)) throw drift();
  const info = field("payload.error.codex_error_info");
  if (typeof info === "string") return code(info);
  if (isObject(info)) {
    const keys = Object.keys(/** @type {object} */ (info));
    if (keys.length === 1) return code(String(keys[0]));
  }
  throw drift();
}

/**
 * @param {(path: string) => unknown} field
 * @param {string} prefix
 * @returns {Usage}
 */
function projectUsage(field, prefix) {
  if (!isObject(field(prefix))) throw drift();
  /** @param {string} name */
  const count = (name) => {
    const value = field(`${prefix}.${name}`);
    if (!Number.isSafeInteger(value) || Number(value) < 0) throw drift();
    return Number(value);
  };
  const cacheWrite = field(`${prefix}.cache_write_input_tokens`);
  if (cacheWrite !== undefined && (!Number.isSafeInteger(cacheWrite) || Number(cacheWrite) < 0)) {
    throw drift();
  }
  return {
    input_tokens: count("input_tokens"),
    cached_input_tokens: count("cached_input_tokens"),
    cache_write_input_tokens: cacheWrite === undefined ? null : Number(cacheWrite),
    output_tokens: count("output_tokens"),
    reasoning_output_tokens: count("reasoning_output_tokens"),
    total_tokens: count("total_tokens"),
  };
}

/**
 * Project what a token count says about rate limits.
 *
 * Two kinds of field live here. `rate_limit_reached_type` and `spend_control_reached` classify the
 * prompt, so a value that does not fit refuses the history like any other drift. The windows,
 * `limit_id` and `plan_type` are only ever quoted beside the estimate: a value that does not fit
 * there -- a `used_percent` above 100, which Codex's own TUI clamps rather than rules out, or a
 * label that is not an identifier -- drops that one statement (`invalid`, counted by `health()`),
 * never the prompts the same history holds.
 *
 * @param {(path: string) => unknown} field
 * @returns {RateLimits | null}
 */
function projectRateLimits(field) {
  const limits = field("payload.rate_limits");
  if (limits === undefined || limits === null) return null;
  if (!isObject(limits)) throw drift();
  let invalid = false;
  /** @param {string} path */
  const label = (path) => {
    const value = field(path);
    if (value === undefined || value === null) return null;
    if (typeof value !== "string" || !labelPattern.test(value)) {
      invalid = true;
      return null;
    }
    return value;
  };
  /** @type {ReportedCapacityWindow[]} */
  const windows = [];
  for (const slot of ["primary", "secondary"]) {
    const window = field(`payload.rate_limits.${slot}`);
    if (window === undefined || window === null) continue;
    const projected = isObject(window) ? projectWindow(field, slot) : null;
    if (projected === null) invalid = true;
    else windows.push(projected);
  }
  // Windows are identified by their length, never by their slot, so two figures for one length
  // could not be told apart once stored.
  if (windows.length === 2 && windows[0]?.window_minutes === windows[1]?.window_minutes) {
    invalid = true;
  }
  const reachedValue = field("payload.rate_limits.rate_limit_reached_type");
  if (
    reachedValue !== undefined &&
    reachedValue !== null &&
    (typeof reachedValue !== "string" || !labelPattern.test(reachedValue))
  ) {
    throw drift();
  }
  const spend = field("payload.rate_limits.spend_control_reached");
  const limitId = label("payload.rate_limits.limit_id");
  const planType = label("payload.rate_limits.plan_type");
  return {
    limit_id: invalid ? null : limitId,
    plan_type: invalid ? null : planType,
    reached: typeof reachedValue === "string" ? code(reachedValue) : null,
    spend_control_reached: spend !== undefined && spend !== null,
    windows: invalid ? [] : windows,
    invalid,
  };
}

/**
 * @param {(path: string) => unknown} field
 * @param {string} slot
 * @returns {ReportedCapacityWindow | null} null for a window that is not a stated figure
 */
function projectWindow(field, slot) {
  const used = field(`payload.rate_limits.${slot}.used_percent`);
  const minutes = field(`payload.rate_limits.${slot}.window_minutes`);
  const resets = field(`payload.rate_limits.${slot}.resets_at`);
  if (typeof used !== "number" || !(used >= 0 && used <= 100)) return null;
  if (!Number.isSafeInteger(minutes) || Number(minutes) <= 0) return null;
  let resetsAt = null;
  if (resets !== undefined && resets !== null) {
    if (!Number.isSafeInteger(resets)) return null;
    const date = new Date(Number(resets) * 1000);
    if (!Number.isFinite(date.getTime())) return null;
    resetsAt = date.toISOString();
  }
  return { window_minutes: Number(minutes), used_percent: used, resets_at: resetsAt };
}

/**
 * @typedef {object} Turn
 * @property {string} turn_id
 * @property {string} root
 * @property {boolean} user
 * @property {Projected & {kind: "task_started"}} started
 * @property {(Projected & {kind: "task_complete" | "turn_aborted"}) | undefined} completion
 * @property {ParsedFile} file
 * @property {string | null} model the model the turn's own context named, or the latest before it
 */
/**
 * @typedef {object} PromptEntry
 * @property {Turn[]} turns
 * @property {ReturnType<typeof slice>[]} slices
 * @property {ReturnType<typeof restriction>[]} restrictions
 * @property {{source_code: string}[]} operational
 * @property {{at: number, thread: string, ordinal: number}[]} records
 * @property {Set<ParsedFile>} files
 */

/**
 * Assemble the prompts of one thread family.
 *
 * A prompt is a root turn of a user thread. In the usage-record family every other turn names its
 * root, so subagent turns and the continuation after an interrupted turn contribute to the prompt
 * that started them and never open one; a root that is nowhere in the family makes its turns a
 * prompt of their own, keyed by that root. The token-count family has no root field, so each
 * turn is its own prompt.
 *
 * @param {ParsedFile[]} unordered
 */
function assemblePrompts(unordered) {
  // Ordered by thread rather than by path, so a rollout Codex moves to `archived_sessions` does not
  // reorder the slices of an unchanged prompt.
  const files = unordered.toSorted((left, right) => left.thread.localeCompare(right.thread));
  /** @type {Map<string, PromptEntry>} */
  const prompts = new Map();
  /** @param {string} root */
  const prompt = (root) => {
    let entry = prompts.get(root);
    if (!entry) {
      entry = {
        turns: [],
        slices: [],
        restrictions: [],
        operational: [],
        records: [],
        files: new Set(),
      };
      prompts.set(root, entry);
    }
    return entry;
  };
  /** @type {Set<string>} */
  const seenSlices = new Set();

  for (const file of files) {
    /** @type {Map<string, Turn>} */
    const turns = new Map();
    /** @type {Map<string, string | null>} */
    const contexts = new Map();
    /** @type {string | null} */
    let latestModel = null;
    /** @type {Turn | null} */
    let current = null;
    /** @type {Usage | null} */
    let previousTotal = null;
    /** @param {{at: number, ordinal: number}} record @param {string} root */
    const contribute = (record, root) => {
      const entry = prompt(root);
      entry.records.push({ at: record.at, thread: file.thread, ordinal: record.ordinal });
      entry.files.add(file);
      return entry;
    };
    /** @param {string} turnId */
    const modelFor = (turnId) => {
      const own = contexts.get(turnId);
      return own === undefined || own === null ? latestModel : own;
    };
    for (const record of file.records) {
      switch (record.kind) {
        case "turn_context":
          contexts.set(record.turn_id, record.model);
          if (record.model !== null) latestModel = record.model;
          break;
        case "task_started": {
          if (opensNoPrompt(record, file.subagent)) {
            // Its token counts and completion then have no turn to land on either.
            current = null;
            break;
          }
          const root = record.root_turn_id ?? record.turn_id;
          current = {
            turn_id: record.turn_id,
            root,
            user: !file.subagent,
            started: record,
            completion: undefined,
            file,
            model: modelFor(record.turn_id),
          };
          turns.set(record.turn_id, current);
          contribute(record, root).turns.push(current);
          break;
        }
        case "task_complete":
        case "turn_aborted": {
          const turn = turns.get(record.turn_id);
          if (!turn) break;
          turn.completion = record;
          const entry = contribute(record, turn.root);
          if (record.kind === "task_complete" && record.error_code !== null) {
            if (errorRestrictions.has(record.error_code)) {
              entry.restrictions.push(restriction(record.error_code, record.at));
            }
          }
          break;
        }
        case "token_count": {
          const total = record.total;
          const repeated =
            total !== null && previousTotal !== null && sameUsage(total, previousTotal);
          if (total !== null) previousTotal = total;
          if (current === null) break;
          const entry = contribute(record, current.root);
          // A turn whose responses Codex recorded one by one takes its slices from those records;
          // its token counts then only repeat them. Any other turn has nothing but its token counts.
          const fromCounts = !file.usageTurns.has(current.turn_id);
          if (fromCounts && record.last !== null && total !== null && !repeated) {
            const sliceId = sha256(`${file.thread}:${record.ordinal}`);
            if (!seenSlices.has(sliceId)) {
              seenSlices.add(sliceId);
              entry.slices.push(
                slice(sliceId, file.provider, modelFor(current.turn_id), record.last),
              );
            }
          }
          const limits = record.rate_limits;
          if (limits !== null) {
            if (limits.reached !== null && reachedRestrictions.has(limits.reached)) {
              entry.restrictions.push(restriction(limits.reached, record.at));
            } else if (limits.reached !== null && limits.reached.endsWith("_credits_depleted")) {
              entry.operational.push({ source_code: limits.reached });
            }
            if (limits.spend_control_reached) {
              entry.operational.push({ source_code: "spend_control_reached" });
            }
          }
          break;
        }
        case "token_usage_record": {
          const entry = contribute(record, record.root_turn_id);
          if (seenSlices.has(`response:${record.response_id}`)) break;
          seenSlices.add(`response:${record.response_id}`);
          entry.slices.push(
            slice(record.response_id, file.provider, modelFor(record.turn_id), record.usage),
          );
          break;
        }
        default:
          break;
      }
    }
  }

  return [...prompts.entries()]
    .filter(([, entry]) => entry.records.length > 0)
    .map(([root, entry]) => buildObservation(root, entry));
}

/**
 * @param {string} root
 * @param {PromptEntry} entry
 */
function buildObservation(root, entry) {
  const rootTurn = entry.turns.find((turn) => turn.turn_id === root && turn.user);
  const userTurns = entry.turns.filter((turn) => turn.user);
  // The prompt ends where its last user-thread turn ends. After an interrupted turn the user may
  // resume, and the continuation is the same submission still running.
  const lastTurn = (userTurns.length > 0 ? userTurns : entry.turns)
    .toSorted((left, right) => left.started.at - right.started.at)
    .at(-1);
  const terminal = lastTurn?.completion;
  const startedAtMs = rootTurn?.started.at ?? Math.min(...entry.records.map((record) => record.at));
  const startedAt = new Date(startedAtMs).toISOString();
  const completedAt = terminal === undefined ? null : new Date(terminal.at).toISOString();
  const durationMs =
    terminal === undefined
      ? null
      : terminal.kind === "task_complete" && terminal.duration_ms !== null && lastTurn === rootTurn
        ? Math.round(terminal.duration_ms)
        : Math.max(0, terminal.at - startedAtMs);
  const restrictions = entry.restrictions.slice(0, 1);
  const exclusion = classifyExclusion(terminal, entry.operational);
  const anchor = rootTurn?.file ?? entry.turns[0]?.file ?? [...entry.files][0];
  const sessionId = rootTurn ? rootTurn.file.thread : (anchor?.parent ?? anchor?.thread ?? root);
  const model = entry.slices.at(-1)?.model ?? (rootTurn ?? lastTurn)?.model ?? null;
  return {
    source_prompt_id: root,
    source_session_id: sessionId,
    revision: readRevision(entry.records),
    revision_domain: "codex-turn-v1",
    parser_version: PARSER_VERSION,
    started_at: startedAt,
    completed_at: completedAt,
    duration_ms: durationMs,
    completion: terminal === undefined ? "provisional" : "completed",
    provider: anchor?.provider ?? null,
    model,
    outcome:
      restrictions.length > 0
        ? "restricted"
        : terminal === undefined || exclusion !== undefined
          ? "excluded"
          : "success",
    ...(restrictions.length === 0 && exclusion ? { exclusion } : {}),
    usage_slices: entry.slices,
    restrictions,
  };
}

/**
 * Why a finished Codex prompt does not count as a successful one.
 *
 * An interrupted turn is a cancellation. Any other error Codex recorded — overload, authentication,
 * a context window, a dropped connection — is operational: it says something about the request or
 * the service and nothing about what the provider still allows. So does a spending cap or depleted
 * credits: money ran out, which is not a usage condition.
 *
 * @param {(Projected & {kind: "task_complete" | "turn_aborted"}) | undefined} terminal
 * @param {{source_code: string}[]} operational
 */
function classifyExclusion(terminal, operational) {
  if (terminal?.kind === "turn_aborted") {
    return {
      class: "cancelled",
      source_code: terminal.reason,
      classifier_version: CLASSIFIER_VERSION,
    };
  }
  if (
    terminal?.kind === "task_complete" &&
    terminal.error_code !== null &&
    !errorRestrictions.has(terminal.error_code)
  ) {
    return {
      class: "operational_error",
      source_code: terminal.error_code,
      classifier_version: CLASSIFIER_VERSION,
    };
  }
  const first = operational[0];
  if (terminal !== undefined && first) {
    return {
      class: "operational_error",
      source_code: first.source_code,
      classifier_version: CLASSIFIER_VERSION,
    };
  }
  return undefined;
}

/** @param {string} sourceCode @param {number} at */
function restriction(sourceCode, at) {
  return {
    class: "rate_limit",
    source_code: sourceCode,
    observed_at: new Date(at).toISOString(),
    classifier_version: CLASSIFIER_VERSION,
    provenance: "backfill",
  };
}

/**
 * Describe one model response as a usage slice in SNACK's disjoint token dimensions.
 *
 * OpenAI reports cached input inside input and reasoning inside output. SNACK stores them apart,
 * so they are subtracted out; a result below zero means Codex changed what the fields mean, and
 * the history is refused rather than stored with a dimension that no longer adds up.
 *
 * @param {string} sliceId
 * @param {string} provider
 * @param {string | null} model
 * @param {Usage} usage
 */
function slice(sliceId, provider, model, usage) {
  const cacheWrite = usage.cache_write_input_tokens;
  const input = usage.input_tokens - usage.cached_input_tokens - (cacheWrite ?? 0);
  const output = usage.output_tokens - usage.reasoning_output_tokens;
  if (input < 0 || output < 0) throw drift();
  return {
    source_slice_id: sliceId,
    provider,
    model,
    input_tokens: input,
    output_tokens: output,
    reasoning_tokens: usage.reasoning_output_tokens,
    cache_read_tokens: usage.cached_input_tokens,
    cache_write_tokens: cacheWrite,
    cost_decimal: null,
    currency: null,
  };
}

/** @param {Usage} left @param {Usage} right */
function sameUsage(left, right) {
  return usageFields.every(
    (name) => left[/** @type {keyof Usage} */ (name)] === right[/** @type {keyof Usage} */ (name)],
  );
}

/**
 * Describe how far a prompt has been written, as a revision storage can order.
 *
 * The numeric timestamp leads because storage orders revisions by that prefix; the thread and the
 * ordinal break ties between records written in the same millisecond, and keep the revision stable
 * when the same unchanged rollout is read again.
 *
 * @param {{at: number, thread: string, ordinal: number}[]} records
 */
function readRevision(records) {
  const newest = records
    .map((record) => ({ ...record, thread: sha256(record.thread).slice(0, 16) }))
    .sort(
      (left, right) =>
        left.at - right.at ||
        left.thread.localeCompare(right.thread) ||
        left.ordinal - right.ordinal,
    )
    .at(-1);
  return `${newest?.at ?? 0}:${newest?.thread ?? ""}:${newest?.ordinal ?? 0}`;
}

/**
 * The reported capacity usage one thread stated, as snapshots.
 *
 * A snapshot is emitted whenever the stated figure differs from the thread's previous one, plus the
 * thread's last, so the time a figure was stated stays current while the figure itself is flat.
 *
 * @param {ParsedFile} file
 * @returns {ReportedCapacitySnapshot[]}
 */
function readSnapshots(file) {
  /** @type {ReportedCapacitySnapshot[]} */
  const emitted = [];
  /** @type {ReportedCapacitySnapshot | null} */
  let latest = null;
  let previousSignature = null;
  for (const record of file.records) {
    if (record.kind !== "token_count" || record.rate_limits === null) continue;
    const limits = record.rate_limits;
    // A statement that was not a figure is dropped here and counted by `health()`.
    if (limits.invalid || limits.windows.length === 0) continue;
    const windows = limits.windows.map((window) => ({ ...window }));
    const signature = JSON.stringify([limits.limit_id, limits.plan_type, windows]);
    latest = {
      observation_key: sha256(`codex-rate-limits\0${file.thread}\0${record.ordinal}`),
      observed_at: new Date(record.at).toISOString(),
      limit_id: limits.limit_id,
      plan_type: limits.plan_type,
      windows,
      parser_version: RATE_LIMITS_PARSER_VERSION,
      provider: file.provider,
    };
    if (signature !== previousSignature) emitted.push(latest);
    previousSignature = signature;
  }
  if (latest !== null && emitted.at(-1) !== latest) emitted.push(latest);
  return emitted;
}

/**
 * List every rollout under `<home>/sessions` (any depth) and `<home>/archived_sessions` (flat).
 *
 * `<home>` itself is never listed.
 *
 * @param {string} home
 * @returns {{files: string[], compressed: number}}
 */
function listRolloutFiles(home) {
  const sessions = join(home, "sessions");
  /** @type {string[]} */
  const files = [];
  let compressed = 0;
  /** @param {string} directory @param {boolean} recurse @param {boolean} required */
  const visit = (directory, recurse, required) => {
    let entries;
    try {
      entries = readdirSync(directory, { withFileTypes: true });
    } catch (error) {
      // An optional directory that does not exist -- no archive yet, a day directory Codex removed
      // mid-listing -- holds nothing. One that exists and cannot be read is the same fact to a
      // user as a missing sessions directory: the history cannot be read in full. Claude Code's
      // reader refuses an unreadable project directory the same way.
      if (!required && isMissing(error)) return;
      throw unavailable();
    }
    for (const entry of entries) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) {
        if (recurse) visit(path, true, false);
      } else if (entry.isFile() && /^rollout-.*\.jsonl$/u.test(entry.name)) {
        files.push(path);
      } else if (entry.isFile() && /^rollout-.*\.jsonl\.zst$/u.test(entry.name)) {
        compressed += 1;
      }
    }
  };
  visit(sessions, true, true);
  visit(join(home, "archived_sessions"), false, false);
  return { files: files.sort(), compressed };
}

/**
 * Read only the first line of a rollout, for the version it names.
 *
 * @param {string} file
 * @returns {Record<string, unknown> | null}
 */
function readFirstRecord(file) {
  let handle;
  try {
    handle = openSync(file, "r");
  } catch {
    return null;
  }
  try {
    const chunk = Buffer.allocUnsafe(64 * 1024);
    let text = "";
    for (;;) {
      const count = readSync(handle, chunk, 0, chunk.length, null);
      if (count === 0) return null;
      text += chunk.toString("utf8", 0, count);
      const newline = text.indexOf("\n");
      if (newline === -1) continue;
      try {
        const raw = JSON.parse(text.slice(0, newline));
        if (!isObject(raw) || raw.type !== "session_meta") return null;
        // Projected through the allowlist like every other read: only the version leaves here.
        const version = reader(raw, "session_meta")("payload.cli_version");
        return { payload: { cli_version: typeof version === "string" ? version : null } };
      } catch {
        return null;
      }
    }
  } finally {
    closeSync(handle);
  }
}

/** @param {string} home @param {string} file */
function fileKey(home, file) {
  // The path of a rollout names a date and a thread; the cursor is written to SNACK's database,
  // so it is reduced to an opaque key there.
  return sha256(`codex-rollout-file\0${relative(home, file)}`);
}

/** @param {string} thread */
function hashThread(thread) {
  return sha256(`codex-thread\0${thread}`);
}

/** @param {string} file */
function modifiedAt(file) {
  try {
    return statSync(file).mtimeMs;
  } catch {
    return 0;
  }
}

/** @param {string} value */
function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

/** @param {string} value */
function code(value) {
  return codePattern.test(value) ? value : "unrecognized";
}

/** @param {unknown} value */
function requireString(value) {
  if (typeof value !== "string" || value === "") throw drift();
  return value;
}

/** @param {unknown} value */
function stringOrNull(value) {
  return typeof value === "string" && value !== "" ? value : null;
}

/**
 * @param {unknown} value
 * @returns {value is Record<string, unknown>}
 */
function isObject(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * @param {Record<string, unknown> | null} source
 * @param {string} name
 * @returns {Record<string, unknown> | null}
 */
function readObject(source, name) {
  const value = source === null ? undefined : source[name];
  return isObject(value) ? value : null;
}

/** No Codex installation, no sessions directory, or one SNACK may not read; names no path. */
function unavailable() {
  return new SnackError(
    "Codex CLI history is unavailable; its sessions directory could not be read. Install Codex CLI, or set CODEX_HOME to an existing Codex CLI home directory.",
    { code: ExitCode.unavailable, reason: "source_unavailable" },
  );
}

/** @param {unknown} error */
function isMissing(error) {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error.code === "ENOENT" || error.code === "ENOTDIR")
  );
}

function drift() {
  return new SnackError("The Codex CLI history fingerprint is unsupported.", {
    code: ExitCode.unavailable,
    reason: "source_schema_unsupported",
  });
}
