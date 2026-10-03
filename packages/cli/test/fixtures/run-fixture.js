import dns from "node:dns";
import dnsPromises from "node:dns/promises";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import net from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import Database from "better-sqlite3";

import { resolvePaths } from "../../src/paths.js";

/**
 * Command tests drive `run(argv, options)` against injected sinks, a temporary XDG environment,
 * and a fixed clock, never the real home directory or the real clock.
 *
 * @type {string[]}
 */
const temporaryRoots = [];

/** Remove every root handed out since the last call. Call from `afterEach`. */
export async function cleanupRunFixtures() {
  await Promise.all(
    temporaryRoots.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
}

/**
 * Deny every way this process could reach the network, and record any attempt.
 *
 * ADR-0010 makes one command an exception to "local only", which turns "no command opens a socket"
 * from a structural fact into a property that has to be proven. Node cannot enforce this: its
 * permission model covers `fs`, `child_process`, `worker`, `wasi` and `addons`, and there is no
 * `--allow-net`. So the denial is built here instead.
 *
 * Patched at `net.Socket.prototype.connect` rather than at `net.connect`, because `http`, `https`,
 * `tls` and `fetch` all end up there, and because replacing a named export would not reach code
 * that already destructured it.
 *
 * This proves the paths a test exercises and nothing about the paths it does not. Its complement is
 * the static import walk in `network-boundary.test.js`, which reads the source instead and so
 * covers code no test runs -- and which in turn cannot see a dependency that opens a socket, which
 * is what this one is for. Neither is complete alone.
 *
 * @returns {{attempts: string[], restore(): void}}
 */
export function denyNetwork() {
  /** @type {string[]} */
  const attempts = [];
  /** @param {string} label */
  const deny =
    (label) =>
    (/** @type {unknown[]} */ ...args) => {
      attempts.push(`${label}(${args.map((value) => String(value)).join(", ")})`);
      throw new Error(`Network access denied in this test: ${label}`);
    };

  const socketConnect = net.Socket.prototype.connect;
  const originalFetch = globalThis.fetch;
  const lookup = dns.lookup;
  const promisesLookup = dnsPromises.lookup;

  net.Socket.prototype.connect = deny("net.Socket.connect");
  // `fetch` rejects rather than throwing, so a caller that only catches asynchronously still sees
  // the denial the way it would see a real failure.
  globalThis.fetch = /** @type {typeof globalThis.fetch} */ (
    async (/** @type {unknown[]} */ ...args) => deny("fetch")(...args)
  );
  // @ts-expect-error -- the stub deliberately does not match the overloaded signature.
  dns.lookup = deny("dns.lookup");
  dnsPromises.lookup = /** @type {typeof dnsPromises.lookup} */ (deny("dns.promises.lookup"));

  return {
    attempts,
    restore() {
      net.Socket.prototype.connect = socketConnect;
      globalThis.fetch = originalFetch;
      dns.lookup = lookup;
      dnsPromises.lookup = promisesLookup;
    },
  };
}

/** @param {string} [prefix] */
export async function makeRunFixture(prefix = "snack-main-") {
  const root = await mkdtemp(join(tmpdir(), prefix));
  temporaryRoots.push(root);
  const stdout = sink();
  const stderr = sink();
  /** @type {{XDG_CONFIG_HOME: string, XDG_DATA_HOME: string, XDG_CACHE_HOME: string, XDG_STATE_HOME: string, OPENCODE_DB?: string, CLAUDE_CONFIG_DIR?: string, CODEX_HOME?: string}} */
  const env = {
    XDG_CONFIG_HOME: join(root, "config-home"),
    XDG_DATA_HOME: join(root, "data-home"),
    XDG_CACHE_HOME: join(root, "cache-home"),
    XDG_STATE_HOME: join(root, "state-home"),
  };
  // Fixtures follow the platform the suite is running on rather than declaring themselves Linux.
  // Pinning the layout made every macOS run exercise XDG paths the product never uses there, and
  // it broke outright for the tests that spawn the real binary, which cannot be told a platform.
  // `paths.test.js` still pins both layouts against `resolvePaths` directly.
  const platform = process.platform;
  const paths = resolvePaths({ env, platform, home: root });
  return {
    root,
    stdout,
    stderr,
    paths,
    dataHome: dirname(paths.dataDir),
    options: {
      stdout,
      stderr,
      home: root,
      env,
      platform,
      nodeVersion: "24.18.1",
      now: new Date("2026-01-02T03:04:05.000Z"),
      // Every injected port is listed here, typed and unset. Widening the whole bag to `RunOptions`
      // instead would make `env` optional for the several dozen tests that read it back.
      writeConfig:
        /** @type {typeof import("../../src/config.js").writePrivateAtomic | undefined} */ (
          undefined
        ),
      prompt: /** @type {import("../../src/main.js").SetupPrompt | undefined} */ (undefined),
      modulePath: /** @type {string | undefined} */ (undefined),
      execute: /** @type {import("../../src/main.js").ExecuteCommand | undefined} */ (undefined),
    },
  };
}

/** @param {string} root @param {string} [filename] */
export async function createOpenCodeDatabase(root, filename = "opencode.db") {
  const databaseFile = join(root, filename);
  const sql = await readFile(new URL("./opencode/supported-v1.sql", import.meta.url), "utf8");
  const database = new Database(databaseFile);
  try {
    database.exec(sql);
  } finally {
    database.close();
  }
  return databaseFile;
}

/**
 * Plant a Claude Code configuration directory holding one session history.
 *
 * Claude Code keeps its histories under `<config>/projects/<slugified working directory>`, and
 * honours `CLAUDE_CONFIG_DIR`, which is what lets a test point SNACK at a throwaway tree.
 *
 * @param {string} root
 * @param {string} [fixtureName]
 */
export async function createClaudeHistory(root, fixtureName = "version-2-1-220.jsonl") {
  const configDir = join(root, "claude-home");
  const project = join(configDir, "projects", "-fixture-project");
  await mkdir(project, { recursive: true, mode: 0o700 });
  await writeFile(
    join(project, "aaaaaaaa-0000-4000-8000-000000000001.jsonl"),
    await readFile(new URL(`./claude/${fixtureName}`, import.meta.url), "utf8"),
    { mode: 0o600 },
  );
  return configDir;
}

/**
 * Plant a Claude Code history whose every content-bearing field holds a canary.
 *
 * Claude Code histories are far richer than the OpenCode source: beside prompt and response text
 * they carry the working directory, the git branch, a generated session title, subagent names, and
 * whole tool results. Each canary goes in the field Claude Code actually uses for it, including the
 * project directory name, which Claude Code derives from the working directory a session ran in.
 *
 * @param {string} root
 * @param {Record<string, string>} canaries
 */
export async function createClaudeCanaryHistory(root, canaries) {
  const configDir = join(root, "claude-canary-home");
  const project = join(configDir, "projects", String(canaries.path).replaceAll("/", "-"));
  await mkdir(project, { recursive: true, mode: 0o700 });
  const common = {
    isSidechain: false,
    cwd: canaries.path,
    sessionId: "bbbbbbbb-0000-4000-8000-000000000001",
    version: "2.1.220",
    gitBranch: canaries.branch,
  };
  const records = [
    {
      ...common,
      parentUuid: null,
      promptId: "p-canary",
      promptSource: "typed",
      type: "user",
      message: { role: "user", content: [{ type: "text", text: canaries.prompt }] },
      uuid: "aaaaaaa1-1111-4111-8111-111111111111",
      timestamp: "2026-01-02T02:00:00.000Z",
    },
    { type: "ai-title", aiTitle: canaries.title, sessionId: common.sessionId },
    { type: "agent-name", agentName: canaries.agent, sessionId: common.sessionId },
    {
      ...common,
      parentUuid: "aaaaaaa1-1111-4111-8111-111111111111",
      promptId: "p-canary",
      type: "user",
      message: {
        role: "user",
        content: [
          { type: "tool_result", content: `${canaries.toolResult} ${canaries.credential}` },
        ],
      },
      toolUseResult: { filePath: canaries.path, stdout: canaries.credential },
      uuid: "aaaaaaa2-2222-4222-8222-222222222222",
      timestamp: "2026-01-02T02:00:01.000Z",
    },
    {
      ...common,
      parentUuid: "aaaaaaa2-2222-4222-8222-222222222222",
      type: "assistant",
      message: {
        id: "msg_canary",
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
      uuid: "aaaaaaa3-3333-4333-8333-333333333333",
      timestamp: "2026-01-02T02:00:05.000Z",
    },
  ];
  await writeFile(
    join(project, `${common.sessionId}.jsonl`),
    `${records.map((record) => JSON.stringify(record)).join("\n")}\n`,
    { mode: 0o600 },
  );
  return configDir;
}

/**
 * Plant a Codex CLI home holding rollouts from the synthetic fixtures.
 *
 * Codex keeps rollouts under `<CODEX_HOME>/sessions/YYYY/MM/DD/rollout-*.jsonl` and honours
 * `CODEX_HOME`, which is what lets a test point SNACK at a throwaway tree. The returned value is the
 * `CODEX_HOME` to set.
 *
 * @param {string} root
 * @param {string | string[]} [fixtureNames]
 * @param {{archived?: string[]}} [options] fixtures to place in `archived_sessions` instead
 */
export async function createCodexHistory(
  root,
  fixtureNames = "version-0-159-3.jsonl",
  options = {},
) {
  const codexHome = join(root, "codex");
  const day = join(codexHome, "sessions", "2026", "01", "02");
  await mkdir(day, { recursive: true, mode: 0o700 });
  for (const name of Array.isArray(fixtureNames) ? fixtureNames : [fixtureNames]) {
    await writeFile(
      join(day, `rollout-2026-01-02T02-00-00-${name}`),
      await readFile(new URL(`./codex/${name}`, import.meta.url), "utf8"),
      { mode: 0o600 },
    );
  }
  if (options.archived && options.archived.length > 0) {
    const archived = join(codexHome, "archived_sessions");
    await mkdir(archived, { recursive: true, mode: 0o700 });
    for (const name of options.archived) {
      await writeFile(
        join(archived, `rollout-2026-01-02T02-00-00-${name}`),
        await readFile(new URL(`./codex/${name}`, import.meta.url), "utf8"),
        { mode: 0o600 },
      );
    }
  }
  return codexHome;
}

/**
 * Plant a Codex CLI home whose every never-read slot holds a canary.
 *
 * Codex rollouts keep the user's messages, the model's answers, reasoning, tool calls and their
 * output, the working directory, git remotes, and agent names in the same files as the usage
 * figures. Each canary goes in the slot Codex actually uses for it. The prompt-history file Codex
 * keeps beside `sessions/` is planted too, full of canaries, because SNACK must never open it.
 *
 * @param {string} root
 * @param {Record<string, string>} canaries
 */
export async function createCodexCanaryHistory(root, canaries) {
  const codexHome = join(root, "codex-canary-home");
  const day = join(codexHome, "sessions", "2026", "01", "02");
  await mkdir(day, { recursive: true, mode: 0o700 });
  const everything = Object.values(canaries).join(" ");
  await writeFile(
    join(codexHome, "history.jsonl"),
    `${JSON.stringify({ session_id: canaries.title, ts: 1, text: everything })}\n`,
    { mode: 0o600 },
  );
  const parentId = "00000000-0000-7000-8000-0000000000c1";
  const childId = "00000000-0000-7000-8000-0000000000c2";
  const rootTurn = "00000000-0000-7000-8000-0000000001c1";
  const childTurn = "00000000-0000-7000-8000-0000000001c2";
  const usage = {
    input_tokens: 100,
    cached_input_tokens: 10,
    output_tokens: 20,
    reasoning_output_tokens: 5,
    total_tokens: 120,
  };
  const rateLimits = {
    limit_id: "codex",
    limit_name: canaries.title,
    primary: { used_percent: 34, window_minutes: 300, resets_at: 1767335400 },
    secondary: { used_percent: 19, window_minutes: 10080, resets_at: 1767862800 },
    credits: { has_credits: true, unlimited: false, balance: canaries.credential },
    individual_limit: canaries.agent,
    plan_type: "plus",
    rate_limit_reached_type: null,
    spend_control_reached: null,
  };
  /**
   * @param {string} id
   * @param {Record<string, unknown>} identity
   * @param {[string, Record<string, unknown>][]} body
   */
  const rollout = (id, identity, body) =>
    [
      [
        "session_meta",
        {
          id,
          timestamp: canaries.title,
          cwd: canaries.path,
          originator: canaries.agent,
          cli_version: "0.159.3",
          source: canaries.agent,
          model_provider: "openai",
          base_instructions: { text: `${canaries.prompt} ${canaries.credential}` },
          git: {
            commit_hash: canaries.branch,
            branch: canaries.branch,
            repository_url: canaries.path,
          },
          runtime_workspace_roots: [canaries.path],
          creator_account_id: canaries.credential,
          creator_user_id: canaries.credential,
          ...identity,
        },
      ],
      ...body,
    ]
      .map(([type, payload], ordinal) =>
        JSON.stringify({
          timestamp: new Date(Date.UTC(2026, 0, 2, 2, 0, ordinal + 1)).toISOString(),
          type,
          payload,
          ordinal,
        }),
      )
      .join("\n");
  /** @param {string} turnId @returns {[string, Record<string, unknown>]} */
  const context = (turnId) => [
    "turn_context",
    {
      turn_id: turnId,
      cwd: canaries.path,
      workspace_roots: [canaries.path],
      current_date: canaries.title,
      timezone: canaries.title,
      model: "gpt-test",
      collaboration_mode: { settings: { developer_instructions: canaries.prompt } },
    },
  ];
  /** @type {[string, Record<string, unknown>][]} */
  const work = [
    [
      "response_item",
      { type: "message", role: "user", content: [{ type: "input_text", text: canaries.prompt }] },
    ],
    ["response_item", { type: "reasoning", summary: [{ text: canaries.response }] }],
    [
      "response_item",
      { type: "function_call", name: canaries.agent, arguments: canaries.path, call_id: "c" },
    ],
    ["response_item", { type: "function_call_output", call_id: "c", output: canaries.toolResult }],
    [
      "response_item",
      { type: "custom_tool_call", name: canaries.agent, input: canaries.credential },
    ],
    ["response_item", { type: "custom_tool_call_output", output: canaries.toolResult }],
    [
      "response_item",
      {
        type: "message",
        role: "assistant",
        content: [{ type: "output_text", text: canaries.response }],
      },
    ],
    ["event_msg", { type: "item_completed", item: { text: canaries.response } }],
    ["event_msg", { type: "thread_settings_applied", thread_settings: { cwd: canaries.path } }],
    ["world_state", { cwd: canaries.path, entries: [canaries.toolResult] }],
    ["inter_agent_communication_metadata", { trigger_turn: canaries.agent }],
  ];
  const parent = rollout(parentId, { thread_source: "user" }, [
    context(rootTurn),
    ["event_msg", { type: "task_started", turn_id: rootTurn, root_turn_id: rootTurn }],
    ...work,
    [
      "event_msg",
      {
        type: "token_count",
        info: {
          last_token_usage: usage,
          total_token_usage: usage,
          model_context_window: 1,
        },
        rate_limits: rateLimits,
      },
    ],
    [
      "token_usage_record",
      { turn_id: rootTurn, root_turn_id: rootTurn, response_id: "resp_canary_1", usage },
    ],
    ["compacted", { message: canaries.response, replacement_history: [{ text: canaries.prompt }] }],
    [
      "retained_context",
      {
        user_messages: [canaries.prompt],
        questions: [canaries.prompt],
        answers: [canaries.response],
      },
    ],
    [
      "event_msg",
      {
        type: "task_complete",
        turn_id: rootTurn,
        duration_ms: 1000,
        last_agent_message: canaries.response,
        error: { codex_error_info: "server_overloaded", message: canaries.credential },
      },
    ],
  ]);
  const child = rollout(
    childId,
    {
      thread_source: "subagent",
      parent_thread_id: parentId,
      agent_nickname: canaries.agent,
      agent_path: canaries.path,
      agent_role: canaries.agent,
    },
    [
      context(childTurn),
      ["event_msg", { type: "task_started", turn_id: childTurn, root_turn_id: rootTurn }],
      ...work,
      [
        "token_usage_record",
        { turn_id: childTurn, root_turn_id: rootTurn, response_id: "resp_canary_2", usage },
      ],
      [
        "event_msg",
        {
          type: "task_complete",
          turn_id: childTurn,
          last_agent_message: canaries.response,
        },
      ],
    ],
  );
  await writeFile(join(day, `rollout-2026-01-02T02-00-00-${parentId}.jsonl`), `${parent}\n`, {
    mode: 0o600,
  });
  await writeFile(join(day, `rollout-2026-01-02T02-00-00-${childId}.jsonl`), `${child}\n`, {
    mode: 0o600,
  });
  return codexHome;
}

export function sink() {
  return {
    value: "",
    /** @param {string} chunk */
    write(chunk) {
      this.value += chunk;
    },
  };
}

/** @param {string} databaseFile @param {string} sql */
export function executeOpenCodeSql(databaseFile, sql) {
  const database = new Database(databaseFile);
  try {
    database.exec(sql);
  } finally {
    database.close();
  }
}

/**
 * Write stated figures straight into the two tables a statement lives in, the way
 * `storeObservations` writes them, and nothing else. A whole ingestion batch would also move the
 * cursor and possibly the period, and a test comparing two histories would then be comparing two
 * different ones.
 *
 * @param {string} databaseFile
 * @param {string} alias
 * @param {string} installationId a Codex installation already bound to `alias`
 * @param {{observation_key: string, observed_at: string, limit_id: string | null, plan_type: string | null, windows: {window_minutes: number, used_percent: number, resets_at: string | null}[], parser_version: string}[]} snapshots
 * @param {Date} now
 */
export function plantStatements(databaseFile, alias, installationId, snapshots, now) {
  const database = new Database(databaseFile);
  try {
    const insert = database.prepare(
      `INSERT INTO reported_capacity_observation
         (source_alias, installation_id, observation_key, observed_at, limit_id, plan_type,
          window_minutes, used_percent, resets_at, parser_version, first_seen_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    const latest = database.prepare(
      `INSERT INTO reported_capacity_latest
         (source_alias, installation_id, limit_key, observation_key, observed_at, row_id)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT (source_alias, installation_id, limit_key) DO UPDATE
          SET observation_key = excluded.observation_key, observed_at = excluded.observed_at,
              row_id = excluded.row_id
        WHERE excluded.observed_at > reported_capacity_latest.observed_at
           OR (excluded.observed_at = reported_capacity_latest.observed_at
               AND excluded.row_id > reported_capacity_latest.row_id)`,
    );
    for (const snapshot of snapshots) {
      let row = 0;
      for (const window of snapshot.windows) {
        row = Number(
          insert.run(
            alias,
            installationId,
            snapshot.observation_key,
            snapshot.observed_at,
            snapshot.limit_id,
            snapshot.plan_type,
            window.window_minutes,
            window.used_percent,
            window.resets_at,
            snapshot.parser_version,
            now.toISOString(),
          ).lastInsertRowid,
        );
      }
      latest.run(
        alias,
        installationId,
        snapshot.limit_id ?? "",
        snapshot.observation_key,
        snapshot.observed_at,
        row,
      );
    }
  } finally {
    database.close();
  }
}
