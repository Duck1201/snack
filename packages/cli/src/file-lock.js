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
 * @param {{ update?: number, fs?: object }} [testing] a shorter refresh interval and an fs, for tests only
 * @returns {Promise<() => Promise<void>>}
 */
export async function acquirePrivateLock(target, testing = {}) {
  const state = { releasing: false };
  const release = await lockfile.lock(target, {
    realpath: false,
    stale: 120_000,
    update: testing.update ?? 10_000,
    ...(testing.fs ? { fs: testing.fs } : {}),
    retries: { retries: 20, minTimeout: 50, maxTimeout: 250 },
    // proper-lockfile 4.1.2 refreshes the lock on a timer whose `stat` does not check whether the
    // lock was released while it was in flight. After a long synchronous operation that timer is
    // overdue and fires as the operation releases, so the `stat` meets the directory `release`
    // removed and the library reports the lock compromised. A lock this process is releasing was
    // not compromised; any other compromise still throws, as the library's default does.
    onCompromised: (error) => {
      if (state.releasing) return;
      throw error;
    },
  });
  await chmod(`${target}.lock`, 0o700);
  return async () => {
    state.releasing = true;
    await release();
  };
}
