import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { afterEach, test } from "node:test";

import Database from "better-sqlite3";

import { ExitCode, SnackError } from "../src/errors.js";
import { run } from "../src/main.js";
import { pluginPackageSpec, resolveOpenCodeConfig } from "../src/opencode-config.js";
import { resolveUpdatePlan } from "../src/update.js";
import {
  cleanupRunFixtures,
  createOpenCodeDatabase,
  makeRunFixture,
} from "./fixtures/run-fixture.js";

afterEach(cleanupRunFixtures);

/** A module path that looks like the layout `npm i -g` writes. */
const globalModulePath = "/usr/local/lib/node_modules/@snack-ai/cli/src/update.js";

/**
 * A fixture whose installation layout is recognized, with an installer that records rather than
 * runs. No test in this file may execute a package manager.
 *
 * @param {{fails?: boolean}} [behaviour]
 */
async function makeUpdateFixture(behaviour = {}) {
  const fixture = await makeRunFixture("snack-update-");
  /** @type {{command: string, args: string[]}[]} */
  const executions = [];
  fixture.options.modulePath = globalModulePath;
  fixture.options.execute = async (/** @type {string} */ command, /** @type {string[]} */ args) => {
    executions.push({ command, args });
    if (behaviour.fails === true) {
      throw new Error("npm ERR! network request to https://registry.npmjs.org failed");
    }
  };
  return { ...fixture, executions };
}

test("an npm global install resolves to a global npm install of the CLI", () => {
  // The layout npm writes for `npm i -g`: the package lives under the prefix's `lib/node_modules`.
  // This is the only layout Phase 1 actually upgraded through, and the one every other case is
  // measured against.
  const plan = resolveUpdatePlan({
    modulePath: "/usr/local/lib/node_modules/@snack-ai/cli/src/update.js",
    cwd: "/home/someone/project",
    env: {},
  });

  assert.equal(plan.manager, "npm");
  assert.equal(plan.scope, "global");
  // Only the CLI is installed. The plugin arrives through the pin `--finish` writes from the newly
  // installed build -- see the addendum to ADR-0010.
  assert.deepEqual(plan.args, ["install", "--global", "@snack-ai/cli@latest"]);
  assert.equal(plan.command, "npm install --global @snack-ai/cli@latest");
});

test("a pnpm global install resolves to pnpm, not to npm", () => {
  // pnpm's global root is a versioned directory under its home. It contains `node_modules` like
  // every other layout, so the distinguishing signal has to be the `pnpm/global/<n>` segment --
  // matching on `node_modules` alone would hand a pnpm installation to npm, which would install a
  // second copy somewhere pnpm does not look and leave the user running the old one.
  const plan = resolveUpdatePlan({
    modulePath: "/home/someone/.local/share/pnpm/global/5/node_modules/@snack-ai/cli/src/update.js",
    cwd: "/home/someone/project",
    env: {},
  });

  assert.equal(plan.manager, "pnpm");
  assert.equal(plan.scope, "global");
  assert.deepEqual(plan.args, ["add", "--global", "@snack-ai/cli@latest"]);
  assert.equal(plan.command, "pnpm add --global @snack-ai/cli@latest");
});

test("a bun global install resolves to bun", () => {
  const plan = resolveUpdatePlan({
    modulePath: "/home/someone/.bun/install/global/node_modules/@snack-ai/cli/src/update.js",
    cwd: "/home/someone/project",
    env: {},
  });

  assert.equal(plan.manager, "bun");
  assert.equal(plan.scope, "global");
  assert.deepEqual(plan.args, ["add", "--global", "@snack-ai/cli@latest"]);
  assert.equal(plan.command, "bun add --global @snack-ai/cli@latest");
});

test("a local install reads its manager off the lockfile beside the project root", () => {
  // A local `node_modules` names no manager -- all four write the same directory. The lockfile is
  // the only signal, and it is passed in rather than read here so the seam stays pure: the caller
  // does the one `readdir`, and every layout in this file is a fixture rather than a directory
  // somebody has to build.
  const plan = resolveUpdatePlan({
    modulePath: "/home/someone/project/node_modules/@snack-ai/cli/src/update.js",
    cwd: "/home/someone/project",
    env: {},
    lockfiles: ["package-lock.json"],
  });

  assert.equal(plan.manager, "npm");
  assert.equal(plan.scope, "local");
  assert.deepEqual(plan.args, ["install", "@snack-ai/cli@latest"]);
  assert.equal(plan.command, "npm install @snack-ai/cli@latest");
});

