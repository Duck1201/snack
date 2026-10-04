import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";
import { closeSync, openSync, readdirSync, readFileSync, readSync, statSync } from "node:fs";
import { homedir as systemHomedir } from "node:os";
import { isAbsolute, join, relative } from "node:path";
import { StringDecoder } from "node:string_decoder";

import { ExitCode, SnackError } from "./errors.js";
import { numberOrNull } from "./guards.js";

/**
 * Fields every Claude Code turn record must carry for a turn tree to be reconstructable.
 *
 * `parentUuid` is checked for presence, not for a value: the first record of a session has a null
 * parent, and that is the root of the tree rather than a missing field.
 */
const requiredTurnFields = ["type", "uuid", "sessionId", "timestamp"];

/**
 * Claude Code records one provider identity and never names it.
 *
 * Its histories carry a model but no provider field, because the client only ever talks to one.
 * Naming it here keeps the ambiguous-provider mapping path — which exists because OpenCode reports
 * a provider without an account identity — unreachable for Claude sources.
 */
const claudeProvider = "anthropic";

const requiredUsageFields = [
  "input_tokens",
  "output_tokens",
  "cache_creation_input_tokens",
  "cache_read_input_tokens",
];

/**
 * How many records of a session file the check before every read inspects.
 *
 * A sample of the head of a file is cheap enough to run on every `sync`, and it refuses a history
 * whose files start in a shape SNACK does not read before any of it is parsed. It proves nothing
 * about the rest of the file: a session a later client resumed holds that client's records at its
 * tail. So the sample is never the guard -- `readRecords` holds every turn record it consumes to
 * the shape, and `fingerprint()` (setup and `doctor`) inspects every record.
 */
const fingerprintSampleSize = 200;

/**
 * Resolve Claude Code's history directory without reading its settings or credentials.
 *
 * `CLAUDE_CONFIG_DIR` is Claude Code's own variable for relocating that directory, so honouring it
 * is what lets SNACK find a history that is not in the default place.
 *
 * @param {{env?: NodeJS.ProcessEnv, home?: string}} [options]
 */
export function resolveClaudeProjectsDirectory(options = {}) {
  const env = options.env ?? process.env;
  const configured = env.CLAUDE_CONFIG_DIR;
  const configDir =
    configured && isAbsolute(configured)
      ? configured
      : join(options.home ?? systemHomedir(), ".claude");
  return join(configDir, "projects");
}

/**
 * Create the internal Claude Code source-adapter port.
 *
 * @param {{projectsDirectory: string}} options
 */
export function createClaudeAdapter(options) {
  return {
    // Claude Code only appends, and a revision names a turn's newest record, so the same revision
    // read again is the same turn: storage keeps what it stored when the content differs.
    revisionIdentifiesContent: true,
    detect() {
      const versions = new Set();
      for (const sessionFile of listSessionFiles(options.projectsDirectory)) {
        eachRecord(sessionFile, Infinity, (record) => {
          if (typeof record.version === "string") versions.add(record.version);
        });
      }
      return { detected: true, client: "claude", versions: [...versions].sort() };
    },
    fingerprint() {
      // Setup and `doctor` answer the question `sync --full` would, so they hold every record to
      // the shape, not a sample: a family a later client appended to the tail of a resumed session
      // is exactly what a sample of the head cannot see. The records are streamed, so this costs
      // the history's I/O once but never holds more than one chunk of it.
      const supported = hasSupportedStructure(options.projectsDirectory, Infinity);
      return {
        adapter: "claude-jsonl",
        fingerprint_version: 1,
        family: supported ? "cc-jsonl-turntree-v1" : null,
        supported,
      };
    },
    readAll() {
      return this.readSince(null);
    },
    /** @param {{sessions: Record<string, number>} | null} cursor */
    readSince(cursor) {
      // Setup checks the fingerprint once; the client keeps shipping afterwards. Every read has to
      // check it too, or a release that moves a usage field turns the next sync into a history
      // stored with null tokens -- partial, plausible-looking data.
      //
      // This check samples the head of every file, which keeps a sync with nothing new to read
      // O(files) rather than O(history). It is not the guard: `read()` holds every record it
      // consumes to the same shape, which is what catches a family appended past the sample.
      if (!hasSupportedStructure(options.projectsDirectory, fingerprintSampleSize)) {
        throw drift();
      }
      return read(options.projectsDirectory, cursor);
    },
    health() {
      try {
        const fingerprint = this.fingerprint();
        return {
          status: fingerprint.supported ? "compatible" : "incompatible",
          accessible: true,
          fingerprint: {
            family: fingerprint.family,
            supported: fingerprint.supported,
          },
        };
      } catch {
        return {
          status: "inaccessible",
          accessible: false,
          fingerprint: { family: null, supported: false },
        };
      }
    },
  };
}

