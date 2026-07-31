import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * Command tests drive `run(argv, options)` against injected sinks, a temporary XDG environment,
 * and a fixed clock, never the real home directory or the real clock.
 *
 * @type {string[]}
 */
const temporaryRoots = [];

/** Remove every root handed out since the last call. Call from `afterEach`. */
export async function cleanupRunFixtures() {
  await Promise.all(
    temporaryRoots.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
}

/** @param {string} [prefix] */
export async function makeRunFixture(prefix = "snack-main-") {
  const root = await mkdtemp(join(tmpdir(), prefix));
  temporaryRoots.push(root);
  const stdout = sink();
  const stderr = sink();
  /** @type {{XDG_CONFIG_HOME: string, XDG_DATA_HOME: string, XDG_CACHE_HOME: string, XDG_STATE_HOME: string, OPENCODE_DB?: string}} */
  const env = {
    XDG_CONFIG_HOME: join(root, "config-home"),
    XDG_DATA_HOME: join(root, "data-home"),
    XDG_CACHE_HOME: join(root, "cache-home"),
    XDG_STATE_HOME: join(root, "state-home"),
  };
  const paths = {
    configDir: join(env.XDG_CONFIG_HOME, "snack"),
    configFile: join(env.XDG_CONFIG_HOME, "snack", "config.jsonc"),
    dataDir: join(env.XDG_DATA_HOME, "snack"),
    databaseFile: join(env.XDG_DATA_HOME, "snack", "snack.sqlite3"),
    backupDir: join(env.XDG_DATA_HOME, "snack", "backups"),
  };
  return {
    root,
    stdout,
    stderr,
    paths,
    dataHome: env.XDG_DATA_HOME,
    options: {
      stdout,
      stderr,
      home: root,
      env,
      platform: /** @type {NodeJS.Platform} */ ("linux"),
      nodeVersion: "24.18.1",
      now: new Date("2026-01-02T03:04:05.000Z"),
      writeConfig:
        /** @type {typeof import("../../src/config.js").writePrivateAtomic | undefined} */ (
          undefined
        ),
    },
  };
}

export function sink() {
  return {
    value: "",
    /** @param {string} chunk */
    write(chunk) {
      this.value += chunk;
    },
  };
}
