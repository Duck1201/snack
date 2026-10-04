import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import process from "node:process";
import { afterEach, test } from "node:test";

import { SnackOpenCodePlugin } from "../src/plugin.js";

/**
 * The same canaries the CLI feeds through its own capture paths.
 *
 * Duplicated into this package rather than imported across the boundary, for the reason the spool
 * schema is duplicated: these two packages version and publish independently, and neither may
 * reach into the other's tests. Duplicated on purpose still has to mean identical, or the two
 * packages come to disagree about what a leak is -- which is exactly the disagreement nobody would
 * notice. `contracts.test.js` asserts the two files are byte-identical.
 */
const privacyCanaries = JSON.parse(
  await readFile(new URL("./privacy-canaries.json", import.meta.url), "utf8"),
);

/** @type {string[]} */
const temporaryRoots = [];

afterEach(async () => {
  await Promise.all(
    temporaryRoots.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

test("captures an explicit live restriction without retaining prompt or error text", async () => {
  const root = await mkdtemp(join(tmpdir(), "snack-opencode-plugin-"));
  temporaryRoots.push(root);
  const spoolDirectory = join(root, "spool");
  const hooks = await SnackOpenCodePlugin(
    {},
    { installation_id: "installation-1", spool_directory: spoolDirectory },
  );

  await hooks["chat.message"](
    {
      sessionID: "session-1",
      messageID: "prompt-1",
      model: { providerID: "anthropic", modelID: "claude-sonnet" },
    },
    { message: { text: String(privacyCanaries.prompt) }, parts: [] },
  );
  await hooks.event({
    event: {
      type: "session.error",
      properties: {
        sessionID: "session-1",
        error: {
          name: "APIError",
          data: { statusCode: 429, message: String(privacyCanaries.response) },
        },
        time: "2026-01-02T03:04:10.000Z",
      },
    },
  });

  await hooks.dispose();

  const content = await readFile(join(spoolDirectory, "_pending", "current.open"), "utf8");
  const events = content
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));

  assert.deepEqual(events[1], {
    schema_version: 1,
    event_id: "session.error:session-1:prompt-1:2026-01-02T03:04:10.000Z",
    installation_id: "installation-1",
    event_type: "session_error",
    source_prompt_id: "prompt-1",
    source_session_id: "session-1",
    revision: "2026-01-02T03:04:10.000Z:session.error",
    revision_domain: "opencode-plugin-v1",
    parser_version: "opencode-plugin-v1",
    occurred_at: "2026-01-02T03:04:10.000Z",
    provider: "anthropic",
    model: "claude-sonnet",
    completion: "completed",
    outcome: "restricted",
    usage_slices: [],
    restrictions: [
      {
        class: "rate_limit",
        source_code: "http_429",
        observed_at: "2026-01-02T03:04:10.000Z",
        classifier_version: "opencode-plugin-error-v1",
      },
    ],
  });
  for (const canary of Object.values(privacyCanaries)) {
    assert.doesNotMatch(content, new RegExp(String(canary), "u"));
  }
});

test("spool failures do not escape an OpenCode hook", async () => {
  const root = await mkdtemp(join(tmpdir(), "snack-opencode-plugin-"));
  temporaryRoots.push(root);
  const blockedSpoolPath = join(root, "not-a-directory");
  await writeFile(blockedSpoolPath, "blocked");
  const hooks = await SnackOpenCodePlugin(
    {},
    { installation_id: "installation-1", spool_directory: blockedSpoolPath },
  );

  /** @type {string[]} */
  const warnings = [];
  const originalWarn = globalThis.console.warn;
  globalThis.console.warn = (message) => warnings.push(String(message));
  try {
    await assert.doesNotReject(
      hooks["chat.message"](
        { sessionID: "session-1", messageID: "prompt-1" },
        { message: { text: String(privacyCanaries.prompt) }, parts: [] },
      ),
    );
    await assert.doesNotReject(
      hooks.event({
        event: { type: "session.idle", properties: { sessionID: "session-1" } },
      }),
    );
    await hooks.dispose();
  } finally {
    globalThis.console.warn = originalWarn;
  }
  assert.deepEqual(warnings, ["SNACK live metadata capture is temporarily unavailable."]);
});

test("an identifier the host makes longer than the schema allows is never written", async () => {
  // OpenCode bounds neither its session ids nor its message ids, and the published schema bounds
  // both at 200. Writing the event anyway would put a line in the spool that `spool.js` validates
  // against that same schema and rejects -- which reads as a corrupt segment rather than as a
  // prompt this plugin could not represent. Refusing here is what keeps the two readings apart.
  const root = await mkdtemp(join(tmpdir(), "snack-opencode-plugin-"));
  temporaryRoots.push(root);
  const spoolDirectory = join(root, "spool");
  const hooks = await SnackOpenCodePlugin(
    {},
    { installation_id: "installation-1", spool_directory: spoolDirectory },
  );

  /** @type {string[]} */
  const warnings = [];
  const originalWarn = globalThis.console.warn;
  globalThis.console.warn = (message) => warnings.push(String(message));
  try {
    await hooks["chat.message"](
      {
        sessionID: "s".repeat(201),
        messageID: "prompt-1",
        model: { providerID: "anthropic", modelID: "claude-sonnet" },
      },
      { message: { text: "" }, parts: [] },
    );
    await hooks.dispose();
  } finally {
    globalThis.console.warn = originalWarn;
  }

  assert.deepEqual(warnings, ["SNACK live metadata capture is temporarily unavailable."]);
  await assert.rejects(readFile(join(spoolDirectory, "_pending", "current.open"), "utf8"), {
    code: "ENOENT",
  });
});

test("uses the official output message id when chat.message input omits it", async () => {
  const root = await mkdtemp(join(tmpdir(), "snack-opencode-plugin-"));
  temporaryRoots.push(root);
  const spoolDirectory = join(root, "spool");
  const hooks = await SnackOpenCodePlugin(
    {},
    { installation_id: "installation-1", spool_directory: spoolDirectory },
  );

  await hooks["chat.message"](
    { sessionID: "session-1", model: { providerID: "anthropic", modelID: "claude-sonnet" } },
    { message: { id: "prompt-from-output" }, parts: [] },
  );

  await hooks.dispose();

  const content = await readFile(join(spoolDirectory, "_pending", "current.open"), "utf8");
  assert.match(content, /"source_prompt_id":"prompt-from-output"/u);
});

test("derives only allowlisted features from the official parts payload", async () => {
  const root = await mkdtemp(join(tmpdir(), "snack-opencode-plugin-"));
  temporaryRoots.push(root);
  const spoolDirectory = join(root, "spool");
  const hooks = await SnackOpenCodePlugin(
    {},
    {
      installation_id: "installation-1",
      spool_directory: spoolDirectory,
      prospective_analysis: true,
    },
  );

  await hooks["chat.message"](
    { sessionID: "session-1" },
    {
      message: { id: "prompt-1" },
      parts: [
        {
          type: "text",
          text: `${privacyCanaries.prompt}\n\u0060\u0060\u0060js\ncode\n\u0060\u0060\u0060`,
        },
        { type: "file", url: "file:///private/path" },
      ],
    },
  );

  await hooks.dispose();

  const content = await readFile(join(spoolDirectory, "_pending", "current.open"), "utf8");
  const event = JSON.parse(content);
  assert.deepEqual(event.input_features, {
    analyzer_version: "opencode-input-v1",
    estimated_input_tokens: 0,
    line_count_bucket: "1-10",
    code_block_count_bucket: "1",
    attachment_count: 1,
  });
  for (const canary of Object.values(privacyCanaries)) {
    assert.doesNotMatch(content, new RegExp(String(canary), "u"));
  }
  assert.doesNotMatch(content, /private\/path/u);
});

test("a host that omits the model on chat.message still routes to the bound source", async () => {
  // OpenCode declares `model` optional on `chat.message` and does not send it on 1.18.10, so the
  // provider was null, every live event went to `_pending`, and `sync` could never attribute one.
  // `chat.params` carries the provider on the same turn and is not optional; the routing decision
  // waits for it rather than being taken without it.
  const root = await mkdtemp(join(tmpdir(), "snack-opencode-plugin-"));
  temporaryRoots.push(root);
  const spoolDirectory = join(root, "spool");
  const bound = join(spoolDirectory, "oc-main");
  const hooks = await SnackOpenCodePlugin(
    {},
    {
      installation_id: "installation-1",
      spool_directory: spoolDirectory,
      source_bindings: [{ provider: "anthropic", source_alias: "oc-main", spool_directory: bound }],
    },
  );

  await hooks["chat.message"]({ sessionID: "session-1", messageID: "prompt-1" }, { parts: [] });
  await hooks["chat.params"]({
    sessionID: "session-1",
    model: { providerID: "anthropic", modelID: "claude-sonnet" },
  });
  await hooks.event({
    event: {
      type: "session.idle",
      properties: { sessionID: "session-1", time: "2026-01-02T03:04:10.000Z" },
    },
  });

  await hooks.dispose();

  const events = (await readFile(join(bound, "current.open"), "utf8"))
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));

  assert.equal(events.length, 2);
  assert.equal(events[0].event_type, "prompt_started");
  assert.equal(events[1].event_type, "session_idle");
  for (const event of events) {
    assert.equal(event.provider, "anthropic");
    assert.equal(event.model, "claude-sonnet");
  }
});

