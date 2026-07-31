import assert from "node:assert/strict";
import { appendFile, mkdir, mkdtemp, readFile, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, test } from "node:test";

import { createClaudeAdapter } from "../src/claude-adapter.js";

/** @type {string[]} */
const temporaryRoots = [];

afterEach(async () => {
  await Promise.all(
    temporaryRoots.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

test("recognizes the supported Claude Code JSONL fingerprint", async () => {
  const projectsDirectory = await createFixtureProjects("version-2-1-220.jsonl");
  const adapter = createClaudeAdapter({ projectsDirectory });

  assert.deepEqual(adapter.fingerprint(), {
    adapter: "claude-jsonl",
    fingerprint_version: 1,
    family: "cc-jsonl-turntree-v1",
    supported: true,
  });
});

test("refuses a Claude usage shape that lost a token field", async () => {
  const projectsDirectory = await createFixtureProjects("drifted-usage.jsonl");
  const adapter = createClaudeAdapter({ projectsDirectory });

  // Token counts are the whole observed-usage contribution of a Claude turn. Reading a history
  // whose usage shape moved would store plausible-looking numbers, so the family fails closed
  // rather than guessing which field replaced the missing one.
  assert.deepEqual(adapter.fingerprint(), {
    adapter: "claude-jsonl",
    fingerprint_version: 1,
    family: null,
    supported: false,
  });
});

test("an unrecognized Claude record type does not move the fingerprint", async () => {
  const projectsDirectory = await createFixtureProjects("unknown-record-type.jsonl");
  const adapter = createClaudeAdapter({ projectsDirectory });

  // Claude Code introduces record types on its own schedule, and none of them are the turn tree.
  // Failing closed on an unread record type would take SNACK down on a client release that changed
  // nothing SNACK reads, so the family is decided by the records it does read.
  assert.equal(adapter.fingerprint().supported, true);
});

test("detects the Claude Code client versions that wrote the history", async () => {
  const projectsDirectory = await createFixtureProjects("version-2-1-220.jsonl");
  const adapter = createClaudeAdapter({ projectsDirectory });

  assert.deepEqual(adapter.detect(), {
    detected: true,
    client: "claude",
    versions: ["2.1.220"],
  });
});

test("reports Claude source health for readable, drifted, and absent histories", async () => {
  const readable = await createFixtureProjects("version-2-1-220.jsonl");
  assert.deepEqual(createClaudeAdapter({ projectsDirectory: readable }).health(), {
    status: "compatible",
    accessible: true,
    fingerprint: { family: "cc-jsonl-turntree-v1", supported: true },
  });

  const drifted = await createFixtureProjects("drifted-usage.jsonl");
  assert.deepEqual(createClaudeAdapter({ projectsDirectory: drifted }).health(), {
    status: "incompatible",
    accessible: true,
    fingerprint: { family: null, supported: false },
  });

  // No Claude Code installation at all is the first-run case, and it is a fact about the source
  // rather than a SNACK failure.
  const absent = await createFixtureProjects("version-2-1-220.jsonl");
  assert.deepEqual(
    createClaudeAdapter({ projectsDirectory: join(absent, "no-such-directory") }).health(),
    {
      status: "inaccessible",
      accessible: false,
      fingerprint: { family: null, supported: false },
    },
  );
});

test("reads one prompt from a one-turn Claude session", async () => {
  const projectsDirectory = await createFixtureProjects("version-2-1-220.jsonl");
  const adapter = createClaudeAdapter({ projectsDirectory });

  const { observations } = adapter.readAll();

  assert.ok(observations[0]);
  assert.equal(observations.length, 1);
  // Session identity leaves the adapter raw and is hashed once on the way into storage, the same
  // way OpenCode session identity is. Hashing here as well would only make the two adapters
  // disagree about what a source identity is.
  assert.equal(observations[0].source_prompt_id, "p-0001");
  assert.equal(observations[0].source_session_id, "aaaaaaaa-0000-4000-8000-000000000001");
});

test("a turn that called tools is one prompt with a usage slice per model call", async () => {
  const projectsDirectory = await createFixtureProjects("version-2-1-220.jsonl");
  const adapter = createClaudeAdapter({ projectsDirectory });

  const [observation] = adapter.readAll().observations;
  assert.ok(observation);

  // The fixture turn is one submission that produced two model calls: a tool use and the answer
  // after it. Both consumed capacity, so both are slices of the same prompt rather than two
  // prompts.
  assert.deepEqual(observation.usage_slices, [
    {
      source_slice_id: "22222222-2222-4222-8222-222222222222",
      provider: "anthropic",
      model: "claude-opus-5",
      input_tokens: 12,
      output_tokens: 34,
      reasoning_tokens: null,
      cache_read_tokens: 900,
      cache_write_tokens: 100,
      cost_decimal: null,
      currency: null,
    },
    {
      source_slice_id: "44444444-4444-4444-8444-444444444444",
      provider: "anthropic",
      model: "claude-opus-5",
      input_tokens: 8,
      output_tokens: 56,
      reasoning_tokens: null,
      cache_read_tokens: 1000,
      cache_write_tokens: 0,
      cost_decimal: null,
      currency: null,
    },
  ]);
});

test("a subagent contributes usage to the prompt that started it and opens no prompt", async () => {
  const projectsDirectory = await createFixtureProjects("subagent-parent.jsonl", {
    subagents: { f1f1f1f1f1f1f1f1: "subagent-child.jsonl" },
  });
  const adapter = createClaudeAdapter({ projectsDirectory });

  const { observations } = adapter.readAll();

  // Claude Code writes a subagent's turns to a file of their own and records no token count for
  // them in the session that spawned it, so a reader that stops at the session file drops real
  // consumption on the floor. The subagent is not a submission, so it is not a prompt either.
  assert.ok(observations[0]);
  assert.equal(observations.length, 1);
  assert.deepEqual(
    observations[0].usage_slices.map((slice) => [slice.model, slice.output_tokens]),
    [
      ["claude-opus-5", 34],
      ["claude-opus-5", 56],
      ["claude-haiku-4-5-20251001", 70],
    ],
  );
});

test("a turn that reached its answer is a completed, successful prompt", async () => {
  const projectsDirectory = await createFixtureProjects("version-2-1-220.jsonl");
  const adapter = createClaudeAdapter({ projectsDirectory });

  const [observation] = adapter.readAll().observations;
  assert.ok(observation);

  assert.deepEqual(
    { ...observation, usage_slices: undefined, restrictions: undefined, revision: undefined },
    {
      source_prompt_id: "p-0001",
      source_session_id: "aaaaaaaa-0000-4000-8000-000000000001",
      revision: undefined,
      revision_domain: "claude-uuid-v1",
      parser_version: "claude-session-v1",
      started_at: "2026-07-30T10:00:00.000Z",
      completed_at: "2026-07-30T10:00:07.000Z",
      duration_ms: 7000,
      completion: "completed",
      provider: "anthropic",
      model: "claude-opus-5",
      outcome: "success",
      usage_slices: undefined,
      restrictions: undefined,
    },
  );
});

test("a refused Claude turn is an observed restriction", async () => {
  const projectsDirectory = await createFixtureProjects("restricted-turn.jsonl");
  const adapter = createClaudeAdapter({ projectsDirectory });

  const [observation] = adapter.readAll().observations;
  assert.ok(observation);

  assert.equal(observation.outcome, "restricted");
  // The refusal is classified from the structured error Claude Code records beside the message,
  // never from the sentence it shows the user. That sentence is the only place the moment capacity
  // returns appears, and reading it is a privacy boundary SNACK does not cross.
  assert.deepEqual(observation.restrictions, [
    {
      class: "rate_limit",
      source_code: "http_429",
      observed_at: "2026-07-30T10:00:04.000Z",
      classifier_version: "claude-error-v1",
      provenance: "backfill",
    },
  ]);
});

test("a Claude turn that failed operationally is excluded, not restricted", async () => {
  const projectsDirectory = await createFixtureProjects("operational-failure.jsonl");
  const adapter = createClaudeAdapter({ projectsDirectory });

  const [observation] = adapter.readAll().observations;
  assert.ok(observation);

  // A server failure says nothing about what the provider still allows. Counting it as a refusal
  // would teach the forecast that capacity ran out every time Anthropic had a bad minute.
  assert.equal(observation.outcome, "excluded");
  assert.deepEqual(observation.restrictions, []);
  assert.deepEqual(observation.exclusion, {
    class: "operational_error",
    source_code: "server_error",
    classifier_version: "claude-error-v1",
  });
});

test("a turn still being written revises upward instead of duplicating", async () => {
  const open = createClaudeAdapter({
    projectsDirectory: await createFixtureProjects("open-turn.jsonl"),
  });
  const finished = createClaudeAdapter({
    projectsDirectory: await createFixtureProjects("version-2-1-220.jsonl"),
  });

  const [provisional] = open.readAll().observations;
  const [terminal] = finished.readAll().observations;
  assert.ok(provisional);
  assert.ok(terminal);

  assert.equal(provisional.completion, "provisional");
  assert.equal(terminal.completion, "completed");
  // Both readings are the same prompt of the same session, so storage has to recognize the second
  // as a later revision of the first rather than as a second prompt. Storage orders revisions by
  // the numeric prefix, so the revision has to carry one.
  assert.equal(provisional.source_prompt_id, terminal.source_prompt_id);
  assert.match(provisional.revision, /^\d+:/u);
  assert.equal(
    Number(terminal.revision.split(":")[0]) > Number(provisional.revision.split(":")[0]),
    true,
  );
  // Reading an unchanged history twice must produce an identical revision, or every sync would
  // rewrite history that did not move.
  const reread = open.readAll().observations[0];
  assert.ok(reread);
  assert.equal(reread.revision, provisional.revision);
});

test("an incremental Claude read skips sessions that did not move", async () => {
  const projectsDirectory = await createFixtureProjects("version-2-1-220.jsonl");
  const adapter = createClaudeAdapter({ projectsDirectory });

  const full = adapter.readAll();
  assert.equal(adapter.readSince(null).observations.length, full.observations.length);
  assert.equal(adapter.readSince(full.cursor).observations.length, 0);

  const sessionFile = join(
    projectsDirectory,
    "-fixture-project",
    "aaaaaaaa-0000-4000-8000-000000000001.jsonl",
  );
  const later = new Date(Date.now() + 60_000);
  await utimes(sessionFile, later, later);

  assert.deepEqual(adapter.readSince(full.cursor).observations, full.observations);

  // The cursor is written to SNACK's database, and Claude Code names its directories after the
  // working directory a session ran in. Keeping those names would put project paths in storage
  // through the back door.
  assert.doesNotMatch(JSON.stringify(adapter.readAll().cursor), /fixture-project/u);
});

test("a half-written trailing record does not cost the session its history", async () => {
  const projectsDirectory = await createFixtureProjects("version-2-1-220.jsonl");
  const sessionFile = join(
    projectsDirectory,
    "-fixture-project",
    "aaaaaaaa-0000-4000-8000-000000000001.jsonl",
  );
  // Reading a session Claude Code is writing right now catches the last record mid-line. That is a
  // session in progress, not a damaged history, so it costs that record and nothing else.
  await appendFile(sessionFile, '{"parentUuid":"44444444-4444-4444-8444-4444444');

  const adapter = createClaudeAdapter({ projectsDirectory });

  assert.equal(adapter.readAll().observations.length, 1);
  assert.equal(adapter.fingerprint().supported, true);
});

test("nothing a Claude history says about the user leaves the adapter", async () => {
  const canaries = JSON.parse(
    await readFile(new URL("./fixtures/privacy-canaries.json", import.meta.url), "utf8"),
  );
  // Claude Code histories are far richer than the OpenCode source: beside prompt and response text
  // they carry the working directory, the git branch, a generated session title, subagent names,
  // and whole tool results. Each is planted here in the field Claude Code actually uses for it.
  const root = "11111111-1111-4111-8111-111111111111";
  const session = [
    {
      parentUuid: null,
      isSidechain: false,
      promptId: "p-0001",
      promptSource: "typed",
      type: "user",
      message: { role: "user", content: [{ type: "text", text: canaries.prompt }] },
      uuid: root,
      timestamp: "2026-07-30T10:00:00.000Z",
      cwd: canaries.path,
      sessionId: "aaaaaaaa-0000-4000-8000-000000000001",
      version: "2.1.220",
      gitBranch: canaries.branch,
    },
    {
      type: "ai-title",
      aiTitle: canaries.title,
      sessionId: "aaaaaaaa-0000-4000-8000-000000000001",
    },
    {
      type: "agent-name",
      agentName: canaries.agent,
      sessionId: "aaaaaaaa-0000-4000-8000-000000000001",
    },
    {
      parentUuid: root,
      isSidechain: false,
      promptId: "p-0001",
      type: "user",
      message: {
        role: "user",
        content: [
          { type: "tool_result", content: `${canaries.toolResult} ${canaries.credential}` },
        ],
      },
      toolUseResult: {
        agentId: "f1f1f1f1f1f1f1f1",
        prompt: canaries.toolResult,
        filePath: canaries.path,
        stdout: canaries.credential,
      },
      uuid: "22222222-2222-4222-8222-222222222222",
      timestamp: "2026-07-30T10:00:01.000Z",
      cwd: canaries.path,
      sessionId: "aaaaaaaa-0000-4000-8000-000000000001",
      version: "2.1.220",
      gitBranch: canaries.branch,
    },
    {
      parentUuid: "22222222-2222-4222-8222-222222222222",
      isSidechain: false,
      type: "assistant",
      message: {
        id: "msg_0001",
        model: "claude-opus-5",
        role: "assistant",
        stop_reason: "end_turn",
        type: "message",
        content: [{ type: "text", text: canaries.response }],
        usage: {
          input_tokens: 1,
          output_tokens: 2,
          cache_creation_input_tokens: 3,
          cache_read_input_tokens: 4,
        },
      },
      uuid: "33333333-3333-4333-8333-333333333333",
      timestamp: "2026-07-30T10:00:05.000Z",
      cwd: canaries.path,
      sessionId: "aaaaaaaa-0000-4000-8000-000000000001",
      version: "2.1.220",
      gitBranch: canaries.branch,
    },
  ];

  const temporaryRoot = await mkdtemp(join(tmpdir(), "snack-claude-canary-"));
  temporaryRoots.push(temporaryRoot);
  const projectsDirectory = join(temporaryRoot, "projects");
  const project = join(projectsDirectory, canaries.path.replaceAll("/", "-"));
  await mkdir(project, { recursive: true });
  const sessionFile = join(project, "aaaaaaaa-0000-4000-8000-000000000001.jsonl");
  await writeFile(sessionFile, `${session.map((record) => JSON.stringify(record)).join("\n")}\n`, {
    mode: 0o600,
  });

  // Guard against a vacuous pass: every canary has to really be in the history being read, or the
  // assertions below hold for the wrong reason.
  const planted = await readFile(sessionFile, "latin1");
  for (const [name, canary] of Object.entries(canaries)) {
    assert.match(planted, new RegExp(String(canary), "u"), `${name} was never planted`);
  }

  const adapter = createClaudeAdapter({ projectsDirectory });
  const emitted = JSON.stringify({
    read: adapter.readAll(),
    detected: adapter.detect(),
    health: adapter.health(),
  });

  // Guard against a vacuous pass: the adapter really did read this history.
  assert.equal(adapter.readAll().observations.length, 1);
  for (const [name, canary] of Object.entries(canaries)) {
    assert.doesNotMatch(emitted, new RegExp(String(canary), "u"), `${name} left the adapter`);
  }
});

test("a resumed session whose submission record is elsewhere still reports its restriction", async () => {
  const projectsDirectory = await createFixtureProjects("resumed-session.jsonl");
  const adapter = createClaudeAdapter({ projectsDirectory });

  const [observation] = adapter.readAll().observations;
  assert.ok(observation);

  // Resuming a session gives the continued turn a root that is not a submission record at all, so
  // a reader that only walks down from submissions loses the whole turn. Losing a turn loses its
  // refusal, and a forecast that never sees refusals reads as though capacity were never reached.
  assert.equal(adapter.readAll().observations.length, 1);
  assert.equal(observation.outcome, "restricted");
  assert.equal(observation.restrictions.length, 1);
  assert.equal(observation.usage_slices.length, 2);
  // The turn is real and its identity has to be stable across syncs even though Claude Code never
  // wrote a prompt identifier for it.
  assert.equal(observation.source_prompt_id, "aaaa1111-1111-4111-8111-111111111111");
});

test("a subagent that never reported back still reports what it consumed", async () => {
  // The session spawns one agent and records its result; a second agent transcript sits beside it
  // that the session never links, which is what an agent interrupted before it reported back
  // leaves behind. Its tokens were spent and its refusal happened either way, and refusals are the
  // scarcest evidence SNACK has — losing one silently is worse than losing a successful turn.
  const projectsDirectory = await createFixtureProjects("subagent-parent.jsonl", {
    subagents: {
      f1f1f1f1f1f1f1f1: "subagent-child.jsonl",
      f2f2f2f2f2f2f2f2: "restricted-turn.jsonl",
    },
  });
  const adapter = createClaudeAdapter({ projectsDirectory });

  const { observations } = adapter.readAll();

  assert.equal(observations.length, 2);
  const restricted = observations.filter((observation) => observation.outcome === "restricted");
  assert.equal(restricted.length, 1);
  // The linked agent stays part of the prompt that started it and is not counted a second time.
  const linked = observations.find((observation) => observation.source_prompt_id === "p-0001");
  assert.ok(linked);
  assert.equal(linked.usage_slices.length, 3);
});

/**
 * Build a throwaway Claude projects directory from a JSONL fixture.
 *
 * Claude Code names each project directory after the slugified working directory it was launched
 * in, so the fixture tree carries a path-shaped name on purpose: every read has to survive it
 * without letting it reach storage. Subagent transcripts live one level down, in a `subagents`
 * directory named after the session that spawned them.
 *
 * @param {string} fixtureName
 * @param {{project?: string, session?: string, subagents?: Record<string, string>}} [placement]
 */
async function createFixtureProjects(fixtureName, placement = {}) {
  const root = await mkdtemp(join(tmpdir(), "snack-claude-adapter-"));
  temporaryRoots.push(root);
  const projectsDirectory = join(root, "projects");
  const project = join(projectsDirectory, placement.project ?? "-fixture-project");
  await mkdir(project, { recursive: true });
  const session = placement.session ?? "aaaaaaaa-0000-4000-8000-000000000001";
  await writeFile(join(project, `${session}.jsonl`), await readFixture(fixtureName), {
    mode: 0o600,
  });
  const subagents = Object.entries(placement.subagents ?? {});
  if (subagents.length > 0) {
    const directory = join(project, session, "subagents");
    await mkdir(directory, { recursive: true });
    for (const [agentId, agentFixture] of subagents) {
      await writeFile(join(directory, `agent-${agentId}.jsonl`), await readFixture(agentFixture), {
        mode: 0o600,
      });
    }
  }
  return projectsDirectory;
}

/** @param {string} fixtureName */
function readFixture(fixtureName) {
  return readFile(new URL(`./fixtures/claude/${fixtureName}`, import.meta.url), "utf8");
}
