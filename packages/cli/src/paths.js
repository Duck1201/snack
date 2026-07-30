import { homedir as systemHomedir } from "node:os";
import { isAbsolute, join } from "node:path";

/**
 * @typedef {object} SnackPaths
 * @property {string} configDir
 * @property {string} configFile
 * @property {string} dataDir
 * @property {string} databaseFile
 * @property {string} backupDir
 * @property {string} cacheDir
 * @property {string} stateDir
 */

/**
 * Resolve all local paths without creating or reading them.
 *
 * @param {{env?: NodeJS.ProcessEnv | undefined, platform?: NodeJS.Platform | undefined, home?: string | undefined}} [options]
 * @returns {SnackPaths}
 */
export function resolvePaths(options = {}) {
  const env = options.env ?? process.env;
  const platform = options.platform ?? process.platform;
  const home = options.home ?? systemHomedir();

  if (platform === "darwin") {
    const support = join(home, "Library", "Application Support", "SNACK");
    return buildPaths({
      configDir: support,
      dataDir: support,
      cacheDir: join(home, "Library", "Caches", "SNACK"),
      stateDir: join(home, "Library", "Logs", "SNACK"),
    });
  }

  const configHome = xdgHome(env.XDG_CONFIG_HOME, join(home, ".config"));
  const dataHome = xdgHome(env.XDG_DATA_HOME, join(home, ".local", "share"));
  const cacheHome = xdgHome(env.XDG_CACHE_HOME, join(home, ".cache"));
  const stateHome = xdgHome(env.XDG_STATE_HOME, join(home, ".local", "state"));

  return buildPaths({
    configDir: join(configHome, "snack"),
    dataDir: join(dataHome, "snack"),
    cacheDir: join(cacheHome, "snack"),
    stateDir: join(stateHome, "snack"),
  });
}

/** @param {string | undefined} candidate @param {string} fallback */
function xdgHome(candidate, fallback) {
  return candidate && isAbsolute(candidate) ? candidate : fallback;
}

/**
 * @param {{configDir: string, dataDir: string, cacheDir: string, stateDir: string}} roots
 * @returns {SnackPaths}
 */
function buildPaths(roots) {
  return {
    ...roots,
    configFile: join(roots.configDir, "config.jsonc"),
    databaseFile: join(roots.dataDir, "snack.sqlite3"),
    backupDir: join(roots.dataDir, "backups"),
  };
}
