import assert from "node:assert/strict";
import { join } from "node:path";
import { rm, writeFile } from "node:fs/promises";
import { afterEach, test } from "node:test";
import { PassThrough } from "node:stream";
import { setImmediate } from "node:timers";

import Database from "better-sqlite3";
import lockfile from "proper-lockfile";

import { SYNC_DELAY_MS, TICK_MS, classifySync } from "../src/dash.js";
import { RESTORE } from "../src/screen.js";
import {
  SYNC_OK,
  makeFakeClock,
  makeFakeSignals,
  makeFakeSync,
  makeFakeTerminal,
  startDash,
} from "./fixtures/fake-tty.js";
import { makeSeededSource } from "./fixtures/seeded-history.js";

/** @type {string[]} */
const roots = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

const HOUR = 3_600_000;
const origin = new Date("2026-10-01T00:00:00.000Z");
const start = new Date(origin.getTime() + 40 * HOUR);

/** A source with forty hours of history, one restriction among it. */
async function seeded() {
  const source = await makeSeededSource({ origin, roots });
  /** @type {{at: Date, restricted?: boolean}[]} */
  const prompts = [];
  for (let hour = 0; hour < 40; hour += 1) {
    for (let index = 0; index < 1 + (hour % 3); index += 1) {
      prompts.push({
        at: new Date(origin.getTime() + hour * HOUR + (index + 1) * 60_000),
        restricted: hour === 30 && index === 0,
      });
    }
  }
  source.plant(prompts);
  return source;
}

/**
 * @param {Awaited<ReturnType<typeof seeded>>} source
 * @param {{sync?: ReturnType<typeof makeFakeSync>, columns?: number, rows?: number, env?: Record<string, string>}} [options]
 */
async function open(source, options = {}) {
  const terminal = makeFakeTerminal({ columns: options.columns ?? 80, rows: options.rows ?? 24 });
  const clock = makeFakeClock(start);
  const sync = options.sync ?? makeFakeSync(async () => SYNC_OK);
  const signals = makeFakeSignals();
  const started = await startDash(
    { env: { ...source.env, ...options.env }, home: source.root, now: start },
    { terminal, clock, sync, signals },
  );
  return { ...started, terminal, clock, sync };
}

/** @param {string} databaseFile @param {string} sql */
function count(databaseFile, sql) {
  const database = new Database(databaseFile, { readonly: true });
  try {
    return /** @type {{n: number}} */ (database.prepare(sql).get()).n;
  } finally {
    database.close();
  }
}

/** @param {{writes: string[]}} terminal */
function lastWrite(terminal) {
  return terminal.writes.at(-1) ?? "";
}

test("a session enters the alternate buffer and raw mode, draws a reading, and q restores both", async () => {
  const source = await seeded();
  const dash = await open(source);
  assert.equal(dash.terminal.inAltBuffer, true);
  assert.equal(dash.terminal.rawMode, true);
  assert.equal(dash.terminal.cursorVisible, false);
  assert.equal(dash.terminal.paused, false);
  assert.match(dash.terminal.text(), /snack dash · 1 capacity source/u);
  assert.match(dash.terminal.text(), /next prompt {2}\d+-\d+% chance it goes through/u);

  dash.terminal.press("q");
  assert.equal(await dash.done, 0);
  assert.equal(dash.terminal.inAltBuffer, false);
  assert.equal(dash.terminal.rawMode, false);
  assert.equal(dash.terminal.cursorVisible, true);
  assert.equal(dash.terminal.paused, true);
  assert.ok(lastWrite(dash.terminal).endsWith(RESTORE));
  // Every listener released, every timer cleared, nothing re-raised.
  assert.equal(dash.terminal.listeners(), 0);
  assert.equal(dash.signals.listeners(), 0);
  assert.equal(dash.clock.pending(), 0);
  assert.deepEqual(dash.signals.raised, []);
});

test("Ctrl+C is a key in raw mode, and quits like q", async () => {
  const dash = await open(await seeded());
  dash.terminal.press("ctrl+c");
  assert.equal(await dash.done, 0);
  assert.equal(dash.terminal.inAltBuffer, false);
  assert.deepEqual(dash.signals.raised, []);
});