test("every lockfile the table claims resolves to its own manager", () => {
  // Guards the table itself. A row silently dropped here hands that project to the refusal path,
  // where the symptom -- "SNACK cannot tell how it was installed" -- names nothing about lockfiles
  // and reads as a broken install rather than a missing row.
  /** @type {[string, string, string[]][]} */
  const rows = [
    ["package-lock.json", "npm", ["install", "@snack-ai/cli@latest"]],
    ["npm-shrinkwrap.json", "npm", ["install", "@snack-ai/cli@latest"]],
    ["pnpm-lock.yaml", "pnpm", ["add", "@snack-ai/cli@latest"]],
    ["bun.lock", "bun", ["add", "@snack-ai/cli@latest"]],
    ["bun.lockb", "bun", ["add", "@snack-ai/cli@latest"]],
    ["yarn.lock", "yarn", ["add", "@snack-ai/cli@latest"]],
  ];

  for (const [lockfile, manager, args] of rows) {
    const plan = resolveUpdatePlan({
      modulePath: "/home/someone/project/node_modules/@snack-ai/cli/src/update.js",
      cwd: "/home/someone/project",
      env: {},
      lockfiles: [lockfile],
    });
    assert.equal(plan.manager, manager, lockfile);
    assert.equal(plan.scope, "local", lockfile);
    assert.deepEqual(plan.args, args, lockfile);
  }
});

test("a local install with no lockfile refuses rather than assuming npm", () => {
  assert.throws(
    () =>
      resolveUpdatePlan({
        modulePath: "/home/someone/project/node_modules/@snack-ai/cli/src/update.js",
        cwd: "/home/someone/project",
        env: {},
        lockfiles: [],
      }),
    { reason: "unrecognized_install_layout" },
  );
});

test("an unrecognized layout refuses, and the refusal is something the reader can act on", () => {
  // Fail closed, the same rule ingestion follows: installing into a place the user did not expect
  // and saying nothing is worse than not installing. A refusal that only says "unrecognized" leaves
  // them stuck, so it has to name what was resolved and what to run instead.
  const refuse = () =>
    resolveUpdatePlan({
      modulePath: "/opt/weird/snack/src/update.js",
      cwd: "/home/someone/project",
      env: {},
    });

  assert.throws(refuse, (error) => {
    assert.ok(error instanceof SnackError);
    assert.equal(error.exitCode, ExitCode.unavailable);
    assert.equal(error.reason, "unrecognized_install_layout");
    assert.match(error.message, /\/opt\/weird\/snack\/src\/update\.js/u);
    assert.match(error.message, /@snack-ai\/cli@latest/u);
    return true;
  });
});

test("two lockfiles are two answers, so a local install refuses rather than picking one", () => {
  // A tree with both a package-lock.json and a pnpm-lock.yaml has no single maintaining manager.
  // Installing with either one writes a tree the other will undo on its next install.
  assert.throws(
    () =>
      resolveUpdatePlan({
        modulePath: "/home/someone/project/node_modules/@snack-ai/cli/src/update.js",
        cwd: "/home/someone/project",
        env: {},
        lockfiles: ["package-lock.json", "pnpm-lock.yaml"],
      }),
    { reason: "unrecognized_install_layout" },
  );
});

test("--dry-run prints the exact command and runs nothing", async () => {
  // The command that will run is shown before anything happens, because "detected and then
  // confirmed" is the whole reason the layout is resolved rather than assumed.
  const fixture = await makeUpdateFixture();

  const code = await run(["node", "snack", "update", "--dry-run"], fixture.options);

  assert.equal(code, ExitCode.success);
  assert.match(fixture.stdout.value, /npm install --global @snack-ai\/cli@latest/u);
  assert.deepEqual(fixture.executions, []);
});

test("--yes installs, and only then re-execs the new build to finish", async () => {
  // The order is the decision: the plugin registration is written by the process that comes after
  // the install, because the pin lives in the build. Registering first, or from this process,
  // writes the version being replaced -- which is finding 09 arriving by a new road.
  const fixture = await makeUpdateFixture();

  const code = await run(["node", "/usr/local/bin/snack", "update", "--yes"], fixture.options);

  assert.equal(code, ExitCode.success);
  assert.deepEqual(fixture.executions, [
    { command: "npm", args: ["install", "--global", "@snack-ai/cli@latest"] },
    { command: "/usr/local/bin/snack", args: ["update", "--finish"] },
  ]);
});

test("without --yes the resolved command is confirmed, and a refusal runs nothing", async () => {
  const fixture = await makeUpdateFixture();
  /** @type {string[]} */
  const asked = [];
  fixture.options.prompt = async (/** @type {{message: string}} */ question) => {
    asked.push(question.message);
    return "n";
  };

  const code = await run(["node", "snack", "update"], fixture.options);

  assert.equal(code, ExitCode.success);
  assert.equal(asked.length, 1);
  // The command is in the question, not just in a line above it: confirming something the prompt
  // does not name is not confirmation.
  assert.match(asked[0] ?? "", /npm install --global @snack-ai\/cli@latest/u);
  assert.deepEqual(fixture.executions, []);
});