/**
 * A plugin rooted in a fresh temporary spool, with two providers bound to two sources.
 *
 * @param {Record<string, unknown>} [extra]
 */
async function boundPlugin(extra = {}) {
  const root = await mkdtemp(join(tmpdir(), "snack-opencode-plugin-"));
  temporaryRoots.push(root);
  const spoolDirectory = join(root, "spool");
  const directories = {
    fake: join(spoolDirectory, "oc-fake"),
    other: join(spoolDirectory, "oc-other"),
    pending: join(spoolDirectory, "_pending"),
  };
  const hooks = await SnackOpenCodePlugin(
    {},
    {
      installation_id: "installation-1",
      spool_directory: spoolDirectory,
      source_bindings: [
        { provider: "fake", source_alias: "oc-fake", spool_directory: directories.fake },
        { provider: "other", source_alias: "oc-other", spool_directory: directories.other },
      ],
      ...extra,
    },
  );
  return { hooks, directories };
}

/** @param {string} directory @returns {Promise<Record<string, unknown>[]>} */
async function readEvents(directory) {
  try {
    return (await readFile(join(directory, "current.open"), "utf8"))
      .trim()
      .split("\n")
      .filter((line) => line !== "")
      .map((line) => JSON.parse(line));
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return [];
    throw error;
  }
}

