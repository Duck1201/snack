/**
 * The narrowings every reader of foreign data needs.
 *
 * Each of these was written out identically in three or four modules. They are one line each, so
 * the copies were cheap to make and would have been silent to diverge — the version that stops
 * excluding arrays, or starts treating `EACCES` as absent, still typechecks everywhere.
 *
 * @param {unknown} value
 * @returns {value is Record<string, unknown>}
 */
export function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Recognize the one filesystem error that means "not there" rather than "went wrong".
 *
 * Only ENOENT. A permission error is a failure to answer the question, not an answer to it.
 *
 * @param {unknown} error
 */
export function isNotFound(error) {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}

/**
 * Keep a number that is really a number, and refuse everything else.
 *
 * `NaN` and the infinities are the point: a source blob carrying one of those would otherwise
 * become arithmetic in a window or a horizon, which is the fail-open a client adapter must not do.
 *
 * @param {unknown} value
 */
export function numberOrNull(value) {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}
