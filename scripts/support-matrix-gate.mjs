/**
 * Whether a client's support matrix still says its own validation is unfinished.
 *
 * A published support matrix is a claim about what SNACK reads, and shipping one whose `Status:`
 * line does not say `complete` publishes the claim anyway. Every client's page is held to the same
 * rule, so it lives in one place rather than being restated per client in the readiness script.
 *
 * @param {string} matrix the support page's Markdown
 */
export function supportMatrixIncomplete(matrix) {
  return !/^Status:[^\n]*\bcomplete\b/mu.test(matrix);
}