/**
 * Decide whether a Claude projects directory holds the turn-tree family SNACK can read.
 *
 * Claude Code adds record types continuously — session titles, agent names, queue operations,
 * file-history snapshots — so an unrecognized `type` is skipped rather than treated as drift.
 * Refusing them would break SNACK on a client release that changed nothing SNACK reads. What must
 * hold is the shape of the two record types the turn tree is built from.
 *
 * @param {string} projectsDirectory
 * @param {number} limit records to inspect per file: `fingerprintSampleSize`, or `Infinity`
 */
function hasSupportedStructure(projectsDirectory, limit) {
  let recognized = 0;
  for (const sessionFile of listReadableFiles(projectsDirectory)) {
    let supported = true;
    eachRecord(sessionFile, limit, (record) => {
      if (record.type !== "user" && record.type !== "assistant") return true;
      if (!isSupportedTurnRecord(record)) {
        supported = false;
        return false;
      }
      recognized += 1;
      return true;
    });
    if (!supported) return false;
  }
  return recognized > 0;
}

function drift() {
  return new SnackError("The Claude Code history fingerprint is unsupported.", {
    code: ExitCode.unavailable,
    reason: "source_schema_unsupported",
  });
}

/**
 * Read just enough of a transcript to recognize its shape.
 *
 * The fingerprint inspects at most `fingerprintSampleSize` records per file and then stops — but it
 * used to stop inside an array `readRecords` had already built by reading the whole file and
 * parsing every line. Sampling 200 records from a 9 MB transcript cost 9 MB, on every file, on
 * every command that synchronizes. Over a real 222 MB history that was 238 MB of process RSS for a
 * `sync` with nothing to read: O(total history) where the cursor was designed to make the work
 * O(new data).
 *
 * Reading forward in chunks and stopping at the sample bounds it by the sample instead. A sample
 * only proves the head of a file, so it is never the guard on what `read()` consumes: `readRecords`
 * holds every turn record to the shape itself.
 *
 * @param {string} sessionFile
 * @param {number} limit records to collect
 * @returns {{records: Record<string, unknown>[], bytesRead: number}}
 */
export function readSampleRecords(sessionFile, limit) {
  /** @type {Record<string, unknown>[]} */
  const records = [];
  const bytesRead = eachRecord(sessionFile, limit, (record) => {
    records.push(record);
  });
  return { records, bytesRead };
}

/**
 * Stream the parseable records of a transcript to `visit`, holding one chunk of the file at a time,
 * until `limit` records were visited or `visit` returns `false`.
 *
 * A line that does not parse is skipped: the callers ask what shape the readable records have, and
 * `readRecords` is the reader that reports damage. A final line with no trailing newline is a
 * session being written right now, which `readRecords` skips for the same reason.
 *
 * @param {string} sessionFile
 * @param {number} limit
 * @param {(record: Record<string, unknown>) => boolean | void} visit
 * @returns {number} bytes read
 */
function eachRecord(sessionFile, limit, visit) {
  let bytesRead = 0;
  let handle;
  try {
    handle = openSync(sessionFile, "r");
  } catch {
    // A transcript deleted between listing and reading is absence of evidence, exactly as it is
    // for a subagent file in `readRecords`.
    return bytesRead;
  }
  try {
    const chunk = Buffer.allocUnsafe(64 * 1024);
    // A multi-byte character can straddle two chunks; the decoder holds its first bytes back.
    const decoder = new StringDecoder("utf8");
    let pending = "";
    let visited = 0;
    for (;;) {
      const read = readSync(handle, chunk, 0, chunk.length, null);
      if (read === 0) break;
      bytesRead += read;
      pending += decoder.write(chunk.subarray(0, read));
      // Lines are cut by index and the remainder kept once per chunk. Slicing the remainder off
      // per line copies the chunk once for every line in it, which a whole-history scan cannot
      // afford.
      let start = 0;
      let newline = pending.indexOf("\n", start);
      while (newline !== -1) {
        const line = pending.slice(start, newline);
        start = newline + 1;
        newline = pending.indexOf("\n", start);
        if (line === "") continue;
        /** @type {Record<string, unknown>} */
        let record;
        try {
          record = JSON.parse(line);
        } catch {
          continue;
        }
        visited += 1;
        if (visit(record) === false || visited >= limit) return bytesRead;
      }
      pending = pending.slice(start);
    }
  } finally {
    closeSync(handle);
  }
  return bytesRead;
}

