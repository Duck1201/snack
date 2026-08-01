import { SnackError, ExitCode } from "./errors.js";

const cliPackageName = "@snack-ai/cli";

/**
 * @typedef {object} UpdatePlan
 * @property {"npm" | "pnpm" | "bun" | "yarn"} manager
 * @property {"global" | "local"} scope
 * @property {string} command the exact invocation, for display and confirmation
 * @property {string[]} args
 */

/**
 * Work out how this CLI was installed, and therefore how to replace it.
 *
 * Pure on purpose: the running module's path, the working directory and the environment are the
 * only inputs, so every layout is a fixture rather than a directory somebody has to build. Getting
 * this wrong installs into a place the user did not expect and says nothing, which is worse than
 * refusing.
 *
 * @param {{modulePath: string, cwd: string, env: NodeJS.ProcessEnv, lockfiles?: string[]}} context
 *   `lockfiles` is the set of lockfile names found beside the project root, supplied by the caller
 *   so this function stays free of the filesystem.
 * @returns {UpdatePlan}
 */
export function resolveUpdatePlan(context) {
  // Ordered most specific first: every global layout contains `node_modules`, so a manager is
  // identified by the segment above it and never by `node_modules` alone.
  if (/\/pnpm\/global\/[^/]+\/node_modules\//u.test(context.modulePath)) {
    return plan("pnpm", "global", ["add", "--global", `${cliPackageName}@latest`]);
  }
  if (context.modulePath.includes("/.bun/install/global/node_modules/")) {
    return plan("bun", "global", ["add", "--global", `${cliPackageName}@latest`]);
  }
  if (context.modulePath.includes("/lib/node_modules/")) {
    return plan("npm", "global", ["install", "--global", `${cliPackageName}@latest`]);
  }

  // A local `node_modules` names no manager -- all four write the same directory -- so the lockfile
  // beside it is the only signal, and an unlocked project falls through to the refusal below.
  if (context.modulePath.startsWith(`${context.cwd}/node_modules/`)) {
    const manager = managerFromLockfiles(context.lockfiles ?? []);
    if (manager) {
      return plan(manager, "local", [
        manager === "npm" ? "install" : "add",
        `${cliPackageName}@latest`,
      ]);
    }
  }

  throw new SnackError(
    `SNACK cannot tell how it was installed, so it will not guess where to install the update.\n` +
      `Resolved location: ${context.modulePath}\n` +
      `Update it with your own package manager, for example:\n` +
      `  npm install --global ${cliPackageName}@latest\n` +
      `Then run: snack update --finish`,
    { code: ExitCode.unavailable, reason: "unrecognized_install_layout" },
  );
}

/** @type {Record<string, UpdatePlan["manager"]>} */
const lockfileManagers = {
  "package-lock.json": "npm",
  "npm-shrinkwrap.json": "npm",
  "pnpm-lock.yaml": "pnpm",
  "bun.lock": "bun",
  "bun.lockb": "bun",
  "yarn.lock": "yarn",
};

/**
 * @param {string[]} lockfiles
 * @returns {UpdatePlan["manager"] | null}
 */
function managerFromLockfiles(lockfiles) {
  const found = [...new Set(lockfiles.map((name) => lockfileManagers[name]).filter(Boolean))];
  // Two lockfiles is two answers, and picking one silently installs with a manager that is not the
  // one maintaining the tree. Refuse, the same as an unrecognized layout.
  return found.length === 1 ? (found[0] ?? null) : null;
}

/**
 * @param {UpdatePlan["manager"]} manager
 * @param {UpdatePlan["scope"]} scope
 * @param {string[]} args
 * @returns {UpdatePlan}
 */
function plan(manager, scope, args) {
  return { manager, scope, command: [manager, ...args].join(" "), args };
}