test("with no terminal to confirm at, update refuses rather than installing unasked", async () => {
  // Same rule as `data purge`: prompting is impossible without a terminal and impossible in JSON
  // mode without breaking the one-document contract.
  const fixture = await makeUpdateFixture();
  fixture.options.prompt = undefined;

  const code = await run(["node", "snack", "update"], fixture.options);

  assert.equal(code, ExitCode.usage);
  assert.deepEqual(fixture.executions, []);
  assert.match(fixture.stderr.value, /--yes/u);
});

test("an install that fails leaves the pair as it was, and reads as an environment failure", async () => {
  const fixture = await makeUpdateFixture({ fails: true });

  const code = await run(["node", "snack", "update", "--yes"], fixture.options);

  // Not internal_error: a registry outage is not a defect in SNACK, and exit 10 would tell the user
  // to file a bug about their own network.
  assert.equal(code, ExitCode.unavailable);
  // The install was attempted and nothing followed it -- no re-exec, so no registration rewritten.
  assert.equal(fixture.executions.length, 1);
  assert.match(fixture.stderr.value, /nothing was changed/u);
});

/**
 * A fixture with one configured OpenCode source and the plugin registered, so `--finish` has
 * something real to rewrite.
 */
async function makeFinishFixture() {
  const fixture = await makeUpdateFixture();
  fixture.options.env.OPENCODE_DB = await createOpenCodeDatabase(fixture.root);
  await run(
    [
      "node",
      "snack",
      "setup",
      "opencode",
      "--non-interactive",
      "--source",
      "work",
      "--provider",
      "anthropic",
      "--profile",
      "default",
      "--plan",
      "pro",
      "--install-plugin",
      "--yes",
    ],
    fixture.options,
  );
  fixture.stdout.value = "";
  return fixture;
}

/** Every capacity period row, in a form a diff can show. */
function capacityPeriods(/** @type {string} */ databaseFile) {
  const database = new Database(databaseFile, { readonly: true });
  try {
    return JSON.stringify(
      database.prepare("select * from capacity_period order by rowid").all(),
      null,
      2,
    );
  } finally {
    database.close();
  }
}

test("--finish rewrites the registration to this build's pin", async () => {
  const fixture = await makeFinishFixture();
  const configFile = resolveOpenCodeConfig({ env: fixture.options.env, home: fixture.root });
  // Stand the registration on an older pin, which is the state an upgrade actually finds.
  const stale = (await readFile(configFile, "utf8")).replaceAll(
    pluginPackageSpec,
    "@snack-ai/opencode@0.9.0",
  );
  await writeFile(configFile, stale, "utf8");

  const code = await run(["node", "snack", "update", "--finish"], fixture.options);

  assert.equal(code, ExitCode.success);
  const written = await readFile(configFile, "utf8");
  assert.match(written, new RegExp(pluginPackageSpec.replaceAll("/", "\\/"), "u"));
  assert.doesNotMatch(written, /0\.9\.0/u);
});

test("--finish leaves every capacity period byte-identical", async () => {
  // The exit criterion, asserted against the rows rather than against which function was called:
  // an upgrade is not a change of capacity regime, and rotating one here would retire the user's
  // accumulated evidence for doing the thing the product told them to do.
  const fixture = await makeFinishFixture();
  const before = capacityPeriods(fixture.paths.databaseFile);
  assert.match(before, /"source_alias": "work"/u, "the fixture has no period to leave alone");

  const code = await run(["node", "snack", "update", "--finish"], fixture.options);

  // Asserted before the comparison: a command that refused to run also changes nothing, and would
  // make this pass while proving the opposite of what it claims.
  assert.equal(code, ExitCode.success);
  assert.equal(capacityPeriods(fixture.paths.databaseFile), before);
});

test("--finish with nothing registered does not start registering a plugin", async () => {
  // Someone who never asked for live capture ran an upgrade. Creating a registration here would
  // turn on a capture path they did not choose, on the command that was meant to keep them current.
  const fixture = await makeUpdateFixture();
  const configFile = resolveOpenCodeConfig({ env: fixture.options.env, home: fixture.root });

  const code = await run(["node", "snack", "update", "--finish"], fixture.options);

  assert.equal(code, ExitCode.success);
  await assert.rejects(readFile(configFile, "utf8"), { code: "ENOENT" });
});
