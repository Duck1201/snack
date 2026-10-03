import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, test } from "node:test";

import { run } from "../src/main.js";
import {
  cleanupRunFixtures,
  createClaudeHistory,
  createCodexHistory,
  createOpenCodeDatabase,
  executeOpenCodeSql,
  makeRunFixture,
} from "./fixtures/run-fixture.js";

afterEach(cleanupRunFixtures);

/**
 * A scripted stand-in for the terminal.
 *
 * Keyed by question id rather than by call order, and it throws on an id it was not given
 * an answer for, so a question added without updating a test fails loudly instead of
 * silently taking a default.
 *
 * An array of answers is consumed one per asking of that question, which is how a question that
 * refuses its own answer and asks again is scripted; the last one is repeated if it is asked
 * beyond the end of the script.
 *
 * @param {Record<string, string | string[]>} answers
 */
function scriptedPrompt(answers) {
  /** @type {{id: string, message: string, choices?: {value: string, label: string}[], default?: string}[]} */
  const asked = [];
  /** @type {Record<string, number>} */
  const takenPerId = {};
  /** @param {{id: string, message: string, choices?: {value: string, label: string}[], default?: string}} question */
  const prompt = async (question) => {
    asked.push(question);
    const scripted = answers[question.id];
    if (scripted === undefined) {
      throw new Error(`the guided setup asked an unscripted question: ${question.id}`);
    }
    if (typeof scripted === "string") return scripted;
    const taken = takenPerId[question.id] ?? 0;
    takenPerId[question.id] = taken + 1;
    return /** @type {string} */ (scripted[Math.min(taken, scripted.length - 1)]);
  };
  return { prompt, asked };
}

const defaultAnswers = {
  alias: "work",
  provider: "anthropic",
  profile: "default",
  plan: "pro",
  plan_profile: "subscription-window",
  prospective_analysis: "no",
  install_plugin: "no",
  confirm: "yes",
};

test("setup claude configures a source and sync reads its history", async () => {
  const fixture = await makeRunFixture("snack-setup-claude-");
  fixture.options.env.CLAUDE_CONFIG_DIR = await createClaudeHistory(fixture.root);

  await run(
    [
      "node",
      "snack",
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
      "--json",
    ],
    fixture.options,
  );
  const configured = JSON.parse(fixture.stdout.value);

  assert.equal(configured.status, "ok");
  assert.equal(configured.command, "setup claude");
  assert.equal(configured.data.source.adapter, "claude");
  assert.equal(configured.data.fingerprint.family, "cc-jsonl-turntree-v1");
  // Claude Code has no separate account identity in its history, so the one mapping OpenCode
  // cannot discover is the same one a Claude user still has to name.
  assert.equal(configured.data.source.provider, "anthropic");

  fixture.stdout.value = "";
  await run(["node", "snack", "sync", "--full", "--json"], fixture.options);
  const synced = JSON.parse(fixture.stdout.value);

  assert.equal(synced.status, "ok");
  assert.equal(synced.data.sources[0].inserted, 1);

  // The configuration written for a Claude source has to be the one the schema accepts, or every
  // later command fails on a configuration SNACK wrote itself.
  const config = await readFile(fixture.paths.configFile, "utf8");
  assert.match(config, /"adapter": "claude"/u);
  assert.doesNotMatch(config, /"database"/u);
});

test("setup claude fails closed when no Claude history is there to read", async () => {
  const fixture = await makeRunFixture("snack-setup-claude-missing-");
  fixture.options.env.CLAUDE_CONFIG_DIR = join(fixture.root, "no-such-claude-home");

  const exitCode = await run(
    [
      "node",
      "snack",
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
      "--json",
    ],
    fixture.options,
  );
  const document = JSON.parse(fixture.stdout.value);

  // No Claude Code installation is a fact about the source, not a SNACK failure, and it must not
  // leave a configured source pointing at a history that is not there.
  assert.equal(document.status, "error");
  assert.equal(document.errors[0].code, "source_unavailable");
  assert.equal(exitCode, 4);
  await assert.rejects(readFile(fixture.paths.configFile, "utf8"));
});