for (const signal of ["SIGTERM", "SIGINT"]) {
  test(`${signal} from outside restores the terminal first, then re-raises itself`, async () => {
    const dash = await open(await seeded());
    dash.signals.send(signal);
    assert.equal(await dash.done, 0);
    assert.equal(dash.terminal.inAltBuffer, false);
    assert.equal(dash.terminal.rawMode, false);
    assert.equal(dash.terminal.cursorVisible, true);
    assert.deepEqual(dash.signals.raised, [signal]);
    // The listener was removed before the re-raise, so the default action ends the process.
    assert.equal(dash.signals.listeners(), 0);
  });
}

test("SIGHUP: the terminal is gone, so nothing more is written to it", async () => {
  const dash = await open(await seeded());
  const before = dash.terminal.writes.length;
  dash.signals.send("SIGHUP");
  assert.equal(await dash.done, 0);
  assert.equal(dash.terminal.writes.length, before);
  assert.deepEqual(dash.signals.raised, ["SIGHUP"]);
});

test("EIO on the terminal ends the session quietly, writing nothing after it", async () => {
  const dash = await open(await seeded());
  const before = dash.terminal.writes.length;
  dash.terminal.vanish();
  assert.equal(await dash.done, 0);
  assert.equal(dash.terminal.writes.length, before);
  assert.deepEqual(dash.signals.raised, []);
});

test("Ctrl+Z restores the terminal and stops; SIGCONT takes it back and repaints everything", async () => {
  const dash = await open(await seeded());
  dash.terminal.press("ctrl+z");
  assert.equal(dash.terminal.inAltBuffer, false);
  assert.equal(dash.terminal.rawMode, false);
  assert.deepEqual(dash.signals.raised, ["SIGSTOP"]);
  // Stopped: a tick draws nothing.
  const stopped = dash.terminal.writes.length;
  await dash.clock.advance(3 * TICK_MS);
  assert.equal(dash.terminal.writes.length, stopped);

  dash.signals.send("SIGCONT");
  assert.equal(dash.terminal.inAltBuffer, true);
  assert.equal(dash.terminal.rawMode, true);
  assert.match(dash.terminal.text(), /next prompt/u);
  // A full repaint: every row of the frame is written again.
  assert.ok(lastWrite(dash.terminal).includes("\u001B[1;1H"));
  dash.terminal.press("q");
  assert.equal(await dash.done, 0);
});

test("Ctrl+Z during a recompute stops the process only once the storage lock is released", async () => {
  // Stopped while holding the lock, the dash would block every other snack command for as long as
  // the shell kept it stopped. The terminal is restored at once; the stop waits for the work.
  const source = await makeSeededSource({ origin, roots });
  source.plant(
    Array.from({ length: 60 }, (_unused, index) => ({
      at: new Date(origin.getTime() + index * 30 * 60_000),
    })),
  );
  const terminal = makeFakeTerminal();
  const clock = makeFakeClock(start);
  const signals = makeFakeSignals();
  const target = join(source.paths.stateDir, "storage-operation");
  /** @type {boolean | null} */
  let lockAtRaise = null;
  const raise = signals.port.raise;
  signals.port.raise = (/** @type {string} */ signal) => {
    lockAtRaise = lockfile.checkSync(target, { realpath: false, stale: 120_000 });
    raise(signal);
  };
  const dash = await startDash(
    { env: source.env, home: source.root, now: start },
    { terminal, clock, sync: makeFakeSync(async () => SYNC_OK), signals },
  );
  let pressed = false;
  let restoredAtOnce = false;
  const poll = async () => {
    for (let attempt = 0; attempt < 20_000 && !pressed; attempt += 1) {
      if (lockfile.checkSync(target, { realpath: false, stale: 120_000 })) {
        terminal.press("\u001A");
        pressed = true;
        restoredAtOnce = !terminal.inAltBuffer && !terminal.rawMode;
        break;
      }
      await new Promise((resolve) => setImmediate(resolve));
    }
  };
  await Promise.all([poll(), clock.advance(SYNC_DELAY_MS)]);
  await dash.settle();
  assert.ok(pressed, "the recompute never took the lock while the test watched");
  assert.ok(restoredAtOnce, "the terminal waited for the work to be restored");
  assert.deepEqual(signals.raised, ["SIGSTOP"]);
  assert.equal(lockAtRaise, false);
  signals.send("SIGCONT");
  terminal.press("q");
  assert.equal(await dash.done, 0);
});

