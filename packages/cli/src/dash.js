import { renderDash } from "./dash-view.js";
import { SnackError } from "./errors.js";
import { SEQUENCE_MAX_LENGTH, assessSequence } from "./prediction.js";
import { shownForecast } from "./render.js";
import { RESTORE, createScreen } from "./screen.js";
import {
  buildSourceReports,
  confirmPredictionDelivery,
  primaryHorizon,
  recordAttempt,
} from "./source-report.js";
import { describeSequenceCaveats } from "./status.js";
import { readStorageReadiness, withStorageOperationLock } from "./storage.js";

/**
 * The controller behind `snack dash`: two clocks, the keys, the sync child and the snapshot ledger.
 *
 * It talks only to ports. The terminal, the clock, the timers, the signals and the sync child are
 * `dash-terminal.js`'s in production and a test's fakes otherwise; storage is reached only through
 * the storage port, and only inside the storage operation lock.
 *
 * **Two clocks.** Every second -- and on every key, resize and state change -- a frame is drawn from
 * the cached reading and the clock: no storage, no lock. A synchronization is a child process,
 * `snack sync --json`, started once at start and then 60 seconds after the previous one ended, or
 * now on `r`; single-flight, never timed out, never killed. After a child that ends `ok`, and once
 * at start, one recompute runs under the storage operation lock: the reports, the attempts whose
 * snapshot key changed, a frame, and the deliveries of what that frame drew. Between recomputes the
 * dash holds no lock and opens no connection.
 *
 * **Snapshots.** One per rendered forecast (ADR-0008): an attempt is recorded only when a source's
 * key (`snapshotKey`) differs from the key last delivered in this session, and confirmed delivered
 * only once a frame actually drew it. An identical reading writes nothing. A sequence shown in the
 * `next N` row is display-only and records nothing: its length is the person's, stepped by a key,
 * and recording each length passed through would write rows about key presses, not about forecasts
 * the person received.
 */

/** Seconds between the end of one synchronization and the start of the next (decision D2). */
export const SYNC_DELAY_MS = 60_000;

/** The redraw clock. */
export const TICK_MS = 1_000;

/** The `next N` row's length when it is first shown; the person moves it from there. */
export const DEFAULT_SEQUENCE_LENGTH = 10;

/**
 * The key a dash snapshot is written on: what the reader is shown of one source's answer, and the
 * versions that make it that answer.
 *
 * The interval enters as `shownForecast` rounds it -- the very function every printed interval goes
 * through -- so two readings that print the same line share a key, and a reading that moves the
 * printed interval, the risk word or the evidence level gets a new one (ADR-0008, stated for a
 * screen). The capacity period is in the key because an outcome is linked only to an attempt of its
 * own period. The unrounded interval, the point, freshness, synchronization, the pressure reading
 * and the shadows are not: they are not the answer, or they change with the clock alone.
 *
 * @param {{source: {alias: string, plan_profile: {id: string, version: string}}, viability: {lower: number, upper: number}, risk: {label: string, policy_version: string}, evidence: {level: string, policy_version: string}, method: {id: string, version: string}, model_policy_version: string, pressure: {policy_version: string}}} report
 * @param {number | null} capacityPeriodId
 * @returns {string}
 */
export function snapshotKey(report, capacityPeriodId) {
  const shown = shownForecast(report);
  return JSON.stringify([
    report.source.alias,
    capacityPeriodId,
    shown.interval.lower,
    shown.interval.upper,
    shown.risk,
    shown.evidence,
    report.method.id,
    report.method.version,
    report.model_policy_version,
    report.risk.policy_version,
    report.evidence.policy_version,
    report.pressure.policy_version,
    report.source.plan_profile.id,
    report.source.plan_profile.version,
  ]);
}