test("guided setup writes what the equivalent flags would have written", async () => {
  const guided = await makeRunFixture("snack-setup-guided-");
  guided.options.env.OPENCODE_DB = await createOpenCodeDatabase(guided.root);
  const script = scriptedPrompt(defaultAnswers);

  const exitCode = await run(["node", "snack", "setup", "opencode"], {
    ...guided.options,
    prompt: script.prompt,
  });

  const flagged = await makeRunFixture("snack-setup-flagged-");
  flagged.options.env.OPENCODE_DB = await createOpenCodeDatabase(flagged.root);
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
      "--plan-profile",
      "subscription-window",
    ],
    flagged.options,
  );

  assert.equal(exitCode, 0);
  const guidedSource = await soleSource(guided.paths.configFile);
  const flaggedSource = await soleSource(flagged.paths.configFile);
  // Both entry points must produce the same configuration, because they run the same
  // journal, backup, and rollback path afterwards.
  assert.deepEqual(
    { ...guidedSource, installation_id: null, database: null },
    { ...flaggedSource, installation_id: null, database: null },
  );
  assert.equal(guidedSource.plan_profile, "subscription-window");
});

test("guided setup asks for what it cannot observe, in a stable order", async () => {
  const fixture = await makeRunFixture("snack-setup-order-");
  fixture.options.env.OPENCODE_DB = await createOpenCodeDatabase(fixture.root);
  const script = scriptedPrompt(defaultAnswers);

  await run(["node", "snack", "setup", "opencode"], {
    ...fixture.options,
    prompt: script.prompt,
  });

  assert.deepEqual(
    script.asked.map((question) => question.id),
    [
      "alias",
      "provider",
      "profile",
      "plan",
      "plan_profile",
      "prospective_analysis",
      "install_plugin",
      "confirm",
    ],
  );
  // The plan a user names and the profile SNACK holds a prior for are different things, so
  // they are asked separately rather than one being guessed from the other.
  const planProfile = script.asked.find((question) => question.id === "plan_profile");
  assert.deepEqual(planProfile?.choices?.map((choice) => choice.value).sort(), [
    "generic",
    "metered-credit",
    "subscription-window",
  ]);
  // Consent is never the default.
  assert.equal(
    script.asked.find((question) => question.id === "prospective_analysis")?.default,
    "no",
  );
  assert.equal(script.asked.find((question) => question.id === "install_plugin")?.default, "no");
});

test("guided setup offers the providers actually present in the database", async () => {
  const fixture = await makeRunFixture("snack-setup-discover-");
  const openCodeDatabase = await createOpenCodeDatabase(fixture.root);
  executeOpenCodeSql(
    openCodeDatabase,
    `INSERT INTO session (id, project_id, slug, directory, title, version, time_created, time_updated) VALUES
       ('session-2', 'project-1', 'slug-2', '/workspace', 'session title', '1.18.9', 1767323045000, 1767323050000);
     INSERT INTO message (id, session_id, time_created, time_updated, data) VALUES
       ('user-2', 'session-2', 1767323100000, 1767323100000,
        '{"role":"user","time":{"created":1767323100000},"agent":"build","model":{"providerID":"openai","modelID":"gpt-5"}}'),
       ('assistant-2', 'session-2', 1767323101000, 1767323105000,
        '{"role":"assistant","time":{"created":1767323101000,"completed":1767323105000},"parentID":"user-2","providerID":"openai","modelID":"gpt-5","finish":"stop","cost":0.004,"tokens":{"input":120,"output":30,"reasoning":0,"cache":{"read":0,"write":0}}}');
     INSERT INTO part (id, message_id, session_id, time_created, time_updated, data) VALUES
       ('user-text-2', 'user-2', 'session-2', 1767323100000, 1767323100000,
        '{"type":"text","text":""}'),
       ('step-finish-2', 'assistant-2', 'session-2', 1767323105000, 1767323105000,
        '{"type":"step-finish","reason":"stop","cost":0.004,"tokens":{"input":120,"output":30,"reasoning":0,"cache":{"read":0,"write":0}}}');`,
  );
  fixture.options.env.OPENCODE_DB = openCodeDatabase;
  const script = scriptedPrompt({ ...defaultAnswers, provider: "openai" });

  await run(["node", "snack", "setup", "opencode"], { ...fixture.options, prompt: script.prompt });

  const provider = script.asked.find((question) => question.id === "provider");
  // Providers are discoverable from the source; the local account alias is not, because
  // OpenCode does not expose account identity and SNACK never reads credentials.
  assert.deepEqual(provider?.choices?.map((choice) => choice.value).sort(), [
    "anthropic",
    "openai",
  ]);
  assert.equal((await soleSource(fixture.paths.configFile)).provider, "openai");
});