test("an external SIGTSTP stops the dash the way Ctrl+Z does", async () => {
  const dash = await open(await seeded());
  dash.signals.send("SIGTSTP");
  assert.equal(dash.terminal.inAltBuffer, false);
  assert.deepEqual(dash.signals.raised, ["SIGSTOP"]);
  dash.signals.send("SIGCONT");
  assert.equal(dash.terminal.inAltBuffer, true);
  dash.terminal.press("q");
  assert.equal(await dash.done, 0);
});

test("a failure inside the loop restores the terminal before it is reported", async () => {
  const source = await seeded();
  const dash = await open(source);
  const size = dash.terminal.port.size;
  /** @type {string[]} */
  const order = [];
  dash.terminal.port.size = () => {
    throw new Error("injected fault");
  };
  const write = dash.stderr.write.bind(dash.stderr);
  dash.stderr.write = (/** @type {string} */ chunk) => {
    order.push(dash.terminal.inAltBuffer ? "error while drawn" : "error after restore");
    write(chunk);
  };
  dash.terminal.press("j");
  assert.equal(await dash.done, 10);
  dash.terminal.port.size = size;
  assert.equal(dash.terminal.inAltBuffer, false);
  assert.equal(dash.terminal.rawMode, false);
  assert.match(dash.stderr.value, /Unexpected internal failure\./u);
  assert.deepEqual(order, ["error after restore"]);
});

test("no storage lock is held between synchronizations, at any tick of half an hour", async () => {
  const source = await seeded();
  const dash = await open(source);
  const target = join(source.paths.stateDir, "storage-operation");
  let checked = 0;
  dash.clock.afterEach = async () => {
    // Taken with no retry at all: held by anyone, this throws.
    const release = await lockfile.lock(target, { realpath: false, retries: 0, stale: 120_000 });
    await release();
    checked += 1;
  };
  await dash.clock.advance(30 * 60_000);
  dash.clock.afterEach = () => {};
  // Every tick and every sync: 1,800 ticks and 30 synchronizations.
  assert.ok(checked >= 1_800 + 29, String(checked));
  assert.equal(dash.sync.started, 31);
  dash.terminal.press("q");
  assert.equal(await dash.done, 0);
});

test("one sync at a time: r during a running sync starts none, and the next comes 60 s after the end", async () => {
  const source = await seeded();
  const clock = makeFakeClock(start);
  /** @type {number[]} */
  const ends = [];
  const sync = makeFakeSync(
    () =>
      new Promise((resolve) => {
        // Three virtual minutes per sync.
        clock.scheduler.setTimeout(() => {
          ends.push(clock.now().getTime());
          resolve(SYNC_OK);
        }, 180_000);
      }),
    { held: true },
  );
  const terminal = makeFakeTerminal();
  const signals = makeFakeSignals();
  const dash = await startDash(
    { env: source.env, home: source.root, now: start },
    { terminal, clock, sync, signals },
  );
  assert.equal(sync.started, 1);
  assert.match(terminal.text(), /synchronizing… 0s/u);
  terminal.press("r");
  terminal.press("r");
  terminal.press("r");
  await clock.advance(60_000);
  assert.equal(sync.started, 1);
  assert.match(terminal.text(), /synchronizing… 1m/u);
  await clock.advance(120_000);
  assert.equal(ends.length, 1);
  assert.match(terminal.text(), /synced 0s ago · next in 1m/u);
  await clock.advance(SYNC_DELAY_MS - TICK_MS);
  assert.equal(sync.started, 1);
  await clock.advance(TICK_MS);
  assert.equal(sync.started, 2);
  terminal.press("q");
  assert.equal(await dash.done, 0);
});

test("r starts a sync now when none is running", async () => {
  const dash = await open(await seeded());
  assert.equal(dash.sync.started, 1);
  await dash.clock.advance(5 * TICK_MS);
  dash.terminal.press("r");
  await dash.settle();
  assert.equal(dash.sync.started, 2);
  dash.terminal.press("q");
  assert.equal(await dash.done, 0);
});

