import Database from "better-sqlite3";

import { ExitCode, SnackError } from "./errors.js";

/**
 * The one dependency install script SNACK needs: the SQLite driver's native build. npm 12 skips
 * dependency install scripts in a global install unless they are allowed by name, and the install
 * still succeeds -- leaving a CLI that cannot open SQLite. npm 11.16 accepts the same flag.
 */
export const sqliteInstallScripts = "--allow-scripts=better-sqlite3";

/**
 * `better-sqlite3` is a native addon built for one Node.js ABI. Installed under one Node.js and run
 * under another -- an nvm switch, a second global prefix left behind -- every database open throws
 * before SQLite reads a byte. Without naming that, each caller reported what it was trying to do:
 * `status` said "Storage could not be read", `doctor` said storage was "invalid or inaccessible"
 * and every OpenCode source "inaccessible". A person reading that concludes their history is
 * damaged, when it was never opened.
 *
 * @param {unknown} error
 * @returns {boolean}
 */
export function isDriverLoadFailure(error) {
  return causes(error).some(
    (cause) =>
      /** @type {{code?: unknown}} */ (cause).code === "ERR_DLOPEN_FAILED" ||
      cause.message.startsWith(missingBuild),
  );
}

/** What `bindings` throws when the compiled addon is missing altogether. */
const missingBuild = "Could not locate the bindings file";

/**
 * @param {unknown} cause
 * @returns {SnackError}
 */
export function driverUnavailable(cause) {
  // The ABI numbers are the whole diagnosis, and the only part of the addon's message that carries
  // no absolute path.
  const abi = abiMismatch(cause);
  const notAtFault = "Stored data was not read and is not at fault.";
  const message = abi
    ? `The SQLite driver could not load: it was built for Node.js ABI ${abi.built} and this ` +
      `Node.js is ${abi.running}. ${notAtFault} Reinstall @snack-ai/cli with the Node.js that ` +
      `runs it; a second copy under another global prefix is the usual cause.`
    : causes(cause).some((error) => error.message.startsWith(missingBuild))
      ? `The SQLite driver could not load: its native build is missing. ${notAtFault} npm 12 ` +
        `skips that build unless it is allowed; reinstall with ` +
        `\`npm install --global ${sqliteInstallScripts} @snack-ai/cli\`.`
      : `The SQLite driver could not load. ${notAtFault} Reinstall @snack-ai/cli with ` +
        `\`npm install --global ${sqliteInstallScripts} @snack-ai/cli\`.`;
  return new SnackError(message, {
    code: ExitCode.storage,
    reason: "storage_driver_unavailable",
    cause,
  });
}

/**
 * Open an in-memory database once, so a failure whose cause a caller dropped can still be named.
 *
 * @param {() => void} [open]
 * @returns {SnackError | null}
 */
export function probeSqliteDriver(open = () => new Database(":memory:").close()) {
  try {
    open();
    return null;
  } catch (error) {
    // A diagnostic, run from inside error handling: anything that is not the addon failing to load
    // is someone else's failure to report, never a reason for the handler itself to throw.
    return isDriverLoadFailure(error) ? driverUnavailable(error) : null;
  }
}

/**
 * @param {unknown} error
 * @returns {{built: string, running: string} | null}
 */
function abiMismatch(error) {
  for (const cause of causes(error)) {
    const match = /NODE_MODULE_VERSION (\d+)\.[\s\S]*?NODE_MODULE_VERSION (\d+)/u.exec(
      cause.message,
    );
    if (match?.[1] && match[2]) return { built: match[1], running: match[2] };
  }
  return null;
}

/**
 * The error and the causes under it, bounded so a cycle cannot hang error handling.
 *
 * @param {unknown} error
 * @returns {Error[]}
 */
function causes(error) {
  /** @type {Error[]} */
  const chain = [];
  for (let current = error; current instanceof Error && chain.length < 8; current = current.cause) {
    chain.push(current);
  }
  return chain;
}