/**
 * What OpenCode 1.18.15 hands `chat.message` for a prompt sent without an explicit model: the
 * input carries `agent` and `model` keys whose values are undefined, and the user message on the
 * output names both. Recorded from the real host (`opencode serve`).
 *
 * @param {string} promptId
 * @param {{model?: boolean}} [options]
 * @returns {[Record<string, unknown>, Record<string, unknown>]}
 */
function recordedChatMessage(promptId, options = {}) {
  return [
    {
      sessionID: "ses-1",
      agent: undefined,
      model: undefined,
      messageID: undefined,
      variant: undefined,
    },
    {
      message: {
        id: promptId,
        role: "user",
        sessionID: "ses-1",
        agent: "build",
        ...(options.model === false ? {} : { model: { providerID: "fake", modelID: "big" } }),
      },
      parts: [{ type: "text", text: String(privacyCanaries.prompt) }],
    },
  ];
}

/**
 * `chat.params` as OpenCode 1.18.15 sends it: `model` is the provider's model record, whose name
 * is `id`, not `modelID`; `message` is the user message the call answers.
 *
 * @param {string} agent @param {string} providerID @param {string} id @param {string} promptId
 */
function recordedChatParams(agent, providerID, id, promptId) {
  return {
    sessionID: "ses-1",
    agent,
    model: { id, providerID, name: id, api: {}, options: {} },
    provider: {},
    message: { id: promptId, role: "user", agent: "build" },
  };
}