test("a sync child's outcome maps to the header and the SYNC column, and only ok recomputes", () => {
  assert.equal(classifySync(SYNC_OK), "ok");
  assert.equal(
    classifySync({ exitCode: 0, envelope: { status: "degraded", data: { sources: [] } } }),
    "ok",
  );
  assert.equal(
    classifySync({
      exitCode: 5,
      envelope: { status: "error", errors: [{ code: "storage_locked" }] },
    }),
    "storage_busy",
  );
  assert.equal(
    classifySync({
      exitCode: 5,
      envelope: { status: "error", errors: [{ code: "storage_newer_than_application" }] },
    }),
    "storage_newer",
  );
  for (const outcome of [
    { exitCode: 5, envelope: { status: "error", errors: [{ code: "storage_read_error" }] } },
    { exitCode: 3, envelope: { status: "error", errors: [{ code: "config_invalid" }] } },
    { exitCode: 10, envelope: null },
    { exitCode: -1, envelope: null },
  ]) {
    assert.equal(classifySync(outcome), "failed", JSON.stringify(outcome));
  }
});

test("each sync outcome reads as the specification words it, and never ends the session", async () => {
  const source = await seeded();
  /** @type {import("../src/dash.js").SyncOutcome[]} */
  const script = [
    SYNC_OK,
    {
      exitCode: 0,
      envelope: { status: "degraded", data: { sources: [{ alias: "work", failed: 1 }] } },
    },
    { exitCode: 5, envelope: { status: "error", errors: [{ code: "storage_locked" }] } },
    { exitCode: 10, envelope: null },
    {
      exitCode: 5,
      envelope: { status: "error", errors: [{ code: "storage_newer_than_application" }] },
    },
  ];
  let next = 0;
  const dash = await open(source, {
    sync: makeFakeSync(async () => script[next++] ?? SYNC_OK),
  });
  const state = () => dash.controller.state();
  const computed = () => state().reading.computedAt;

  // 1: ok.
  assert.equal(state().sources[0]?.sync, "ok");
  assert.match(dash.terminal.text(), /synced 0s ago · next in 1m/u);
  let before = computed();

  // 2: degraded, with this source failing: recomputed, SYNC says failed.
  await dash.clock.advance(SYNC_DELAY_MS);
  assert.equal(state().sources[0]?.sync, "failed");
  assert.notEqual(computed(), before);
  assert.match(dash.terminal.text(), /work .*failed/u);
  before = computed();

  // 3: storage busy: skipped, not recomputed, marked stale.
  await dash.clock.advance(SYNC_DELAY_MS);
  assert.equal(computed(), before);
  assert.equal(state().sources[0]?.sync, "busy");
  assert.equal(state().reading.stale, true);
  assert.match(dash.terminal.text(), /sync skipped — another snack command is using storage/u);
  assert.match(dash.terminal.text(), /showing the reading from 1m/u);

  // 4: failed: not recomputed, the header says so.
  await dash.clock.advance(SYNC_DELAY_MS);
  assert.equal(computed(), before);
  assert.match(dash.terminal.text(), /sync failed — run snack doctor · next in 1m/u);

  // 5: newer storage: syncs stop, the banner says what to do.
  await dash.clock.advance(SYNC_DELAY_MS);
  assert.match(
    dash.terminal.text(),
    /A newer snack upgraded storage; quit and restart snack dash\./u,
  );
  const started = dash.sync.started;
  await dash.clock.advance(5 * SYNC_DELAY_MS);
  assert.equal(dash.sync.started, started);
  assert.equal(started, 5);

  dash.terminal.press("q");
  assert.equal(await dash.done, 0);
});

test("storage that does not exist yet is prepared by the first sync, and the screen says so", async () => {
  const source = await makeSeededSource({ origin, roots });
  await rm(source.paths.databaseFile);
  let prepared = false;
  const dash = await open(source, {
    sync: makeFakeSync(async () => {
      if (prepared) return SYNC_OK;
      prepared = true;
      // The child fails before it could create anything.
      return { exitCode: 10, envelope: null };
    }),
  });
  assert.match(dash.terminal.text(), /Storage could not be prepared; run snack sync to see why\./u);
  assert.match(dash.terminal.text(), /no reading/u);
  dash.terminal.press("q");
  assert.equal(await dash.done, 0);
});

