import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
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

/** @param {string} [prefix] */
export async function makeRunFixture(prefix = "snack-main-") {
  const root = await mkdtemp(join(tmpdir(), prefix));
  temporaryRoots.push(root);
  const stdout = sink();
  const stderr = sink();
  /** @type {{XDG_CONFIG_HOME: string, XDG_DATA_HOME: string, XDG_CACHE_HOME: string, XDG_STATE_HOME: string, OPENCODE_DB?: string, CLAUDE_CONFIG_DIR?: string}} */
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