test("an unsupported database is refused before a single question is asked", async () => {
  const fixture = await makeRunFixture("snack-setup-unsupported-");
  const openCodeDatabase = await createOpenCodeDatabase(fixture.root);
  executeOpenCodeSql(openCodeDatabase, "DROP TABLE part;");
  fixture.options.env.OPENCODE_DB = openCodeDatabase;
  const script = scriptedPrompt(defaultAnswers);

  const exitCode = await run(["node", "snack", "setup", "opencode", "--json"], {
    ...fixture.options,
    prompt: script.prompt,
  });

  // Failing closed on an unknown schema must happen before the user is walked through a
  // questionnaire that cannot lead anywhere.
  assert.equal(exitCode, 4);
  assert.deepEqual(script.asked, []);
});

test("declining the final confirmation changes nothing", async () => {
  const fixture = await makeRunFixture("snack-setup-declined-");
  fixture.options.env.OPENCODE_DB = await createOpenCodeDatabase(fixture.root);
  const script = scriptedPrompt({ ...defaultAnswers, confirm: "no" });

  const exitCode = await run(["node", "snack", "setup", "opencode"], {
    ...fixture.options,
    prompt: script.prompt,
  });

  assert.equal(exitCode, 0);
  await assert.rejects(readFile(fixture.paths.configFile, "utf8"));
});

test("re-running guided setup proposes the source it already configured", async () => {
  const fixture = await makeRunFixture("snack-setup-idempotent-");
  fixture.options.env.OPENCODE_DB = await createOpenCodeDatabase(fixture.root);
  await run(["node", "snack", "setup", "opencode"], {
    ...fixture.options,
    prompt: scriptedPrompt(defaultAnswers).prompt,
  });
  const first = await soleSource(fixture.paths.configFile);
  const script = scriptedPrompt(defaultAnswers);

  await run(["node", "snack", "setup", "opencode"], { ...fixture.options, prompt: script.prompt });
  const second = await soleSource(fixture.paths.configFile);

  // Setup is idempotent: re-running it shows current state rather than duplicating a source.
  assert.equal(script.asked.find((question) => question.id === "alias")?.default, "work");
  assert.equal(second.installation_id, first.installation_id);
});

test("a guided answer the configuration would refuse is refused at the question", async () => {
  const fixture = await makeRunFixture("snack-setup-reask-");
  fixture.options.env.OPENCODE_DB = await createOpenCodeDatabase(fixture.root);
  // A local account named the way people name accounts. The schema takes no spaces, and finding
  // that out at the end of the questionnaire costs every other answer.
  const script = scriptedPrompt({ ...defaultAnswers, profile: ["Claude Fortex", "fortex"] });

  const exitCode = await run(["node", "snack", "setup", "opencode"], {
    ...fixture.options,
    prompt: script.prompt,
  });

  assert.equal(exitCode, 0);
  assert.equal((await soleSource(fixture.paths.configFile)).profile, "fortex");
  assert.equal(script.asked.filter((question) => question.id === "profile").length, 2);
  // The refusal carries the rule, because that is the moment someone needs it.
  assert.match(fixture.stdout.value, /profile "Claude Fortex" is not usable; it must match/u);
  // The question does not. A rule on every question spends a line of regex on everyone who was
  // going to type something ordinary anyway.
  assert.doesNotMatch(
    /** @type {string} */ (script.asked.find((question) => question.id === "profile")?.message),
    /must match/u,
  );
});