/** @param {Record<string, unknown>} record */
function isSupportedTurnRecord(record) {
  if (!requiredTurnFields.every((field) => typeof record[field] === "string")) return false;
  if (!("parentUuid" in record)) return false;
  if (record.type === "user") return true;
  const usage = readObject(readObject(record, "message"), "usage");
  return usage !== null && requiredUsageFields.every((field) => typeof usage[field] === "number");
}

/**
 * Read a Claude projects directory, optionally skipping sessions that have not been written to.
 *
 * The session file is the unit of both skipping and reading. A turn is reconstructed from a chain
 * of records that can span the whole file, so there is no offset inside a file that a reader could
 * resume from; and a file Claude Code has not touched cannot have produced a different reading, so
 * skipping it is exactly the work worth avoiding.
 *
 * @param {string} projectsDirectory
 * @param {{sessions: Record<string, number>} | null} cursor
 */
function read(projectsDirectory, cursor) {
  const observations = [];
  /** @type {{segment: string, line_offset: number}[]} */
  const rejected = [];
  /** @type {Record<string, number>} */
  const sessions = {};
  for (const sessionFile of listSessionFiles(projectsDirectory)) {
    // Claude Code names project directories after the working directory a session ran in, and this
    // cursor is written to SNACK's database. The name is reduced to an opaque key so that storing
    // where a reader stopped never stores where the user was working.
    const key = hashPath(relative(projectsDirectory, sessionFile));
    /** @param {string} file */
    const records = (file) => readRecords(file, rejected);
    const writtenAt = modifiedAt(sessionFile);
    sessions[key] = writtenAt;
    if (cursor !== null && (cursor.sessions?.[key] ?? -1) >= writtenAt) continue;
    /** @type {Set<string>} */
    const linked = new Set();
    observations.push(
      ...readSessionObservations(records(sessionFile), (agentId) => {
        linked.add(agentId);
        return records(subagentFile(sessionFile, agentId));
      }),
    );
    // An agent interrupted before it reported back leaves a transcript the session never links.
    // Its tokens were still spent and its refusal still happened, so it is read as a turn of its
    // own rather than dropped. Linked transcripts are already part of their prompt and are not
    // read twice.
    for (const [agentId, agentFile] of listSubagentFiles(sessionFile)) {
      if (linked.has(agentId)) continue;
      observations.push(...readSessionObservations(records(agentFile), () => []));
    }
  }
  return { observations, rejected, cursor: { sessions } };
}

/**
 * List every subagent transcript a session wrote, by agent identifier.
 *
 * @param {string} sessionFile
 * @returns {[string, string][]}
 */
function listSubagentFiles(sessionFile) {
  const directory = subagentDirectory(sessionFile);
  try {
    return readdirSync(directory, { withFileTypes: true })
      .filter((entry) => entry.isFile() && /^agent-.+\.jsonl$/u.test(entry.name))
      .map((entry) => [
        entry.name.slice("agent-".length, -".jsonl".length),
        join(directory, entry.name),
      ]);
  } catch {
    return [];
  }
}

/** @param {string} sessionFile */
function modifiedAt(sessionFile) {
  try {
    return statSync(sessionFile).mtimeMs;
  } catch {
    return 0;
  }
}

/** @param {string} value */
function hashPath(value) {
  return createHash("sha256").update(`claude-session-file\0${value}`).digest("hex");
}

