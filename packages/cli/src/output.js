/**
 * @typedef {object} Diagnostic
 * @property {string} code
 * @property {string} message
 */

/**
 * @param {string} command
 * @param {unknown} data
 * @param {{status?: "ok" | "degraded" | "error", warnings?: Diagnostic[], errors?: Diagnostic[], now?: Date}} [options]
 */
export function createEnvelope(command, data, options = {}) {
  return {
    schema_version: "1",
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