test("missing storage shows the preparing banner until a sync creates it", async () => {
  const source = await makeSeededSource({ origin, roots });
  await rm(source.paths.databaseFile);
  const clock = makeFakeClock(start);
  const terminal = makeFakeTerminal();
  /** @type {(value: import("../src/dash.js").SyncOutcome) => void} */
  let finish = () => {};
  const sync = makeFakeSync(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
    { held: true },
  );
  const dash = await startDash(
    { env: source.env, home: source.root, now: start },
    { terminal, clock, sync, signals: makeFakeSignals() },
  );
  assert.match(terminal.text(), /Preparing storage — the first synchronization creates it\./u);
  assert.match(terminal.text(), /synchronizing…/u);
  terminal.press("q");
  assert.equal(await dash.done, 0);
  // Quitting never waits for, or kills, the child.
  finish(SYNC_OK);
});

test("pending migrations are counted on the banner, and are the first sync's to apply", async () => {
  const source = await seeded();
  const database = new Database(source.paths.databaseFile);
  try {
    database.exec(
      "DELETE FROM schema_migration WHERE number = (SELECT MAX(number) FROM schema_migration)",
    );
  } finally {
    database.close();
  }
  const clock = makeFakeClock(start);
  // Wide enough for the whole banner, which a narrower terminal cuts with an ellipsis.
  const terminal = makeFakeTerminal({ columns: 120 });
  /** @type {(value: import("../src/dash.js").SyncOutcome) => void} */
  let finish = () => {};
  const sync = makeFakeSync(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
    { held: true },
  );
  const dash = await startDash(
    { env: source.env, home: source.root, now: start },
    { terminal, clock, sync, signals: makeFakeSignals() },
  );
  assert.match(terminal.text(), /Preparing storage — 1 pending migration, after a backup\./u);
  assert.match(terminal.text(), /preparing storage…|synchronizing…/u);
  // The child fails: the reading was never prepared, and the screen says where to look.
  finish({ exitCode: 10, envelope: null });
  await dash.settle();
  assert.match(terminal.text(), /Storage could not be prepared; run snack sync to see why\./u);
  terminal.press("q");
  assert.equal(await dash.done, 0);
});

test("a lock another command holds marks the reading stale, and the next tick takes it back", async () => {
  const source = await seeded();
  const dash = await open(source);
  const target = join(source.paths.stateDir, "storage-operation");
  const release = await lockfile.lock(target, { realpath: false, retries: 0, stale: 120_000 });
  // The next sync ends ok; its recompute meets the lock for proper-lockfile's few real seconds.
  await dash.clock.advance(SYNC_DELAY_MS);
  assert.equal(dash.controller.state().reading.stale, true);
  assert.match(dash.terminal.text(), /showing the reading from/u);
  await release();
  await dash.clock.advance(TICK_MS);
  assert.equal(dash.controller.state().reading.stale, false);
  dash.terminal.press("q");
  assert.equal(await dash.done, 0);
});

