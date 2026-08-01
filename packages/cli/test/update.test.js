import assert from "node:assert/strict";
import { test } from "node:test";

import { ExitCode, SnackError } from "../src/errors.js";
import { resolveUpdatePlan } from "../src/update.js";

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