/** @param {string} type @param {Record<string, unknown>} [properties] */
function hostEvent(type, properties = {}) {
  return { event: { type, properties: { sessionID: "ses-1", ...properties } } };
}

test("the first prompt of a session is not routed to the title model's provider", async () => {
  // OpenCode 1.18.15 generates the session title with `small_model` on the first prompt, and its
  // `chat.params` (agent `title`) arrives before the `build` one. Routing on the first
  // `chat.params` filed every session's first prompt under the title model's provider.
  const { hooks, directories } = await boundPlugin();
  await hooks["chat.message"](...recordedChatMessage("msg-1", { model: false }));
  await hooks["chat.params"](recordedChatParams("title", "other", "small", "msg-1"));
  await hooks["chat.params"](recordedChatParams("build", "fake", "big", "msg-1"));
  await hooks.event(hostEvent("session.status", { status: { type: "busy" } }));
  await hooks.event(hostEvent("session.status", { status: { type: "idle" } }));
  await hooks.event(hostEvent("session.idle"));
  await hooks.dispose();

  assert.deepEqual(await readEvents(directories.other), []);
  assert.deepEqual(
    (await readEvents(directories.fake)).map((event) => [
      event.event_type,
      event.provider,
      event.model,
      event.outcome,
    ]),
    [
      ["prompt_started", "fake", "big", "excluded"],
      ["session_idle", "fake", "big", "success"],
    ],
  );
});

test("the recorded 1.18.15 sequence routes from the user message chat.message carries", async () => {
  const { hooks, directories } = await boundPlugin();
  await hooks["chat.message"](...recordedChatMessage("msg-1"));
  await hooks["chat.params"](recordedChatParams("title", "other", "small", "msg-1"));
  await hooks["chat.params"](recordedChatParams("build", "fake", "big", "msg-1"));
  await hooks.event(hostEvent("session.idle"));
  await hooks.dispose();

  assert.deepEqual(await readEvents(directories.other), []);
  assert.deepEqual(
    (await readEvents(directories.fake)).map((event) => [event.provider, event.model]),
    [
      ["fake", "big"],
      ["fake", "big"],
    ],
  );
});

test("compaction, summary and another prompt's chat.params never route a prompt", async () => {
  const { hooks, directories } = await boundPlugin();
  await hooks["chat.message"](...recordedChatMessage("msg-1", { model: false }));
  await hooks["chat.params"](recordedChatParams("compaction", "other", "big", "msg-1"));
  await hooks["chat.params"](recordedChatParams("summary", "other", "big", "msg-1"));
  await hooks["chat.params"](recordedChatParams("build", "other", "big", "msg-0"));
  await hooks["chat.params"](recordedChatParams("plan", "other", "big", "msg-1"));
  await hooks["chat.params"](recordedChatParams("build", "fake", "big", "msg-1"));
  await hooks.event(hostEvent("session.idle"));
  await hooks.dispose();

  assert.deepEqual(await readEvents(directories.other), []);
  assert.equal((await readEvents(directories.fake)).length, 2);
});

