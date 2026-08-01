/**
 * @typedef {object} Diagnostic
 * @property {string} code
 * @property {string} message
 */

/**
 * Version of the envelope contract, frozen at Stage 9.
 *
 * Version 2 renamed the `config set` storage keys to the snake_case every other payload uses, and
 * pinned the per-command payloads that version 1 left unconstrained. Named once because the string
 * was written out in three places -- here, the streaming export, and the export provenance -- which
 * is how the three would have drifted.
 */
export const ENVELOPE_SCHEMA_VERSION = "2";

/**
 * @param {string} command
 * @param {unknown} data
 * @param {{status?: "ok" | "degraded" | "error", warnings?: Diagnostic[], errors?: Diagnostic[], now?: Date}} [options]
 */
export function createEnvelope(command, data, options = {}) {
  return {
    schema_version: ENVELOPE_SCHEMA_VERSION,
    command,
    generated_at: (options.now ?? new Date()).toISOString(),
    status: options.status ?? "ok",
    data,
    warnings: options.warnings ?? [],
    errors: options.errors ?? [],
  };
}

/** @param {unknown} value */
export function formatJson(value) {
  return `${JSON.stringify(value, null, 2)}\n`;
}
