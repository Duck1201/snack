import assert from "node:assert/strict";
import { readFile, readdir, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, test } from "node:test";

import { ExitCode } from "../src/errors.js";
import { run } from "../src/main.js";
import {
  cleanupRunFixtures,
  createOpenCodeDatabase,
  executeOpenCodeSql,
  makeRunFixture,
} from "./fixtures/run-fixture.js";

afterEach(cleanupRunFixtures);

const privacyCanaries = JSON.parse(
  await readFile(new URL("./fixtures/privacy-canaries.json", import.meta.url), "utf8"),
);

/**
 * Every byte SNACK owns under a root, whatever its format.
 *
 * Files are read as latin1 rather than utf8 so a canary that landed inside a SQLite page, a
 * backup, or a rotated spool segment is still found: utf8 decoding replaces invalid sequences
 * and could hide the very bytes this is looking for.
 *
 * @param {string} root
 */
async function readEveryByte(root) {
  /** @type {{path: string, content: string}[]} */
  const files = [];
  /** @param {string} directory */
  async function visit(directory) {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) await visit(path);
      else files.push({ path, content: await readFile(path, "latin1").catch(() => "") });
    }
  }
  await visit(root);
  return files;
}

/** @param {string} value */
function quote(value) {
  return `'${value.replaceAll("'", "''")}'`;
}

test("no command writes or prints prompt text, credentials, or local paths", async () => {
  const fixture = await makeRunFixture("snack-privacy-");
  const openCodeDatabase = await createOpenCodeDatabase(fixture.root);
  // The canaries travel the real ingestion path: they are planted in the source SNACK reads,
  // in the prompt text, the model identifier, and the session identifier alike.
  executeOpenCodeSql(
    openCodeDatabase,
    `UPDATE part SET data = json_set(data, '$.text', ${quote(
      `${privacyCanaries.prompt} ${privacyCanaries.response} ${privacyCanaries.credential} ${privacyCanaries.path}`,
    )});`,
  );
  fixture.options.env.OPENCODE_DB = openCodeDatabase;
  const promptFile = join(fixture.root, "unsent-prompt.txt");
  await writeFile(promptFile, Object.values(privacyCanaries).join("\n"), { mode: 0o600 });

  /** @type {string[][]} */
  const invocations = [
    [
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
      "--enable-prospective-analysis",
    ],
    ["sync", "--full"],
    ["status"],
    ["status", "--prompt-file", promptFile],
    ["stats", "--verbose"],
    ["doctor"],
    ["config", "get"],
    ["config", "path"],
    ["export", "--format", "json", "--output", "-"],
    ["export", "--format", "csv", "--output", join(fixture.root, "csv-out")],
    ["data", "purge", "--source", "work", "--dry-run"],
    ["data", "purge", "--source", "work", "--prevent-reimport", "--yes"],
    ["sync", "--full"],
  ];

  /** @type {string[]} */
  const transcript = [];
  for (const argv of invocations) {
    for (const json of [false, true]) {
      fixture.stdout.value = "";
      fixture.stderr.value = "";
      await run(["node", "snack", ...argv, ...(json ? ["--json"] : [])], fixture.options);
      transcript.push(fixture.stdout.value, fixture.stderr.value);
    }
  }

  // Guard against a vacuous pass: the canaries must really be in the source, and SNACK must
  // really have ingested from it.
  assert.match(await readFile(openCodeDatabase, "latin1"), /PROMPT_CANARY_DO_NOT_STORE/u);
  assert.ok(
    transcript.join("").includes("work"),
    "no command produced output naming the configured source",
  );

  const files = await readEveryByte(fixture.root);
  // The OpenCode database and the unsent-prompt file are this test's inputs: they hold the
  // canaries on purpose. Everything else under the root is SNACK's own.
  const snackFiles = files.filter(
    (file) => file.path !== openCodeDatabase && file.path !== promptFile,
  );
  assert.ok(
    snackFiles.some((file) => file.path.endsWith("snack.sqlite3")),
    "the storage database was never created",
  );

  for (const [name, canary] of Object.entries(privacyCanaries)) {
    const pattern = new RegExp(String(canary), "u");
    for (const [index, output] of transcript.entries()) {
      assert.doesNotMatch(output, pattern, `${name} reached output ${index}`);
    }
    for (const file of snackFiles) {
      assert.doesNotMatch(file.content, pattern, `${name} reached ${file.path}`);
    }
  }
});