test("a cancelled prompt is recorded as excluded, never as a success", async () => {
  // Recorded from 1.18.15: an abort mid-stream emits `session.error` (MessageAbortedError) and
  // then `session.idle` twice. Each idle used to append a `success` that outranked the error.
  const { hooks, directories } = await boundPlugin();
  await hooks["chat.message"](...recordedChatMessage("msg-1"));
  await hooks.event(
    hostEvent("session.error", {
      error: { name: "MessageAbortedError", data: { message: String(privacyCanaries.response) } },
    }),
  );
  await hooks.event(hostEvent("session.status", { status: { type: "idle" } }));
  await hooks.event(hostEvent("session.idle"));
  await hooks.event(hostEvent("session.idle"));
  await hooks.dispose();

  const events = await readEvents(directories.fake);
  assert.deepEqual(
    events.map((event) => [event.event_type, event.completion, event.outcome]),
    [
      ["prompt_started", "provisional", "excluded"],
      ["session_error", "completed", "excluded"],
    ],
  );
  const content = JSON.stringify(events);
  for (const canary of Object.values(privacyCanaries)) {
    assert.doesNotMatch(content, new RegExp(String(canary), "u"));
  }
});

test("a turn OpenCode retried claims no terminal outcome and leaves it to backfill", async () => {
  // 1.18.15 retries a 429 itself and reports it only as `session.status {type: "retry"}`, whose
  // one descriptive field is free text. A retried turn ends in `session.idle` whether it then
  // succeeded or was aborted, so that idle is not evidence of success; and the retry carries no
  // structured status code, so it is not evidence of a restriction either.
  for (const ending of ["succeeded", "aborted"]) {
    const { hooks, directories } = await boundPlugin();
    await hooks["chat.message"](...recordedChatMessage("msg-1"));
    await hooks.event(
      hostEvent("session.status", {
        status: {
          type: "retry",
          attempt: 1,
          message: String(privacyCanaries.response),
          next: 1_791_085_448_666,
        },
      }),
    );
    await hooks.event(hostEvent("session.status", { status: { type: "busy" } }));
    if (ending === "succeeded") {
      await hooks.event(hostEvent("session.status", { status: { type: "idle" } }));
    }
    await hooks.event(hostEvent("session.idle"));
    await hooks.dispose();

    const events = await readEvents(directories.fake);
    assert.deepEqual(
      events.map((event) => event.event_type),
      ["prompt_started"],
      ending,
    );
    const content = JSON.stringify(events);
    for (const canary of Object.values(privacyCanaries)) {
      assert.doesNotMatch(content, new RegExp(String(canary), "u"));
    }
  }
});

test("a retry in one turn does not withhold the next turn's success", async () => {
  const { hooks, directories } = await boundPlugin();
  await hooks["chat.message"](...recordedChatMessage("msg-1"));
  await hooks.event(hostEvent("session.status", { status: { type: "retry", attempt: 1 } }));
  await hooks.event(hostEvent("session.idle"));
  await hooks["chat.message"](...recordedChatMessage("msg-2"));
  await hooks.event(hostEvent("session.idle"));
  await hooks.dispose();

  assert.deepEqual(
    (await readEvents(directories.fake)).map((event) => [event.event_type, event.source_prompt_id]),
    [
      ["prompt_started", "msg-1"],
      ["prompt_started", "msg-2"],
      ["session_idle", "msg-2"],
    ],
  );
});

test("a late idle after the terminal does not re-emit the finished prompt", async () => {
  // `/shell` and `/summarize` run after a prompt has finished and each ends in `session.idle`;
  // every one of them re-emitted `session_idle` for the old prompt and moved its spool instant.
  const { hooks, directories } = await boundPlugin();
  await hooks["chat.message"](...recordedChatMessage("msg-1"));
  await hooks.event(hostEvent("session.idle"));
  await hooks.event(hostEvent("session.idle"));
  await hooks["chat.params"](recordedChatParams("compaction", "fake", "big", "msg-9"));
  await hooks.event(hostEvent("session.compacted"));
  await hooks.event(hostEvent("session.idle"));
  await hooks.event(
    hostEvent("session.error", { error: { name: "APIError", data: { statusCode: 429 } } }),
  );
  await hooks.dispose();

  assert.deepEqual(
    (await readEvents(directories.fake)).map((event) => event.event_type),
    ["prompt_started", "session_idle"],
  );
});

