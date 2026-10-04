import assert from "node:assert/strict";
import { join } from "node:path";
import { rm } from "node:fs/promises";
import { afterEach, test } from "node:test";

import Database from "better-sqlite3";
import lockfile from "proper-lockfile";

import { SYNC_DELAY_MS, TICK_MS, snapshotKey } from "../src/dash.js";
import { isConfiguredSource, readConfig } from "../src/config.js";
import { run } from "../src/main.js";
import { shownInterval } from "../src/render.js";
import { buildSourceReports } from "../src/source-report.js";
import {
  SYNC_OK,
  makeFakeClock,
  makeFakeSignals,
  makeFakeSync,
  makeFakeTerminal,
  realSync,
  startDash,
} from "./fixtures/fake-tty.js";
import {
  cleanupRunFixtures,
  createOpenCodeDatabase,
  makeRunFixture,
  sink,
} from "./fixtures/run-fixture.js";
import { makeSeededSource } from "./fixtures/seeded-history.js";

/** @type {string[]} */
const roots = [];
afterEach(async () => {
  await cleanupRunFixtures();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

const HOUR = 3_600_000;
const EIGHT_HOURS = 8 * HOUR;

/**
 * @param {string} databaseFile
 * @param {string} sql
 * @param {unknown[]} [parameters]
 * @returns {Record<string, unknown>[]}
 */
function rows(databaseFile, sql, parameters = []) {
  const database = new Database(databaseFile, { readonly: true });
  try {
    return /** @type {Record<string, unknown>[]} */ (database.prepare(sql).all(...parameters));
  } finally {
    database.close();
  }
}

/**
 * The reference: what `status --no-sync` would compute at this instant on this storage, keyed the
 * way the dash keys it. Recording off, so it leaves no trace.
 *
 * @param {{databaseFile: string, configFile: string}} paths
 * @param {Date} now
 */
async function referenceKeys(paths, now) {
  const config = await readConfig(paths.configFile);
  const sources = Array.isArray(config.sources) ? config.sources.filter(isConfiguredSource) : [];
  /** @type {typeof sources} */
  const selected = [];
  for (const source of sources) {
    if (!selected.some((entry) => entry.alias === source.alias)) selected.push(source);
  }
  const built = await buildSourceReports({
    databaseFile: paths.databaseFile,
    config,
    selected,
    inScope: sources,
    now,
    synchronize: async () => ({ performed: false, status: "ok" }),
  });
  return new Map(
    built.sources
      .filter((source) => source.capacityPeriodId !== null)
      .map((source) => [source.alias, snapshotKey(source.report, source.capacityPeriodId)]),
  );
}

/**
 * Follow a session: count frames, check the lock is free after every timer, and keep the reference
 * key at every instant the dash recomputed.
 *
 * @param {{databaseFile: string, configFile: string, stateDir: string}} paths
 * @param {Awaited<ReturnType<typeof startDash>>} dash
 * @param {ReturnType<typeof makeFakeClock>} clock
 */
function observe(paths, dash, clock) {
  const target = join(paths.stateDir, "storage-operation");
  const seen = {
    lockHeld: 0,
    recomputes: 0,
    /** @type {Map<string, string[]>} the reference key at each recompute, per source */
    reference: new Map(),
  };
  let computedAt = dash.controller.state().reading.computedAt;
  const record = async (/** @type {Date} */ at) => {
    seen.recomputes += 1;
    for (const [alias, key] of await referenceKeys(paths, at)) {
      const keys = seen.reference.get(alias) ?? [];
      keys.push(key);
      seen.reference.set(alias, keys);
    }
  };
  clock.afterEach = async (at) => {
    if (lockfile.checkSync(target, { realpath: false, stale: 120_000 })) seen.lockHeld += 1;
    const now = dash.controller.state().reading.computedAt;
    if (now !== computedAt) {
      computedAt = now;
      await record(at);
    }
  };
  return { seen, first: () => record(clock.now()) };
}

/** @param {string[]} keys */
function changes(keys) {
  return keys.filter((key, index) => index === 0 || key !== keys[index - 1]).length;
}

/**
 * The attempt rows a dash session delivered, per source, oldest first, with the key they carry.
 *
 * @param {string} databaseFile
 */
function delivered(databaseFile) {
  return rows(
    databaseFile,
    `SELECT a.source_alias AS alias, a.capacity_period_id AS period, a.lower, a.upper,
            a.risk_label AS risk, a.evidence_level AS evidence
       FROM prediction_attempt a
       JOIN prediction_delivery d ON d.prediction_attempt_id = a.id
      WHERE d.format = 'dash'
      ORDER BY a.id`,
  );
}

test("eight hours with no new observation: 28,800 frames, 480 syncs, a snapshot only when the print moved", async (t) => {
  const fixture = await makeRunFixture("snack-dash-eight-hours-");
  fixture.options.env.OPENCODE_DB = await createOpenCodeDatabase(fixture.root);
  const setup = ["setup", "opencode", "--non-interactive", "--source", "work"];
  setup.push("--provider", "anthropic", "--profile", "default", "--plan", "pro");
  assert.equal(await run(["node", "snack", ...setup], fixture.options), 0, fixture.stderr.value);
  assert.equal(await run(["node", "snack", "sync", "--full"], fixture.options), 0);

  const start = /** @type {Date} */ (fixture.options.now);
  const clock = makeFakeClock(start);
  const terminal = makeFakeTerminal();
  let frames = 0;
  const size = terminal.port.size;
  terminal.port.size = () => {
    frames += 1;
    return size();
  };
  const sync = makeFakeSync(realSync(fixture.options, clock.now));
  const dash = await startDash(
    { ...fixture.options, now: start },
    { terminal, clock, sync, signals: makeFakeSignals() },
  );
  const watch = observe(fixture.paths, dash, clock);
  await watch.first();
  const startFrames = frames;

  await clock.advance(EIGHT_HOURS);
  terminal.press("q");
  assert.equal(await dash.done, 0);

  // Every second drawn, and one sync a minute after the previous one ended.
  assert.ok(frames - startFrames >= EIGHT_HOURS / TICK_MS, String(frames - startFrames));
  assert.equal(sync.started, 1 + EIGHT_HOURS / SYNC_DELAY_MS);
  assert.equal(watch.seen.recomputes, 1 + EIGHT_HOURS / SYNC_DELAY_MS);
  assert.equal(watch.seen.lockHeld, 0, "a lock was held between synchronizations");

  const snapshots = delivered(fixture.paths.databaseFile);
  const attempts = rows(
    fixture.paths.databaseFile,
    `SELECT a.id FROM prediction_attempt a
      WHERE NOT EXISTS (SELECT 1 FROM prediction_delivery d WHERE d.prediction_attempt_id = a.id)`,
  );
  assert.equal(attempts.length, 0, "every attempt the dash recorded was delivered");
  for (const [alias, keys] of watch.seen.reference) {
    // The equivalent manual runs: one status at every instant the dash recomputed, counted only
    // when what it would print differs from what the previous one printed.
    const dashSnapshots = snapshots.filter((row) => row.alias === alias).length;
    assert.equal(dashSnapshots, changes(keys), alias);
  }
  // No new observation. The clock alone still moves the estimate -- outcome weights decay with
  // age -- and on this fixture it carries the printed lower end across one whole percent during the
  // eight hours: that is a new rendered estimate, and `status` run then would have printed and
  // recorded it too (spec §4.3). Nothing else is written: 480 recomputes, two snapshots.
  assert.equal(watch.seen.reference.size, 1);
  const work = /** @type {string[]} */ (watch.seen.reference.get("work"));
  assert.equal(work.length, 481);
  assert.equal(snapshots.length, changes(work));
  assert.ok(snapshots.length <= 2, String(snapshots.length));
  t.diagnostic(
    `eight hours: ${frames - startFrames} frames, ${sync.started} syncs, ${watch.seen.recomputes} recomputes, ${snapshots.length} snapshots, ${changes(work)} reference key changes, lock held ${watch.seen.lockHeld} times`,
  );
});

/** A seeded source and a sync that plants the scripted prompts due by each sync's instant. */
async function scripted() {
  const origin = new Date("2026-10-01T00:00:00.000Z");
  const start = new Date(origin.getTime() + 40 * HOUR);
  const source = await makeSeededSource({ origin, roots });
  /** @type {{at: Date, restricted?: boolean}[]} */
  const history = [];
  for (let hour = 0; hour < 40; hour += 1) {
    for (let index = 0; index < 2; index += 1) {
      history.push({ at: new Date(origin.getTime() + hour * HOUR + (index + 1) * 60_000) });
    }
  }
  source.plant(history);
  return { source, start };
}

test("eight hours with 40 new prompts: a snapshot exactly when what status would print changed", async (t) => {
  const { source, start } = await scripted();
  // Forty prompts at scripted instants: some restricted, some in a burst that moves the band.
  /** @type {{at: Date, restricted?: boolean}[]} */
  const script = Array.from({ length: 40 }, (_, index) => ({
    at: new Date(start.getTime() + (index < 20 ? index * 23 * 60_000 : 7 * HOUR + index * 60_000)),
    restricted: [5, 13, 27, 33].includes(index),
  }));
  const clock = makeFakeClock(start);
  const sync = makeFakeSync(async () => {
    const due = script.filter((prompt) => prompt.at.getTime() <= clock.now().getTime());
    script.splice(0, due.length);
    source.plant(due);
    return SYNC_OK;
  });
  const terminal = makeFakeTerminal();
  const dash = await startDash(
    { env: source.env, home: source.root, now: start },
    { terminal, clock, sync, signals: makeFakeSignals() },
  );
  const watch = observe(source.paths, dash, clock);
  await watch.first();
  await clock.advance(EIGHT_HOURS);
  terminal.press("q");
  assert.equal(await dash.done, 0);

  assert.equal(script.length, 0, "every scripted prompt was synchronized");
  assert.equal(watch.seen.lockHeld, 0);
  const snapshots = delivered(source.paths.databaseFile);
  const keys = /** @type {string[]} */ (watch.seen.reference.get("work"));
  assert.equal(snapshots.length, changes(keys));
  // Non-vacuity: the evidence moved what is printed more than once.
  assert.ok(snapshots.length > 2, String(snapshots.length));
  t.diagnostic(
    `forty prompts: ${keys.length} recomputes, ${snapshots.length} snapshots, ${changes(keys)} reference key changes`,
  );
  // No two consecutive snapshots print the same thing.
  const printed = snapshots.map((row) => {
    const shown = shownInterval({ lower: Number(row.lower), upper: Number(row.upper) });
    return JSON.stringify([row.period, shown.lower, shown.upper, row.risk, row.evidence]);
  });
  for (let index = 1; index < printed.length; index += 1) {
    assert.notEqual(printed[index], printed[index - 1], `snapshots ${index - 1} and ${index}`);
  }
});

test("a reading whose unrounded ends moved but whose printed line did not writes nothing", async () => {
  const { source, start } = await scripted();
  const clock = makeFakeClock(start);
  let plant = false;
  const sync = makeFakeSync(async () => {
    if (plant) source.plant([{ at: new Date(clock.now().getTime() - 30_000) }]);
    plant = false;
    return SYNC_OK;
  });
  const terminal = makeFakeTerminal();
  const dash = await startDash(
    { env: source.env, home: source.root, now: start },
    { terminal, clock, sync, signals: makeFakeSignals() },
  );
  const count = () => ({
    attempts: rows(source.paths.databaseFile, "SELECT id FROM prediction_attempt").length,
    deliveries: rows(source.paths.databaseFile, "SELECT 1 FROM prediction_delivery").length,
  });
  const before = count();
  const viability = () =>
    /** @type {{viability: {lower: number, upper: number}}} */ (
      dash.controller.state().sources[0]?.report ?? { viability: { lower: 0, upper: 0 } }
    ).viability;
  const lowerBefore = viability().lower;
  plant = true;
  await clock.advance(SYNC_DELAY_MS);
  const lowerAfter = viability().lower;
  // The estimate moved, the printed interval did not.
  assert.notEqual(lowerAfter, lowerBefore);
  assert.deepEqual(
    shownInterval(viability()),
    shownInterval({ ...viability(), lower: lowerBefore }),
  );
  assert.deepEqual(count(), before);
  assert.deepEqual(before, { attempts: 1, deliveries: 1 });
  terminal.press("q");
  assert.equal(await dash.done, 0);
});

test("rendered means drawn: too small records the attempt and delivers it at the first full frame", async () => {
  const { source, start } = await scripted();
  const clock = makeFakeClock(start);
  /** @type {{at: Date, restricted?: boolean}[]} */
  let next = [];
  const sync = makeFakeSync(async () => {
    source.plant(next);
    next = [];
    return SYNC_OK;
  });
  const terminal = makeFakeTerminal();
  const dash = await startDash(
    { env: source.env, home: source.root, now: start },
    { terminal, clock, sync, signals: makeFakeSignals() },
  );
  const attempts = () =>
    rows(
      source.paths.databaseFile,
      `SELECT a.id, d.format FROM prediction_attempt a
         LEFT JOIN prediction_delivery d ON d.prediction_attempt_id = a.id ORDER BY a.id`,
    );
  assert.deepEqual(
    attempts().map((row) => row.format),
    ["dash"],
  );

  terminal.resize(40, 10);
  // A restriction moves the printed interval: recorded at the recompute, not delivered.
  next = [{ at: new Date(clock.now().getTime() + SYNC_DELAY_MS - 30_000), restricted: true }];
  await clock.advance(SYNC_DELAY_MS);
  assert.deepEqual(
    attempts().map((row) => row.format),
    ["dash", null],
  );
  // Another before it was ever drawn: the first is superseded and stays an attempt.
  next = [{ at: new Date(clock.now().getTime() + SYNC_DELAY_MS - 30_000), restricted: true }];
  await clock.advance(SYNC_DELAY_MS);
  assert.deepEqual(
    attempts().map((row) => row.format),
    ["dash", null, null],
  );

  terminal.resize(80, 24);
  await dash.settle();
  assert.deepEqual(
    attempts().map((row) => row.format),
    ["dash", null, "dash"],
  );
  terminal.press("q");
  assert.equal(await dash.done, 0);
});

test("a frame delivers a snapshot only with the next N row it was recorded with", async () => {
  // Recorded while the terminal was too small, then the person moved N or hid the row: the first
  // full frame shows a sequence the attempt does not carry, so it is not delivered -- as when the
  // key changes. Same row, it is.
  const { source, start } = await scripted();
  const clock = makeFakeClock(start);
  /** @type {{at: Date, restricted?: boolean}[]} */
  let next = [];
  const sync = makeFakeSync(async () => {
    source.plant(next);
    next = [];
    return SYNC_OK;
  });
  const terminal = makeFakeTerminal({ columns: 80, rows: 24 });
  const dash = await startDash(
    { env: source.env, home: source.root, now: start },
    { terminal, clock, sync, signals: makeFakeSignals() },
  );
  const attempts = () =>
    rows(
      source.paths.databaseFile,
      `SELECT a.id, d.format, s.length FROM prediction_attempt a
         LEFT JOIN prediction_delivery d ON d.prediction_attempt_id = a.id
         LEFT JOIN prediction_sequence s ON s.prediction_attempt_id = a.id ORDER BY a.id`,
    ).map((row) => [row.format, row.length]);
  /** Record one new reading while the terminal is too small. */
  const recordSmall = async () => {
    terminal.resize(40, 10);
    next = [{ at: new Date(clock.now().getTime() + SYNC_DELAY_MS - 30_000), restricted: true }];
    await clock.advance(SYNC_DELAY_MS);
  };
  const grow = async () => {
    terminal.resize(80, 24);
    await dash.settle();
  };
  assert.deepEqual(attempts(), [["dash", null]]);

  // Recorded with N = 7, shown with N = 9.
  terminal.press("s");
  for (let step = 0; step < 3; step += 1) terminal.press("-");
  await recordSmall();
  assert.deepEqual(attempts().at(-1), [null, 7]);
  terminal.press("+");
  terminal.press("+");
  await grow();
  assert.deepEqual(attempts().at(-1), [null, 7], "delivered with a sequence never shown");
  // The same reading is recorded again at the next recompute, now with the row on screen.
  await clock.advance(SYNC_DELAY_MS);
  assert.deepEqual(attempts().slice(-2), [
    [null, 7],
    ["dash", 9],
  ]);

  // Recorded with N = 9, shown with the row off.
  await recordSmall();
  assert.deepEqual(attempts().at(-1), [null, 9]);
  terminal.press("s");
  await grow();
  assert.deepEqual(attempts().at(-1), [null, 9], "delivered with a row that was hidden");

  // Recorded with the row off, shown with it on.
  await clock.advance(SYNC_DELAY_MS);
  assert.deepEqual(attempts().at(-1), ["dash", null]);
  await recordSmall();
  assert.deepEqual(attempts().at(-1), [null, null]);
  terminal.press("s");
  await grow();
  assert.deepEqual(attempts().at(-1), [null, null], "delivered without the row on screen");

  // Unchanged while small: delivered at the first full frame, with the row it carries.
  await recordSmall();
  assert.deepEqual(attempts().at(-1), [null, 9]);
  await grow();
  assert.deepEqual(attempts().at(-1), ["dash", 9]);
  terminal.press("q");
  assert.equal(await dash.done, 0);
});

test("the dash prints the interval status --no-sync prints at the same instant", async () => {
  const { source, start } = await scripted();
  const clock = makeFakeClock(start);
  let restrict = false;
  const sync = makeFakeSync(async () => {
    if (restrict)
      source.plant([{ at: new Date(clock.now().getTime() - 30_000), restricted: true }]);
    restrict = false;
    return SYNC_OK;
  });
  const terminal = makeFakeTerminal();
  const dash = await startDash(
    { env: source.env, home: source.root, now: start },
    { terminal, clock, sync, signals: makeFakeSignals() },
  );
  for (let instant = 0; instant < 3; instant += 1) {
    const out = sink();
    const code = await run(["node", "snack", "status", "--no-sync", "--source", "work"], {
      env: source.env,
      home: source.root,
      stdout: out,
      stderr: sink(),
      now: clock.now(),
    });
    assert.equal(code, 0);
    const panel = String(/next prompt {2}(\d+-\d+%)/u.exec(out.value)?.[1]);
    const screen = String(/next prompt {2}(\d+-\d+%)/u.exec(terminal.text())?.[1]);
    assert.equal(screen, panel, `instant ${instant}`);
    restrict = true;
    await clock.advance(SYNC_DELAY_MS);
  }
  terminal.press("q");
  assert.equal(await dash.done, 0);
});
