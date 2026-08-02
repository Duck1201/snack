import { chmod } from "node:fs/promises";

import lockfile from "proper-lockfile";

/**
 * Take one of SNACK's cross-process locks.
 *
 * The waiting policy is here rather than at each call site because three of them had the same four
 * numbers written out in full, which is how two of them would eventually have disagreed about how
 * long a stale lock lives. `realpath: false` keeps the lock addressable before the target exists.
 *
 * The `.lock` directory proper-lockfile creates is `0o700` like every other directory SNACK owns;
 * `doctor` fails on anything more permissive, including this one.
 *
 * Callers classify the failure themselves — a config lock and a storage lock exit differently — so
 * this throws whatever proper-lockfile threw.
 *
 * @param {string} target
 * @returns {Promise<() => Promise<void>>}
 */
export async function acquirePrivateLock(target) {
  const release = await lockfile.lock(target, {
    realpath: false,
    stale: 120_000,
    update: 10_000,
    retries: { retries: 20, minTimeout: 50, maxTimeout: 250 },
  });
  await chmod(`${target}.lock`, 0o700);
  return release;
}
