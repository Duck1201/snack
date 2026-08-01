import Database from "better-sqlite3";

import { ENVELOPE_SCHEMA_VERSION } from "./output.js";

/**
 * The export contract, versioned independently of the output envelope because it freezes as a
 * public contract at 1.0 on its own timeline.
 */
export const EXPORT_SCHEMA_VERSION = "2";

/**
 * Exported tables, flat and joined by key rather than nested.
 *
 * Flat tables mean JSON and CSV carry exactly the same records, no merge join is needed to
 * assemble them, and every table streams one row at a time regardless of how many usage slices
 * or predictions a prompt accumulated.
 *
 * The column list of each table is part of the contract: a table is exported by naming its
 * columns, never by selecting everything a future migration happens to add. Operational tables
 * are deliberately absent — cursors, ingestion issues, pending mappings, and above all
 * `pending_spool_observation`, whose payload column is the one place an unreviewed field from a
 * future capture schema could reach an export.
 *
 * @type {{name: string, columns: string[], sql: (filter: {source: boolean, since: boolean, until: boolean}) => string}[]}
 */
export const EXPORT_TABLES = [
  {
    name: "capacity_periods",
    columns: [
      "id",
      "source_alias",
      "provider",
      "profile",
      "plan",
      "started_at",
      "ended_at",
      "plan_profile_id",
      "plan_profile_version",
    ],
    sql: (filter) => `
      SELECT id, source_alias, provider, profile, plan, started_at, ended_at,
             plan_profile_id, plan_profile_version
        FROM capacity_period
       WHERE 1 = 1
         ${filter.source ? "AND source_alias = @source" : ""}
       ORDER BY started_at, id`,
  },
  {
    // What an `installation_id` on a prompt means. The attribution is an opaque id, so without the
    // bindings a consumer can tell two clients apart but not say which is which; with them the join
    // is one row per configured client rather than a client name repeated on every prompt.
    //
    // `client_installation` itself is not exported. Its `local_fingerprint` is derived from a local
    // path, and an export is the one artifact that leaves the machine.
    name: "source_bindings",
    columns: ["source_alias", "installation_id", "adapter", "provider", "profile"],
    sql: (filter) => `
      SELECT source_alias, installation_id, adapter, provider, profile
        FROM source_binding
       WHERE 1 = 1
         ${filter.source ? "AND source_alias = @source" : ""}
       ORDER BY source_alias, installation_id`,
  },
  {
    name: "prompts",
    columns: [
      "id",
      "source_alias",
      "installation_id",
      "capacity_period_id",
      "started_at",
      "completed_at",
      "duration_ms",
      "completion",
      "outcome",
      "outcome_policy_version",
      "size_category",
      "category_policy_version",
      "category_baseline_as_of",
      "parser_version",
      "revision_domain",
      "seen_spool",
      "input_analyzer_version",
      "estimated_input_tokens",
      "input_line_count_bucket",
      "input_code_block_count_bucket",
      "input_attachment_count",
    ],
    sql: (filter) => `
      SELECT prompt_execution.id AS id,
             prompt_execution.source_alias AS source_alias,
             prompt_execution.installation_id AS installation_id,
             prompt_execution.capacity_period_id AS capacity_period_id,
             prompt_execution.started_at AS started_at,
             prompt_execution.completed_at AS completed_at,
             prompt_execution.duration_ms AS duration_ms,
             prompt_execution.completion AS completion,
             prompt_source_outcome.outcome AS outcome,
             prompt_source_outcome.policy_version AS outcome_policy_version,
             prompt_execution.size_category AS size_category,
             prompt_execution.category_policy_version AS category_policy_version,
             prompt_execution.category_baseline_as_of AS category_baseline_as_of,
             prompt_execution.parser_version AS parser_version,
             prompt_execution.revision_domain AS revision_domain,
             prompt_execution.seen_spool AS seen_spool,
             prompt_execution.input_analyzer_version AS input_analyzer_version,
             prompt_execution.estimated_input_tokens AS estimated_input_tokens,
             prompt_execution.input_line_count_bucket AS input_line_count_bucket,
             prompt_execution.input_code_block_count_bucket AS input_code_block_count_bucket,
             prompt_execution.input_attachment_count AS input_attachment_count
        FROM prompt_execution
        LEFT JOIN prompt_source_outcome
          ON prompt_source_outcome.prompt_execution_id = prompt_execution.id
       WHERE 1 = 1
         ${filter.source ? "AND prompt_execution.source_alias = @source" : ""}
         ${filter.since ? "AND prompt_execution.started_at >= @since" : ""}
         ${filter.until ? "AND prompt_execution.started_at < @until" : ""}
       ORDER BY prompt_execution.started_at, prompt_execution.id`,
  },
  {
    name: "usage_slices",
    columns: [
      "prompt_execution_id",
      "source_slice_id",
      "provider",
      "model",
      "input_tokens",
      "output_tokens",
      "reasoning_tokens",
      "cache_read_tokens",
      "cache_write_tokens",
      "cost_decimal",
      "currency",
    ],
    sql: (filter) => `
      SELECT prompt_usage_slice.prompt_execution_id AS prompt_execution_id,
             prompt_usage_slice.source_slice_id AS source_slice_id,
             prompt_usage_slice.provider AS provider,
             prompt_usage_slice.model AS model,
             prompt_usage_slice.input_tokens AS input_tokens,
             prompt_usage_slice.output_tokens AS output_tokens,
             prompt_usage_slice.reasoning_tokens AS reasoning_tokens,
             prompt_usage_slice.cache_read_tokens AS cache_read_tokens,
             prompt_usage_slice.cache_write_tokens AS cache_write_tokens,
             prompt_usage_slice.cost_decimal AS cost_decimal,
             prompt_usage_slice.currency AS currency
        FROM prompt_usage_slice
        JOIN prompt_execution ON prompt_execution.id = prompt_usage_slice.prompt_execution_id
       WHERE 1 = 1
         ${filter.source ? "AND prompt_execution.source_alias = @source" : ""}
         ${filter.since ? "AND prompt_execution.started_at >= @since" : ""}
         ${filter.until ? "AND prompt_execution.started_at < @until" : ""}
       ORDER BY prompt_usage_slice.prompt_execution_id, prompt_usage_slice.source_slice_id`,
  },
  {
    name: "restrictions",
    columns: [
      "prompt_execution_id",
      "class",
      "source_code",
      "observed_at",
      "classifier_version",
      "provenance",
    ],
    sql: (filter) => `
      SELECT restriction_observation.prompt_execution_id AS prompt_execution_id,
             restriction_observation.class AS class,
             restriction_observation.source_code AS source_code,
             restriction_observation.observed_at AS observed_at,
             restriction_observation.classifier_version AS classifier_version,
             restriction_observation.provenance AS provenance
        FROM restriction_observation
        JOIN prompt_execution
          ON prompt_execution.id = restriction_observation.prompt_execution_id
       WHERE 1 = 1
         ${filter.source ? "AND prompt_execution.source_alias = @source" : ""}
         ${filter.since ? "AND prompt_execution.started_at >= @since" : ""}
         ${filter.until ? "AND prompt_execution.started_at < @until" : ""}
       ORDER BY restriction_observation.observed_at,
                restriction_observation.prompt_execution_id`,
  },
  {
    name: "predictions",
    columns: [
      "id",
      "source_alias",
      "capacity_period_id",
      "generated_at",
      "delivered",
      "delivered_at",
      "delivery_channel",
      "delivery_format",
      "method_id",
      "method_version",
      "model_policy_version",
      "risk_policy_version",
      "evidence_policy_version",
      "weight_policy_version",
      "analytics_policy_version",
      "category_policy_version",
      "lower",
      "point",
      "upper",
      "coverage_target",
      "risk_label",
      "evidence_level",
      "expected_size_category",
      "backoff_level",
      "pressure_band",
      "pressure_score",
      "plan_profile_id",
      "plan_profile_version",
      "data_as_of",
      "completeness",
    ],
    sql: (filter) => `
      SELECT prediction_attempt.id AS id,
             prediction_attempt.source_alias AS source_alias,
             prediction_attempt.capacity_period_id AS capacity_period_id,
             prediction_attempt.generated_at AS generated_at,
             CASE WHEN prediction_delivery.prediction_attempt_id IS NULL THEN 0 ELSE 1 END
               AS delivered,
             prediction_delivery.delivered_at AS delivered_at,
             prediction_delivery.channel AS delivery_channel,
             prediction_delivery.format AS delivery_format,
             prediction_attempt.method_id AS method_id,
             prediction_attempt.method_version AS method_version,
             prediction_attempt.model_policy_version AS model_policy_version,
             prediction_attempt.risk_policy_version AS risk_policy_version,
             prediction_attempt.evidence_policy_version AS evidence_policy_version,
             prediction_attempt.weight_policy_version AS weight_policy_version,
             prediction_attempt.analytics_policy_version AS analytics_policy_version,
             prediction_attempt.category_policy_version AS category_policy_version,
             prediction_attempt.lower AS lower,
             prediction_attempt.point AS point,
             prediction_attempt.upper AS upper,
             prediction_attempt.coverage_target AS coverage_target,
             prediction_attempt.risk_label AS risk_label,
             prediction_attempt.evidence_level AS evidence_level,
             prediction_attempt.expected_size_category AS expected_size_category,
             prediction_attempt.backoff_level AS backoff_level,
             prediction_attempt.pressure_band AS pressure_band,
             prediction_attempt.pressure_score AS pressure_score,
             prediction_attempt.plan_profile_id AS plan_profile_id,
             prediction_attempt.plan_profile_version AS plan_profile_version,
             prediction_attempt.data_as_of AS data_as_of,
             prediction_attempt.completeness AS completeness
        FROM prediction_attempt
        LEFT JOIN prediction_delivery
          ON prediction_delivery.prediction_attempt_id = prediction_attempt.id
       WHERE 1 = 1
         ${filter.source ? "AND prediction_attempt.source_alias = @source" : ""}
         ${filter.since ? "AND prediction_attempt.generated_at >= @since" : ""}
         ${filter.until ? "AND prediction_attempt.generated_at < @until" : ""}
       ORDER BY prediction_attempt.generated_at, prediction_attempt.id`,
  },
  {
    name: "prediction_evaluations",
    columns: [
      "prediction_attempt_id",
      "prompt_execution_id",
      "linked_at",
      "is_primary",
      "policy_version",
    ],
    sql: (filter) => `
      SELECT prediction_evaluation.prediction_attempt_id AS prediction_attempt_id,
             prediction_evaluation.prompt_execution_id AS prompt_execution_id,
             prediction_evaluation.linked_at AS linked_at,
             prediction_evaluation.is_primary AS is_primary,
             prediction_evaluation.policy_version AS policy_version
        FROM prediction_evaluation
        JOIN prediction_attempt
          ON prediction_attempt.id = prediction_evaluation.prediction_attempt_id
       WHERE 1 = 1
         ${filter.source ? "AND prediction_attempt.source_alias = @source" : ""}
         ${filter.since ? "AND prediction_evaluation.linked_at >= @since" : ""}
         ${filter.until ? "AND prediction_evaluation.linked_at < @until" : ""}
       ORDER BY prediction_evaluation.prediction_attempt_id,
                prediction_evaluation.prompt_execution_id`,
  },
];