test("--non-interactive refuses a malformed identifier before it writes anything", async () => {
  const fixture = await makeRunFixture("snack-setup-invalid-flags-");
  fixture.options.env.OPENCODE_DB = await createOpenCodeDatabase(fixture.root);

  const exitCode = await run(
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
      "Claude Fortex",
      "--plan",
      "pro",
      "--json",
    ],
    fixture.options,
  );
  const document = JSON.parse(fixture.stdout.value);

  assert.equal(exitCode, 2);
  assert.equal(document.errors[0].code, "setup_values_invalid");
  assert.match(document.errors[0].message, /profile "Claude Fortex"/u);
  assert.match(document.errors[0].message, /must match/u);
  await assert.rejects(() => readFile(fixture.paths.configFile, "utf8"));
});

test("--non-interactive still demands every value as a flag", async () => {
  const fixture = await makeRunFixture("snack-setup-flags-");
  fixture.options.env.OPENCODE_DB = await createOpenCodeDatabase(fixture.root);

  const exitCode = await run(
    ["node", "snack", "setup", "opencode", "--non-interactive", "--source", "work", "--json"],
    fixture.options,
  );

  assert.equal(exitCode, 2);
  assert.equal(JSON.parse(fixture.stdout.value).errors[0].code, "setup_values_required");
});

test("without a terminal, setup names the flags instead of hanging", async () => {
  const fixture = await makeRunFixture("snack-setup-no-tty-");
  fixture.options.env.OPENCODE_DB = await createOpenCodeDatabase(fixture.root);

  const exitCode = await run(["node", "snack", "setup", "opencode", "--json"], fixture.options);
  const document = JSON.parse(fixture.stdout.value);

  assert.equal(exitCode, 2);
  assert.equal(document.errors[0].code, "setup_requires_tty");
  assert.match(document.errors[0].message, /--non-interactive/u);
});

/** @param {string} configFile */
async function soleSource(configFile) {
  const config = JSON.parse(await readFile(configFile, "utf8"));
  assert.equal(config.sources.length, 1);
  return config.sources[0];
}

test("interrupting the questions cancels setup instead of reporting a crash", async () => {
  const fixture = await makeRunFixture("snack-setup-interrupted-");
  fixture.options.env.OPENCODE_DB = await createOpenCodeDatabase(fixture.root);

  const exitCode = await run(["node", "snack", "setup", "opencode"], {
    ...fixture.options,
    // What `node:readline` raises when the user presses Ctrl+D or stdin closes mid-question.
    prompt: async () => {
      const error = new Error("Aborted with Ctrl+D");
      error.name = "AbortError";
      throw error;
    },
  });

  assert.equal(exitCode, 0);
  assert.match(fixture.stdout.value, /cancelled/iu);
  await assert.rejects(readFile(fixture.paths.configFile, "utf8"));
});

