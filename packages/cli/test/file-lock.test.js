import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const lockModule = fileURLToPath(new URL("../src/file-lock.js", import.meta.url));

// proper-lockfile 4.1.2 refreshes a held lock on a timer, and the `stat` that starts each refresh
// does not check whether the lock was released while it was in flight. A long synchronous
// operation — a 100,000-prompt backfill holds the event loop for tens of seconds — leaves that
// timer overdue, so it fires in the same turn the operation releases the lock: the `stat` meets
// the directory `release` just removed, the library calls the lock compromised, and its default
// `onCompromised` throws from a timer. The command had finished and printed `ok`; the process
// still exited 1. macOS CI hit it on `sync --full` at 1.6.0.
//
// The child makes the race deterministic: the shortest refresh interval the library allows (it
// clamps anything below 1 s), an `fs` whose `stat` answers late, a loop blocked past the interval so
// the overdue refresh fires in the next timers phase, and a release while that `stat` is in flight.
test("releasing a lock whose refresh is overdue never crashes the process", () => {
  const dir = mkdtempSync(join(tmpdir(), "snack-lock-"));
  try {
    const script = `
      import fs from "node:fs";
      import { acquirePrivateLock } from ${JSON.stringify(lockModule)};
      const lateStat = { ...fs, stat: (path, callback) => setTimeout(() => fs.stat(path, callback), 50) };
      const release = await acquirePrivateLock(${JSON.stringify(join(dir, "target"))}, { update: 1_000, fs: lateStat });
      const until = Date.now() + 1_100;
      while (Date.now() < until) {}
      await new Promise((resolve) => setTimeout(resolve, 0));
      await release();
      await new Promise((resolve) => setTimeout(resolve, 200));
      process.stdout.write("done");
    `;
    const result = spawnSync(process.execPath, ["--input-type=module", "-e", script], {
      encoding: "utf8",
      timeout: 60_000,
    });
    assert.equal(result.stderr, "", result.stderr);
    assert.equal(result.status, 0);
    assert.equal(result.stdout, "done");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