/**
 * Reconstruct the prompts of one Claude Code session.
 *
 * A prompt starts at a `user` record carrying `promptSource` — the field Claude Code sets when a
 * submission came from the user rather than from the turn itself. A `user` record without it is a
 * tool result inside a turn, which is why the count of prompts is not the count of user records.
 *
 * Resuming a session writes the continued turn under a root that is not a submission record at
 * all, so those turns are rooted too. They consumed capacity and they can carry a refusal, and a
 * reader that walked down only from submissions would drop both — leaving a forecast that never
 * sees the refusals that actually happened.
 *
 * @param {Record<string, unknown>[]} records
 * @param {(agentId: string) => Record<string, unknown>[]} readSubagent
 */
function readSessionObservations(records, readSubagent) {
  const children = groupByParent(records);
  return turnRoots(records, children).map((prompt) => {
    const turn = descendants(prompt, children);
    const subagentCalls = turn.flatMap((record) => {
      // Only the agent identifier is read out of a tool result. The rest of that object is the
      // agent's instructions and output, which SNACK has no reason to look at.
      const agentId = readObject(record, "toolUseResult")?.agentId;
      return typeof agentId === "string" ? readSubagent(agentId) : [];
    });
    const modelCalls = [...turn, ...subagentCalls].filter((record) => record.type === "assistant");
    // The turn ends at the model call that stopped without asking for another tool. Anything after
    // it in the tree belongs to a later submission, and its absence means Claude Code is still
    // writing the turn.
    const terminal = turn
      .filter((record) => record.type === "assistant")
      .findLast((record) => isTerminalCall(record));
    const startedAt = String(prompt.timestamp);
    const completedAt = terminal === undefined ? null : String(terminal.timestamp);
    const restrictions = modelCalls.flatMap(readRestriction);
    const exclusion = terminal === undefined ? undefined : classifyExclusion(terminal);
    return {
      // A resumed turn has no prompt identifier of its own, so the record that roots it names it.
      // That identity is as stable across syncs as the file it came from.
      source_prompt_id: String(prompt.promptId ?? prompt.uuid),
      source_session_id: String(prompt.sessionId),
      revision: readRevision([prompt, ...turn, ...subagentCalls]),
      revision_domain: "claude-uuid-v1",
      parser_version: "claude-session-v1",
      started_at: startedAt,
      completed_at: completedAt,
      duration_ms: elapsedMs(startedAt, completedAt),
      completion: terminal === undefined ? "provisional" : "completed",
      provider: claudeProvider,
      model: terminal === undefined ? null : readModel(terminal),
      outcome:
        restrictions.length > 0
          ? "restricted"
          : terminal === undefined || exclusion !== undefined
            ? "excluded"
            : "success",
      ...(exclusion ? { exclusion } : {}),
      usage_slices: modelCalls.map(readUsageSlice),
      restrictions,
    };
  });
}

/**
 * Where each record was read from: its file and its line, which is the order Claude Code appended
 * it in. Held beside the records rather than on them, so nothing SNACK adds can be mistaken for a
 * field Claude Code wrote.
 *
 * @type {WeakMap<Record<string, unknown>, {file: string, line: number}>}
 */
const appendPosition = new WeakMap();

/**
 * Describe how far a turn has been written, as a revision storage can order.
 *
 * Claude Code only appends, so the newest record of a turn says how complete the reading is. The
 * numeric timestamp leads because storage orders revisions by that prefix, and the rest is compared
 * as text.
 *
 * Records written in the same millisecond tie on that prefix. The tie used to be broken by uuid
 * alone, and a record appended later in the millisecond under a uuid that sorts lower added
 * content -- a usage slice, or the terminal -- without moving the revision; storage then refused
 * the turn as a same-revision conflict until some later record arrived. So the tie is broken by
 * append order: the revision names the highest uuid of the newest millisecond, as it always did,
 * followed by how many of that millisecond's records were appended after it (`+000001`, ...). The
 * suffix sorts after the bare uuid and grows with every such append, and a record with a higher
 * uuid replaces the name and sorts higher still, so every append moves the revision forward.
 *
 * Where nothing was appended after that record -- every turn without a tie, and every tie written
 * in uuid order -- the revision is exactly the one earlier releases wrote, so an upgraded database
 * reads its unchanged history as unchanged and nothing is re-written. A record in another file (a
 * subagent transcript) has no append order relative to the session file, so it counts as after.
 *
 * @param {Record<string, unknown>[]} records
 */
