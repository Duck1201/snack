import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import Database from "better-sqlite3";

import { resolvePaths } from "../../src/paths.js";

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
  // Fixtures follow the platform the suite is running on rather than declaring themselves Linux.
  // Pinning the layout made every macOS run exercise XDG paths the product never uses there, and
  // it broke outright for the tests that spawn the real binary, which cannot be told a platform.
  // `paths.test.js` still pins both layouts against `resolvePaths` directly.
  const platform = process.platform;
  const paths = resolvePaths({ env, platform, home: root });
  return {
    root,
    stdout,
    stderr,
    paths,
    dataHome: dirname(paths.dataDir),
    options: {
      stdout,
      stderr,
      home: root,
      env,
      platform,
      nodeVersion: "24.18.1",
      now: new Date("2026-01-02T03:04:05.000Z"),
      writeConfig:
        /** @type {typeof import("../../src/config.js").writePrivateAtomic | undefined} */ (
          undefined
        ),
    },
  };
}

/** @param {string} root @param {string} [filename] */
export async function createOpenCodeDatabase(root, filename = "opencode.db") {
  const databaseFile = join(root, filename);
  const sql = await readFile(new URL("./opencode/supported-v1.sql", import.meta.url), "utf8");
  const database = new Database(databaseFile);
  try {
    database.exec(sql);
  } finally {
    database.close();
  }
  return databaseFile;
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

/** @param {string} databaseFile @param {string} sql */
export function executeOpenCodeSql(databaseFile, sql) {
  const database = new Database(databaseFile);
  try {
    database.exec(sql);
  } finally {
    database.close();
  }
}
