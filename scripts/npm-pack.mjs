// `npm pack --json` changed shape between majors: npm 11 prints an array of results, npm 12 prints
// an object keyed by package name. CI pins npm 11.16.0, but a contributor on a current npm runs 12,
// and every script that packs read the array with `[0]` -- so `pack:smoke`, `release:evidence`,
// `release:check`, `release:staging` and `upgrade:smoke` all failed locally with "unexpected
// manifest" while CI stayed green. Reading both shapes here keeps the two in agreement.

/**
 * The pack results `npm pack --json` printed, in the order npm printed them.
 *
 * @param {string} stdout
 * @returns {Array<{ filename?: unknown, files?: unknown }>}
 */
export function packResults(stdout) {
  const parsed = JSON.parse(stdout);
  if (Array.isArray(parsed)) return parsed;
  if (parsed !== null && typeof parsed === "object") return Object.values(parsed);
  throw new Error("npm pack --json printed neither an array nor an object.");
}