function readRevision(records) {
  const timed = records
    .map((record) => ({
      record,
      at: Date.parse(String(record.timestamp)),
      uuid: String(record.uuid),
    }))
    .filter((entry) => Number.isFinite(entry.at));
  const at = Math.max(...timed.map((entry) => entry.at));
  const newestMillisecond = timed.filter((entry) => entry.at === at);
  const named = newestMillisecond
    .toSorted((left, right) => left.uuid.localeCompare(right.uuid))
    .at(-1);
  if (named === undefined) return "0:";
  const namedAt = appendPosition.get(named.record);
  const appendedAfter = newestMillisecond.filter((entry) => {
    if (entry.record === named.record) return false;
    const position = appendPosition.get(entry.record);
    if (position === undefined || namedAt === undefined || position.file !== namedAt.file) {
      return true;
    }
    return position.line > namedAt.line;
  }).length;
  const suffix = appendedAfter === 0 ? "" : `+${String(appendedAfter).padStart(6, "0")}`;
  return `${at}:${named.uuid}${suffix}`;
}

/**
 * Classify why a finished Claude turn does not count as a successful one.
 *
 * Everything Claude Code reports other than a refusal is operational: it says something about the
 * request, the account, or the service, and nothing about what the provider still allows.
 *
 * @param {Record<string, unknown>} terminal
 */
function classifyExclusion(terminal) {
  const error = terminal.error;
  if (typeof error !== "string" || error === "rate_limit") return undefined;
  return {
    class: "operational_error",
    source_code: error,
    classifier_version: "claude-error-v1",
  };
}

/**
 * Classify a model call that Claude Code recorded as failed.
 *
 * Claude Code writes the class beside the message as a structured field, so no sentence shown to
 * the user is read to decide what happened. Only an explicit provider refusal is an observed
 * restriction: overload, authentication, billing, and output-length failures are operational and
 * never train a forecast.
 *
 * @param {Record<string, unknown>} record
 */
function readRestriction(record) {
  if (record.error !== "rate_limit") return [];
  return [
    {
      class: "rate_limit",
      source_code: `http_${record.apiErrorStatus ?? 429}`,
      observed_at: String(record.timestamp),
      classifier_version: "claude-error-v1",
      provenance: "backfill",
    },
  ];
}

/**
 * Decide whether a model call ended its turn.
 *
 * `tool_use` means the turn continues; every other stop reason means Claude Code handed control
 * back to the user.
 *
 * @param {Record<string, unknown>} record
 */
function isTerminalCall(record) {
  const stopReason = readObject(record, "message")?.stop_reason;
  return typeof stopReason === "string" && stopReason !== "tool_use";
}

/** @param {Record<string, unknown>} record */
function readModel(record) {
  const model = readObject(record, "message")?.model;
  return typeof model === "string" ? model : null;
}

/** @param {string} startedAt @param {string | null} completedAt */
function elapsedMs(startedAt, completedAt) {
  if (completedAt === null) return null;
  const elapsed = Date.parse(completedAt) - Date.parse(startedAt);
  return Number.isFinite(elapsed) && elapsed >= 0 ? elapsed : null;
}

/**
 * Index every record by the record it answers.
 *
 * @param {Record<string, unknown>[]} records
 * @returns {Map<string, Record<string, unknown>[]>}
 */
function groupByParent(records) {
  /** @type {Map<string, Record<string, unknown>[]>} */
  const children = new Map();
  for (const record of records) {
    if (typeof record.parentUuid !== "string") continue;
    const siblings = children.get(record.parentUuid);
    if (siblings) siblings.push(record);
    else children.set(record.parentUuid, [record]);
  }
  return children;
}

/**
 * Walk the turn tree below one prompt, in the order the records were written.
 *
 * Claude Code links every record of a turn to the one it answers rather than to the submission that
 * started it: `assistant` records carry no `promptId` at all. The chain is therefore the only thing
 * that says which model calls belong to which prompt.
 *
 * @param {Record<string, unknown>} prompt
 * @param {Map<string, Record<string, unknown>[]>} children
 * @returns {Record<string, unknown>[]}
 */