test("one Claude history cannot be bound to two capacity sources", async () => {
  const fixture = await makeRunFixture("snack-claude-ambiguous-");
  fixture.options.env.CLAUDE_CONFIG_DIR = await createClaudeHistory(fixture.root);
  /** @param {string} alias */
  const setup = (alias) =>
    run(
      [
        "node",
        "snack",
        "setup",
        "claude",
        "--non-interactive",
        "--source",
        alias,
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

  assert.equal(await setup("work"), 0);

  // The same history behind two capacity sources would be read twice and counted twice, inventing
  // usage that never happened. OpenCode already refuses this; the rule belongs to the mapping, not
  // to one client.
  fixture.stdout.value = "";
  const exitCode = await setup("personal");
  assert.equal(exitCode, 3);
  assert.equal(JSON.parse(fixture.stdout.value).errors[0].code, "source_mapping_ambiguous");
});

/** @param {string} alias */
function codexFlags(alias) {
  return [
    "--non-interactive",
    "--source",
    alias,
    "--provider",
    "openai",
    "--profile",
    "default",
    "--plan",
    "plus",
  ];
}

test("setup codex configures a source and sync reads its rollouts", async () => {
  const fixture = await makeRunFixture("snack-setup-codex-");
  fixture.options.env.CODEX_HOME = await createCodexHistory(fixture.root, [
    "version-0-159-3.jsonl",
    "subagent-0-159-3.jsonl",
    "version-0-147-0.jsonl",
  ]);

  await run(["node", "snack", "setup", "codex", ...codexFlags("codex"), "--json"], fixture.options);
  const configured = JSON.parse(fixture.stdout.value);

  assert.equal(configured.status, "ok");
  assert.equal(configured.command, "setup codex");
  assert.equal(configured.data.source.adapter, "codex");
  assert.ok(
    ["cx-rollout-tokencount-v1", "cx-rollout-usagerecord-v1"].includes(
      configured.data.fingerprint.family,
    ),
  );
  assert.equal(configured.data.dry_run.observations, 3);
  assert.equal(configured.data.dry_run.applied, true);

  fixture.stdout.value = "";
  await run(["node", "snack", "sync", "--full", "--json"], fixture.options);
  const synced = JSON.parse(fixture.stdout.value);
  assert.equal(synced.status, "ok");
  assert.equal(synced.data.sources[0].inserted, 3);
  // Stated figures are counted inside storage and kept out of the frozen sync payload in 1.3.
  assert.ok(!("reported_capacity" in synced.data.sources[0]));

  const config = await readFile(fixture.paths.configFile, "utf8");
  assert.match(config, /"adapter": "codex"/u);
  assert.match(config, /"sessions": /u);
  assert.doesNotMatch(config, /"database"|"projects"/u);

  // A second sync with nothing new reads nothing new.
  fixture.stdout.value = "";
  await run(["node", "snack", "sync", "--json"], fixture.options);
  const again = JSON.parse(fixture.stdout.value);
  assert.equal(again.data.sources[0].inserted, 0);
});

test("setup codex fails closed when there is no sessions directory", async () => {
  const fixture = await makeRunFixture("snack-setup-codex-missing-");
  fixture.options.env.CODEX_HOME = join(fixture.root, "no-such-codex-home");

  const exitCode = await run(
    ["node", "snack", "setup", "codex", ...codexFlags("codex"), "--json"],
    fixture.options,
  );
  const document = JSON.parse(fixture.stdout.value);

  assert.equal(exitCode, 4);
  assert.equal(document.errors[0].code, "source_unavailable");
  assert.doesNotMatch(fixture.stdout.value, /no-such-codex-home/u);
  await assert.rejects(readFile(fixture.paths.configFile, "utf8"));
});

test("setup codex refuses a drifted history before it asks anything", async () => {
  const fixture = await makeRunFixture("snack-setup-codex-drift-");
  fixture.options.env.CODEX_HOME = await createCodexHistory(fixture.root, [
    "version-0-159-3.jsonl",
    "drifted-rate-limits.jsonl",
  ]);
  const { prompt, asked } = scriptedPrompt(defaultAnswers);
  fixture.options.prompt = prompt;

  const exitCode = await run(["node", "snack", "setup", "codex", "--json"], fixture.options);
  const document = JSON.parse(fixture.stdout.value);

  assert.equal(exitCode, 4);
  assert.equal(document.errors[0].code, "source_schema_unsupported");
  assert.match(document.errors[0].message, /Codex CLI history fingerprint is unsupported/u);
  assert.deepEqual(asked, []);
  await assert.rejects(readFile(fixture.paths.configFile, "utf8"));
});

test("guided setup codex offers the provider its rollouts name, and no plugin", async () => {
  const fixture = await makeRunFixture("snack-setup-codex-guided-");
  fixture.options.env.CODEX_HOME = await createCodexHistory(fixture.root);
  const { prompt, asked } = scriptedPrompt({ ...defaultAnswers, provider: "openai" });
  fixture.options.prompt = prompt;

  const exitCode = await run(["node", "snack", "setup", "codex"], fixture.options);

  assert.equal(exitCode, 0, fixture.stderr.value);
  const provider = asked.find((question) => question.id === "provider");
  assert.equal(provider?.default, "openai");
  assert.ok(!asked.some((question) => question.id === "install_plugin"));
  assert.match(fixture.stdout.value, /Configured Codex CLI source work\./u);
});

test("a dry run of setup codex changes nothing", async () => {
  const fixture = await makeRunFixture("snack-setup-codex-dry-");
  fixture.options.env.CODEX_HOME = await createCodexHistory(fixture.root);

  const exitCode = await run(
    ["node", "snack", "setup", "codex", ...codexFlags("codex"), "--dry-run"],
    fixture.options,
  );

  assert.equal(exitCode, 0);
  assert.match(fixture.stdout.value, /Validated Codex CLI source codex; no changes applied\./u);
  await assert.rejects(readFile(fixture.paths.configFile, "utf8"));
});
