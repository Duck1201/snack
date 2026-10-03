import { Buffer } from "node:buffer";
import { spawn } from "node:child_process";
import { writeSync } from "node:fs";
import { emitKeypressEvents } from "node:readline";
import { clearTimeout, setTimeout } from "node:timers";
import { fileURLToPath } from "node:url";

/**
 * The production ports of `snack dash`: the real terminal, the real clock and timers, this
 * process's signals, and the sync child. The one dash file no test reaches except through a
 * pseudo-terminal; everything it does is wiring, and every decision is `dash.js`'s.
 */

/** The executable a sync child runs: this very build's, resolved from this module. */
const CLI = fileURLToPath(new URL("./cli.js", import.meta.url));

/**
 * @param {{stdin: NodeJS.ReadStream, stdout: NodeJS.WriteStream, env: NodeJS.ProcessEnv}} input
 * @returns {Omit<import("./dash.js").DashPorts, "storage" | "color">}
 */
export function createTerminalPorts({ stdin, stdout, env }) {
  emitKeypressEvents(stdin);
  return {
    terminal: {
      size: () => ({ columns: stdout.columns ?? 80, rows: stdout.rows ?? 24 }),
      write: (chunk) => {
        stdout.write(chunk);
      },
      writeSync: (chunk) => {
        writeSync(/** @type {{fd: number}} */ (/** @type {unknown} */ (stdout)).fd, chunk);
      },
      setRawMode: (on) => {
        stdin.setRawMode(on);
      },
      pause: () => {
        stdin.pause();
      },
      resume: () => {
        stdin.resume();
      },
      onKey: (handler) => {
        /** @param {string | undefined} text @param {import("./dash.js").Key | undefined} key */
        const listener = (text, key) => handler(key ?? { sequence: text ?? "" });
        stdin.on("keypress", listener);
        return () => {
          stdin.off("keypress", listener);
        };
      },
      onResize: (handler) => {
        // Node's `SIGWINCH`, delivered as the stream's `resize` with `columns`/`rows` updated.
        stdout.on("resize", handler);
        return () => {
          stdout.off("resize", handler);
        };
      },
      onGone: (handler) => {
        // `EIO` when the terminal closed under us; any error on a TTY stream means the same thing
        // to a screen: there is nothing left to draw on or read from.
        const listener = () => handler();
        stdin.on("error", listener);
        stdout.on("error", listener);
        return () => {
          stdin.off("error", listener);
          stdout.off("error", listener);
        };
      },
    },
    clock: () => new Date(),
    scheduler: {
      setTimeout: (callback, ms) => setTimeout(callback, ms),
      clearTimeout: (handle) => clearTimeout(/** @type {NodeJS.Timeout} */ (handle)),
    },
    signals: {
      on: (signal, handler) => {
        process.on(signal, handler);
        return () => {
          process.off(signal, handler);
        };
      },
      raise: (signal) => {
        // `proper-lockfile` loads `signal-exit`, which keeps a listener of its own on the
        // terminating signals and, seeing ours gone, swallows the re-raised one: the process would
        // end 0 instead of by the signal. The session holds no lock by now, so there is nothing
        // left for that listener to clean up, and it is removed with ours.
        if (signal !== "SIGSTOP") {
          for (const listener of process.listeners(/** @type {NodeJS.Signals} */ (signal))) {
            process.off(signal, listener);
          }
        }
        process.kill(process.pid, signal);
      },
      onExit: (handler) => {
        process.on("exit", handler);
        return () => {
          process.off("exit", handler);
        };
      },
    },
    sync: { start: () => startSyncChild(env) },
  };
}

/**
 * Run `snack sync --json` as a child of its own process group and resolve to how it ended.
 *
 * Detached, so a `SIGHUP` or `SIGINT` aimed at the terminal's foreground group never reaches it in
 * the middle of a transaction; unreferenced, so quitting the dash never waits for it and never
 * kills it -- it finishes, writes into a closed pipe (`cli.js` ends quietly on `EPIPE`) and
 * releases the storage lock on its own. Its stderr is drained and dropped: with `SNACK_DEBUG` it
 * can carry a stack with absolute paths, which is never shown on the screen or kept.
 *
 * @param {NodeJS.ProcessEnv} env
 * @returns {Promise<import("./dash.js").SyncOutcome>}
 */
function startSyncChild(env) {
  return new Promise((resolve) => {
    /** @type {import("node:child_process").ChildProcess} */
    let child;
    try {
      child = spawn(process.execPath, [CLI, "sync", "--json"], {
        env,
        stdio: ["ignore", "pipe", "pipe"],
        detached: true,
      });
    } catch {
      resolve({ exitCode: -1, envelope: null });
      return;
    }
    /** @type {Buffer[]} */
    const chunks = [];
    child.stdout?.on("data", (chunk) => chunks.push(chunk));
    child.stderr?.resume();
    child.on("error", () => resolve({ exitCode: -1, envelope: null }));
    child.on("close", (code) => {
      resolve({ exitCode: code ?? -1, envelope: parseEnvelope(Buffer.concat(chunks)) });
    });
    child.unref();
    /** @type {{unref?: () => void} | null} */ (child.stdout)?.unref?.();
    /** @type {{unref?: () => void} | null} */ (child.stderr)?.unref?.();
  });
}

/**
 * @param {Buffer} bytes
 * @returns {import("./dash.js").SyncOutcome["envelope"]}
 */
function parseEnvelope(bytes) {
  try {
    return JSON.parse(bytes.toString("utf8"));
  } catch {
    return null;
  }
}