function descendants(prompt, children) {
  const walked = [];
  const pending = [...(children.get(String(prompt.uuid)) ?? [])];
  const seen = new Set();
  while (pending.length > 0) {
    const record = /** @type {Record<string, unknown>} */ (pending.shift());
    const uuid = String(record.uuid);
    if (seen.has(uuid)) continue;
    seen.add(uuid);
    // A later submission is its own prompt, so the walk stops rather than absorbing the rest of
    // the session into the first prompt of the file.
    if (isPromptRecord(record)) continue;
    walked.push(record);
    pending.push(...(children.get(uuid) ?? []));
  }
  return walked;
}

/**
 * Describe one model call as a usage slice.
 *
 * Claude Code reports no cost of any kind and no separate reasoning-token count, so both stay null
 * rather than being derived from a price table or folded into the output count.
 *
 * @param {Record<string, unknown>} record
 */
function readUsageSlice(record) {
  const message = readObject(record, "message") ?? {};
  const usage = readObject(message, "usage") ?? {};
  return {
    source_slice_id: String(record.uuid),
    provider: claudeProvider,
    model: typeof message.model === "string" ? message.model : null,
    input_tokens: numberOrNull(usage.input_tokens),
    output_tokens: numberOrNull(usage.output_tokens),
    reasoning_tokens: null,
    cache_read_tokens: numberOrNull(usage.cache_read_input_tokens),
    cache_write_tokens: numberOrNull(usage.cache_creation_input_tokens),
    cost_decimal: null,
    currency: null,
  };
}

/**
 * Find every record that roots a turn of its own.
 *
 * A submission always roots one. So does a record whose parent is not in this file, which is what
 * resuming a session produces: the turn continues, but the submission that started it lives in the
 * history the session was resumed from. Such a root only counts when its tree actually reached the
 * model — a dangling record that produced no model call consumed nothing and is not a prompt.
 *
 * @param {Record<string, unknown>[]} records
 * @param {Map<string, Record<string, unknown>[]>} children
 */
function turnRoots(records, children) {
  const present = new Set(records.map((record) => String(record.uuid)));
  return records.filter((record) => {
    // A root becomes an observation, and its `timestamp` becomes `started_at` verbatim. A record
    // with no time is not a submission whatever else it looks like -- Claude Code writes several
    // record types without one, and any of them could otherwise root a turn and publish a prompt
    // that started at `undefined`.
    if (!Number.isFinite(Date.parse(String(record.timestamp)))) return false;
    if (isPromptRecord(record)) return true;
    if (typeof record.uuid !== "string") return false;
    if (typeof record.parentUuid === "string" && present.has(record.parentUuid)) return false;
    return descendants(record, children).some((child) => child.type === "assistant");
  });
}

/** @param {Record<string, unknown>} record */
function isPromptRecord(record) {
  return (
    record.type === "user" &&
    typeof record.promptSource === "string" &&
    typeof record.promptId === "string" &&
    record.isMeta !== true
  );
}

/**
 * Read a nested object field without asserting the shape of a record SNACK does not own.
 *
 * @param {Record<string, unknown> | null} source
 * @param {string} field
 * @returns {Record<string, unknown> | null}
 */
function readObject(source, field) {
  const value = source === null ? undefined : source[field];
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  return /** @type {Record<string, unknown>} */ (value);
}

/**
 * List every session file under a Claude projects directory.
 *
 * The directory names are slugified working directories, so they are read as opaque containers and
 * never returned, parsed, or stored.
 *
 * @param {string} projectsDirectory
 * @returns {string[]}
 */
function listSessionFiles(projectsDirectory) {
  let projects;
  try {
    projects = readdirSync(projectsDirectory, { withFileTypes: true });
  } catch {
    // No Claude Code installation, no project directory, or a directory SNACK may not read are the
    // same fact to a user: the source is unavailable. They are classified once, here, so none of
    // them reaches the command layer as an unexplained internal failure, and the message names no
    // path.
    throw new SnackError(
      "Claude Code history is unavailable; its project directory could not be read. Install Claude Code, or set CLAUDE_CONFIG_DIR to an existing Claude Code configuration directory.",
      { code: ExitCode.unavailable, reason: "source_unavailable" },
    );
  }
  return projects
    .filter((entry) => entry.isDirectory())
    .flatMap((entry) => {
      const project = join(projectsDirectory, entry.name);
      return readdirSync(project, { withFileTypes: true })
        .filter((session) => session.isFile() && session.name.endsWith(".jsonl"))
        .map((session) => join(project, session.name));
    })
    .sort();
}

