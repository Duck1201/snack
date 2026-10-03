/**
 * Whether a client's support matrix still says its own validation is unfinished.
 *
 * A published support matrix is a claim about what SNACK reads, and shipping one whose `Status:`
 * line does not say it is complete publishes the claim anyway. Every client's page is held to the same
 * rule, so it lives in one place rather than being restated per client in the readiness script.
 *
 * @param {string} matrix the support page's Markdown
 */
export function supportMatrixIncomplete(matrix) {
  // The whole line, in one of the two forms the published pages use -- `Status: complete.` and
  // `Status: completed on YYYY-MM-DD.` A line that merely contains the word, such as "not yet
  // complete" or "complete except Windows", says the opposite and must keep blocking.
  return !/^Status: (?:complete|completed on \d{4}-\d{2}-\d{2})\.?[ \t]*$/mu.test(matrix);
}