test("s shows the next N row, + and - step N by exactly one between 1 and 100", async () => {
  const source = await seeded();
  const dash = await open(source, { rows: 30 });
  const length = () => dash.controller.state().sequenceLength;
  assert.equal(length(), null);
  assert.doesNotMatch(dash.terminal.text(), /next 10 /u);
  dash.terminal.press("+");
  assert.equal(length(), null, "+ does nothing while the row is hidden");

  dash.terminal.press("s");
  assert.equal(length(), 10);
  assert.match(dash.terminal.text(), /next 10 /u);
  /** @type {number[]} */
  const seen = [];
  for (let step = 0; step < 105; step += 1) {
    dash.terminal.press("-");
    seen.push(Number(length()));
  }
  // Down one at a time, never skipping a length, and held at 1.
  assert.deepEqual(seen.slice(0, 9), [9, 8, 7, 6, 5, 4, 3, 2, 1]);
  assert.ok(seen.slice(9).every((value) => value === 1));
  seen.length = 0;
  for (let step = 0; step < 105; step += 1) {
    dash.terminal.press("+");
    seen.push(Number(length()));
    // The row on screen is the person's N, at every N.
    assert.match(dash.terminal.text(), new RegExp(`next ${length()} `, "u"));
  }
  assert.deepEqual(
    seen.slice(0, 99),
    Array.from({ length: 99 }, (_, index) => index + 2),
  );
  assert.ok(seen.slice(99).every((value) => value === 100));

  dash.terminal.press("s");
  assert.equal(length(), null);
  dash.terminal.press("s");
  assert.equal(length(), 100, "the person's N is kept while the row is hidden");

  dash.terminal.press("q");
  assert.equal(await dash.done, 0);
  // A keypress writes nothing: the reading did not change, so no attempt was recorded after the row
  // was shown, and a sequence is only ever recorded with an attempt.
  assert.equal(
    count(source.paths.databaseFile, "SELECT COUNT(*) AS n FROM prediction_sequence"),
    0,
  );
});

test("each attempt the dash records carries the next N row on screen, and none while it is off", async () => {
  const source = await seeded();
  const dash = await open(source, { rows: 30, columns: 120 });
  const db = source.paths.databaseFile;
  const attempts = () => count(db, "SELECT COUNT(*) AS n FROM prediction_attempt");
  const sequences = () => count(db, "SELECT COUNT(*) AS n FROM prediction_sequence");
  const before = attempts();
  assert.ok(before > 0);
  assert.equal(sequences(), 0, "the row was off when the first reading was recorded");

  dash.terminal.press("s");
  for (let step = 0; step < 3; step += 1) dash.terminal.press("-");
  assert.equal(dash.controller.state().sequenceLength, 7);
  assert.equal(sequences(), 0, "a keypress records nothing");

  // A refusal moves the reading, so the next recompute records a new attempt.
  source.plant([{ at: new Date(start.getTime() - 60_000), restricted: true }]);
  await dash.clock.advance(SYNC_DELAY_MS);
  assert.equal(attempts(), before + 1);
  const database = new Database(db, { readonly: true });
  /** @type {Record<string, number>} */
  let row;
  /** @type {{id: number}} */
  let latest;
  try {
    row = /** @type {Record<string, number>} */ (
      database.prepare("SELECT * FROM prediction_sequence").get()
    );
    latest = /** @type {{id: number}} */ (
      database.prepare("SELECT MAX(id) AS id FROM prediction_attempt").get()
    );
  } finally {
    database.close();
  }
  const shown = /** @type {import("../src/prediction.js").SequenceAssessment | undefined} */ (
    dash.controller.state().sources[0]?.sequence?.assessment
  );
  assert.ok(shown);
  assert.equal(row.prediction_attempt_id, latest.id);
  assert.equal(row.length, 7);
  assert.deepEqual(
    [row.lower, row.point, row.upper],
    [shown.viability.lower, shown.viability.point, shown.viability.upper],
  );
  assert.equal(row.width_too_wide, shown.width.too_wide ? 1 : 0);

  // Off: the next attempt records no sequence.
  dash.terminal.press("s");
  source.plant(
    Array.from({ length: 4 }, (_unused, index) => ({
      at: new Date(start.getTime() - 40_000 + index * 5_000),
      restricted: true,
    })),
  );
  await dash.clock.advance(SYNC_DELAY_MS);
  assert.equal(attempts(), before + 2);
  assert.equal(sequences(), 1);
  dash.terminal.press("q");
  assert.equal(await dash.done, 0);
});