/**
 * Every file the adapter reads usage out of: session histories and the subagent transcripts beside
 * them. The fingerprint and the reader must agree on this list, or a family would be decided from
 * files that are not the ones being parsed.
 *
 * @param {string} projectsDirectory
 * @returns {string[]}
 */
function listReadableFiles(projectsDirectory) {
  return listSessionFiles(projectsDirectory).flatMap((sessionFile) => [
    sessionFile,
    ...listSubagentFiles(sessionFile).map(([, agentFile]) => agentFile),
  ]);
}

/**
 * Locate the transcript of one subagent spawned by a session.
 *
 * Claude Code keeps subagent turns out of the session file entirely, in
 * `<session>/subagents/agent-<agentId>.jsonl`, and records no token count for them in the session
 * that spawned them. A reader that stops at the session file therefore sees none of what a
 * subagent consumed.
 *
 * @param {string} sessionFile
 * @param {string} agentId
 */
function subagentFile(sessionFile, agentId) {
  return join(subagentDirectory(sessionFile), `agent-${agentId}.jsonl`);
}

/** @param {string} sessionFile */
function subagentDirectory(sessionFile) {
  return join(sessionFile.replace(/\.jsonl$/u, ""), "subagents");
}

/**
 * Read one session file as records.
 *
 * A whole session file is materialized, one file at a time. That bounds the read by the largest
 * session rather than by the size of the history, which is what keeps a long-lived installation
 * inside the steady-state memory budget.
 *
 * A trailing partial line is a session Claude Code is still writing, not corruption, so it is
 * dropped instead of failing the file.
 *
 * @param {string} sessionFile
 * @param {{segment: string, line_offset: number}[]} [rejected] collects the lines that would not
 *   parse, so a quietly incomplete read is reported rather than silently accepted
 * @returns {Record<string, unknown>[]}
 */
function readRecords(sessionFile, rejected = undefined) {
  /** @type {Record<string, unknown>[]} */
  const records = [];
  let content;
  try {
    content = readFileSync(sessionFile, "utf8");
  } catch {
    // A subagent transcript the user has since deleted is absence of evidence, not a broken
    // history. The prompt that spawned it is still real and still carries its own usage.
    return records;
  }
  const lines = content.split("\n");
  for (const [index, line] of lines.entries()) {
    if (line === "") continue;
    /** @type {Record<string, unknown>} */
    let record;
    try {
      record = JSON.parse(line);
    } catch {
      // The last line of a file that does not end in a newline is a session Claude Code is
      // writing right now. Any other unparseable line is damage the file has already moved past,
      // and dropping it without a word would make a history quietly incomplete.
      if (index === lines.length - 1) continue;
      rejected?.push({ segment: hashPath(sessionFile), line_offset: index + 1 });
      continue;
    }
    // A line that parses as JSON is not yet a record this reader can use. `timestamp` becomes
    // `started_at` and `completed_at` verbatim, so a value that is not a time was stored as one:
    // `sync` reported it inserted, and every window, freshness and horizon computed over that row
    // was then computed over a string. Whatever the field holds also travelled out of the source
    // file and into the database unread, which is the shape a content leak would take.
    //
    // Only the two record types the turn tree is built from are held to this. Claude Code keeps
    // adding record types -- session titles, agent names, queue operations -- and the ones this
    // reader never looks at need not carry a time; refusing them would break SNACK on a client
    // release that changed nothing SNACK reads.
    //
    // Those two types are first held to the family's shape -- here, on every record, and not only
    // in the fingerprint `readSince` runs, which samples the head of each file. A session resumed
    // by a later client gains that client's records at its tail. A turn record of another shape is
    // not damage this reader can step over: read under these rules it becomes a prompt stored with
    // null tokens. So it refuses the whole history, before anything is written, as drift at the
    // head of a file does.
    const turnRecord = record.type === "user" || record.type === "assistant";
    if (turnRecord && !isSupportedTurnRecord(record)) throw drift();
    if (turnRecord && !Number.isFinite(Date.parse(String(record.timestamp)))) {
      rejected?.push({ segment: hashPath(sessionFile), line_offset: index + 1 });
      continue;
    }
    appendPosition.set(record, { file: sessionFile, line: index });
    records.push(record);
  }
  return records;
}
