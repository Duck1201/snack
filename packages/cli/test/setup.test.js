import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, test } from "node:test";

import { run } from "../src/main.js";
import {
  cleanupRunFixtures,
  createClaudeHistory,
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
 * @param {Record<string, string>} answers
 */
function scriptedPrompt(answers) {
  /** @type {{id: string, message: string, choices?: {value: string, label: string}[], default?: string}[]} */
  const asked = [];
  /** @param {{id: string, message: string, choices?: {value: string, label: string}[], default?: string}} question */
  const prompt = async (question) => {
    asked.push(question);
    if (!(question.id in answers)) {
      throw new Error(`the guided setup asked an unscripted question: ${question.id}`);
    }
    return /** @type {string} */ (answers[question.id]);
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
    `INSERT INTO session (id, version) VALUES ('session-2', '1.18.9');
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