/**
 * @typedef {{name?: string, sequence?: string, ctrl?: boolean}} Key
 *
 * @typedef {object} TerminalPort
 * @property {() => {columns: number, rows: number}} size
 * @property {(chunk: string) => void} write
 * @property {(chunk: string) => void} writeSync The last resort from `exit`.
 * @property {(on: boolean) => void} setRawMode
 * @property {() => void} pause
 * @property {() => void} resume
 * @property {(handler: (key: Key) => void) => () => void} onKey
 * @property {(handler: () => void) => () => void} onResize
 * @property {(handler: () => void) => () => void} onGone `EIO`: the terminal went away.
 *
 * @typedef {object} SchedulerPort
 * @property {(callback: () => void, ms: number) => unknown} setTimeout
 * @property {(handle: unknown) => void} clearTimeout
 *
 * @typedef {object} SignalPort
 * @property {(signal: "SIGINT" | "SIGTERM" | "SIGHUP" | "SIGTSTP" | "SIGCONT", handler: () => void) => () => void} on
 * @property {(signal: string) => void} raise Send a signal to this process, our handler removed.
 * @property {(handler: () => void) => () => void} onExit
 *
 * @typedef {{exitCode: number, envelope: {status?: string, data?: unknown, errors?: {code: string}[]} | null}} SyncOutcome
 * @typedef {{start(): Promise<SyncOutcome>}} SyncPort
 *
 * @typedef {object} StorageSession
 * @property {() => Promise<{storage: "missing" | "pending" | "ready", pendingMigrations: number}>} readiness
 * @property {(now: Date, synchronization: (alias: string) => {performed: boolean, status: string}) => Promise<import("./source-report.js").BuiltSource[]>} build
 * @property {(built: import("./source-report.js").BuiltSource) => number | null} record
 * @property {(attemptIds: number[], now: Date) => void} confirm
 *
 * @typedef {object} StoragePort
 * @property {string[]} aliases The capacity sources, in configuration order.
 * @property {string} horizon The primary horizon, which the plot's windows are.
 * @property {<T>(work: (session: StorageSession) => Promise<T>) => Promise<T>} session Runs `work`
 *   inside the storage operation lock; rejects with `storage_locked` when it cannot be taken.
 *
 * @typedef {object} DashPorts
 * @property {TerminalPort} terminal
 * @property {() => Date} clock
 * @property {SchedulerPort} scheduler
 * @property {SyncPort} sync
 * @property {SignalPort} signals
 * @property {StoragePort} storage
 * @property {boolean} color
 * @property {(controller: {idle(): Promise<void>, state(): import("./dash-view.js").DashState}) => void} [probe]
 *   A test seam: called once with what lets a test wait for the controller to settle.
 */

/**
 * The real storage port: the reports `status` builds, read and written only inside the storage
 * operation lock.
 *
 * @param {{paths: import("./paths.js").SnackPaths, config: Record<string, unknown>, selected: import("./source-report.js").ReportedSource[], inScope: import("./source-report.js").ReportedSource[], invocationId: string, weightingVariants?: typeof import("./prediction.js").WEIGHTING_VARIANTS}} input
 * @returns {StoragePort}
 */
export function createStoragePort(input) {
  const { paths } = input;
  /** @type {StorageSession} */
  const session = {
    readiness: () => readStorageReadiness(paths.databaseFile),
    build: async (now, synchronization) =>
      (
        await buildSourceReports({
          databaseFile: paths.databaseFile,
          config: input.config,
          selected: input.selected,
          inScope: input.inScope,
          now,
          synchronize: async (source) => synchronization(source.alias),
          ...(input.weightingVariants === undefined
            ? {}
            : { weightingVariants: input.weightingVariants }),
          includeSeries: true,
        })
      ).sources,
    record: (built) => recordAttempt(paths.databaseFile, built),
    confirm: (attemptIds, now) =>
      confirmPredictionDelivery(paths.databaseFile, attemptIds, {
        now,
        // Decision D5: a dash snapshot is identifiable without a filter that changes calibration.
        format: "dash",
        invocationId: input.invocationId,
      }),
  };
  return {
    aliases: input.selected.map((source) => source.alias),
    horizon: primaryHorizon(input.config),
    session: (work) => withStorageOperationLock(paths, () => work(session)),
  };
}

/**
 * Run one dash session until the person quits, a signal ends it, or the terminal goes away.
 *
 * Resolves to the exit code; rejects only for an unexpected failure, and always after the terminal
 * was restored, so the error is reported to the terminal the person is looking at.
 *
 * @param {DashPorts} ports
 * @returns {Promise<number>}
 */
