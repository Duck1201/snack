import { setImmediate } from "node:timers";

import { run } from "../../src/main.js";
import { makeVirtualScreen } from "./fake-screen.js";
import { sink } from "./run-fixture.js";

/**
 * The ports `snack dash` runs on, faked: a terminal that applies what the screen writes to a
 * virtual grid, a clock whose timers run only when the test advances it, signals the test sends,
 * and a sync child the test scripts. Injected through `RunOptions.dash`, so a session is driven
 * through `run(["node", "snack", "dash"], …)` exactly as the real command runs, preconditions and
 * all, with nothing but the ports replaced.
 */

/**
 * @param {{columns?: number, rows?: number}} [size]
 */
export function makeFakeTerminal(size = {}) {
  /** @type {Set<(key: import("../../src/dash.js").Key) => void>} */
  const keys = new Set();
  /** @type {Set<() => void>} */
  const resizes = new Set();
  /** @type {Set<() => void>} */
  const gones = new Set();
  const fake = {
    columns: size.columns ?? 80,
    rows: size.rows ?? 24,
    rawMode: false,
    paused: true,
    inAltBuffer: false,
    cursorVisible: true,
    /** Every chunk written, in order. */
    /** @type {string[]} */
    writes: [],
    virtual: makeVirtualScreen({ columns: size.columns ?? 80, rows: size.rows ?? 24 }),
  };
  /** @type {import("../../src/dash.js").TerminalPort} */
  const port = {
    size: () => ({ columns: fake.columns, rows: fake.rows }),
    write: (chunk) => apply(chunk),
    writeSync: (chunk) => apply(chunk),
    setRawMode: (on) => {
      fake.rawMode = on;
    },
    pause: () => {
      fake.paused = true;
    },
    resume: () => {
      fake.paused = false;
    },
    onKey: (handler) => {
      keys.add(handler);
      return () => keys.delete(handler);
    },
    onResize: (handler) => {
      resizes.add(handler);
      return () => resizes.delete(handler);
    },
    onGone: (handler) => {
      gones.add(handler);
      return () => gones.delete(handler);
    },
  };
  const controls = {
    port,
    /**
     * Press a key by name (`q`, `up`, `escape`, `ctrl+c`, `ctrl+z`, `ctrl+l`) or by the character it
     * types (`?`, `+`, `-`).
     *
     * @param {string} name
     */
    press(name) {
      /** @type {import("../../src/dash.js").Key} */
      let key;
      const control = /^ctrl\+([a-z])$/u.exec(name);
      if (control !== null) {
        const letter = /** @type {string} */ (control[1]);
        key = {
          name: letter,
          ctrl: true,
          sequence: String.fromCharCode(letter.charCodeAt(0) - 96),
        };
      } else if (/^[a-z]$/u.test(name) || ["up", "down", "escape"].includes(name)) {
        key = { name, sequence: name.length === 1 ? name : "" };
      } else {
        key = { sequence: name };
      }
      for (const handler of [...keys]) handler(key);
    },
    /** @param {number} columns @param {number} rows */
    resize(columns, rows) {
      fake.columns = columns;
      fake.rows = rows;
      fake.virtual = makeVirtualScreen({ columns, rows });
      for (const handler of [...resizes]) handler();
    },
    /** The terminal went away (`EIO`). */
    vanish() {
      for (const handler of [...gones]) handler();
    },
    /** What a reader sees now. */
    text() {
      return fake.virtual.text();
    },
    listeners() {
      return keys.size + resizes.size + gones.size;
    },
  };
  /** @param {string} chunk */
  function apply(chunk) {
    fake.writes.push(chunk);
    // The alternate buffer and the cursor are tracked in the order they were written.
    // eslint-disable-next-line no-control-regex -- the escape sequences are what is parsed
    for (const [token] of chunk.matchAll(/\u001B\[\?(?:1049|25)[hl]/gu)) {
      if (token.endsWith("1049h")) fake.inAltBuffer = true;
      if (token.endsWith("1049l")) fake.inAltBuffer = false;
      if (token.endsWith("25l")) fake.cursorVisible = false;
      if (token.endsWith("25h")) fake.cursorVisible = true;
    }
    fake.virtual.write(chunk);
  }
  return Object.assign(fake, controls);
}

/**
 * A clock whose timers fire only as the test advances it, in order, each followed by everything
 * the controller started settling -- a recompute, a sync child, a delivery.
 *
 * @param {Date} start
 */
export function makeFakeClock(start) {
  let current = start.getTime();
  let nextId = 1;
  /** @type {Map<number, {at: number, callback: () => void}>} */
  const timers = new Map();
  const clock = {
    now: () => new Date(current),
    /** @type {() => Promise<void>} */
    settle: async () => {},
    /** Called after every timer has fired and settled. */
    /** @type {(at: Date) => void | Promise<void>} */
    afterEach: () => {},
    /** @type {import("../../src/dash.js").SchedulerPort} */
    scheduler: {
      setTimeout: (callback, ms) => {
        const id = nextId;
        nextId += 1;
        timers.set(id, { at: current + ms, callback });
        return id;
      },
      clearTimeout: (handle) => {
        timers.delete(/** @type {number} */ (handle));
      },
    },
    pending: () => timers.size,
    /** @param {number} ms */
    async advance(ms) {
      const target = current + ms;
      for (;;) {
        /** @type {[number, {at: number, callback: () => void}] | null} */
        let due = null;
        for (const [id, timer] of timers) {
          if (timer.at <= target && (due === null || timer.at < due[1].at)) due = [id, timer];
        }
        if (due === null) break;
        const [id, timer] = due;
        timers.delete(id);
        current = Math.max(current, timer.at);
        timer.callback();
        await clock.settle();
        await clock.afterEach(new Date(current));
      }
      current = target;
      await clock.settle();
    },
  };
  return clock;
}

export function makeFakeSignals() {
  /** @type {Map<string, Set<() => void>>} */
  const handlers = new Map();
  /** @type {Set<() => void>} */
  const exits = new Set();
  const fake = {
    /** Every signal the controller sent to its own process, in order. */
    /** @type {string[]} */
    raised: [],
    /** @type {import("../../src/dash.js").SignalPort} */
    port: {
      on: (signal, handler) => {
        const set = handlers.get(signal) ?? new Set();
        set.add(handler);
        handlers.set(signal, set);
        return () => set.delete(handler);
      },
      raise: (signal) => {
        fake.raised.push(signal);
      },
      onExit: (handler) => {
        exits.add(handler);
        return () => exits.delete(handler);
      },
    },
    /** @param {string} signal */
    send(signal) {
      for (const handler of [...(handlers.get(signal) ?? [])]) handler();
    },
    exit() {
      for (const handler of [...exits]) handler();
    },
    listeners() {
      return [...handlers.values()].reduce((total, set) => total + set.size, 0) + exits.size;
    },
  };
  return fake;
}

/**
 * A sync child the test scripts. `outcome` is called once per synchronization, in process. A child
 * that ends on its own -- the usual case -- is waited for when the clock settles; one that is
 * `held` ends only when the test lets it (a timer on the fake clock, say), and is not.
 *
 * @param {() => Promise<import("../../src/dash.js").SyncOutcome>} outcome
 * @param {{held?: boolean}} [options]
 */
export function makeFakeSync(outcome, options = {}) {
  /** @type {Set<Promise<unknown>>} */
  const running = new Set();
  const fake = {
    started: 0,
    /** @type {import("../../src/dash.js").SyncPort} */
    port: {
      start: () => {
        fake.started += 1;
        const child = outcome();
        if (options.held !== true) {
          const settled = child.finally(() => running.delete(settled));
          running.add(settled);
        }
        return child;
      },
    },
    async idle() {
      while (running.size > 0) await Promise.allSettled([...running]);
    },
  };
  return fake;
}

/** An `ok` sync that ingested nothing. */
export const SYNC_OK = Object.freeze({
  exitCode: 0,
  envelope: { status: "ok", data: { sources: [] }, errors: [] },
});

/**
 * The real `snack sync --json`, run in process on the test's storage at the fake clock's instant:
 * what the child process does, without a process.
 *
 * @param {Record<string, unknown>} options run options of the fixture
 * @param {() => Date} now
 */
export function realSync(options, now) {
  return async () => {
    const out = sink();
    const exitCode = await run(["node", "snack", "sync", "--json"], {
      ...options,
      stdout: out,
      stderr: sink(),
      now: now(),
    });
    try {
      return { exitCode, envelope: JSON.parse(out.value) };
    } catch {
      return { exitCode, envelope: null };
    }
  };
}

/**
 * Start `snack dash` through `run` on fake ports, and resolve once the controller is up.
 *
 * @param {{env: Record<string, string | undefined>, home?: string, now?: Date, [key: string]: unknown}} options
 * @param {{terminal: ReturnType<typeof makeFakeTerminal>, clock: ReturnType<typeof makeFakeClock>, signals?: ReturnType<typeof makeFakeSignals>, sync: ReturnType<typeof makeFakeSync>}} fakes
 */
export async function startDash(options, fakes) {
  const signals = fakes.signals ?? makeFakeSignals();
  const stderr = sink();
  /** @type {(controller: {idle(): Promise<void>, state(): import("../../src/dash-view.js").DashState}) => void} */
  let ready = () => {};
  /** @type {Promise<{idle(): Promise<void>, state(): import("../../src/dash-view.js").DashState}>} */
  const probed = new Promise((resolve) => {
    ready = resolve;
  });
  const done = run(["node", "snack", "dash"], {
    ...options,
    env: { TERM: "xterm-256color", ...options.env },
    stdout: /** @type {never} */ ({ isTTY: true, write: () => true }),
    stdin: /** @type {never} */ ({ isTTY: true }),
    stderr,
    dash: {
      terminal: fakes.terminal.port,
      clock: fakes.clock.now,
      scheduler: fakes.clock.scheduler,
      sync: fakes.sync.port,
      signals: signals.port,
      probe: ready,
    },
  });
  const controller = await Promise.race([
    probed,
    done.then((code) => {
      throw new Error(`dash ended before it started: exit ${code}, ${stderr.value}`);
    }),
  ]);
  /**
   * Everything started settles: the controller's work, a child that ends on its own, and the work
   * its end starts.
   */
  const settle = async () => {
    await controller.idle();
    await fakes.sync.idle();
    // The end of a child is handled a few microtasks after it resolves.
    await new Promise((resolve) => setImmediate(resolve));
    await controller.idle();
  };
  fakes.clock.settle = settle;
  await settle();
  return { done, controller, signals, stderr, settle };
}