/**
 * @typedef {object} ExportScope
 * @property {string} [source]
 * @property {string} [since] Inclusive lower bound.
 * @property {string} [until] Exclusive upper bound, matching the half-open horizon convention.
 */

/**
 * Yield one table's rows without ever holding the table in memory.
 *
 * @param {string} databaseFile
 * @param {ExportScope} scope
 * @param {string} tableName
 * @yields {Record<string, unknown>} one exported row
 * @returns {Generator<Record<string, unknown>, void, void>}
 */
export function* exportTable(databaseFile, scope, tableName) {
  const table = EXPORT_TABLES.find((candidate) => candidate.name === tableName);
  if (table === undefined) throw new Error(`Unknown export table '${tableName}'.`);
  const database = new Database(databaseFile, { readonly: true, fileMustExist: true });
  try {
    const statement = database.prepare(
      table.sql({
        source: scope.source !== undefined,
        since: scope.since !== undefined,
        until: scope.until !== undefined,
      }),
    );
    const parameters = {
      ...(scope.source === undefined ? {} : { source: scope.source }),
      ...(scope.since === undefined ? {} : { since: scope.since }),
      ...(scope.until === undefined ? {} : { until: scope.until }),
    };
    const rows = statement.iterate(parameters);
    try {
      for (const row of rows) {
        yield /** @type {Record<string, unknown>} */ (row);
      }
    } finally {
      rows.return?.();
    }
  } finally {
    database.close();
  }
}