test("an error carries no trace of the input that caused it", async () => {
  const fixture = await makeRunFixture("snack-privacy-errors-");

  for (const canary of Object.values(privacyCanaries)) {
    for (const argv of [
      ["config", "set", "presentation.json", String(canary)],
      ["config", "get", String(canary)],
      ["stats", "--source", String(canary)],
      ["export", "--format", "json", "--output", "-", "--source", String(canary)],
      ["export", "--format", "json", "--output", "-", "--since", String(canary)],
      ["data", "purge", "--source", String(canary), "--yes"],
    ]) {
      fixture.stdout.value = "";
      fixture.stderr.value = "";
      await run(["node", "snack", ...argv, "--json"], fixture.options);
      const pattern = new RegExp(String(canary), "u");
      // Echoing a rejected value back is the cheapest way to leak one, and a source alias or a
      // configuration value is exactly where someone might paste something private.
      assert.doesNotMatch(fixture.stdout.value, pattern, argv.join(" "));
      assert.doesNotMatch(fixture.stderr.value, pattern, argv.join(" "));
    }
  }
});

test("prospective text has no way into argv", async () => {
  const fixture = await makeRunFixture("snack-privacy-argv-");
  fixture.options.env.OPENCODE_DB = await createOpenCodeDatabase(fixture.root);

  // Acceptance criterion 9. Argv is readable by every other process on the machine, so the
  // protection is that no option takes prompt text at all: it arrives from a file or from stdin,
  // and both stay inside this process. An option added later that accepted text inline would
  // defeat every other prospective-analysis control, and this is what would notice.
  for (const option of ["--prompt", "--prompt-text", "--text", "--input"]) {
    fixture.stdout.value = "";
    fixture.stderr.value = "";
    const exitCode = await run(
      ["node", "snack", "status", option, String(privacyCanaries.prompt), "--json"],
      fixture.options,
    );

    assert.equal(exitCode, ExitCode.usage, option);
    const pattern = new RegExp(String(privacyCanaries.prompt), "u");
    assert.doesNotMatch(fixture.stdout.value, pattern, option);
    assert.doesNotMatch(fixture.stderr.value, pattern, option);
  }
});

test("every file SNACK creates is private to its owner", async () => {
  const fixture = await makeRunFixture("snack-privacy-modes-");
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
    ],
    fixture.options,
  );
  await run(["node", "snack", "sync", "--full"], fixture.options);
  await run(
    ["node", "snack", "export", "--format", "json", "--output", join(fixture.root, "export.json")],
    fixture.options,
  );
  await run(
    ["node", "snack", "export", "--format", "csv", "--output", join(fixture.root, "csv-out")],
    fixture.options,
  );

  const paths = fixture.paths;
  for (const directory of [paths.configDir, paths.dataDir, paths.spoolDir, paths.backupDir]) {
    const mode = await stat(directory)
      .then((stats) => stats.mode & 0o777)
      .catch(() => null);
    if (mode !== null) assert.equal(mode, 0o700, directory);
  }
  for (const file of await readEveryByte(fixture.dataHome)) {
    assert.equal((await stat(file.path)).mode & 0o777, 0o600, file.path);
  }
  for (const file of await readEveryByte(join(fixture.root, "csv-out"))) {
    assert.equal((await stat(file.path)).mode & 0o777, 0o600, file.path);
  }
  assert.equal((await stat(join(fixture.root, "export.json"))).mode & 0o777, 0o600);
});
