import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, test } from "node:test";

import { SnackOpenCodePlugin } from "../src/plugin.js";

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
    { message: { text: "PRIVATE_PROMPT_CANARY" }, parts: [] },
  );
  await hooks.event({
    event: {
      type: "session.error",
      properties: {
        sessionID: "session-1",
        error: {
          name: "APIError",
          data: { statusCode: 429, message: "PRIVATE_ERROR_CANARY" },
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
  assert.doesNotMatch(content, /PRIVATE_(?:PROMPT|ERROR)_CANARY/u);
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
        { message: { text: "PRIVATE_PROMPT_CANARY" }, parts: [] },
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
        { type: "text", text: "PRIVATE_FEATURE_CANARY\n```js\ncode\n```" },
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
  assert.doesNotMatch(content, /PRIVATE_FEATURE_CANARY|private\/path/u);
});