/**
 * Render the whole export as a stream of string chunks.
 *
 * The envelope is written by hand around streamed array bodies so a six-figure history never
 * has to exist as one object before it can be serialized. `test/export.test.js` asserts the
 * assembled bytes still parse into exactly what `createEnvelope` would have produced.
 *
 * @param {string} databaseFile
 * @param {ExportScope} scope
 * @param {{command: string, now: Date, provenance: unknown}} context
 * @yields {string} the next fragment of the document
 * @returns {Generator<string, Record<string, number>, void>} row counts per table
 */
export function* exportJsonChunks(databaseFile, scope, context) {
  yield `{\n  "schema_version": ${JSON.stringify(ENVELOPE_SCHEMA_VERSION)},\n  "command": ${JSON.stringify(context.command)},\n`;
  yield `  "generated_at": ${JSON.stringify(context.now.toISOString())},\n`;
  yield `  "status": "ok",\n  "data": {\n`;
  yield `    "export": ${JSON.stringify({ export_schema_version: EXPORT_SCHEMA_VERSION, scope })},\n`;
  yield `    "provenance": ${JSON.stringify(context.provenance)},\n`;
  yield `    "tables": {\n`;
  /** @type {Record<string, number>} */
  const counts = {};
  for (const [index, table] of EXPORT_TABLES.entries()) {
    yield `      ${JSON.stringify(table.name)}: [`;
    let rows = 0;
    for (const row of exportTable(databaseFile, scope, table.name)) {
      yield rows === 0 ? "\n        " : ",\n        ";
      yield JSON.stringify(row);
      rows += 1;
    }
    yield rows === 0 ? "]" : "\n      ]";
    yield index === EXPORT_TABLES.length - 1 ? "\n" : ",\n";
    counts[table.name] = rows;
  }
  yield `    }\n  },\n  "warnings": [],\n  "errors": []\n}\n`;
  return counts;
}

/**
 * Render one CSV field.
 *
 * A missing value stays empty rather than becoming `0` or the text `null`: the difference
 * between unobserved and zero is load-bearing everywhere else in SNACK, and an export must not
 * be the place it is lost.
 *
 * @param {unknown} value
 */
export function toCsvField(value) {
  if (value === null || value === undefined) return "";
  const text = String(value);
  return /["\n\r,]/u.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

/**
 * Render one table as CSV chunks, header first.
 *
 * @param {string} databaseFile
 * @param {ExportScope} scope
 * @param {{name: string, columns: string[]}} table
 * @yields {string} the header, then one line per row
 * @returns {Generator<string, number, void>}
 */
export function* exportCsvChunks(databaseFile, scope, table) {
  yield `${table.columns.join(",")}\n`;
  let rows = 0;
  for (const row of exportTable(databaseFile, scope, table.name)) {
    yield `${table.columns.map((column) => toCsvField(row[column])).join(",")}\n`;
    rows += 1;
  }
  return rows;
}
