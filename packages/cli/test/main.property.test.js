import assert from "node:assert/strict";
import { afterEach, test } from "node:test";

import fc from "fast-check";

import { ExitCode } from "../src/errors.js";
import { run } from "../src/main.js";
import {
  cleanupRunFixtures,
  createOpenCodeDatabase,
  makeRunFixture,
} from "./fixtures/run-fixture.js";

afterEach(cleanupRunFixtures);

/** A value that could only have come from argv. */
const CANARY = "PRIVATE_ARGV_CANARY";

/** The command paths a user can type. `help` is excluded: it exits before anything is decided. */
const commands = [
  ["setup", "opencode"],
  ["setup", "claude"],
  ["sync"],
  ["stats"],
  ["status"],
  ["doctor"],
  ["config", "get"],
  ["config", "path"],
  ["config", "set"],
  ["data", "purge"],
  ["export"],
];

/**
 * Flags drawn from the frozen surface and from just outside it, so a generated invocation is as
 * likely to be a typo as a valid call. `--yes` is included because a destructive command that
 * skipped confirmation on a malformed scope is the worst outcome argv could produce.
 */
const flags = [
  "--json",
  "--source",
  "--full",
  "--verbose",
  "--by-client",
  "--no-sync",
  "--horizon",
  "--format",
  "--output",
  "--since",
  "--until",
  "--all",
  "--dry-run",
  "--yes",
  "--include-config",
  "--prevent-reimport",
  "--non-interactive",
  "--provider",
  "--profile",
  "--plan",
  "--prompt-file",
  "--not-a-flag",
  "-x",
];

/** Values a flag might be given, including the one that must never come back. */
const values = fc.constantFrom(
  CANARY,
  "json",
  "csv",
  "-",
  "work",
  "PT1H",
  "true",
  "",
  "../../etc/passwd",
  "2026-01-02T03:04:05.000Z",
);

const argv = fc
  .tuple(
    fc.constantFrom(...commands),
    fc.array(fc.oneof(fc.constantFrom(...flags), values), { maxLength: 5 }),
  )
  .map(([command, rest]) => [...command, ...rest]);

test("no argv makes SNACK exit outside its published codes, print a stack, or echo a rejected value", async () => {
  // Exit codes are a frozen public contract, and argv is the one input a user composes by hand and
  // a script composes by accident. Three things have to hold for anything typed: the exit code is
  // one of the published categories, a failure is a message rather than a stack trace with absolute
  // paths in it, and a value SNACK refused does not travel back out.
  //
  // The last one only applies to refusals. A value SNACK accepted is a value it is supposed to
  // report -- `config set` echoing what it stored is the command working.
  /** @type {Set<number>} */
  const published = new Set(Object.values(ExitCode));
  const fixture = await makeRunFixture("snack-argv-property-");
  fixture.options.env.OPENCODE_DB = await createOpenCodeDatabase(fixture.root);
  let exercised = 0;

  await fc.assert(
    fc.asyncProperty(argv, async (line) => {
      fixture.stdout.value = "";
      fixture.stderr.value = "";
      const exitCode = await run(["node", "snack", ...line], fixture.options);
      const output = `${fixture.stdout.value}${fixture.stderr.value}`;
      exercised += 1;

      assert.ok(published.has(exitCode), `${line.join(" ")} exited ${exitCode}`);
      // A stack trace carries absolute paths, which is both a leak and an answer nobody can act
      // on. `SNACK_DEBUG` prints one deliberately and is not set here.
      assert.doesNotMatch(output, /\n\s+at [\w.<>]+ \(/u, line.join(" "));
      assert.doesNotMatch(output, /file:\/\//u, line.join(" "));
      if (exitCode !== ExitCode.success) {
        assert.doesNotMatch(
          output,
          new RegExp(CANARY, "u"),
          `${line.join(" ")} echoed a value it rejected`,
        );
      }
    }),
    { numRuns: 300 },
  );

  assert.ok(exercised > 0, "no invocation ran");
});
