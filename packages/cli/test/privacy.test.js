import assert from "node:assert/strict";
import { mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, test } from "node:test";

import Database from "better-sqlite3";

import { ExitCode } from "../src/errors.js";
import { run } from "../src/main.js";
import {
  addCodexTurns,
  cleanupRunFixtures,
  createClaudeCanaryHistory,
  createCodexCanaryHistory,
  createOpenCodeDatabase,
  executeOpenCodeSql,
  makeRunFixture,
  plantStatements,
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
  // OpenCode carries content outside the message parts too, and those fields held innocent fixture
  // values -- so if SNACK ever started storing a session title or a working directory, nothing
  // here would have noticed. The Claude fixture already plants its equivalents; this is the other
  // client catching up.
  executeOpenCodeSql(
    openCodeDatabase,
    `UPDATE session SET title = ${quote(String(privacyCanaries.title))},
                        directory = ${quote(String(privacyCanaries.path))},
                        slug = ${quote(String(privacyCanaries.title))};
     UPDATE project SET worktree = ${quote(String(privacyCanaries.path))};`,
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
    ["status", "--prompt-file", promptFile, "--sequence", "5"],
    ["stats", "--verbose"],
    ["doctor"],
    ["config", "get"],
    ["config", "path"],
    ["export", "--format", "json", "--output", "-"],
    ["export", "--format", "csv", "--output", join(fixture.root, "csv-out")],
    ["data", "purge", "--source", "work", "--dry-run"],
    ["data", "purge", "--source", "work", "--prevent-reimport", "--yes"],
    ["sync", "--full"],
    // After the purge, so the database the sweep reads still holds recorded sequence answers.
    ["status", "--sequence", "10"],
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
  // The swept database holds recorded sequence answers, so their table is part of the sweep.
  const database = new Database(fixture.paths.databaseFile, { readonly: true });
  try {
    const recorded = /** @type {{total: number}} */ (
      database.prepare("SELECT COUNT(*) AS total FROM prediction_sequence").get()
    ).total;
    assert.ok(recorded > 0, "no sequence answer was recorded");
  } finally {
    database.close();
  }

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
      ["status", "--sequence", String(canary)],
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

test("no command writes or prints what a Claude history says about the user", async () => {
  const fixture = await makeRunFixture("snack-privacy-claude-");
  fixture.options.env.CLAUDE_CONFIG_DIR = await createClaudeCanaryHistory(
    fixture.root,
    privacyCanaries,
  );

  /** @type {string[][]} */
  const invocations = [
    [
      "setup",
      "claude",
      "--non-interactive",
      "--source",
      "claude",
      "--provider",
      "anthropic",
      "--profile",
      "default",
      "--plan",
      "pro",
    ],
    ["sync", "--full"],
    ["status"],
    ["stats", "--verbose"],
    ["doctor"],
    ["config", "get"],
    ["export", "--format", "json", "--output", "-"],
    ["export", "--format", "csv", "--output", join(fixture.root, "claude-csv-out")],
    ["data", "purge", "--source", "claude", "--prevent-reimport", "--yes"],
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

  // Guard against a vacuous pass: the canaries have to really be in the history SNACK read, and
  // SNACK has to really have read it.
  const history = await readEveryByte(
    join(String(fixture.options.env.CLAUDE_CONFIG_DIR), "projects"),
  );
  assert.ok(history.some((file) => file.content.includes(privacyCanaries.prompt)));
  assert.ok(transcript.join("").includes("claude"), "no command named the configured source");

  const files = await readEveryByte(fixture.root);
  const snackFiles = files.filter(
    (file) => !file.path.startsWith(String(fixture.options.env.CLAUDE_CONFIG_DIR)),
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

test("no command writes or prints what a Codex rollout says about the user", async () => {
  const fixture = await makeRunFixture("snack-privacy-codex-");
  const codexHome = await createCodexCanaryHistory(fixture.root, privacyCanaries);
  // A few ordinary successes beside the canary rollout: the canary's own prompts are not evidence
  // either way, and the weighting variants compute only from an outcome of the user's, so without
  // these their capture path would never run here.
  await addCodexTurns(codexHome, {
    from: /** @type {Date} */ (fixture.options.now).getTime() - 5 * 3_600_000,
    count: 6,
    spacingMs: 20 * 60_000,
    thread: 9,
  });
  fixture.options.env.CODEX_HOME = codexHome;

  /** @type {string[][]} */
  const invocations = [
    [
      "setup",
      "codex",
      "--non-interactive",
      "--source",
      "codex",
      "--provider",
      "openai",
      "--profile",
      "default",
      "--plan",
      "plus",
    ],
    ["sync", "--full"],
    ["status"],
    ["status", "--source", "codex", "--verbose"],
    // After the stated full window planted below: the shadow computes from its `full` ladder.
    ["status", "--source", "codex", "--verbose", "--sequence", "3"],
    ["stats", "--verbose"],
    ["doctor"],
    ["config", "get"],
    ["export", "--format", "json", "--output", "-"],
    ["export", "--format", "csv", "--output", join(fixture.root, "codex-csv-out")],
    ["data", "purge", "--source", "codex", "--prevent-reimport", "--yes"],
    ["sync", "--full"],
  ];

  /** @type {string[]} */
  const transcript = [];
  /** @type {unknown[]} */
  let shadowRows = [];
  /** @type {unknown[]} */
  let weightingRows = [];
  let planted = false;
  for (const argv of invocations) {
    for (const json of [false, true]) {
      fixture.stdout.value = "";
      fixture.stderr.value = "";
      await run(["node", "snack", ...argv, ...(json ? ["--json"] : [])], fixture.options);
      transcript.push(fixture.stdout.value, fixture.stderr.value);
    }
    // The canary history's prompts are not evidence either way, but the six turns added above are:
    // under the figure the rollout states, the shadow already computes from them on the first
    // `status`. Once the verbose panel has quoted that figure, Codex stating the same limit full a
    // minute before the clock moves the shadow onto its `full` ladder, which computes from the
    // starting assumption -- through the identity the rollout's own statement was stored under.
    if (argv[0] === "status" && argv.includes("--verbose") && !planted) {
      planted = true;
      const database = new Database(fixture.paths.databaseFile, { readonly: true });
      /** @type {{installation_id: string, limit_id: string | null, plan_type: string | null}} */
      let stated;
      try {
        stated = /** @type {typeof stated} */ (
          database
            .prepare(
              "SELECT installation_id, limit_id, plan_type FROM reported_capacity_observation LIMIT 1",
            )
            .get()
        );
      } finally {
        database.close();
      }
      const now = /** @type {Date} */ (fixture.options.now);
      plantStatements(
        fixture.paths.databaseFile,
        "codex",
        stated.installation_id,
        [
          {
            observation_key: "f".repeat(64),
            observed_at: new Date(now.getTime() - 60_000).toISOString(),
            limit_id: stated.limit_id,
            plan_type: stated.plan_type,
            windows: [{ window_minutes: 300, used_percent: 100, resets_at: null }],
            parser_version: "codex-rate-limits-v1",
          },
        ],
        now,
      );
    }
    // The shadow forecasts `status` recorded, read before the purge below deletes them.
    if (argv[0] === "stats") {
      const database = new Database(fixture.paths.databaseFile, { readonly: true });
      try {
        shadowRows = database.prepare("SELECT * FROM prediction_reported_capacity").all();
        weightingRows = database.prepare("SELECT * FROM prediction_shadow").all();
      } finally {
        database.close();
      }
    }
  }
  // The shadow is a capture path of its own -- a stated figure copied beside an attempt -- so it
  // carries its own canary assertion, and a vacuity guard that it really ran.
  assert.ok(shadowRows.length > 0, "the shadow was never computed and recorded");
  assert.ok(transcript.join("").includes("reported-capacity@1 would say"));
  for (const [name, canary] of Object.entries(privacyCanaries)) {
    assert.doesNotMatch(
      JSON.stringify(shadowRows),
      new RegExp(String(canary), "u"),
      `${name} reached prediction_reported_capacity`,
    );
  }
  // The weighting variants are a capture path too: their rows ride with every attempt.
  assert.ok(weightingRows.length > 0, "no weighting variant was computed and recorded");
  for (const [name, canary] of Object.entries(privacyCanaries)) {
    assert.doesNotMatch(
      JSON.stringify(weightingRows),
      new RegExp(String(canary), "u"),
      `${name} reached prediction_shadow`,
    );
  }

  // Guard against a vacuous pass: the canaries have to really be in the history SNACK read, and
  // SNACK has to really have read it -- including the stated figure, which travels a path of its
  // own into storage and onto the status surface.
  const history = await readEveryByte(codexHome);
  assert.ok(history.some((file) => file.content.includes(privacyCanaries.prompt)));
  assert.ok(
    history.some(
      (file) => file.path.endsWith("history.jsonl") && file.content.includes(privacyCanaries.title),
    ),
  );
  assert.ok(transcript.join("").includes("codex"), "no command named the configured source");
  assert.ok(
    transcript.join("").includes("Codex states 34% of its 5h window"),
    "the stated figure never reached status",
  );

  const files = await readEveryByte(fixture.root);
  const snackFiles = files.filter((file) => !file.path.startsWith(codexHome));
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

test("no source file names the Codex prompt-history file", async () => {
  // The adapter never lists CODEX_HOME itself, which is what keeps that file out of reach. A source
  // file that named it would be the first step towards opening it, so naming it is refused here.
  const directory = new URL("../src/", import.meta.url);
  for (const name of await readdir(directory)) {
    const source = await readFile(new URL(name, directory), "utf8");
    assert.ok(!source.includes("history.jsonl"), `src/${name} names the Codex prompt history`);
  }
});

test("a session identifier from the spool is hashed before it is stored", async () => {
  // The privacy suite drove backfill only; live capture writes through a spool segment instead, and
  // that path had no canary anywhere.
  //
  // Most of a spool event is identifiers SNACK stores on purpose -- the prompt id, the provider,
  // the model, a provider error code -- so planting canaries in those would assert the opposite of
  // the policy. The session identifier is the one field that must not survive as it arrived: it
  // names a conversation, and SNACK reduces it to a fingerprint on the way in. That is the claim
  // worth holding, and it was held for backfill and not for the spool.
  const fixture = await makeRunFixture("snack-privacy-spool-");
  fixture.options.env.OPENCODE_DB = await createOpenCodeDatabase(fixture.root);
  fixture.stdout.value = "";
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
      "--json",
    ],
    fixture.options,
  );
  const installationId = JSON.parse(fixture.stdout.value).data.source.installation_id;

  const segmentDirectory = join(fixture.paths.spoolDir, "work");
  await mkdir(segmentDirectory, { recursive: true, mode: 0o700 });
  await writeFile(
    join(segmentDirectory, "segment-1.ndjson"),
    `${JSON.stringify({
      schema_version: 1,
      event_id: "event-1",
      installation_id: installationId,
      event_type: "session_idle",
      source_prompt_id: "prompt-1",
      source_session_id: String(privacyCanaries.title),
      revision: "revision-1",
      revision_domain: "opencode-plugin-v1",
      parser_version: "opencode-plugin-v1",
      occurred_at: "2026-01-02T03:04:20.000Z",
      provider: "anthropic",
      model: "claude-sonnet",
      completion: "completed",
      outcome: "success",
      usage_slices: [],
      restrictions: [],
    })}\n`,
    { mode: 0o600 },
  );

  /** @type {string[]} */
  const transcript = [];
  for (const argv of [
    ["sync", "--full"],
    ["status", "--no-sync"],
    ["stats", "--verbose"],
    ["doctor"],
    ["export", "--format", "json", "--output", "-"],
  ]) {
    for (const json of [false, true]) {
      fixture.stdout.value = "";
      fixture.stderr.value = "";
      await run(["node", "snack", ...argv, ...(json ? ["--json"] : [])], fixture.options);
      transcript.push(fixture.stdout.value, fixture.stderr.value);
    }
  }

  // Guard against a vacuous pass: the segment has to have been read for the hashing to mean
  // anything, and the spool is the one place the canary is allowed to remain.
  assert.match(transcript.join(""), /"read": 1/u, "the spool segment was never read");
  const files = await readEveryByte(fixture.dataHome);
  assert.ok(
    files.some((file) => file.path.endsWith("snack.sqlite3")),
    "the storage database was never created",
  );

  const pattern = new RegExp(String(privacyCanaries.title), "u");
  for (const [index, output] of transcript.entries()) {
    assert.doesNotMatch(output, pattern, `the session identifier reached output ${index}`);
  }
  for (const file of files) {
    if (file.path.startsWith(fixture.paths.spoolDir)) continue;
    assert.doesNotMatch(file.content, pattern, `the session identifier reached ${file.path}`);
  }
});