test("the next N row says what status --sequence says, or no number at all when too wide", async () => {
  const source = await seeded();
  const dash = await open(source, { rows: 30, columns: 120 });
  dash.terminal.press("s");
  for (let step = 0; step < 9; step += 1) dash.terminal.press("-");
  let informative = 0;
  let withheld = 0;
  for (let length = 1; length <= 100; length += 1) {
    const sequence = dash.controller.state().sources[0]?.sequence;
    assert.equal(sequence?.assessment.length, length);
    const row = dash.terminal
      .text()
      .split("\n")
      .find((line) => line.startsWith(`   next ${length} `));
    assert.ok(row !== undefined, `no row for ${length}`);
    if (sequence?.assessment.width.too_wide) {
      withheld += 1;
      // No figure but the person's own N.
      assert.deepEqual(row.match(/\d+/gu)?.map(Number), [length, length]);
      assert.match(row, /interval is too wide to say much/u);
    } else {
      informative += 1;
      assert.match(row, /\d+-\d+% chance (?:it goes|all \d+ go) through/u);
    }
    dash.terminal.press("+");
  }
  // Non-vacuity: both forms were drawn.
  assert.ok(informative > 0 && withheld > 0, `${informative} / ${withheld}`);
  dash.terminal.press("q");
  assert.equal(await dash.done, 0);
});

test("the keys move the selection and the panes, and change nothing in storage", async () => {
  const source = await makeSeededSource({ origin, roots });
  const attempts = () =>
    count(source.paths.databaseFile, "SELECT COUNT(*) AS n FROM prediction_attempt");
  const dash = await open(source);
  const before = attempts();
  dash.terminal.press("?");
  assert.equal(dash.controller.state().pane, "help");
  assert.match(dash.terminal.text(), /reading this screen/u);
  dash.terminal.press("escape");
  assert.equal(dash.controller.state().pane, "detail");
  dash.terminal.press("j");
  dash.terminal.press("down");
  assert.equal(dash.controller.state().selected, 0, "clamped at the only source");
  dash.terminal.press("ctrl+l");
  assert.ok(lastWrite(dash.terminal).includes("\u001B[1;1H"), "Ctrl+L repaints from the top");
  dash.terminal.press("x");
  assert.equal(attempts(), before);
  dash.terminal.press("q");
  assert.equal(await dash.done, 0);
});

test("a resize repaints the whole frame at the new size", async () => {
  const dash = await open(await seeded());
  dash.terminal.resize(100, 30);
  assert.ok(lastWrite(dash.terminal).includes("\u001B[1;1H"));
  assert.match(dash.terminal.text(), /next prompt/u);
  dash.terminal.resize(40, 10);
  assert.match(dash.terminal.text(), /snack dash needs at least 64 columns/u);
  dash.terminal.press("q");
  assert.equal(await dash.done, 0);
});

test("the warnings a reading carries are written to standard error once the terminal is restored", async () => {
  // A plan profile that cannot be read falls back to the generic one and says so, as `status` does;
  // the dash, which owns the screen while it runs, says it on standard error as it leaves.
  const source = await seeded();
  const missing = join(source.root, "absent-profile.json");
  await writeFile(
    source.paths.configFile,
    `${JSON.stringify({ schema_version: 1, sources: [{ ...source.source, plan_profile: missing }] })}\n`,
    { mode: 0o600 },
  );
  const dash = await open(source);
  assert.equal(dash.stderr.value, "", "nothing reaches standard error while the screen is drawn");
  await dash.clock.advance(SYNC_DELAY_MS);
  dash.terminal.press("q");
  assert.equal(await dash.done, 0);
  const lines = dash.stderr.value.split("\n").filter(Boolean);
  assert.equal(lines.length, 1, dash.stderr.value);
  assert.match(String(lines[0]), /^Warning: Plan profile ".*absent-profile\.json" is unavailable/u);
  assert.equal(dash.terminal.inAltBuffer, false);
});

test("a terminal error after the session let go of the streams is absorbed, never thrown", async () => {
  // The dash may outlive its screen by a moment -- waiting for a write in flight, or for its sync
  // child -- and an `EIO` emitted then, with no listener, would crash the process instead.
  const { createTerminalPorts } = await import("../src/dash-terminal.js");
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  const ports = createTerminalPorts({
    stdin: /** @type {never} */ (stdin),
    stdout: /** @type {never} */ (stdout),
    env: {},
  });
  let gone = 0;
  const off = ports.terminal.onGone(() => {
    gone += 1;
  });
  stdin.emit("error", new Error("EIO"));
  assert.equal(gone, 1);
  off();
  assert.doesNotThrow(() => stdin.emit("error", new Error("EIO")));
  assert.doesNotThrow(() => stdout.emit("error", new Error("EIO")));
  assert.equal(gone, 1);
});
