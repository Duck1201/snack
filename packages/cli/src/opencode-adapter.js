import Database from "better-sqlite3";
import { homedir as systemHomedir } from "node:os";
import { isAbsolute, join } from "node:path";

import { ExitCode, SnackError } from "./errors.js";

const requiredTables = {
  session: [
    ["id", "TEXT", true],
    ["version", "TEXT", false],
  ],
  message: [
    ["id", "TEXT", true],
    ["session_id", "TEXT", false],
    ["time_created", "INTEGER", false],
    ["time_updated", "INTEGER", false],
    ["data", "TEXT", false],
  ],
  part: [
    ["id", "TEXT", true],
    ["message_id", "TEXT", false],
    ["session_id", "TEXT", false],
    ["time_created", "INTEGER", false],
    ["time_updated", "INTEGER", false],
    ["data", "TEXT", false],
  ],
};

const requiredIndexes = {
  message: [["session_id", "time_created", "id"]],
  part: [["message_id", "id"], ["session_id"]],
};

const requiredForeignKeys = {
  message: [["session_id", "session", "id", "CASCADE"]],
  part: [["message_id", "message", "id", "CASCADE"]],
};

const operationalErrors = new Set([
  "ProviderAuthError",
  "MessageOutputLengthError",
  "StructuredOutputError",
  "ContextOverflowError",
  "ContentFilterError",
  "UnknownError",
  "APIError",
]);

/**
 * Resolve OpenCode's database without probing credentials or content.
 *
 * @param {{env?: NodeJS.ProcessEnv, home?: string}} [options]
 */
export function resolveOpenCodeDatabase(options = {}) {
  const env = options.env ?? process.env;
  const configured = env.OPENCODE_DB;
  if (configured && isAbsolute(configured)) return configured;
  const home = options.home ?? systemHomedir();
  const dataHome =
    env.XDG_DATA_HOME && isAbsolute(env.XDG_DATA_HOME)
      ? env.XDG_DATA_HOME
      : join(home, ".local", "share");
  return join(dataHome, "opencode", "opencode.db");
}

/**
 * Open OpenCode's own database read-only and query-only.
 *
 * Every reason an open can fail — no OpenCode installation, a missing data directory, a file
 * SNACK may not read — is the same fact to a user: the source is unavailable. better-sqlite3
 * reports those as different native error types, so they are classified once, here, instead of
 * reaching the command layer as an unexplained internal failure. The message names no path.
 *
 * @param {string} databaseFile
 */
function openSource(databaseFile) {
  try {
    const database = new Database(databaseFile, { readonly: true, fileMustExist: true });
    database.pragma("query_only = ON");
    // SQLite validates the file header on the first read, not on open, so a file that is not a
    // database survives the constructor and fails inside whichever query runs first. Forcing that
    // read here keeps every way of not being a readable source classified in one place.
    database.pragma("schema_version");
    return database;
  } catch {
    throw new SnackError(
      "OpenCode history is unavailable; its database could not be opened. Install OpenCode, or set OPENCODE_DB to an existing OpenCode database.",
      { code: ExitCode.unavailable, reason: "source_unavailable" },
    );
  }
}

/**
 * Create the internal OpenCode source-adapter port.
 *
 * @param {{databaseFile: string}} options
 */
