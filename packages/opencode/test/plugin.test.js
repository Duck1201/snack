import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