export async function runDash(ports) {
  const { terminal, clock, scheduler, sync, signals, storage } = ports;
  const nowIso = () => clock().toISOString();

  /** @type {import("./dash-view.js").DashState} */
  const state = {
    now: nowIso(),
    sources: storage.aliases.map((alias) => ({
      alias,
      report: null,
      series: [],
      seriesHorizon: storage.horizon,
      sync: "waiting",
    })),
    selected: 0,
    pane: "detail",
    sync: { phase: "idle", startedAt: null, endedAt: null, outcome: null, nextAt: null },
    reading: { computedAt: null, stale: false, storage: "ready", pendingMigrations: 0 },
    sequenceLength: null,
  };
  /** The cached reading: the last recompute's built sources, by alias. */
  /** @type {Map<string, import("./source-report.js").BuiltSource>} */
  const cache = new Map();
  /** The snapshot ledger (spec §4.3). */
  /** @type {Map<string, string>} */
  const delivered = new Map();
  /** @type {Map<string, {key: string, attemptId: number}>} */
  const pending = new Map();
  let lastLength = DEFAULT_SEQUENCE_LENGTH;

  let gone = false;
  let entered = false;
  let finished = false;
  let suspended = false;
  let syncStopped = false;
  let recomputing = false;
  /** A recompute was asked for while one ran: run once more right after it. */
  let recomputeAgain = false;
  /** The lock was busy: the next tick tries again. */
  let recomputeOnTick = false;
  let delivering = false;
  /** @type {unknown} */
  let tickTimer = null;
  /** @type {unknown} */
  let syncTimer = null;
  /** @type {Set<Promise<unknown>>} */
  const inflight = new Set();
  /** @type {(() => void)[]} */
  const unsubscribe = [];

  /** @type {(value: string | null) => void} */
  let settle = () => {};
  /** @type {(error: unknown) => void} */
  let crash = () => {};
  /** @type {Promise<string | null>} resolves to the signal to re-raise, if any */
  const session = new Promise((resolve, reject) => {
    settle = resolve;
    crash = reject;
  });

  const screen = createScreen({
    write: (chunk) => {
      if (!gone) terminal.write(chunk);
    },
  });

  /** @param {unknown} error */
  const fail = (error) => {
    if (finished) return;
    finished = true;
    crash(error);
  };
  /** @param {string | null} [signal] */
  const finish = (signal = null) => {
    if (finished) return;
    finished = true;
    settle(signal);
  };
  /**
   * Every callback the controller registers runs inside this: a synchronous throw and a rejection
   * both end the session through `fail`, so the terminal is restored before the error is reported.
   *
   * @template {unknown[]} A
   * @param {(...args: A) => unknown} work
   * @returns {(...args: A) => void}
   */
  const guard =
    (work) =>
    (...args) => {
      if (finished) return;
      try {
        const result = work(...args);
        if (result instanceof Promise) track(result);
      } catch (error) {
        fail(error);
      }
    };
  /** @param {Promise<unknown>} promise */
  const track = (promise) => {
    const tracked = promise.catch(fail).finally(() => inflight.delete(tracked));
    inflight.add(tracked);
  };

  /** Draw one frame from the cached reading and the clock. Reads no storage. */
  const draw = () => {
    if (finished || suspended || gone || !entered) return { drawn: /** @type {string[]} */ ([]) };
    state.now = nowIso();
    const { lines, drawn } = renderDash(state, terminal.size(), { color: ports.color });
    screen.frame(lines);
    if (drawn.some((alias) => pending.has(alias)) && !recomputing) track(deliverDrawn());
    return { drawn };
  };

  /**
   * Confirm the pending snapshots a normal frame has drawn since: the reading was recorded while the
   * terminal was too small, and is delivered at the first frame that showed it.
   */
  const deliverDrawn = async () => {
    if (delivering) return;
    delivering = true;
    try {
      await storage.session(async (tx) => {
        const { drawn } = draw();
        confirmDrawn(tx, drawn);
      });
    } catch (error) {
      // Busy storage: the pending snapshot stays pending, and the next frame tries again.
      if (!isStorageError(error)) throw error;
    } finally {
      delivering = false;
    }
  };

  /**
   * @param {StorageSession} tx
   * @param {string[]} drawn
   */
  const confirmDrawn = (tx, drawn) => {
    const confirmed = drawn.flatMap((alias) => {
      const entry = pending.get(alias);
      return entry === undefined ? [] : [[alias, entry]];
    });
    if (confirmed.length === 0) return;
    tx.confirm(
      confirmed.map(([, entry]) => /** @type {{attemptId: number}} */ (entry).attemptId),
      clock(),
    );
    for (const [alias, entry] of confirmed) {
      delivered.set(/** @type {string} */ (alias), /** @type {{key: string}} */ (entry).key);
      pending.delete(/** @type {string} */ (alias));
    }
  };

  /** The sequence reading for the person's length, from the cached reports alone. */
  const refreshSequences = () => {
    for (const source of state.sources) {
      if (state.sequenceLength === null || source.report === null) {
        delete source.sequence;
        continue;
      }
      const report = /** @type {import("./source-report.js").SourceReport} */ (
        /** @type {unknown} */ (source.report)
      );
      const assessment = assessSequence(report, state.sequenceLength);
      source.sequence = {
        assessment,
        caveats: describeSequenceCaveats(assessment, report.contributors.evidence_window),
      };
    }
  };

  /**
   * One recompute, under the lock: read every source, record the attempts whose key changed, draw,
   * and confirm what the frame drew. At most one in flight; a request meanwhile runs once after it.
   */
  const recompute = async () => {
    if (recomputing) {
      recomputeAgain = true;
      return;
    }
    if (suspended) {
      // Never take the lock on the way to being stopped: run it when the dash is resumed.
      recomputeOnTick = true;
      return;
    }
    recomputing = true;
    recomputeOnTick = false;
    try {
      await storage.session(async (tx) => {
        const readiness = await tx.readiness();
        state.reading.storage = readiness.storage;
        state.reading.pendingMigrations = readiness.pendingMigrations;
        if (readiness.storage !== "ready") return;
        const now = clock();
        const built = await tx.build(now, (alias) => ({
          performed: false,
          status: synchronizationOf(alias),
        }));
        for (const source of built) {
          cache.set(source.alias, source);
          if (source.capacityPeriodId === null) continue;
          const key = snapshotKey(source.report, source.capacityPeriodId);
          if (delivered.get(source.alias) === key) {
            // Back to what the reader already has: a pending one that was never drawn stays an
            // attempt without delivery, which is what it is.
            pending.delete(source.alias);
            continue;
          }
          if (pending.get(source.alias)?.key === key) continue;
          const attemptId = tx.record(source);
          if (attemptId !== null) pending.set(source.alias, { key, attemptId });
        }
        for (const source of state.sources) {
          const built = cache.get(source.alias);
          if (built === undefined) continue;
          source.report = /** @type {never} */ (built.report);
          source.series = built.series;
          source.seriesHorizon = built.seriesHorizon;
        }
        refreshSequences();
        state.reading.computedAt = now.toISOString();
        state.reading.stale = false;
        const { drawn } = draw();
        confirmDrawn(tx, drawn);
      });
    } catch (error) {
      if (!isStorageError(error)) throw error;
      const reason = /** @type {SnackError} */ (error).reason;
      if (reason === "storage_newer_than_application") {
        state.reading.storage = "newer";
        stopSyncs();
      } else if (reason !== "storage_locked") {
        state.reading.storage = "unprepared";
      }
      // Busy or unreadable: the cached reading stays, marked stale. A busy lock is retried on the
      // next tick -- never in a loop, and at most one recompute is ever in flight.
      if (state.reading.computedAt !== null) state.reading.stale = true;
      recomputeOnTick = reason === "storage_locked";
    } finally {
      recomputing = false;
    }
    if (recomputeAgain && !finished) {
      recomputeAgain = false;
      track(recompute());
    }
    draw();
  };

  /** @param {string} alias */
  const synchronizationOf = (alias) => {
    const shown = state.sources.find((source) => source.alias === alias)?.sync;
    return shown === "ok" || shown === "failed" ? shown : "not_requested";
  };

  const stopSyncs = () => {
    syncStopped = true;
    if (syncTimer !== null) scheduler.clearTimeout(syncTimer);
    syncTimer = null;
    state.sync.nextAt = null;
  };

  /** Start a synchronization now, unless one is running (single-flight) or syncs have stopped. */
  const startSync = () => {
    if (finished || syncStopped || state.sync.phase === "running") return;
    if (syncTimer !== null) scheduler.clearTimeout(syncTimer);
    syncTimer = null;
    state.sync.phase = "running";
    state.sync.startedAt = nowIso();
    state.sync.nextAt = null;
    draw();
    // The child itself is not awaited by anything: it runs as long as it runs, and only what the
    // dash does once it has ended is part of the session's work.
    void sync
      .start()
      .catch(() => ({ exitCode: -1, envelope: null }))
      .then(guard(onSyncEnd));
  };

  /** @param {SyncOutcome} outcome */
  const onSyncEnd = async (outcome) => {
    if (finished) return;
    state.sync.phase = "idle";
    state.sync.endedAt = nowIso();
    const kind = classifySync(outcome);
    state.sync.outcome = kind;
    if (kind === "ok") {
      const failed = failedAliases(outcome.envelope);
      for (const source of state.sources) source.sync = failed.has(source.alias) ? "failed" : "ok";
    } else if (kind === "storage_busy") {
      for (const source of state.sources) source.sync = "busy";
      if (state.reading.computedAt !== null) state.reading.stale = true;
    } else if (kind === "storage_newer") {
      state.reading.storage = "newer";
      if (state.reading.computedAt !== null) state.reading.stale = true;
      stopSyncs();
    } else {
      // A failed child leaves each source's SYNC as it was; the header says it failed.
      if (state.reading.storage === "missing" || state.reading.storage === "pending") {
        state.reading.storage = "unprepared";
      }
      if (state.reading.computedAt !== null) state.reading.stale = true;
    }
    // Fixed delay from the end of this one, never a fixed rate: two never overlap and a slow one
    // queues no backlog.
    if (!syncStopped) {
      state.sync.nextAt = new Date(clock().getTime() + SYNC_DELAY_MS).toISOString();
      syncTimer = scheduler.setTimeout(guard(startSync), SYNC_DELAY_MS);
    }
    draw();
    if (kind === "ok") await recompute();
  };

  const tick = () => {
    tickTimer = scheduler.setTimeout(guard(tick), TICK_MS);
    if (recomputeOnTick && !recomputing) track(recompute());
    draw();
  };

  /** @param {Key} key */
  const onKey = (key) => {
    const name = key.name ?? "";
    const sequence = key.sequence ?? "";
    if ((key.ctrl === true && name === "c") || sequence === "\u0003" || name === "q") {
      finish(null);
      return;
    }
    if ((key.ctrl === true && name === "z") || sequence === "\u001A") {
      suspend();
      return;
    }
    if ((key.ctrl === true && name === "l") || sequence === "\f") {
      screen.invalidate();
    } else if (name === "up" || name === "k") {
      state.selected = Math.max(0, state.selected - 1);
    } else if (name === "down" || name === "j") {
      state.selected = Math.min(state.sources.length - 1, state.selected + 1);
    } else if (name === "r") {
      startSync();
    } else if (sequence === "?") {
      state.pane = state.pane === "help" ? "detail" : "help";
    } else if (name === "escape") {
      state.pane = "detail";
    } else if (name === "s") {
      state.sequenceLength = state.sequenceLength === null ? lastLength : null;
      refreshSequences();
    } else if ((sequence === "+" || sequence === "-") && state.sequenceLength !== null) {
      // Exactly one step, within the bounds `status --sequence` accepts: the dash never skips,
      // hides or clamps a length by how informative it would be.
      const step = sequence === "+" ? 1 : -1;
      state.sequenceLength = Math.min(
        SEQUENCE_MAX_LENGTH,
        Math.max(1, state.sequenceLength + step),
      );
      lastLength = state.sequenceLength;
      refreshSequences();
    } else {
      return;
    }
    draw();
  };

  const enterTerminal = () => {
    terminal.setRawMode(true);
    terminal.resume();
    screen.enter();
    entered = true;
  };

  /** Raw mode off, input paused, the alternate buffer left. Idempotent; writes nothing once gone. */
  const restore = () => {
    if (!entered) return;
    entered = false;
    if (gone) return;
    try {
      terminal.setRawMode(false);
      terminal.pause();
      screen.leave();
    } catch {
      // The terminal went away while restoring; there is nothing left to restore.
      gone = true;
    }
  };

  /**
   * The terminal is handed back at once; the stop itself waits for the work in flight -- a
   * recompute, a delivery -- so the process is never stopped holding the storage lock, which would
   * block every other snack command for as long as the shell kept it stopped. Nothing new starts
   * while suspended: `draw` paints nothing, and a recompute asked for meanwhile runs on resume.
   */
  const suspend = () => {
    if (suspended) return undefined;
    restore();
    suspended = true;
    const work = [...inflight];
    if (work.length === 0) {
      signals.raise("SIGSTOP");
      return undefined;
    }
    return Promise.allSettled(work).then(() => {
      if (suspended && !finished) signals.raise("SIGSTOP");
    });
  };

  const resumeFromStop = () => {
    suspended = false;
    // Stopped by us (`Ctrl+Z`) the terminal was restored and is entered again; stopped from outside,
    // the shell may have reset the line discipline, so raw mode is set again either way.
    if (entered) terminal.setRawMode(true);
    else enterTerminal();
    screen.invalidate();
    draw();
    if (recomputeOnTick && !recomputing) track(recompute());
    if (
      !syncStopped &&
      state.sync.phase === "idle" &&
      state.sync.nextAt !== null &&
      Date.parse(state.sync.nextAt) <= clock().getTime()
    ) {
      startSync();
    }
  };

  const terminalGone = () => {
    gone = true;
    finish(null);
  };

  unsubscribe.push(
    terminal.onKey(guard(onKey)),
    terminal.onResize(
      guard(() => {
        screen.invalidate();
        draw();
      }),
    ),
    terminal.onGone(guard(terminalGone)),
    signals.on(
      "SIGINT",
      guard(() => finish("SIGINT")),
    ),
    signals.on(
      "SIGTERM",
      guard(() => finish("SIGTERM")),
    ),
    signals.on(
      "SIGHUP",
      guard(() => {
        gone = true;
        finish("SIGHUP");
      }),
    ),
    signals.on("SIGTSTP", guard(suspend)),
    signals.on("SIGCONT", guard(resumeFromStop)),
    signals.onExit(() => {
      if (entered && !gone) {
        entered = false;
        try {
          terminal.writeSync(RESTORE);
        } catch {
          // Nothing left to write to.
        }
      }
    }),
  );

  ports.probe?.({
    idle: async () => {
      while (inflight.size > 0) await Promise.all([...inflight]);
    },
    state: () => state,
  });

  /** @type {string | null} */
  let raise;
  try {
    enterTerminal();
    draw();
    tickTimer = scheduler.setTimeout(guard(tick), TICK_MS);
    track(
      recompute().then(() => {
        if (!finished) startSync();
      }),
    );
    raise = await session;
  } finally {
    finished = true;
    if (tickTimer !== null) scheduler.clearTimeout(tickTimer);
    if (syncTimer !== null) scheduler.clearTimeout(syncTimer);
    restore();
    for (const off of unsubscribe) off();
  }
  // A sync child still running is left to finish its transaction and release the lock on its own:
  // killing it mid-transaction would leave the lock to go stale for two minutes.
  if (raise !== null) {
    // Dying by the signal mid-recompute would leave the storage lock to go stale for two minutes:
    // the work in flight -- a recompute, a delivery -- finishes and releases it first.
    await Promise.allSettled([...inflight]);
    signals.raise(raise);
  }
  return 0;
}

/**
 * @param {SyncOutcome} outcome
 * @returns {"ok" | "failed" | "storage_busy" | "storage_newer"}
 */
export function classifySync(outcome) {
  const envelope = outcome.envelope;
  const status = envelope?.status;
  if (outcome.exitCode === 0 && (status === "ok" || status === "degraded")) return "ok";
  const code = envelope?.errors?.[0]?.code;
  if (outcome.exitCode === 5 && code === "storage_locked") return "storage_busy";
  if (outcome.exitCode === 5 && code === "storage_newer_than_application") return "storage_newer";
  return "failed";
}

/**
 * The capacity sources a degraded sync reported a failure for.
 *
 * @param {SyncOutcome["envelope"]} envelope
 */
function failedAliases(envelope) {
  const data = /** @type {{sources?: {alias?: unknown, failed?: unknown}[]} | null | undefined} */ (
    envelope?.data
  );
  return new Set(
    (Array.isArray(data?.sources) ? data.sources : [])
      .filter((entry) => typeof entry.failed === "number" && entry.failed > 0)
      .map((entry) => String(entry.alias)),
  );
}

/** @param {unknown} error */
function isStorageError(error) {
  return error instanceof SnackError && error.exitCode === 5;
}