export function createOpenCodeAdapter(options) {
  return {
    detect() {
      const database = openSource(options.databaseFile);
      try {
        const versions = /** @type {{version: string}[]} */ (
          database.prepare("SELECT DISTINCT version FROM session ORDER BY version").all()
        ).map((row) => row.version);
        return { detected: true, client: "opencode", versions };
      } finally {
        database.close();
      }
    },
    fingerprint() {
      const database = openSource(options.databaseFile);
      try {
        const supported = hasSupportedStructure(database);
        return {
          adapter: "opencode-sqlite",
          fingerprint_version: 1,
          family: supported ? "oc-sqlite-msgpart-v1" : null,
          supported,
        };
      } finally {
        database.close();
      }
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
    readAll() {
      const database = openSource(options.databaseFile);
      try {
        if (!hasSupportedStructure(database)) {
          throw new SnackError("The OpenCode database fingerprint is unsupported.", {
            code: ExitCode.unavailable,
            reason: "source_schema_unsupported",
          });
        }
        return readObservations(database);
      } finally {
        database.close();
      }
    },
    /** @param {{time_updated: number, message_id: string} | null} cursor */
    readSince(cursor) {
      const database = openSource(options.databaseFile);
      try {
        if (!hasSupportedStructure(database)) {
          throw new SnackError("The OpenCode database fingerprint is unsupported.", {
            code: ExitCode.unavailable,
            reason: "source_schema_unsupported",
          });
        }
        const sessionIds =
          cursor === null ? undefined : readAffectedSessionIds(database, cursor.time_updated);
        const result = readObservations(database, sessionIds);
        if (cursor === null) return result;
        return {
          observations: result.observations.filter((observation) => {
            const separator = observation.revision.indexOf(":");
            const timeUpdated = Number(observation.revision.slice(0, separator));
            return timeUpdated >= cursor.time_updated;
          }),
          cursor: result.cursor,
        };
      } finally {
        database.close();
      }
    },
  };
}

/** @param {Database.Database} database @param {string[] | undefined} sessionIds */
function readObservations(database, sessionIds = undefined) {
  const read = database.transaction(() => {
    const sessionFilter = sessionIds
      ? sessionIds.length === 0
        ? " AND 0"
        : ` AND message.session_id IN (${sessionIds.map(() => "?").join(", ")})`
      : "";
    const users = /** @type {MessageRow[]} */ (
      database
        .prepare(
          `SELECT
             message.id,
             message.session_id,
             message.time_created,
             message.time_updated,
             json_extract(message.data, '$.time.created') AS json_created,
             -- The user row names its own provider and model. That is the only attribution a
             -- prompt whose assistant reply never arrived will ever have.
             json_extract(message.data, '$.model.providerID') AS user_provider,
             json_extract(message.data, '$.model.modelID') AS user_model,
             EXISTS (
               SELECT 1 FROM part
               WHERE part.message_id = message.id
                 AND json_extract(part.data, '$.type') = 'compaction'
             ) AS is_compaction,
             EXISTS (
               SELECT 1 FROM part
               WHERE part.message_id = message.id
                 AND json_extract(part.data, '$.type') = 'text'
                 AND json_extract(part.data, '$.synthetic') = 1
                 AND json_extract(part.data, '$.metadata.compaction_continue') = 1
             ) AS is_continuation,
             (
               SELECT json_extract(part.data, '$.overflow')
               FROM part
               WHERE part.message_id = message.id
                 AND json_extract(part.data, '$.type') = 'compaction'
               ORDER BY part.id
               LIMIT 1
             ) AS compaction_overflow
           FROM message
           JOIN session ON session.id = message.session_id
           WHERE json_extract(message.data, '$.role') = 'user'${sessionFilter}
           ORDER BY message.time_created, message.id`,
        )
        .all(...(sessionIds ?? []))
    );
    const assistants = /** @type {AssistantRow[]} */ (
      database
        .prepare(
          `SELECT
             message.id,
             message.session_id,
             message.time_created,
             message.time_updated,
             json_extract(message.data, '$.parentID') AS parent_id,
             json_extract(message.data, '$.time.completed') AS completed,
             json_extract(message.data, '$.providerID') AS provider,
             json_extract(message.data, '$.modelID') AS model,
             json_extract(message.data, '$.finish') AS finish,
             json_extract(message.data, '$.summary') AS summary,
             json_type(message.data, '$.error') AS error_type,
             json_extract(message.data, '$.error.name') AS error_name,
             json_extract(message.data, '$.error.data.statusCode') AS error_status_code
           FROM message
           JOIN session ON session.id = message.session_id
           WHERE json_extract(message.data, '$.role') = 'assistant'${sessionFilter}
           ORDER BY message.time_created, message.id`,
        )
        .all(...(sessionIds ?? []))
    );
    const readSlices = database.prepare(
      `SELECT
         part.id,
         part.time_updated,
         part.data -> '$.cost' AS cost_decimal,
         json_extract(part.data, '$.tokens.input') AS input_tokens,
         json_extract(part.data, '$.tokens.output') AS output_tokens,
         json_extract(part.data, '$.tokens.reasoning') AS reasoning_tokens,
         json_extract(part.data, '$.tokens.cache.read') AS cache_read_tokens,
         json_extract(part.data, '$.tokens.cache.write') AS cache_write_tokens
       FROM part
       WHERE part.message_id = ?
         AND json_extract(part.data, '$.type') = 'step-finish'
       ORDER BY part.id`,
    );
    const readUserRevision = database.prepare(
      `SELECT MAX(time_updated) AS time_updated
       FROM (
         SELECT time_updated FROM message WHERE id = ?
         UNION ALL
         SELECT time_updated FROM part WHERE message_id = ?
       )`,
    );

    const ownerByUser = new Map();
    const stateBySession = new Map();
    const externalUsers = [];
    const usersById = new Map(users.map((user) => [user.id, user]));
    const events = [
      ...users.map((user) => ({ kind: "user", row: user })),
      ...assistants
        .filter((assistant) => assistant.summary === 1)
        .map((assistant) => ({ kind: "summary", row: assistant })),
    ].sort(
      (left, right) =>
        left.row.time_created - right.row.time_created || left.row.id.localeCompare(right.row.id),
    );
    for (const event of events) {
      const state = stateBySession.get(event.row.session_id) ?? {
        latestExternal: undefined,
        pendingReplay: undefined,
      };
      stateBySession.set(event.row.session_id, state);
      if (event.kind === "summary") {
        const assistant = /** @type {AssistantRow} */ (event.row);
        const parent =
          typeof assistant.parent_id === "string" ? usersById.get(assistant.parent_id) : undefined;
        if (parent?.compaction_overflow === 1) {
          state.pendingReplay = ownerByUser.get(parent.id) ?? state.latestExternal;
        }
        continue;
      }
      const user = /** @type {MessageRow} */ (event.row);
      const internal = user.is_compaction === 1 || user.is_continuation === 1;
      if (internal) {
        if (state.latestExternal) ownerByUser.set(user.id, state.latestExternal);
        continue;
      }
      if (state.pendingReplay) {
        ownerByUser.set(user.id, state.pendingReplay);
        state.pendingReplay = undefined;
        continue;
      }
      ownerByUser.set(user.id, user.id);
      state.latestExternal = user.id;
      externalUsers.push(user);
    }

    // Group by owning prompt once. Scanning every assistant and every ownership entry
    // per prompt made a full backfill quadratic in the number of prompts.
    /** @type {Map<string, AssistantRow[]>} */
    const assistantsByOwner = new Map();
    for (const assistant of assistants) {
      if (typeof assistant.parent_id !== "string") continue;
      const owner = ownerByUser.get(assistant.parent_id);
      if (owner === undefined) continue;
      if (usersById.get(owner)?.session_id !== assistant.session_id) continue;
      const group = assistantsByOwner.get(owner);
      if (group) group.push(assistant);
      else assistantsByOwner.set(owner, [assistant]);
    }
    /** @type {Map<string, string[]>} */
    const userIdsByOwner = new Map();
    for (const [userId, owner] of ownerByUser) {
      const group = userIdsByOwner.get(owner);
      if (group) group.push(userId);
      else userIdsByOwner.set(owner, [userId]);
    }

    const observations = externalUsers.flatMap((user) => {
      const children = assistantsByOwner.get(user.id) ?? [];
      const started = numberOrNull(user.json_created) ?? user.time_created;
      const userRevisions = (userIdsByOwner.get(user.id) ?? []).flatMap((userId) => {
        const row = /** @type {{time_updated: number | null} | undefined} */ (
          readUserRevision.get(userId, userId)
        );
        return row?.time_updated === null || row?.time_updated === undefined
          ? []
          : [{ timeUpdated: row.time_updated, messageId: userId }];
      });
      /** @type {Map<string | null, AssistantRow[]>} */
      const byProvider = new Map();
      for (const child of children) {
        const provider = stringOrNull(child.provider);
        const group = byProvider.get(provider);
        if (group) group.push(child);
        else byProvider.set(provider, [child]);
      }
      // A prompt with no assistant message at all: sent, and nothing came back that OpenCode
      // recorded. Grouping by the children of an empty set yields nothing, so until `1.0.2` the
      // prompt was not emitted, not counted, and not reconcilable against the source -- eleven of
      // 194 on a real history. The spec already names this state: completion `unknown`, outcome
      // `excluded`, which contributes descriptive dimensions without touching the outcome model.
      if (byProvider.size === 0) {
        const revision = userRevisions.at(-1);
        return [
          {
            source_prompt_id: user.id,
            source_session_id: user.session_id,
            revision: `${revision?.timeUpdated ?? user.time_updated}:${revision?.messageId ?? user.id}`,
            revision_domain: "opencode-message-v1",
            parser_version: "opencode-session-v1",
            started_at: new Date(started).toISOString(),
            completed_at: null,
            duration_ms: null,
            // `provisional`, not the `unknown` that docs/specification.md 4.3 names for this
            // state: `prompt_execution.completion` is `CHECK (completion IN ('provisional',
            // 'completed'))`, so `unknown` needs a table rebuild. `provisional` is true here --
            // nothing recorded says this prompt finished -- and it is what an abandoned prompt
            // already gets. The vocabulary gap is real and belongs to a release that can carry a
            // migration.
            completion: /** @type {const} */ ("provisional"),
            provider: stringOrNull(user.user_provider),
            model: stringOrNull(user.user_model),
            outcome: /** @type {const} */ ("excluded"),
            usage_slices: [],
            restrictions: [],
          },
        ];
      }
      return [...byProvider.entries()].map(([provider, providerChildren]) => {
        const terminal = providerChildren.at(-1);
        if (!terminal) throw new Error("Provider outcome has no assistant observation.");
        const completed = numberOrNull(terminal.completed);
        const slicesByAssistant = providerChildren.map((assistant) => ({
          assistant,
          slices: /** @type {SliceRow[]} */ (readSlices.all(assistant.id)),
        }));
        const usageSlices = slicesByAssistant.flatMap(({ assistant, slices }) =>
          slices.map((slice) => ({
            source_slice_id: slice.id,
            provider: stringOrNull(assistant.provider),
            model: stringOrNull(assistant.model),
            input_tokens: numberOrNull(slice.input_tokens),
            output_tokens: numberOrNull(slice.output_tokens),
            reasoning_tokens: numberOrNull(slice.reasoning_tokens),
            cache_read_tokens: numberOrNull(slice.cache_read_tokens),
            cache_write_tokens: numberOrNull(slice.cache_write_tokens),
            cost_decimal: stringOrNull(slice.cost_decimal),
            currency: null,
          })),
        );
        const revision = slicesByAssistant
          .flatMap(({ assistant, slices }) => [
            { timeUpdated: assistant.time_updated, messageId: assistant.id },
            ...slices.map((slice) => ({
              timeUpdated: slice.time_updated,
              messageId: assistant.id,
            })),
          ])
          .concat(userRevisions)
          .sort(
            (left, right) =>
              left.timeUpdated - right.timeUpdated || left.messageId.localeCompare(right.messageId),
          )
          .at(-1);
        const restrictions = providerChildren.flatMap((assistant) => {
          const assistantCompleted = numberOrNull(assistant.completed);
          return assistant.error_name === "APIError" &&
            numberOrNull(assistant.error_status_code) === 429
            ? [
                {
                  class: "rate_limit",
                  source_code: "http_429",
                  observed_at: new Date(assistantCompleted ?? assistant.time_updated).toISOString(),
                  classifier_version: "opencode-error-v1",
                  provenance: "backfill",
                },
              ]
            : [];
        });
        const rateLimited = restrictions.length > 0;
        const finalized =
          completed !== null && (terminal.error_type !== null || terminal.finish !== "tool-calls");
        const successful =
          finalized &&
          terminal.error_type === null &&
          typeof terminal.finish === "string" &&
          terminal.finish !== "tool-calls";
        const exclusion = classifyExclusion(terminal.error_name, rateLimited);
        return {
          source_prompt_id: user.id,
          source_session_id: user.session_id,
          revision: `${revision?.timeUpdated ?? terminal.time_updated}:${revision?.messageId ?? terminal.id}`,
          revision_domain: "opencode-message-v1",
          parser_version: "opencode-session-v1",
          started_at: new Date(started).toISOString(),
          completed_at: completed === null ? null : new Date(completed).toISOString(),
          duration_ms: completed === null || completed < started ? null : completed - started,
          completion: finalized ? "completed" : "provisional",
          provider,
          model: stringOrNull(terminal.model),
          outcome: rateLimited ? "restricted" : successful ? "success" : "excluded",
          ...(exclusion ? { exclusion } : {}),
          usage_slices: usageSlices,
          restrictions,
        };
      });
    });
    const cursorRow = /** @type {{time_updated: number, id: string} | undefined} */ (
      database
        .prepare(
          `SELECT time_updated, message_id AS id
           FROM (
             SELECT time_updated, id AS message_id FROM message
             UNION ALL
             SELECT time_updated, message_id FROM part
           )
           ORDER BY time_updated DESC, message_id DESC
           LIMIT 1`,
        )
        .get()
    );
    return {
      observations,
      cursor: cursorRow ? { time_updated: cursorRow.time_updated, message_id: cursorRow.id } : null,
    };
  });
  return read.deferred();
}

/** @param {Database.Database} database @param {number} boundary */
function readAffectedSessionIds(database, boundary) {
  const rows = /** @type {{session_id: string}[]} */ (
    database
      .prepare(
        `SELECT session_id FROM message WHERE time_updated >= ?
         UNION
         SELECT session_id FROM part WHERE time_updated >= ?
         ORDER BY session_id`,
      )
      .all(boundary, boundary)
  );
  return rows.map((row) => row.session_id);
}

/**
 * @typedef {object} MessageRow
 * @property {string} id
 * @property {string} session_id
 * @property {number} time_created
 * @property {number} time_updated
 * @property {unknown} json_created
 * @property {number} is_compaction
 * @property {number} is_continuation
 * @property {unknown} compaction_overflow
 */

/**
 * @typedef {MessageRow & {
 *   parent_id: unknown,
 *   completed: unknown,
 *   provider: unknown,
 *   model: unknown,
 *   finish: unknown,
 *   summary: unknown,
 *   error_type: unknown,
 *   error_name: unknown,
 *   error_status_code: unknown
 * }} AssistantRow
 */

/**
 * @typedef {object} SliceRow
 * @property {string} id
 * @property {number} time_updated
 * @property {unknown} cost_decimal
 * @property {unknown} input_tokens
 * @property {unknown} output_tokens
 * @property {unknown} reasoning_tokens
 * @property {unknown} cache_read_tokens
 * @property {unknown} cache_write_tokens
 */

/** @param {unknown} value */
function numberOrNull(value) {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/** @param {unknown} value */
function stringOrNull(value) {
  return typeof value === "string" ? value : null;
}

/** @param {unknown} errorName @param {boolean} rateLimited */
function classifyExclusion(errorName, rateLimited) {
  if (errorName === "MessageAbortedError") {
    return {
      class: "cancelled",
      source_code: errorName,
      classifier_version: "opencode-error-v1",
    };
  }
  if (!rateLimited && typeof errorName === "string" && operationalErrors.has(errorName)) {
    return {
      class: "operational_error",
      source_code: errorName,
      classifier_version: "opencode-error-v1",
    };
  }
  return undefined;
}

/** @param {Database.Database} database */
function hasSupportedStructure(database) {
  for (const [table, requirements] of Object.entries(requiredTables)) {
    const columns = /** @type {{name: string, type: string, notnull: number, pk: number}[]} */ (
      database.pragma(`table_info(${table})`)
    );
    if (
      !requirements.every(([name, type, primary]) =>
        columns.some(
          (column) =>
            column.name === name &&
            column.type.toUpperCase() === type &&
            // A primary key is asserted through `pk`, never through `notnull`. SQLite reports
            // `notnull = 0` for a `TEXT PRIMARY KEY` outside a STRICT table, and OpenCode's own
            // DDL is not STRICT, so demanding it here rejects every real installation while a
            // hand-written STRICT fixture keeps passing.
            (primary ? column.pk === 1 : column.pk === 0 && column.notnull === 1),
        ),
      )
    ) {
      return false;
    }
  }

  for (const [table, requirements] of Object.entries(requiredIndexes)) {
    const indexes = /** @type {{name: string}[]} */ (database.pragma(`index_list(${table})`));
    const columnSequences = indexes.map((index) =>
      /** @type {{name: string}[]} */ (database.pragma(`index_info(${index.name})`)).map(
        (column) => column.name,
      ),
    );
    if (!requirements.every((required) => includesSequence(columnSequences, required)))
      return false;
  }

  for (const [table, requirements] of Object.entries(requiredForeignKeys)) {
    const foreignKeys =
      /** @type {{from: string, table: string, to: string, on_delete: string}[]} */ (
        database.pragma(`foreign_key_list(${table})`)
      );
    if (
      !requirements.every(([from, targetTable, to, onDelete]) =>
        foreignKeys.some(
          (foreignKey) =>
            foreignKey.from === from &&
            foreignKey.table === targetTable &&
            foreignKey.to === to &&
            foreignKey.on_delete === onDelete,
        ),
      )
    ) {
      return false;
    }
  }
  return hasSupportedJsonShapes(database);
}

/** @param {Database.Database} database */
function hasSupportedJsonShapes(database) {
  const invalidMessages = database
    .prepare(
      `SELECT COUNT(*) AS count
       FROM message
       WHERE NOT json_valid(data)
          OR COALESCE(json_extract(data, '$.role'), '') NOT IN ('user', 'assistant')
          OR (
            json_extract(data, '$.role') = 'user'
            AND (
              COALESCE(json_type(data, '$.time.created'), 'null') != 'integer'
              OR COALESCE(json_type(data, '$.agent'), 'null') != 'text'
              OR COALESCE(json_type(data, '$.model.providerID'), 'null') != 'text'
              OR COALESCE(json_type(data, '$.model.modelID'), 'null') != 'text'
            )
          )
          OR (
            json_extract(data, '$.role') = 'assistant'
            AND (
              COALESCE(json_type(data, '$.time.created'), 'null') != 'integer'
              OR COALESCE(json_type(data, '$.time.completed'), 'null') NOT IN ('integer', 'null')
              OR COALESCE(json_type(data, '$.parentID'), 'null') != 'text'
              OR COALESCE(json_type(data, '$.providerID'), 'null') != 'text'
              OR COALESCE(json_type(data, '$.modelID'), 'null') != 'text'
              OR COALESCE(json_type(data, '$.cost'), 'null') NOT IN ('integer', 'real')
              OR COALESCE(json_type(data, '$.tokens.input'), 'null') NOT IN ('integer', 'real')
              OR COALESCE(json_type(data, '$.tokens.output'), 'null') NOT IN ('integer', 'real')
              OR COALESCE(json_type(data, '$.tokens.reasoning'), 'null') NOT IN ('integer', 'real')
              OR COALESCE(json_type(data, '$.tokens.cache.read'), 'null') NOT IN ('integer', 'real')
              OR COALESCE(json_type(data, '$.tokens.cache.write'), 'null') NOT IN ('integer', 'real')
              OR COALESCE(json_type(data, '$.finish'), 'null') NOT IN ('text', 'null')
              OR COALESCE(json_type(data, '$.summary'), 'null') NOT IN ('true', 'false', 'null')
              OR COALESCE(json_type(data, '$.error'), 'null') NOT IN ('object', 'null')
              OR (json_type(data, '$.error') = 'object' AND COALESCE(json_type(data, '$.error.name'), 'null') != 'text')
              OR (json_type(data, '$.error') = 'object' AND COALESCE(json_type(data, '$.error.data'), 'null') != 'object')
              OR COALESCE(json_type(data, '$.error.data.statusCode'), 'null') NOT IN ('integer', 'null')
            )
          )`,
    )
    .get();
  if (readCount(invalidMessages) > 0) return false;

  const invalidParts = database
    .prepare(
      `SELECT COUNT(*) AS count
       FROM part
       WHERE NOT json_valid(data)
          OR COALESCE(json_extract(data, '$.type'), '') NOT IN (
            'snapshot', 'patch', 'text', 'subtask', 'reasoning', 'file', 'tool',
            'step-start', 'step-finish', 'agent', 'retry', 'compaction'
          )
          OR (
            json_extract(data, '$.type') = 'step-finish'
            AND (
              COALESCE(json_type(data, '$.reason'), 'null') != 'text'
              OR COALESCE(json_type(data, '$.cost'), 'null') NOT IN ('integer', 'real')
              OR COALESCE(json_type(data, '$.tokens.input'), 'null') NOT IN ('integer', 'real')
              OR COALESCE(json_type(data, '$.tokens.output'), 'null') NOT IN ('integer', 'real')
              OR COALESCE(json_type(data, '$.tokens.reasoning'), 'null') NOT IN ('integer', 'real')
              OR COALESCE(json_type(data, '$.tokens.cache.read'), 'null') NOT IN ('integer', 'real')
              OR COALESCE(json_type(data, '$.tokens.cache.write'), 'null') NOT IN ('integer', 'real')
            )
          )
          OR (
            json_extract(data, '$.type') = 'compaction'
            AND (
              COALESCE(json_type(data, '$.auto'), 'null') NOT IN ('true', 'false')
              OR COALESCE(json_type(data, '$.overflow'), 'null') NOT IN ('true', 'false', 'null')
              OR COALESCE(json_type(data, '$.tail_start_id'), 'null') NOT IN ('text', 'null')
            )
          )
          OR (
            json_extract(data, '$.type') = 'text'
            AND (
              COALESCE(json_type(data, '$.synthetic'), 'null') NOT IN ('true', 'false', 'null')
              OR COALESCE(json_type(data, '$.metadata'), 'null') NOT IN ('object', 'null')
              OR COALESCE(json_type(data, '$.metadata.compaction_continue'), 'null') NOT IN ('true', 'false', 'null')
            )
          )`,
    )
    .get();
  return readCount(invalidParts) === 0;
}

/** @param {unknown} row */
function readCount(row) {
  return typeof row === "object" && row !== null && "count" in row ? Number(row.count) : 1;
}

/** @param {string[][]} candidates @param {string[]} required */
function includesSequence(candidates, required) {
  return candidates.some(
    (candidate) =>
      candidate.length === required.length &&
      candidate.every((column, index) => column === required[index]),
  );
}