test("a queued prompt without a provider does not drop the previous prompt's start", async () => {
  const { hooks, directories } = await boundPlugin();
  await hooks["chat.message"]({ sessionID: "ses-1", messageID: "msg-1" }, { parts: [] });
  await hooks["chat.message"]({ sessionID: "ses-1", messageID: "msg-2" }, { parts: [] });
  await hooks["chat.params"](recordedChatParams("build", "fake", "big", "msg-2"));
  await hooks.event(hostEvent("session.idle"));
  await hooks.dispose();

  assert.deepEqual(
    (await readEvents(directories.pending)).map((event) => [
      event.event_type,
      event.source_prompt_id,
    ]),
    [["prompt_started", "msg-1"]],
  );
  assert.deepEqual(
    (await readEvents(directories.fake)).map((event) => [event.event_type, event.source_prompt_id]),
    [
      ["prompt_started", "msg-2"],
      ["session_idle", "msg-2"],
    ],
  );
});

test("a partial line left by an interrupted write rejects only itself", async () => {
  const { hooks, directories } = await boundPlugin();
  await mkdir(directories.fake, { recursive: true, mode: 0o700 });
  await writeFile(join(directories.fake, "current.open"), '{"schema_version":1,"event_id":"half', {
    mode: 0o600,
  });
  await hooks["chat.message"](...recordedChatMessage("msg-1"));
  await hooks.event(hostEvent("session.idle"));
  await hooks.dispose();

  const lines = (await readFile(join(directories.fake, "current.open"), "utf8")).split("\n");
  assert.equal(lines[0], '{"schema_version":1,"event_id":"half');
  assert.deepEqual(
    lines.slice(1, -1).map((line) => JSON.parse(line).event_type),
    ["prompt_started", "session_idle"],
  );
  assert.equal(lines.at(-1), "");
});

test("a writer lock older than any write is taken over even when its pid looks alive", async () => {
  // A lock is held for the milliseconds one append takes. A pid that answers `kill(pid, 0)` --
  // reused after a crash, or another user's process -- held capture off forever.
  const { hooks, directories } = await boundPlugin();
  await mkdir(directories.fake, { recursive: true, mode: 0o700 });
  const lock = join(directories.fake, ".writer.lock");
  await writeFile(lock, `${JSON.stringify({ pid: process.pid, token: "abandoned" })}\n`, {
    mode: 0o600,
  });
  const old = new Date(Date.now() - 10 * 60_000);
  await utimes(lock, old, old);
  await hooks["chat.message"](...recordedChatMessage("msg-1"));
  await hooks.dispose();

  assert.equal((await readEvents(directories.fake)).length, 1);
});

test("a host instant outside four-digit years is replaced, not written", async () => {
  const { hooks, directories } = await boundPlugin();
  await hooks["chat.message"](...recordedChatMessage("msg-1"));
  await hooks.event(hostEvent("session.idle", { time: "+010000-01-01T00:00:00.000Z" }));
  await hooks.dispose();

  const events = await readEvents(directories.fake);
  assert.equal(events.length, 2);
  for (const event of events) {
    assert.match(String(event.occurred_at), /^\d{4}-\d{2}-\d{2}T/u);
  }
});

test("the plugin initializes and never throws when OpenCode passes no options", async () => {
  for (const options of [null, undefined, "x", 7, []]) {
    const hooks = await SnackOpenCodePlugin(
      {},
      /** @type {Parameters<typeof SnackOpenCodePlugin>[1]} */ (/** @type {unknown} */ (options)),
    );
    await assert.doesNotReject(hooks["chat.message"](...recordedChatMessage("msg-1")));
    await assert.doesNotReject(hooks.event(hostEvent("session.idle")));
    await assert.doesNotReject(hooks.dispose());
  }
});
