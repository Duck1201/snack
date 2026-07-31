import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, test } from "node:test";

import Database from "better-sqlite3";

import { SnackError } from "../src/errors.js";
import { createOpenCodeAdapter } from "../src/opencode-adapter.js";

/** @type {string[]} */
const temporaryRoots = [];

afterEach(async () => {
  await Promise.all(
    temporaryRoots.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

test("recognizes the supported OpenCode SQLite fingerprint", async () => {
  const databaseFile = await createFixtureDatabase("supported-v1.sql");
  const adapter = createOpenCodeAdapter({ databaseFile });

  assert.deepEqual(adapter.fingerprint(), {
    adapter: "opencode-sqlite",
    fingerprint_version: 1,
    family: "oc-sqlite-msgpart-v1",
    supported: true,
  });
});

test("rejects an unknown OpenCode SQLite fingerprint", async () => {
  const databaseFile = await createFixtureDatabase("unknown.sql");
  const adapter = createOpenCodeAdapter({ databaseFile });

  assert.deepEqual(adapter.fingerprint(), {
    adapter: "opencode-sqlite",
    fingerprint_version: 1,
    family: null,
    supported: false,
  });
});

test("reports an unavailable source when OpenCode is not installed", async () => {
  const root = await mkdtemp(join(tmpdir(), "snack-opencode-missing-"));
  temporaryRoots.push(root);
  // The absent directory is the first-run case: no OpenCode installation at all. better-sqlite3
  // raises a TypeError there and a SqliteError for an absent file inside an existing directory;
  // both must classify the same way instead of surfacing as an internal failure.
  for (const databaseFile of [
    join(root, "no-such-directory", "opencode.db"),
    join(root, "opencode.db"),
  ]) {
    const adapter = createOpenCodeAdapter({ databaseFile });
    for (const read of [
      () => adapter.detect(),
      () => adapter.fingerprint(),
      () => adapter.readAll(),
      () => adapter.readSince(null),
    ]) {
      assert.throws(
        read,
        (error) =>
          error instanceof SnackError &&
          error.reason === "source_unavailable" &&
          error.exitCode === 4,
      );
    }
    assert.equal(adapter.health().status, "inaccessible");
  }
});

test("reads one completed prompt without exposing content", async () => {
  const databaseFile = await createFixtureDatabase("supported-v1.sql");
  executeSql(
    databaseFile,
    `UPDATE part
     SET data = json_set(data, '$.text', 'PRIVATE_PROMPT_CANARY')
     WHERE id = 'user-text-1';`,
  );
  const adapter = createOpenCodeAdapter({ databaseFile });

  const result = adapter.readAll();

  assert.deepEqual(result, {
    observations: [
      {
        source_prompt_id: "user-1",
        source_session_id: "session-1",
        revision: "1767323050000:assistant-1",
        revision_domain: "opencode-message-v1",
        parser_version: "opencode-session-v1",
        started_at: "2026-01-02T03:04:05.000Z",
        completed_at: "2026-01-02T03:04:10.000Z",
        duration_ms: 5000,
        completion: "completed",
        provider: "anthropic",
        model: "claude-sonnet",
        outcome: "success",
        usage_slices: [
          {
            source_slice_id: "step-finish-1",
            provider: "anthropic",
            model: "claude-sonnet",
            input_tokens: 100,
            output_tokens: 25,
            reasoning_tokens: 5,
            cache_read_tokens: 10,
            cache_write_tokens: 2,
            cost_decimal: "0.003",
            currency: null,
          },
        ],
        restrictions: [],
      },
    ],
    cursor: {
      time_updated: 1767323050000,
      message_id: "assistant-1",
    },
  });
  assert.doesNotMatch(JSON.stringify(result), /PRIVATE_PROMPT_CANARY/u);
});

test("produces no observations for an unknown fingerprint", async () => {
  const databaseFile = await createFixtureDatabase("unknown.sql");
  const adapter = createOpenCodeAdapter({ databaseFile });

  assert.throws(
    () => adapter.readAll(),
    (error) => error instanceof SnackError && error.reason === "source_schema_unsupported",
  );
});

test("classifies a structured 429 as an observed restriction without exposing error text", async () => {
  const databaseFile = await createFixtureDatabase("supported-v1.sql");
  executeSql(
    databaseFile,
    `INSERT INTO message (id, session_id, time_created, time_updated, data) VALUES
      (
        'user-2',
        'session-1',
        1767323060000,
        1767323060000,
        '{"role":"user","time":{"created":1767323060000},"agent":"build","model":{"providerID":"anthropic","modelID":"claude-sonnet"}}'
      ),
      (
        'assistant-2',
        'session-1',
        1767323061000,
        1767323062000,
        '{"role":"assistant","time":{"created":1767323061000,"completed":1767323062000},"parentID":"user-2","providerID":"anthropic","modelID":"claude-sonnet","error":{"name":"APIError","data":{"statusCode":429,"message":"PRIVATE_ERROR_CANARY","responseBody":"PRIVATE_RESPONSE_CANARY"}},"cost":0,"tokens":{"input":0,"output":0,"reasoning":0,"cache":{"read":0,"write":0}}}'
      );`,
  );
  const adapter = createOpenCodeAdapter({ databaseFile });

  const result = adapter.readAll();

  assert.deepEqual(result.observations[1], {
    source_prompt_id: "user-2",
    source_session_id: "session-1",
    revision: "1767323062000:assistant-2",
    revision_domain: "opencode-message-v1",
    parser_version: "opencode-session-v1",
    started_at: "2026-01-02T03:04:20.000Z",
    completed_at: "2026-01-02T03:04:22.000Z",
    duration_ms: 2000,
    completion: "completed",
    provider: "anthropic",
    model: "claude-sonnet",
    outcome: "restricted",
    usage_slices: [],
    restrictions: [
      {
        class: "rate_limit",
        source_code: "http_429",
        observed_at: "2026-01-02T03:04:22.000Z",
        classifier_version: "opencode-error-v1",
        provenance: "backfill",
      },
    ],
  });
  assert.doesNotMatch(JSON.stringify(result), /PRIVATE_(?:ERROR|RESPONSE)_CANARY/u);
});

test("reads new observations while revisiting the committed cursor boundary", async () => {
  const databaseFile = await createFixtureDatabase("supported-v1.sql");
  const adapter = createOpenCodeAdapter({ databaseFile });
  const first = adapter.readAll();
  executeSql(
    databaseFile,
    `INSERT INTO message (id, session_id, time_created, time_updated, data) VALUES
      (
        'user-2',
        'session-1',
        1767323060000,
        1767323060000,
        '{"role":"user","time":{"created":1767323060000},"agent":"build","model":{"providerID":"openai","modelID":"gpt-5"}}'
      ),
      (
        'assistant-2',
        'session-1',
        1767323061000,
        1767323062000,
        '{"role":"assistant","time":{"created":1767323061000,"completed":1767323062000},"parentID":"user-2","providerID":"openai","modelID":"gpt-5","finish":"stop","cost":0.004,"tokens":{"input":80,"output":20,"reasoning":10,"cache":{"read":0,"write":0}}}'
      );
     INSERT INTO part (id, message_id, session_id, time_created, time_updated, data) VALUES
      (
        'step-finish-2',
        'assistant-2',
        'session-1',
        1767323062000,
        1767323062000,
        '{"type":"step-finish","reason":"stop","cost":0.004,"tokens":{"input":80,"output":20,"reasoning":10,"cache":{"read":0,"write":0}}}'
      );`,
  );

  const incremental = adapter.readSince(first.cursor);

  assert.deepEqual(
    {
      prompt_ids: incremental.observations.map((observation) => observation.source_prompt_id),
      cursor: incremental.cursor,
    },
    {
      prompt_ids: ["user-1", "user-2"],
      cursor: { time_updated: 1767323062000, message_id: "assistant-2" },
    },
  );
});

test("folds compaction and synthetic continuation usage into the external prompt", async () => {
  const databaseFile = await createFixtureDatabase("supported-v1.sql");
  executeSql(
    databaseFile,
    `INSERT INTO message (id, session_id, time_created, time_updated, data) VALUES
      (
        'user-compaction',
        'session-1',
        1767323051000,
        1767323051000,
        '{"role":"user","time":{"created":1767323051000},"agent":"compaction","model":{"providerID":"anthropic","modelID":"claude-sonnet"}}'
      ),
      (
        'assistant-summary',
        'session-1',
        1767323052000,
        1767323053000,
        '{"role":"assistant","time":{"created":1767323052000,"completed":1767323053000},"parentID":"user-compaction","providerID":"anthropic","modelID":"claude-sonnet","summary":true,"finish":"stop","cost":0.001,"tokens":{"input":40,"output":10,"reasoning":0,"cache":{"read":0,"write":0}}}'
      ),
      (
        'user-continuation',
        'session-1',
        1767323054000,
        1767323054000,
        '{"role":"user","time":{"created":1767323054000},"agent":"build","model":{"providerID":"anthropic","modelID":"claude-sonnet"}}'
      ),
      (
        'assistant-continuation',
        'session-1',
        1767323055000,
        1767323056000,
        '{"role":"assistant","time":{"created":1767323055000,"completed":1767323056000},"parentID":"user-continuation","providerID":"anthropic","modelID":"claude-sonnet","finish":"stop","cost":0.002,"tokens":{"input":60,"output":15,"reasoning":2,"cache":{"read":5,"write":0}}}'
      );
     INSERT INTO part (id, message_id, session_id, time_created, time_updated, data) VALUES
      ('compaction-1', 'user-compaction', 'session-1', 1767323051000, 1767323051000, '{"type":"compaction","auto":true}'),
      ('step-summary', 'assistant-summary', 'session-1', 1767323053000, 1767323053000, '{"type":"step-finish","reason":"stop","cost":0.001,"tokens":{"input":40,"output":10,"reasoning":0,"cache":{"read":0,"write":0}}}'),
      ('continuation-text', 'user-continuation', 'session-1', 1767323054000, 1767323054000, '{"type":"text","synthetic":true,"metadata":{"compaction_continue":true},"text":"PRIVATE_CONTINUATION_CANARY"}'),
      ('step-continuation', 'assistant-continuation', 'session-1', 1767323056000, 1767323056000, '{"type":"step-finish","reason":"stop","cost":0.002,"tokens":{"input":60,"output":15,"reasoning":2,"cache":{"read":5,"write":0}}}');`,
  );
  const adapter = createOpenCodeAdapter({ databaseFile });

  const result = adapter.readAll();

  assert.deepEqual(
    result.observations.map((observation) => ({
      source_prompt_id: observation.source_prompt_id,
      completed_at: observation.completed_at,
      slices: observation.usage_slices.map((slice) => slice.source_slice_id),
    })),
    [
      {
        source_prompt_id: "user-1",
        completed_at: "2026-01-02T03:04:16.000Z",
        slices: ["step-finish-1", "step-summary", "step-continuation"],
      },
    ],
  );
  assert.doesNotMatch(JSON.stringify(result), /PRIVATE_CONTINUATION_CANARY/u);
});

test("folds an overflow replay into the preceding external prompt", async () => {
  const databaseFile = await createFixtureDatabase("supported-v1.sql");
  executeSql(
    databaseFile,
    `INSERT INTO message (id, session_id, time_created, time_updated, data) VALUES
      ('user-compaction', 'session-1', 1767323051000, 1767323051000, '{"role":"user","time":{"created":1767323051000},"agent":"compaction","model":{"providerID":"anthropic","modelID":"claude-sonnet"}}'),
      ('assistant-summary', 'session-1', 1767323052000, 1767323053000, '{"role":"assistant","time":{"created":1767323052000,"completed":1767323053000},"parentID":"user-compaction","providerID":"anthropic","modelID":"claude-sonnet","summary":true,"finish":"stop","cost":0.001,"tokens":{"input":40,"output":10,"reasoning":0,"cache":{"read":0,"write":0}}}'),
      ('user-replay', 'session-1', 1767323054000, 1767323054000, '{"role":"user","time":{"created":1767323054000},"agent":"build","model":{"providerID":"anthropic","modelID":"claude-sonnet"}}'),
      ('assistant-replay', 'session-1', 1767323055000, 1767323056000, '{"role":"assistant","time":{"created":1767323055000,"completed":1767323056000},"parentID":"user-replay","providerID":"anthropic","modelID":"claude-sonnet","finish":"stop","cost":0.002,"tokens":{"input":60,"output":15,"reasoning":2,"cache":{"read":5,"write":0}}}');
     INSERT INTO part (id, message_id, session_id, time_created, time_updated, data) VALUES
      ('compaction-1', 'user-compaction', 'session-1', 1767323051000, 1767323051000, '{"type":"compaction","auto":true,"overflow":true}'),
      ('step-summary', 'assistant-summary', 'session-1', 1767323053000, 1767323053000, '{"type":"step-finish","reason":"stop","cost":0.001,"tokens":{"input":40,"output":10,"reasoning":0,"cache":{"read":0,"write":0}}}'),
      ('replay-text', 'user-replay', 'session-1', 1767323054000, 1767323054000, '{"type":"text","text":"PRIVATE_REPLAY_CANARY"}'),
      ('step-replay', 'assistant-replay', 'session-1', 1767323056000, 1767323056000, '{"type":"step-finish","reason":"stop","cost":0.002,"tokens":{"input":60,"output":15,"reasoning":2,"cache":{"read":5,"write":0}}}');`,
  );
  const adapter = createOpenCodeAdapter({ databaseFile });

  const result = adapter.readAll();

  assert.deepEqual(
    result.observations.map((observation) => ({
      source_prompt_id: observation.source_prompt_id,
      slices: observation.usage_slices.map((slice) => slice.source_slice_id),
    })),
    [
      {
        source_prompt_id: "user-1",
        slices: ["step-finish-1", "step-summary", "step-replay"],
      },
    ],
  );
  assert.doesNotMatch(JSON.stringify(result), /PRIVATE_REPLAY_CANARY/u);
});

test("classifies an aborted prompt as cancelled rather than restricted", async () => {
  const databaseFile = await createFixtureDatabase("supported-v1.sql");
  executeSql(
    databaseFile,
    `INSERT INTO message (id, session_id, time_created, time_updated, data) VALUES
      ('user-2', 'session-1', 1767323060000, 1767323060000, '{"role":"user","time":{"created":1767323060000},"agent":"build","model":{"providerID":"anthropic","modelID":"claude-sonnet"}}'),
      ('assistant-2', 'session-1', 1767323061000, 1767323062000, '{"role":"assistant","time":{"created":1767323061000,"completed":1767323062000},"parentID":"user-2","providerID":"anthropic","modelID":"claude-sonnet","error":{"name":"MessageAbortedError","data":{"message":"PRIVATE_ABORT_CANARY"}},"cost":0,"tokens":{"input":0,"output":0,"reasoning":0,"cache":{"read":0,"write":0}}}');`,
  );
  const adapter = createOpenCodeAdapter({ databaseFile });

  const result = adapter.readAll();

  assert.deepEqual(
    {
      outcome: result.observations[1]?.outcome,
      exclusion: result.observations[1]?.exclusion,
    },
    {
      outcome: "excluded",
      exclusion: {
        class: "cancelled",
        source_code: "MessageAbortedError",
        classifier_version: "opencode-error-v1",
      },
    },
  );
  assert.doesNotMatch(JSON.stringify(result), /PRIVATE_ABORT_CANARY/u);
});

test("classifies authentication failure as operational rather than restricted", async () => {
  const databaseFile = await createFixtureDatabase("supported-v1.sql");
  executeSql(
    databaseFile,
    `INSERT INTO message (id, session_id, time_created, time_updated, data) VALUES
      ('user-2', 'session-1', 1767323060000, 1767323060000, '{"role":"user","time":{"created":1767323060000},"agent":"build","model":{"providerID":"anthropic","modelID":"claude-sonnet"}}'),
      ('assistant-2', 'session-1', 1767323061000, 1767323062000, '{"role":"assistant","time":{"created":1767323061000,"completed":1767323062000},"parentID":"user-2","providerID":"anthropic","modelID":"claude-sonnet","error":{"name":"ProviderAuthError","data":{"providerID":"PRIVATE_PROVIDER_CANARY","message":"PRIVATE_AUTH_CANARY"}},"cost":0,"tokens":{"input":0,"output":0,"reasoning":0,"cache":{"read":0,"write":0}}}');`,
  );
  const adapter = createOpenCodeAdapter({ databaseFile });

  const result = adapter.readAll();

  assert.deepEqual(
    {
      outcome: result.observations[1]?.outcome,
      exclusion: result.observations[1]?.exclusion,
    },
    {
      outcome: "excluded",
      exclusion: {
        class: "operational_error",
        source_code: "ProviderAuthError",
        classifier_version: "opencode-error-v1",
      },
    },
  );
  assert.doesNotMatch(JSON.stringify(result), /PRIVATE_(?:PROVIDER|AUTH)_CANARY/u);
});

test("keeps official non-limit error classes operational", async () => {
  const databaseFile = await createFixtureDatabase("supported-v1.sql");
  const errors = [
    { name: "MessageOutputLengthError", data: {} },
    { name: "StructuredOutputError", data: { retries: 2, message: "PRIVATE_ERROR_CANARY" } },
    { name: "ContextOverflowError", data: { message: "PRIVATE_ERROR_CANARY" } },
    { name: "ContentFilterError", data: { message: "PRIVATE_ERROR_CANARY" } },
    { name: "UnknownError", data: { message: "PRIVATE_ERROR_CANARY" } },
    {
      name: "APIError",
      data: { statusCode: 500, message: "PRIVATE_ERROR_CANARY", isRetryable: true },
    },
  ];
  errors.forEach((error, index) => insertErrorPrompt(databaseFile, index + 2, error));
  const adapter = createOpenCodeAdapter({ databaseFile });

  const result = adapter.readAll();

  assert.deepEqual(
    result.observations.slice(1).map((observation) => observation.exclusion),
    [
      "MessageOutputLengthError",
      "StructuredOutputError",
      "ContextOverflowError",
      "ContentFilterError",
      "UnknownError",
      "APIError",
    ].map((sourceCode) => ({
      class: "operational_error",
      source_code: sourceCode,
      classifier_version: "opencode-error-v1",
    })),
  );
  assert.doesNotMatch(JSON.stringify(result), /PRIVATE_ERROR_CANARY/u);
});

test("incremental reads include a usage part revised after the message cursor", async () => {
  const databaseFile = await createFixtureDatabase("supported-v1.sql");
  const adapter = createOpenCodeAdapter({ databaseFile });
  const first = adapter.readAll();
  executeSql(
    databaseFile,
    `UPDATE part
     SET time_updated = 1767323055000,
         data = '{"type":"step-finish","reason":"stop","cost":0.003,"tokens":{"input":120,"output":25,"reasoning":5,"cache":{"read":10,"write":2}}}'
     WHERE id = 'step-finish-1';`,
  );

  const incremental = adapter.readSince(first.cursor);

  assert.deepEqual(
    {
      prompt_ids: incremental.observations.map((observation) => observation.source_prompt_id),
      input_tokens: incremental.observations[0]?.usage_slices[0]?.input_tokens,
      cursor: incremental.cursor,
    },
    {
      prompt_ids: ["user-1"],
      input_tokens: 120,
      cursor: { time_updated: 1767323055000, message_id: "assistant-1" },
    },
  );
});

test("incremental reads revisit the cursor boundary when content changes at the same timestamp", async () => {
  const databaseFile = await createFixtureDatabase("supported-v1.sql");
  const adapter = createOpenCodeAdapter({ databaseFile });
  const first = adapter.readAll();
  executeSql(
    databaseFile,
    `UPDATE part
     SET data = '{"type":"step-finish","reason":"stop","cost":0.003,"tokens":{"input":120,"output":25,"reasoning":5,"cache":{"read":10,"write":2}}}'
     WHERE id = 'step-finish-1';`,
  );

  const incremental = adapter.readSince(first.cursor);

  assert.deepEqual(
    {
      prompt_ids: incremental.observations.map((observation) => observation.source_prompt_id),
      input_tokens: incremental.observations[0]?.usage_slices[0]?.input_tokens,
      cursor: incremental.cursor,
    },
    {
      prompt_ids: ["user-1"],
      input_tokens: 120,
      cursor: { time_updated: 1767323050000, message_id: "assistant-1" },
    },
  );
});

test("detects OpenCode versions without exposing the database path", async () => {
  const databaseFile = await createFixtureDatabase("supported-v1.sql");
  const adapter = createOpenCodeAdapter({ databaseFile });

  const detection = adapter.detect();

  assert.deepEqual(detection, {
    detected: true,
    client: "opencode",
    versions: ["1.18.9"],
  });
  assert.doesNotMatch(JSON.stringify(detection), new RegExp(databaseFile, "u"));
});

test("reports compatible health for an accessible supported source", async () => {
  const databaseFile = await createFixtureDatabase("supported-v1.sql");
  const adapter = createOpenCodeAdapter({ databaseFile });

  assert.deepEqual(adapter.health(), {
    status: "compatible",
    accessible: true,
    fingerprint: {
      family: "oc-sqlite-msgpart-v1",
      supported: true,
    },
  });
});

test("preserves a restriction when a prompt succeeds through a fallback provider", async () => {
  const databaseFile = await createFixtureDatabase("supported-v1.sql");
  executeSql(
    databaseFile,
    `INSERT INTO message (id, session_id, time_created, time_updated, data) VALUES
      ('user-2', 'session-1', 1767323060000, 1767323060000, '{"role":"user","time":{"created":1767323060000},"agent":"build","model":{"providerID":"anthropic","modelID":"claude-sonnet"}}'),
      ('assistant-2a', 'session-1', 1767323061000, 1767323062000, '{"role":"assistant","time":{"created":1767323061000,"completed":1767323062000},"parentID":"user-2","providerID":"anthropic","modelID":"claude-sonnet","error":{"name":"APIError","data":{"statusCode":429,"message":"PRIVATE_LIMIT_CANARY"}},"cost":0,"tokens":{"input":0,"output":0,"reasoning":0,"cache":{"read":0,"write":0}}}'),
      ('assistant-2b', 'session-1', 1767323063000, 1767323064000, '{"role":"assistant","time":{"created":1767323063000,"completed":1767323064000},"parentID":"user-2","providerID":"openai","modelID":"gpt-5","finish":"stop","cost":0.004,"tokens":{"input":80,"output":20,"reasoning":10,"cache":{"read":0,"write":0}}}');
     INSERT INTO part (id, message_id, session_id, time_created, time_updated, data) VALUES
      ('step-fallback', 'assistant-2b', 'session-1', 1767323064000, 1767323064000, '{"type":"step-finish","reason":"stop","cost":0.004,"tokens":{"input":80,"output":20,"reasoning":10,"cache":{"read":0,"write":0}}}');`,
  );
  const adapter = createOpenCodeAdapter({ databaseFile });

  const outcomes = adapter
    .readAll()
    .observations.filter((observation) => observation.source_prompt_id === "user-2")
    .map((observation) => ({
      provider: observation.provider,
      outcome: observation.outcome,
      restrictions: observation.restrictions.map((restriction) => restriction.class),
      slices: observation.usage_slices.map((slice) => slice.source_slice_id),
    }));

  assert.deepEqual(outcomes, [
    {
      provider: "anthropic",
      outcome: "restricted",
      restrictions: ["rate_limit"],
      slices: [],
    },
    {
      provider: "openai",
      outcome: "success",
      restrictions: [],
      slices: ["step-fallback"],
    },
  ]);
});

test("rejects supported tables when critical message JSON has an unknown shape", async () => {
  const databaseFile = await createFixtureDatabase("supported-v1.sql");
  executeSql(
    databaseFile,
    `UPDATE message
     SET data = '{"role":"assistant"}'
     WHERE id = 'assistant-1';`,
  );
  const adapter = createOpenCodeAdapter({ databaseFile });

  assert.deepEqual(adapter.fingerprint(), {
    adapter: "opencode-sqlite",
    fingerprint_version: 1,
    family: null,
    supported: false,
  });
});

test("preserves observed cost as a lossless JSON decimal", async () => {
  const databaseFile = await createFixtureDatabase("supported-v1.sql");
  executeSql(
    databaseFile,
    `UPDATE part
     SET data = '{"type":"step-finish","reason":"stop","cost":0.123456789012345678901234567890,"tokens":{"input":100,"output":25,"reasoning":5,"cache":{"read":10,"write":2}}}'
     WHERE id = 'step-finish-1';`,
  );
  const adapter = createOpenCodeAdapter({ databaseFile });

  assert.equal(
    adapter.readAll().observations[0]?.usage_slices[0]?.cost_decimal,
    "0.123456789012345678901234567890",
  );
});

test("incremental reads do not hydrate sessions older than the cursor boundary", async () => {
  const databaseFile = await createFixtureDatabase("supported-v1.sql");
  const adapter = createOpenCodeAdapter({ databaseFile });
  const cursor = adapter.readAll().cursor;
  executeSql(
    databaseFile,
    `INSERT INTO session (id, version) VALUES ('session-old', '1.18.9');
     INSERT INTO message (id, session_id, time_created, time_updated, data) VALUES
      ('user-old', 'session-old', 1, 1, '{"role":"user","time":{"created":9000000000000000000},"agent":"build","model":{"providerID":"anthropic","modelID":"claude-sonnet"}}'),
      ('assistant-old', 'session-old', 2, 2, '{"role":"assistant","time":{"created":9000000000000000000,"completed":9000000000000000001},"parentID":"user-old","providerID":"anthropic","modelID":"claude-sonnet","finish":"stop","cost":0,"tokens":{"input":0,"output":0,"reasoning":0,"cache":{"read":0,"write":0}}}');`,
  );

  const result = adapter.readSince(cursor);

  assert.deepEqual(
    result.observations.map((observation) => observation.source_prompt_id),
    ["user-1"],
  );
});

test("a revised compaction part re-emits its external prompt incrementally", async () => {
  const databaseFile = await createFixtureDatabase("supported-v1.sql");
  executeSql(
    databaseFile,
    `INSERT INTO session (id, version) VALUES ('session-other', '1.18.9');
     INSERT INTO message (id, session_id, time_created, time_updated, data) VALUES
      ('user-compaction', 'session-1', 1767323051000, 1767323051000, '{"role":"user","time":{"created":1767323051000},"agent":"compaction","model":{"providerID":"anthropic","modelID":"claude-sonnet"}}'),
      ('assistant-summary', 'session-1', 1767323052000, 1767323053000, '{"role":"assistant","time":{"created":1767323052000,"completed":1767323053000},"parentID":"user-compaction","providerID":"anthropic","modelID":"claude-sonnet","summary":true,"finish":"stop","cost":0.001,"tokens":{"input":40,"output":10,"reasoning":0,"cache":{"read":0,"write":0}}}'),
      ('user-other', 'session-other', 1767323057000, 1767323057000, '{"role":"user","time":{"created":1767323057000},"agent":"build","model":{"providerID":"anthropic","modelID":"claude-sonnet"}}'),
      ('assistant-other', 'session-other', 1767323058000, 1767323059000, '{"role":"assistant","time":{"created":1767323058000,"completed":1767323059000},"parentID":"user-other","providerID":"anthropic","modelID":"claude-sonnet","finish":"stop","cost":0,"tokens":{"input":0,"output":0,"reasoning":0,"cache":{"read":0,"write":0}}}');
     INSERT INTO part (id, message_id, session_id, time_created, time_updated, data) VALUES
      ('compaction-1', 'user-compaction', 'session-1', 1767323051000, 1767323051000, '{"type":"compaction","auto":true}'),
      ('step-summary', 'assistant-summary', 'session-1', 1767323053000, 1767323053000, '{"type":"step-finish","reason":"stop","cost":0.001,"tokens":{"input":40,"output":10,"reasoning":0,"cache":{"read":0,"write":0}}}');`,
  );
  const adapter = createOpenCodeAdapter({ databaseFile });
  const cursor = adapter.readAll().cursor;
  executeSql(
    databaseFile,
    "UPDATE part SET time_updated = 1767323060000 WHERE id = 'compaction-1';",
  );

  const result = adapter.readSince(cursor);

  assert.deepEqual(
    result.observations.map((observation) => observation.source_prompt_id),
    ["user-1", "user-other"],
  );
});

test("rejects incompatible optional JSON fields used by the parser", async () => {
  const mutations = [
    `UPDATE message SET data = json_set(data, '$.summary', 'yes') WHERE id = 'assistant-1'`,
    `UPDATE message SET data = json_set(data, '$.error', json('{"name":"APIError","data":{"statusCode":"429"}}')) WHERE id = 'assistant-1'`,
    `UPDATE part SET data = json_set(data, '$.synthetic', 'yes') WHERE id = 'user-text-1'`,
    `UPDATE part SET data = json_set(data, '$.metadata', json('{"compaction_continue":"yes"}')) WHERE id = 'user-text-1'`,
  ];
  const results = [];
  for (const mutation of mutations) {
    const databaseFile = await createFixtureDatabase("supported-v1.sql");
    executeSql(databaseFile, mutation);
    results.push(createOpenCodeAdapter({ databaseFile }).fingerprint().supported);
  }

  assert.deepEqual(results, [false, false, false, false]);
});

test("supports every documented OpenCode version fixture in the v1 family", async () => {
  const versions = ["1.17.19", "1.17.20", "1.18.1", "1.18.9"];
  const results = [];
  for (const version of versions) {
    const databaseFile = await createFixtureDatabase("supported-v1.sql");
    const overlay = await readFile(
      new URL(`./fixtures/opencode/version-${version}.sql`, import.meta.url),
      "utf8",
    );
    executeSql(databaseFile, overlay);
    const adapter = createOpenCodeAdapter({ databaseFile });
    results.push({ detection: adapter.detect(), fingerprint: adapter.fingerprint() });
  }

  assert.deepEqual(
    results.map((result) => ({
      versions: result.detection.versions,
      family: result.fingerprint.family,
      supported: result.fingerprint.supported,
    })),
    versions.map((version) => ({
      versions: [version],
      family: "oc-sqlite-msgpart-v1",
      supported: true,
    })),
  );
});

test("reads committed WAL data without modifying the OpenCode WAL", async () => {
  const databaseFile = await createFixtureDatabase("supported-v1.sql");
  const writer = new Database(databaseFile);
  try {
    writer.pragma("journal_mode = WAL");
    writer.exec(
      `INSERT INTO message (id, session_id, time_created, time_updated, data) VALUES
        ('user-wal', 'session-1', 1767323060000, 1767323060000, '{"role":"user","time":{"created":1767323060000},"agent":"build","model":{"providerID":"anthropic","modelID":"claude-sonnet"}}'),
        ('assistant-wal', 'session-1', 1767323061000, 1767323062000, '{"role":"assistant","time":{"created":1767323061000,"completed":1767323062000},"parentID":"user-wal","providerID":"anthropic","modelID":"claude-sonnet","finish":"stop","cost":0,"tokens":{"input":0,"output":0,"reasoning":0,"cache":{"read":0,"write":0}}}');`,
    );
    const walFile = `${databaseFile}-wal`;
    const before = await stat(walFile);

    const result = createOpenCodeAdapter({ databaseFile }).readAll();
    const after = await stat(walFile);

    assert.deepEqual(
      {
        promptIds: result.observations.map((observation) => observation.source_prompt_id),
        walSizeBefore: before.size,
        walSizeAfter: after.size,
        walModifiedBefore: before.mtimeMs,
        walModifiedAfter: after.mtimeMs,
      },
      {
        promptIds: ["user-1", "user-wal"],
        walSizeBefore: before.size,
        walSizeAfter: before.size,
        walModifiedBefore: before.mtimeMs,
        walModifiedAfter: before.mtimeMs,
      },
    );
  } finally {
    writer.close();
  }
});

test("treats tool-calls finish as provisional even with a completed step", async () => {
  const databaseFile = await createFixtureDatabase("supported-v1.sql");
  executeSql(
    databaseFile,
    `UPDATE message
     SET data = json_set(data, '$.finish', 'tool-calls')
     WHERE id = 'assistant-1';`,
  );

  const observation = createOpenCodeAdapter({ databaseFile }).readAll().observations[0];

  assert.deepEqual(
    { completion: observation?.completion, outcome: observation?.outcome },
    { completion: "provisional", outcome: "excluded" },
  );
});

/** @param {string} fixtureName */
async function createFixtureDatabase(fixtureName) {
  const root = await mkdtemp(join(tmpdir(), "snack-opencode-adapter-"));
  temporaryRoots.push(root);
  const databaseFile = join(root, "opencode.db");
  const sql = await readFile(
    new URL(`./fixtures/opencode/${fixtureName}`, import.meta.url),
    "utf8",
  );
  const database = new Database(databaseFile);
  try {
    database.exec(sql);
  } finally {
    database.close();
  }
  return databaseFile;
}

/** @param {string} databaseFile @param {string} sql */
function executeSql(databaseFile, sql) {
  const database = new Database(databaseFile);
  try {
    database.exec(sql);
  } finally {
    database.close();
  }
}

/** @param {string} databaseFile @param {number} index @param {{name: string, data: object}} error */
function insertErrorPrompt(databaseFile, index, error) {
  const database = new Database(databaseFile);
  try {
    const created = 1767323060000 + index * 10_000;
    database
      .prepare(
        `INSERT INTO message (id, session_id, time_created, time_updated, data)
         VALUES (?, 'session-1', ?, ?, ?)`,
      )
      .run(
        `user-${index}`,
        created,
        created,
        JSON.stringify({
          role: "user",
          time: { created },
          agent: "build",
          model: { providerID: "anthropic", modelID: "claude-sonnet" },
        }),
      );
    database
      .prepare(
        `INSERT INTO message (id, session_id, time_created, time_updated, data)
         VALUES (?, 'session-1', ?, ?, ?)`,
      )
      .run(
        `assistant-${index}`,
        created + 1000,
        created + 2000,
        JSON.stringify({
          role: "assistant",
          time: { created: created + 1000, completed: created + 2000 },
          parentID: `user-${index}`,
          providerID: "anthropic",
          modelID: "claude-sonnet",
          error,
          cost: 0,
          tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
        }),
      );
  } finally {
    database.close();
  }
}

test("keeps concurrent sessions separate when grouping assistants by prompt", async () => {
  const databaseFile = await createFixtureDatabase("supported-v1.sql");
  // A second session whose messages interleave in time with the fixture session.
  executeSql(
    databaseFile,
    `INSERT INTO session (id, version) VALUES ('session-2', '1.18.9');
     INSERT INTO message (id, session_id, time_created, time_updated, data) VALUES
      (
        'user-s2',
        'session-2',
        1767323045500,
        1767323045500,
        '{"role":"user","time":{"created":1767323045500},"agent":"build","model":{"providerID":"anthropic","modelID":"claude-sonnet"}}'
      ),
      (
        'assistant-s2',
        'session-2',
        1767323046500,
        1767323050500,
        '{"role":"assistant","time":{"created":1767323046500,"completed":1767323050500},"parentID":"user-s2","providerID":"anthropic","modelID":"claude-sonnet","finish":"stop","cost":0.007,"tokens":{"input":700,"output":70,"reasoning":7,"cache":{"read":7,"write":7}}}'
      );
     INSERT INTO part (id, message_id, session_id, time_created, time_updated, data) VALUES
      (
        'step-finish-s2',
        'assistant-s2',
        'session-2',
        1767323050500,
        1767323050500,
        '{"type":"step-finish","reason":"stop","cost":0.007,"tokens":{"input":700,"output":70,"reasoning":7,"cache":{"read":7,"write":7}}}'
      );`,
  );
  const adapter = createOpenCodeAdapter({ databaseFile });

  const result = adapter.readAll();

  // Each prompt keeps only its own session's usage; nothing crosses between sessions.
  const bySource = new Map(
    result.observations.map((observation) => [observation.source_prompt_id, observation]),
  );
  assert.deepEqual(
    bySource.get("user-1")?.usage_slices.map((slice) => slice.input_tokens),
    [100],
  );
  assert.deepEqual(
    bySource.get("user-s2")?.usage_slices.map((slice) => slice.input_tokens),
    [700],
  );
  assert.equal(result.observations.length, 2);
});

test("ignores an assistant whose parent prompt belongs to another session", async () => {
  const databaseFile = await createFixtureDatabase("supported-v1.sql");
  // Malformed history: the assistant lives in session-2 but claims a session-1 parent.
  executeSql(
    databaseFile,
    `INSERT INTO session (id, version) VALUES ('session-2', '1.18.9');
     INSERT INTO message (id, session_id, time_created, time_updated, data) VALUES
      (
        'assistant-cross',
        'session-2',
        1767323047000,
        1767323051000,
        '{"role":"assistant","time":{"created":1767323047000,"completed":1767323051000},"parentID":"user-1","providerID":"anthropic","modelID":"claude-sonnet","finish":"stop","cost":0.009,"tokens":{"input":900,"output":90,"reasoning":9,"cache":{"read":9,"write":9}}}'
      );
     INSERT INTO part (id, message_id, session_id, time_created, time_updated, data) VALUES
      (
        'step-finish-cross',
        'assistant-cross',
        'session-2',
        1767323051000,
        1767323051000,
        '{"type":"step-finish","reason":"stop","cost":0.009,"tokens":{"input":900,"output":90,"reasoning":9,"cache":{"read":9,"write":9}}}'
      );`,
  );
  const adapter = createOpenCodeAdapter({ databaseFile });

  const result = adapter.readAll();

  // The cross-session usage must not be attributed to the session-1 prompt.
  assert.deepEqual(
    result.observations[0]?.usage_slices.map((slice) => slice.input_tokens),
    [100],
  );
});
