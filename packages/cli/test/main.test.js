import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, test } from "node:test";

import Database from "better-sqlite3";

import { getConfigValue, readConfig } from "../src/config.js";
import { SnackError } from "../src/errors.js";
import { run } from "../src/main.js";
import { classifyRisk } from "../src/status.js";
import { initializeDatabase, inspectDatabase } from "../src/storage.js";

const privacyCanaries = JSON.parse(
  await readFile(new URL("./fixtures/privacy-canaries.json", import.meta.url), "utf8"),
);

/** @type {string[]} */
const temporaryRoots = [];

afterEach(async () => {
  await Promise.all(
    temporaryRoots.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

test("config set initializes storage before returning a stable JSON envelope", async () => {
  const fixture = await makeRunFixture();
  const exitCode = await run(
    ["node", "snack", "config", "set", "presentation.json", "true", "--json"],
    fixture.options,
  );
  const document = JSON.parse(fixture.stdout.value);

  assert.equal(exitCode, 0);
  assert.equal(document.schema_version, "1");
  assert.equal(document.command, "config set");
  assert.equal(document.status, "ok");
  assert.equal(document.data.value, true);
  assert.deepEqual(document.data.storage.applied, [1, 2, 3, 4]);
  assert.equal(fixture.stderr.value, "");
});

test("uses the configured JSON presentation default", async () => {
  const fixture = await makeRunFixture();
  await run(
    ["node", "snack", "config", "set", "presentation.json", "true", "--json"],
    fixture.options,
  );
  fixture.stdout.value = "";
  fixture.stderr.value = "";

  const exitCode = await run(["node", "snack", "config", "get"], fixture.options);
  const document = JSON.parse(fixture.stdout.value);

  assert.equal(exitCode, 0);
  assert.equal(document.command, "config get");
  assert.equal(document.status, "ok");
});

test("serializes concurrent configuration updates without losing fields", async () => {
  const fixture = await makeRunFixture();
  const firstOutput = sink();
  const secondOutput = sink();

  const results = await Promise.all([
    run(["node", "snack", "config", "set", "presentation.json", "true", "--json"], {
      ...fixture.options,
      stdout: firstOutput,
    }),
    run(["node", "snack", "config", "set", "analysis.horizons", '["PT2H"]', "--json"], {
      ...fixture.options,
      stdout: secondOutput,
    }),
  ]);
  const config = await readConfig(fixture.paths.configFile);

  assert.deepEqual(results, [0, 0]);
  assert.equal(getConfigValue(config, "presentation.json"), true);
  assert.deepEqual(getConfigValue(config, "analysis.horizons"), ["PT2H"]);
});

test("doctor is read-only and treats missing state as degraded", async () => {
  const fixture = await makeRunFixture();
  const exitCode = await run(["node", "snack", "doctor", "--json"], fixture.options);
  const document = JSON.parse(fixture.stdout.value);

  assert.equal(exitCode, 0);
  assert.equal(document.status, "degraded");
  assert.deepEqual(await readdir(fixture.root), []);
});

test("doctor passes after configuration and storage initialization", async () => {
  const fixture = await makeRunFixture();
  assert.equal(
    await run(["node", "snack", "config", "set", "presentation.json", "false"], fixture.options),
    0,
  );
  await initializeDatabase(fixture.paths);
  fixture.stdout.value = "";
  fixture.stderr.value = "";

  const exitCode = await run(["node", "snack", "doctor", "--json"], fixture.options);
  const document = JSON.parse(fixture.stdout.value);
  /** @type {{status: string}[]} */
  const checks = document.data.checks;

  assert.equal(exitCode, 0);
  assert.equal(document.status, "ok");
  assert.ok(checks.every((check) => check.status === "pass"));
});

test("human doctor routes warnings to stderr", async () => {
  const fixture = await makeRunFixture();
  const exitCode = await run(["node", "snack", "doctor"], fixture.options);

  assert.equal(exitCode, 0);
  assert.match(fixture.stdout.value, /^\[pass\]/mu);
  assert.doesNotMatch(fixture.stdout.value, /\[warn\]|\[fail\]/u);
  assert.match(fixture.stderr.value, /\[warn\] config:/u);
});

test("JSON errors contain no incidental output", async () => {
  const fixture = await makeRunFixture();
  const exitCode = await run(["node", "snack", "config", "get", "--json"], fixture.options);
  const document = JSON.parse(fixture.stdout.value);

  assert.equal(exitCode, 3);
  assert.equal(document.status, "error");
  assert.equal(document.errors[0].code, "config_missing");
  assert.equal(fixture.stderr.value, "");
});

test("invalid private input is neither persisted nor echoed", async () => {
  const fixture = await makeRunFixture();
  for (const canary of Object.values(privacyCanaries)) {
    fixture.stdout.value = "";
    fixture.stderr.value = "";
    const exitCode = await run(
      ["node", "snack", "config", "set", "presentation.json", String(canary), "--json"],
      fixture.options,
    );

    assert.equal(exitCode, 3);
    assert.doesNotMatch(fixture.stdout.value, new RegExp(String(canary), "u"));
    assert.doesNotMatch(fixture.stderr.value, new RegExp(String(canary), "u"));
    assert.doesNotMatch(await readTree(fixture.root), new RegExp(String(canary), "u"));
  }
  assert.deepEqual(await readdir(fixture.root), []);
});

test("storage failure cannot commit a prepared configuration update", async () => {
  const fixture = await makeRunFixture();
  await writeFile(fixture.dataHome, "not a directory", { mode: 0o600 });

  const exitCode = await run(
    ["node", "snack", "config", "set", "presentation.json", "true", "--json"],
    fixture.options,
  );

  assert.equal(exitCode, 5);
  assert.equal(JSON.parse(fixture.stdout.value).errors[0].code, "storage_initialization_error");
  await assert.rejects(readFile(fixture.paths.configFile, "utf8"), { code: "ENOENT" });
});

test("doctor rejects permissive configuration backups", async () => {
  const fixture = await makeRunFixture();
  await run(["node", "snack", "config", "set", "presentation.json", "false"], fixture.options);
  await run(["node", "snack", "config", "set", "presentation.json", "true"], fixture.options);
  await chmod(`${fixture.paths.configFile}.bak`, 0o644);
  fixture.stdout.value = "";
  fixture.stderr.value = "";

  const exitCode = await run(["node", "snack", "doctor", "--json"], fixture.options);
  const document = JSON.parse(fixture.stdout.value);
  /** @type {{id: string, status: string}[]} */
  const checks = document.data.checks;

  assert.equal(exitCode, 3);
  assert.ok(checks.some((check) => check.id === "config_backup" && check.status === "fail"));
});

test("doctor rejects permissive database backups", async () => {
  const fixture = await makeRunFixture();
  await run(["node", "snack", "config", "set", "presentation.json", "false"], fixture.options);
  await writeFile(join(fixture.paths.backupDir, "unsafe.sqlite3"), "not a backup", {
    mode: 0o644,
  });
  fixture.stdout.value = "";
  fixture.stderr.value = "";

  const exitCode = await run(["node", "snack", "doctor", "--json"], fixture.options);
  const document = JSON.parse(fixture.stdout.value);
  /** @type {{id: string, status: string}[]} */
  const checks = document.data.checks;

  assert.equal(exitCode, 5);
  assert.ok(checks.some((check) => check.id === "backup_files" && check.status === "fail"));
});

test("doctor reports a persistent storage lock", async () => {
  const fixture = await makeRunFixture();
  await run(["node", "snack", "config", "set", "presentation.json", "false"], fixture.options);
  await mkdir(`${fixture.paths.databaseFile}.lock`, { mode: 0o700 });
  fixture.stdout.value = "";
  fixture.stderr.value = "";

  const exitCode = await run(["node", "snack", "doctor", "--json"], fixture.options);
  const document = JSON.parse(fixture.stdout.value);
  /** @type {{code: string}[]} */
  const warnings = document.warnings;

  assert.equal(exitCode, 0);
  assert.equal(document.status, "degraded");
  assert.ok(warnings.some((warning) => warning.code === "storage_lock"));
});

test("invalid command usage exits with code 2 and valid JSON", async () => {
  const fixture = await makeRunFixture();
  const exitCode = await run(["node", "snack", "unknown", "--json"], fixture.options);
  const document = JSON.parse(fixture.stdout.value);

  assert.equal(exitCode, 2);
  assert.equal(document.errors[0].code, "invalid_usage");
  assert.equal(fixture.stderr.value, "");
});

test("setup opencode configures an explicit source after a compatible dry-run", async () => {
  const fixture = await makeRunFixture();
  const openCodeDatabase = await createOpenCodeDatabase(fixture.root);
  fixture.options.env.OPENCODE_DB = openCodeDatabase;

  const exitCode = await run(
    [
      "node",
      "snack",
      "setup",
      "opencode",
      "--non-interactive",
      "--source",
      "personal-anthropic",
      "--provider",
      "anthropic",
      "--profile",
      "personal",
      "--plan",
      "generic",
      "--json",
    ],
    fixture.options,
  );
  const setup = JSON.parse(fixture.stdout.value);
  fixture.stdout.value = "";
  const configExitCode = await run(
    ["node", "snack", "config", "get", "sources", "--json"],
    fixture.options,
  );
  const configuredSources = JSON.parse(fixture.stdout.value).data?.value;

  assert.deepEqual(
    {
      exitCode,
      configExitCode,
      command: setup.command,
      status: setup.status,
      data: setup.data,
      configuredSources,
    },
    {
      exitCode: 0,
      configExitCode: 0,
      command: "setup opencode",
      status: "ok",
      data: {
        source: {
          alias: "personal-anthropic",
          installation_id: configuredSources[0].installation_id,
          adapter: "opencode",
          provider: "anthropic",
          profile: "personal",
          plan: "generic",
        },
        fingerprint: {
          family: "oc-sqlite-msgpart-v1",
          supported: true,
        },
        dry_run: { observations: 1 },
      },
      configuredSources: [
        {
          alias: "personal-anthropic",
          installation_id: configuredSources[0].installation_id,
          adapter: "opencode",
          database: openCodeDatabase,
          provider: "anthropic",
          profile: "personal",
          plan: "generic",
          fingerprint: "oc-sqlite-msgpart-v1",
        },
      ],
    },
  );
  assert.doesNotMatch(JSON.stringify(setup), /PRIVATE_PROMPT_CANARY/u);
});

test("full sync converges without duplicating OpenCode usage records", async () => {
  const fixture = await makeRunFixture();
  fixture.options.env.OPENCODE_DB = await createOpenCodeDatabase(fixture.root);
  await run(
    [
      "node",
      "snack",
      "setup",
      "opencode",
      "--non-interactive",
      "--source",
      "personal-anthropic",
      "--provider",
      "anthropic",
      "--profile",
      "personal",
      "--plan",
      "generic",
      "--json",
    ],
    fixture.options,
  );
  fixture.stdout.value = "";

  const firstExitCode = await run(
    ["node", "snack", "sync", "--source", "personal-anthropic", "--full", "--json"],
    fixture.options,
  );
  const first = JSON.parse(fixture.stdout.value);
  fixture.stdout.value = "";
  const secondExitCode = await run(
    ["node", "snack", "sync", "--source", "personal-anthropic", "--full", "--json"],
    fixture.options,
  );
  const second = JSON.parse(fixture.stdout.value);

  assert.deepEqual(
    {
      firstExitCode,
      first: first.data?.sources,
      secondExitCode,
      second: second.data?.sources,
    },
    {
      firstExitCode: 0,
      first: [
        {
          alias: "personal-anthropic",
          path: "backfill",
          read: 1,
          inserted: 1,
          updated: 0,
          unchanged: 0,
          excluded: 0,
          pending_mapping: 0,
          rejected_invalid: 0,
          failed: 0,
        },
      ],
      secondExitCode: 0,
      second: [
        {
          alias: "personal-anthropic",
          path: "backfill",
          read: 1,
          inserted: 0,
          updated: 0,
          unchanged: 1,
          excluded: 0,
          pending_mapping: 0,
          rejected_invalid: 0,
          failed: 0,
        },
      ],
    },
  );
});

test("human sync reports every required count", async () => {
  const fixture = await makeRunFixture();
  fixture.options.env.OPENCODE_DB = await createOpenCodeDatabase(fixture.root);
  await run(
    [
      "node",
      "snack",
      "setup",
      "opencode",
      "--non-interactive",
      "--source",
      "personal-anthropic",
      "--provider",
      "anthropic",
      "--profile",
      "personal",
      "--plan",
      "generic",
    ],
    fixture.options,
  );
  fixture.stdout.value = "";

  assert.equal(
    await run(
      ["node", "snack", "sync", "--source", "personal-anthropic", "--full"],
      fixture.options,
    ),
    0,
  );

  assert.match(
    fixture.stdout.value,
    /personal-anthropic: 1 read, 1 inserted, 0 updated, 0 unchanged, 0 excluded, 0 pending_mapping, 0 rejected_invalid, 0 failed\./u,
  );
});

test("status reports a broad initial estimate with very low evidence", async () => {
  const fixture = await makeRunFixture();
  fixture.options.now = new Date("2026-01-02T03:05:00.000Z");
  fixture.options.env.OPENCODE_DB = await createOpenCodeDatabase(fixture.root);
  await run(
    [
      "node",
      "snack",
      "setup",
      "opencode",
      "--non-interactive",
      "--source",
      "personal-anthropic",
      "--provider",
      "anthropic",
      "--profile",
      "personal",
      "--plan",
      "generic",
      "--json",
    ],
    fixture.options,
  );
  fixture.stdout.value = "";
  await run(
    ["node", "snack", "sync", "--source", "personal-anthropic", "--full", "--json"],
    fixture.options,
  );
  fixture.stdout.value = "";

  const exitCode = await run(
    ["node", "snack", "status", "--source", "personal-anthropic", "--no-sync", "--json"],
    fixture.options,
  );
  const document = JSON.parse(fixture.stdout.value);

  assert.deepEqual(
    { exitCode, command: document.command, status: document.status, data: document.data },
    {
      exitCode: 0,
      command: "status",
      status: "degraded",
      data: {
        source: {
          alias: "personal-anthropic",
          provider: "anthropic",
          profile: "personal",
          plan: "generic",
          active_period: { started_at: "2026-01-02T03:05:00.000Z" },
          plan_profile: { id: "generic", version: "stage2-v1" },
        },
        viability: {
          lower: 0.2666666666666666,
          point: 0.6666666666666666,
          upper: 0.95,
          coverage_target: 0.8,
        },
        risk: { label: "high", policy_version: "stage2-risk-v2" },
        evidence: "very_low",
        method: { id: "initial-generic", version: "1" },
        contributors: {
          prior: { alpha: 1, beta: 1 },
          observed: { successes: 1, restrictions: 0 },
        },
        pressure: { band: "unknown", policy_version: "stage2-placeholder-v1" },
        expected_prompt_category: "typical",
        observed: { prompts: 1, successes: 1, restrictions: 0, excluded: 0 },
        freshness: { as_of: "2026-01-02T03:04:10.000Z", age_seconds: 50 },
        completeness: "partial",
        synchronization: { performed: false, status: "not_requested" },
        caveats: [
          "Initial heuristic; this is not a calibrated probability.",
          "Real provider capacity is unknown.",
          "Usage pressure analytics are not available in Stage 2.",
        ],
      },
    },
  );
});

test("initial risk labels use the lower viability bound and its versioned thresholds", () => {
  assert.deepEqual(
    [0.49, 0.5, 0.749, 0.75].map((lower) => ({ lower, ...classifyRisk(lower) })),
    [
      { lower: 0.49, label: "high", policy_version: "stage2-risk-v2" },
      { lower: 0.5, label: "elevated", policy_version: "stage2-risk-v2" },
      { lower: 0.749, label: "elevated", policy_version: "stage2-risk-v2" },
      { lower: 0.75, label: "low", policy_version: "stage2-risk-v2" },
    ],
  );
});

test("status synchronizes incrementally by default", async () => {
  const fixture = await makeRunFixture();
  fixture.options.now = new Date("2026-01-02T03:05:00.000Z");
  fixture.options.env.OPENCODE_DB = await createOpenCodeDatabase(fixture.root);
  await run(
    [
      "node",
      "snack",
      "setup",
      "opencode",
      "--non-interactive",
      "--source",
      "personal-anthropic",
      "--provider",
      "anthropic",
      "--profile",
      "personal",
      "--plan",
      "generic",
      "--json",
    ],
    fixture.options,
  );
  fixture.stdout.value = "";

  const exitCode = await run(
    ["node", "snack", "status", "--source", "personal-anthropic", "--json"],
    fixture.options,
  );
  const document = JSON.parse(fixture.stdout.value);

  assert.deepEqual(
    {
      exitCode,
      observed: document.data.observed,
      synchronization: document.data.synchronization,
    },
    {
      exitCode: 0,
      observed: { prompts: 1, successes: 1, restrictions: 0, excluded: 0 },
      synchronization: { performed: true, status: "ok" },
    },
  );
});

test("doctor reports configured OpenCode fingerprint mapping and freshness", async () => {
  const fixture = await makeRunFixture();
  fixture.options.now = new Date("2026-01-02T03:05:00.000Z");
  fixture.options.env.OPENCODE_DB = await createOpenCodeDatabase(fixture.root);
  await run(
    [
      "node",
      "snack",
      "setup",
      "opencode",
      "--non-interactive",
      "--source",
      "personal-anthropic",
      "--provider",
      "anthropic",
      "--profile",
      "personal",
      "--plan",
      "generic",
      "--json",
    ],
    fixture.options,
  );
  fixture.stdout.value = "";
  await run(
    ["node", "snack", "sync", "--source", "personal-anthropic", "--full", "--json"],
    fixture.options,
  );
  fixture.stdout.value = "";

  const exitCode = await run(["node", "snack", "doctor", "--json"], fixture.options);
  const document = JSON.parse(fixture.stdout.value);
  const checks = /** @type {{id: string, status: string}[]} */ (document.data.checks);
  const sourceChecks = checks
    .filter((check) => check.id.startsWith("source_"))
    .map((check) => ({ id: check.id, status: check.status }));

  assert.deepEqual(
    { exitCode, status: document.status, sourceChecks },
    {
      exitCode: 0,
      status: "degraded",
      sourceChecks: [
        { id: "source_fingerprint:personal-anthropic", status: "pass" },
        { id: "source_mapping:personal-anthropic", status: "pass" },
        { id: "source_freshness:personal-anthropic", status: "pass" },
      ],
    },
  );
  assert.doesNotMatch(fixture.stdout.value, new RegExp(fixture.options.env.OPENCODE_DB, "u"));
});

test("incremental sync detects allowlisted metadata changes at the cursor timestamp", async () => {
  const fixture = await makeRunFixture();
  fixture.options.env.OPENCODE_DB = await createOpenCodeDatabase(fixture.root);
  await run(
    [
      "node",
      "snack",
      "setup",
      "opencode",
      "--non-interactive",
      "--source",
      "personal-anthropic",
      "--provider",
      "anthropic",
      "--profile",
      "personal",
      "--plan",
      "generic",
      "--json",
    ],
    fixture.options,
  );
  fixture.stdout.value = "";
  await run(
    ["node", "snack", "sync", "--source", "personal-anthropic", "--full", "--json"],
    fixture.options,
  );
  executeOpenCodeSql(
    fixture.options.env.OPENCODE_DB,
    `UPDATE part
     SET data = '{"type":"step-finish","reason":"stop","cost":0.003,"tokens":{"input":120,"output":25,"reasoning":5,"cache":{"read":10,"write":2}}}'
     WHERE id = 'step-finish-1';`,
  );
  fixture.stdout.value = "";

  const exitCode = await run(
    ["node", "snack", "sync", "--source", "personal-anthropic", "--json"],
    fixture.options,
  );
  const result = JSON.parse(fixture.stdout.value).data.sources[0];

  assert.deepEqual(
    { exitCode, read: result.read, updated: result.updated, unchanged: result.unchanged },
    { exitCode: 0, read: 1, updated: 1, unchanged: 0 },
  );
});

test("setup dry-run validates the proposal without creating SNACK state", async () => {
  const fixture = await makeRunFixture();
  fixture.options.env.OPENCODE_DB = await createOpenCodeDatabase(fixture.root);

  const exitCode = await run(
    [
      "node",
      "snack",
      "setup",
      "opencode",
      "--non-interactive",
      "--source",
      "personal-anthropic",
      "--provider",
      "anthropic",
      "--profile",
      "personal",
      "--plan",
      "generic",
      "--dry-run",
      "--json",
    ],
    fixture.options,
  );
  const setup = JSON.parse(fixture.stdout.value);
  fixture.stdout.value = "";
  const configExitCode = await run(
    ["node", "snack", "config", "get", "sources", "--json"],
    fixture.options,
  );
  const configResult = JSON.parse(fixture.stdout.value);

  assert.deepEqual(
    {
      exitCode,
      setupStatus: setup.status,
      dryRun: setup.data?.dry_run,
      configExitCode,
      configError: configResult.errors[0]?.code,
    },
    {
      exitCode: 0,
      setupStatus: "ok",
      dryRun: { observations: 1, applied: false },
      configExitCode: 3,
      configError: "config_missing",
    },
  );
});

test("unmatched provider metadata remains pending and degrades mapping health", async () => {
  const fixture = await makeRunFixture();
  fixture.options.env.OPENCODE_DB = await createOpenCodeDatabase(fixture.root);
  await run(
    [
      "node",
      "snack",
      "setup",
      "opencode",
      "--non-interactive",
      "--source",
      "personal-openai",
      "--provider",
      "openai",
      "--profile",
      "personal",
      "--plan",
      "generic",
      "--json",
    ],
    fixture.options,
  );
  fixture.stdout.value = "";

  const syncExitCode = await run(
    ["node", "snack", "sync", "--source", "personal-openai", "--full", "--json"],
    fixture.options,
  );
  const sync = JSON.parse(fixture.stdout.value).data.sources[0];
  fixture.stdout.value = "";
  const doctorExitCode = await run(["node", "snack", "doctor", "--json"], fixture.options);
  const doctor = JSON.parse(fixture.stdout.value);
  const checks = /** @type {{id: string, status: string}[]} */ (doctor.data.checks);
  const mapping = checks.find((check) => check.id === "source_mapping:personal-openai");

  assert.deepEqual(
    {
      syncExitCode,
      inserted: sync.inserted,
      pendingMapping: sync.pending_mapping,
      doctorExitCode,
      doctorStatus: doctor.status,
      mappingStatus: mapping?.status,
    },
    {
      syncExitCode: 0,
      inserted: 0,
      pendingMapping: 1,
      doctorExitCode: 0,
      doctorStatus: "degraded",
      mappingStatus: "warn",
    },
  );
});

test("an older revision preserves finality while adding restriction evidence", async () => {
  const fixture = await makeRunFixture();
  fixture.options.now = new Date("2026-01-02T03:05:00.000Z");
  fixture.options.env.OPENCODE_DB = await createOpenCodeDatabase(fixture.root);
  await run(
    [
      "node",
      "snack",
      "setup",
      "opencode",
      "--non-interactive",
      "--source",
      "personal-anthropic",
      "--provider",
      "anthropic",
      "--profile",
      "personal",
      "--plan",
      "generic",
      "--json",
    ],
    fixture.options,
  );
  fixture.stdout.value = "";
  await run(
    ["node", "snack", "sync", "--source", "personal-anthropic", "--full", "--json"],
    fixture.options,
  );
  executeOpenCodeSql(
    fixture.options.env.OPENCODE_DB,
    `UPDATE message
     SET time_updated = 1767323049000,
         data = '{"role":"assistant","time":{"created":1767323046000,"completed":1767323049000},"parentID":"user-1","providerID":"anthropic","modelID":"claude-sonnet","error":{"name":"APIError","data":{"statusCode":429,"message":"PRIVATE_STALE_CANARY"}},"cost":0.003,"tokens":{"input":100,"output":25,"reasoning":5,"cache":{"read":10,"write":2}}}'
     WHERE id = 'assistant-1';
     UPDATE part SET time_updated = 1767323049000 WHERE id = 'step-finish-1';`,
  );
  fixture.stdout.value = "";

  await run(
    ["node", "snack", "sync", "--source", "personal-anthropic", "--full", "--json"],
    fixture.options,
  );
  const sync = JSON.parse(fixture.stdout.value).data.sources[0];
  fixture.stdout.value = "";
  await run(
    ["node", "snack", "status", "--source", "personal-anthropic", "--no-sync", "--json"],
    fixture.options,
  );
  const observed = JSON.parse(fixture.stdout.value).data.observed;

  assert.deepEqual(
    { updated: sync.updated, unchanged: sync.unchanged, observed },
    {
      updated: 0,
      unchanged: 1,
      observed: { prompts: 1, successes: 0, restrictions: 1, excluded: 0 },
    },
  );
  assert.doesNotMatch(fixture.stdout.value, /PRIVATE_STALE_CANARY/u);
});

test("two provider mappings for one OpenCode database share one installation identity", async () => {
  const fixture = await makeRunFixture();
  fixture.options.env.OPENCODE_DB = await createOpenCodeDatabase(fixture.root);
  const mappings = /** @type {[string, string][]} */ ([
    ["personal-anthropic", "anthropic"],
    ["personal-openai", "openai"],
  ]);
  for (const [alias, provider] of mappings) {
    await run(
      [
        "node",
        "snack",
        "setup",
        "opencode",
        "--non-interactive",
        "--source",
        alias,
        "--provider",
        provider,
        "--profile",
        "personal",
        "--plan",
        "generic",
        "--json",
      ],
      fixture.options,
    );
    fixture.stdout.value = "";
  }

  await run(["node", "snack", "config", "get", "sources", "--json"], fixture.options);
  const sources = /** @type {{alias: string, installation_id: string}[]} */ (
    JSON.parse(fixture.stdout.value).data.value
  );
  const firstSource = sources[0];
  assert.ok(firstSource);

  assert.deepEqual(
    {
      aliases: sources.map((source) => source.alias),
      installationIds: [...new Set(sources.map((source) => source.installation_id))],
    },
    {
      aliases: ["personal-anthropic", "personal-openai"],
      installationIds: [firstSource.installation_id],
    },
  );
  assert.match(firstSource.installation_id, /^[0-9a-f-]{36}$/u);
});

test("ambiguous OpenCode provider profiles remain pending without affecting forecasts", async () => {
  const fixture = await makeRunFixture();
  fixture.options.now = new Date("2026-01-02T03:05:00.000Z");
  fixture.options.env.OPENCODE_DB = await createOpenCodeDatabase(fixture.root);
  /** @param {string} alias @param {string} profile */
  const setup = (alias, profile) =>
    run(
      [
        "node",
        "snack",
        "setup",
        "opencode",
        "--non-interactive",
        "--source",
        alias,
        "--provider",
        "anthropic",
        "--profile",
        profile,
        "--plan",
        "generic",
        "--json",
      ],
      fixture.options,
    );

  assert.equal(await setup("personal-anthropic", "personal"), 0);
  fixture.stdout.value = "";
  assert.equal(await setup("work-anthropic", "work"), 0);
  fixture.stdout.value = "";
  assert.equal(await run(["node", "snack", "sync", "--full", "--json"], fixture.options), 0);
  const sync = /** @type {{alias: string, pending_mapping: number}[]} */ (
    JSON.parse(fixture.stdout.value).data.sources
  );
  fixture.stdout.value = "";
  await run(["node", "snack", "status", "--no-sync", "--json"], fixture.options);
  const statuses = /** @type {{source: {alias: string}, observed: {prompts: number}}[]} */ (
    JSON.parse(fixture.stdout.value).data.sources
  );
  fixture.stdout.value = "";
  await run(["node", "snack", "doctor", "--json"], fixture.options);
  const checks = /** @type {{id: string, status: string}[]} */ (
    JSON.parse(fixture.stdout.value).data.checks
  );

  assert.deepEqual(
    sync.map((result) => ({ alias: result.alias, pending_mapping: result.pending_mapping })),
    [
      { alias: "personal-anthropic", pending_mapping: 1 },
      { alias: "work-anthropic", pending_mapping: 1 },
    ],
  );
  assert.deepEqual(
    statuses.map((status) => ({ alias: status.source.alias, prompts: status.observed.prompts })),
    [
      { alias: "personal-anthropic", prompts: 0 },
      { alias: "work-anthropic", prompts: 0 },
    ],
  );
  assert.deepEqual(
    checks
      .filter((check) => check.id.startsWith("source_mapping:"))
      .map((check) => ({ id: check.id, status: check.status })),
    [
      { id: "source_mapping:personal-anthropic", status: "warn" },
      { id: "source_mapping:work-anthropic", status: "warn" },
    ],
  );
});

test("mapped providers do not create false pending mappings on sibling sources", async () => {
  const fixture = await makeRunFixture();
  fixture.options.env.OPENCODE_DB = await createOpenCodeDatabase(fixture.root);
  const mappings = /** @type {[string, string][]} */ ([
    ["personal-anthropic", "anthropic"],
    ["personal-openai", "openai"],
  ]);
  for (const [alias, provider] of mappings) {
    await run(
      [
        "node",
        "snack",
        "setup",
        "opencode",
        "--non-interactive",
        "--source",
        alias,
        "--provider",
        provider,
        "--profile",
        "personal",
        "--plan",
        "generic",
        "--json",
      ],
      fixture.options,
    );
    fixture.stdout.value = "";
  }

  await run(["node", "snack", "sync", "--full", "--json"], fixture.options);
  fixture.stdout.value = "";
  await run(["node", "snack", "doctor", "--json"], fixture.options);
  const checks = /** @type {{id: string, status: string}[]} */ (
    JSON.parse(fixture.stdout.value).data.checks
  );

  assert.deepEqual(
    checks
      .filter((check) => check.id.startsWith("source_mapping:"))
      .map((check) => ({ id: check.id, status: check.status })),
    [
      { id: "source_mapping:personal-anthropic", status: "pass" },
      { id: "source_mapping:personal-openai", status: "pass" },
    ],
  );
});

test("completed finality beats a newer provisional revision", async () => {
  const fixture = await makeRunFixture();
  fixture.options.now = new Date("2026-01-02T03:05:00.000Z");
  fixture.options.env.OPENCODE_DB = await createOpenCodeDatabase(fixture.root);
  await run(
    [
      "node",
      "snack",
      "setup",
      "opencode",
      "--non-interactive",
      "--source",
      "personal-anthropic",
      "--provider",
      "anthropic",
      "--profile",
      "personal",
      "--plan",
      "generic",
      "--json",
    ],
    fixture.options,
  );
  executeOpenCodeSql(
    fixture.options.env.OPENCODE_DB,
    `UPDATE message
     SET time_updated = 1767323060000,
         data = '{"role":"assistant","time":{"created":1767323046000},"parentID":"user-1","providerID":"anthropic","modelID":"claude-sonnet","cost":0.003,"tokens":{"input":100,"output":25,"reasoning":5,"cache":{"read":10,"write":2}}}'
     WHERE id = 'assistant-1';
     UPDATE part SET time_updated = 1767323060000 WHERE id = 'step-finish-1';`,
  );
  fixture.stdout.value = "";
  await run(
    ["node", "snack", "sync", "--source", "personal-anthropic", "--full", "--json"],
    fixture.options,
  );
  executeOpenCodeSql(
    fixture.options.env.OPENCODE_DB,
    `UPDATE message
     SET time_updated = 1767323050000,
         data = '{"role":"assistant","time":{"created":1767323046000,"completed":1767323050000},"parentID":"user-1","providerID":"anthropic","modelID":"claude-sonnet","finish":"stop","cost":0.003,"tokens":{"input":100,"output":25,"reasoning":5,"cache":{"read":10,"write":2}}}'
     WHERE id = 'assistant-1';
     UPDATE part SET time_updated = 1767323050000 WHERE id = 'step-finish-1';`,
  );
  fixture.stdout.value = "";

  await run(
    ["node", "snack", "sync", "--source", "personal-anthropic", "--full", "--json"],
    fixture.options,
  );
  const sync = JSON.parse(fixture.stdout.value).data.sources[0];
  fixture.stdout.value = "";
  await run(
    ["node", "snack", "status", "--source", "personal-anthropic", "--no-sync", "--json"],
    fixture.options,
  );
  const observed = JSON.parse(fixture.stdout.value).data.observed;

  assert.deepEqual(
    { updated: sync.updated, unchanged: sync.unchanged, observed },
    {
      updated: 1,
      unchanged: 0,
      observed: { prompts: 1, successes: 1, restrictions: 0, excluded: 0 },
    },
  );
});

test("revision ordering uses message id as the timestamp tiebreak", async () => {
  const fixture = await makeRunFixture();
  fixture.options.env.OPENCODE_DB = await createOpenCodeDatabase(fixture.root);
  await run(
    [
      "node",
      "snack",
      "setup",
      "opencode",
      "--non-interactive",
      "--source",
      "personal-anthropic",
      "--provider",
      "anthropic",
      "--profile",
      "personal",
      "--plan",
      "generic",
      "--json",
    ],
    fixture.options,
  );
  executeOpenCodeSql(
    fixture.options.env.OPENCODE_DB,
    `INSERT INTO message (id, session_id, time_created, time_updated, data)
       SELECT 'assistant-z', session_id, time_created, time_updated, data
       FROM message WHERE id = 'assistant-1';
     UPDATE part SET message_id = 'assistant-z' WHERE message_id = 'assistant-1';
     DELETE FROM message WHERE id = 'assistant-1';`,
  );
  fixture.stdout.value = "";
  await run(
    ["node", "snack", "sync", "--source", "personal-anthropic", "--full", "--json"],
    fixture.options,
  );
  executeOpenCodeSql(
    fixture.options.env.OPENCODE_DB,
    `INSERT INTO message (id, session_id, time_created, time_updated, data)
       SELECT 'assistant-a', session_id, time_created, time_updated, data
       FROM message WHERE id = 'assistant-z';
     UPDATE part SET message_id = 'assistant-a' WHERE message_id = 'assistant-z';
     DELETE FROM message WHERE id = 'assistant-z';`,
  );
  fixture.stdout.value = "";

  await run(
    ["node", "snack", "sync", "--source", "personal-anthropic", "--full", "--json"],
    fixture.options,
  );
  const sync = JSON.parse(fixture.stdout.value).data.sources[0];

  assert.deepEqual(
    { updated: sync.updated, unchanged: sync.unchanged },
    { updated: 0, unchanged: 1 },
  );
});

test("plan changes keep historical prompts in their original capacity period", async () => {
  const fixture = await makeRunFixture();
  fixture.options.now = new Date("2026-01-02T03:05:00.000Z");
  fixture.options.env.OPENCODE_DB = await createOpenCodeDatabase(fixture.root);
  /** @param {string} plan @returns {string[]} */
  const setupArgs = (plan) => [
    "node",
    "snack",
    "setup",
    "opencode",
    "--non-interactive",
    "--source",
    "personal-anthropic",
    "--provider",
    "anthropic",
    "--profile",
    "personal",
    "--plan",
    plan,
    "--json",
  ];
  await run(setupArgs("generic"), fixture.options);
  fixture.stdout.value = "";
  await run(
    ["node", "snack", "sync", "--source", "personal-anthropic", "--full", "--json"],
    fixture.options,
  );
  fixture.options.now = new Date("2026-01-02T04:00:00.000Z");
  fixture.stdout.value = "";
  await run(setupArgs("pro"), fixture.options);
  fixture.stdout.value = "";
  await run(
    ["node", "snack", "status", "--source", "personal-anthropic", "--no-sync", "--json"],
    fixture.options,
  );
  const setupStatus = JSON.parse(fixture.stdout.value).data;
  assert.deepEqual(
    {
      activePeriod: setupStatus.source.active_period.started_at,
      observed: setupStatus.observed,
      plan: setupStatus.source.plan,
    },
    {
      activePeriod: "2026-01-02T04:00:00.000Z",
      observed: { prompts: 0, successes: 0, restrictions: 0, excluded: 0 },
      plan: "pro",
    },
  );
  fixture.stdout.value = "";
  await run(
    ["node", "snack", "sync", "--source", "personal-anthropic", "--full", "--json"],
    fixture.options,
  );
  executeOpenCodeSql(
    fixture.options.env.OPENCODE_DB,
    `INSERT INTO message (id, session_id, time_created, time_updated, data) VALUES
      ('user-late', 'session-1', 1767323060000, 1767323060000, '{"role":"user","time":{"created":1767323060000},"agent":"build","model":{"providerID":"anthropic","modelID":"claude-sonnet"}}'),
      ('assistant-late', 'session-1', 1767323061000, 1767323062000, '{"role":"assistant","time":{"created":1767323061000,"completed":1767323062000},"parentID":"user-late","providerID":"anthropic","modelID":"claude-sonnet","finish":"stop","cost":0,"tokens":{"input":0,"output":0,"reasoning":0,"cache":{"read":0,"write":0}}}');`,
  );
  fixture.stdout.value = "";
  await run(
    ["node", "snack", "sync", "--source", "personal-anthropic", "--full", "--json"],
    fixture.options,
  );
  fixture.stdout.value = "";

  await run(
    ["node", "snack", "status", "--source", "personal-anthropic", "--no-sync", "--json"],
    fixture.options,
  );
  const status = JSON.parse(fixture.stdout.value).data;

  assert.deepEqual(
    { plan: status.source.plan, observed: status.observed },
    {
      plan: "pro",
      observed: { prompts: 0, successes: 0, restrictions: 0, excluded: 0 },
    },
  );
});

test("status summarizes every configured source when none is selected", async () => {
  const fixture = await makeRunFixture();
  fixture.options.now = new Date("2026-01-02T03:05:00.000Z");
  fixture.options.env.OPENCODE_DB = await createOpenCodeDatabase(fixture.root);
  const mappings = /** @type {[string, string][]} */ ([
    ["personal-anthropic", "anthropic"],
    ["personal-openai", "openai"],
  ]);
  for (const [alias, provider] of mappings) {
    await run(
      [
        "node",
        "snack",
        "setup",
        "opencode",
        "--non-interactive",
        "--source",
        alias,
        "--provider",
        provider,
        "--profile",
        "personal",
        "--plan",
        "generic",
        "--json",
      ],
      fixture.options,
    );
    fixture.stdout.value = "";
  }
  await run(["node", "snack", "sync", "--full", "--json"], fixture.options);
  fixture.stdout.value = "";

  const exitCode = await run(["node", "snack", "status", "--no-sync", "--json"], fixture.options);
  const document = JSON.parse(fixture.stdout.value);

  assert.deepEqual(
    {
      exitCode,
      status: document.status,
      sources: /** @type {{source: {alias: string}, observed: unknown}[] | undefined} */ (
        document.data?.sources
      )?.map((source) => ({
        alias: source.source.alias,
        observed: source.observed,
      })),
    },
    {
      exitCode: 0,
      status: "degraded",
      sources: [
        {
          alias: "personal-anthropic",
          observed: { prompts: 1, successes: 1, restrictions: 0, excluded: 0 },
        },
        {
          alias: "personal-openai",
          observed: { prompts: 0, successes: 0, restrictions: 0, excluded: 0 },
        },
      ],
    },
  );
});

test("setup rolls back newly initialized storage when config commit fails", async () => {
  const fixture = await makeRunFixture();
  fixture.options.env.OPENCODE_DB = await createOpenCodeDatabase(fixture.root);
  fixture.options.writeConfig = async () => {
    throw new SnackError("Injected config commit failure.", {
      code: 3,
      reason: "config_write_error",
    });
  };

  const exitCode = await run(
    [
      "node",
      "snack",
      "setup",
      "opencode",
      "--non-interactive",
      "--source",
      "personal-anthropic",
      "--provider",
      "anthropic",
      "--profile",
      "personal",
      "--plan",
      "generic",
      "--json",
    ],
    fixture.options,
  );
  const storage = await inspectDatabase(fixture.paths.databaseFile);

  assert.deepEqual(
    { exitCode, error: JSON.parse(fixture.stdout.value).errors[0]?.code, storage },
    {
      exitCode: 3,
      error: "config_write_error",
      storage: { exists: false, integrity: "missing", migrations: "unknown" },
    },
  );
});

test("setup rejects source rebinds and ambiguous provider mappings", async () => {
  const fixture = await makeRunFixture();
  const firstDatabase = await createOpenCodeDatabase(fixture.root);
  const secondDatabase = await createOpenCodeDatabase(fixture.root, "opencode-second.db");
  /** @param {string} alias @param {string} provider */
  const setup = async (alias, provider) =>
    run(
      [
        "node",
        "snack",
        "setup",
        "opencode",
        "--non-interactive",
        "--source",
        alias,
        "--provider",
        provider,
        "--profile",
        "personal",
        "--plan",
        "generic",
        "--json",
      ],
      fixture.options,
    );
  fixture.options.env.OPENCODE_DB = firstDatabase;
  assert.equal(await setup("personal-anthropic", "anthropic"), 0);
  fixture.stdout.value = "";
  fixture.options.env.OPENCODE_DB = secondDatabase;
  const rebindExitCode = await setup("personal-anthropic", "anthropic");
  const rebindError = JSON.parse(fixture.stdout.value).errors[0]?.code;
  fixture.stdout.value = "";
  fixture.options.env.OPENCODE_DB = firstDatabase;
  const ambiguousExitCode = await setup("other-anthropic", "anthropic");
  const ambiguousError = JSON.parse(fixture.stdout.value).errors[0]?.code;

  assert.deepEqual(
    { rebindExitCode, rebindError, ambiguousExitCode, ambiguousError },
    {
      rebindExitCode: 3,
      rebindError: "source_rebind_rejected",
      ambiguousExitCode: 3,
      ambiguousError: "source_mapping_ambiguous",
    },
  );
});

test("status isolates a failed source and returns stale summaries", async () => {
  const fixture = await makeRunFixture();
  fixture.options.now = new Date("2026-01-02T03:05:00.000Z");
  const anthropicDatabase = await createOpenCodeDatabase(fixture.root);
  const openaiDatabase = await createOpenCodeDatabase(fixture.root, "opencode-openai.db");
  executeOpenCodeSql(
    openaiDatabase,
    `UPDATE message
     SET data = json_set(data, '$.model.providerID', 'openai')
     WHERE json_extract(data, '$.role') = 'user';
     UPDATE message
     SET data = json_set(data, '$.providerID', 'openai')
     WHERE json_extract(data, '$.role') = 'assistant';`,
  );
  for (const [alias, provider, database] of /** @type {[string, string, string][]} */ ([
    ["personal-anthropic", "anthropic", anthropicDatabase],
    ["personal-openai", "openai", openaiDatabase],
  ])) {
    fixture.options.env.OPENCODE_DB = database;
    await run(
      [
        "node",
        "snack",
        "setup",
        "opencode",
        "--non-interactive",
        "--source",
        alias,
        "--provider",
        provider,
        "--profile",
        "personal",
        "--plan",
        "generic",
        "--json",
      ],
      fixture.options,
    );
    fixture.stdout.value = "";
  }
  await run(["node", "snack", "sync", "--full", "--json"], fixture.options);
  await rm(openaiDatabase, { force: true });
  fixture.stdout.value = "";

  const exitCode = await run(["node", "snack", "status", "--json"], fixture.options);
  const document = JSON.parse(fixture.stdout.value);
  const sources =
    /** @type {{source: {alias: string}, observed: {prompts: number}, synchronization: {performed: boolean, status: string}}[] | undefined} */ (
      document.data?.sources
    );

  assert.deepEqual(
    {
      exitCode,
      status: document.status,
      sources: sources?.map((source) => ({
        alias: source.source.alias,
        prompts: source.observed.prompts,
        synchronization: source.synchronization,
      })),
    },
    {
      exitCode: 0,
      status: "degraded",
      sources: [
        {
          alias: "personal-anthropic",
          prompts: 1,
          synchronization: { performed: true, status: "ok" },
        },
        {
          alias: "personal-openai",
          prompts: 1,
          synchronization: { performed: true, status: "failed" },
        },
      ],
    },
  );
});

test("doctor warns when synchronized source data is stale", async () => {
  const fixture = await makeRunFixture();
  fixture.options.now = new Date("2026-01-04T03:05:00.000Z");
  fixture.options.env.OPENCODE_DB = await createOpenCodeDatabase(fixture.root);
  await run(
    [
      "node",
      "snack",
      "setup",
      "opencode",
      "--non-interactive",
      "--source",
      "personal-anthropic",
      "--provider",
      "anthropic",
      "--profile",
      "personal",
      "--plan",
      "generic",
      "--json",
    ],
    fixture.options,
  );
  fixture.stdout.value = "";
  await run(
    ["node", "snack", "sync", "--source", "personal-anthropic", "--full", "--json"],
    fixture.options,
  );
  fixture.stdout.value = "";

  await run(["node", "snack", "doctor", "--json"], fixture.options);
  const document = JSON.parse(fixture.stdout.value);
  const checks = /** @type {{id: string, status: string}[]} */ (document.data.checks);
  const freshness = checks.find((check) => check.id === "source_freshness:personal-anthropic");

  assert.deepEqual(
    { status: document.status, freshness: freshness?.status },
    { status: "degraded", freshness: "warn" },
  );
});

test("human status includes every required uncertainty field", async () => {
  const fixture = await makeRunFixture();
  fixture.options.now = new Date("2026-01-02T03:05:00.000Z");
  fixture.options.env.OPENCODE_DB = await createOpenCodeDatabase(fixture.root);
  await run(
    [
      "node",
      "snack",
      "setup",
      "opencode",
      "--non-interactive",
      "--source",
      "personal-anthropic",
      "--provider",
      "anthropic",
      "--profile",
      "personal",
      "--plan",
      "generic",
    ],
    fixture.options,
  );
  fixture.stdout.value = "";

  await run(["node", "snack", "status", "--source", "personal-anthropic"], fixture.options);

  assert.match(
    fixture.stdout.value,
    /risk high; evidence very_low; method initial-generic@1; pressure unknown; category typical; as_of 2026-01-02T03:04:10.000Z; sync ok/u,
  );
  assert.match(fixture.stdout.value, /Caveat: Initial heuristic/u);
});

async function makeRunFixture() {
  const root = await mkdtemp(join(tmpdir(), "snack-main-"));
  temporaryRoots.push(root);
  const stdout = sink();
  const stderr = sink();
  /** @type {{XDG_CONFIG_HOME: string, XDG_DATA_HOME: string, XDG_CACHE_HOME: string, XDG_STATE_HOME: string, OPENCODE_DB?: string}} */
  const env = {
    XDG_CONFIG_HOME: join(root, "config-home"),
    XDG_DATA_HOME: join(root, "data-home"),
    XDG_CACHE_HOME: join(root, "cache-home"),
    XDG_STATE_HOME: join(root, "state-home"),
  };
  const paths = {
    configDir: join(env.XDG_CONFIG_HOME, "snack"),
    configFile: join(env.XDG_CONFIG_HOME, "snack", "config.jsonc"),
    dataDir: join(env.XDG_DATA_HOME, "snack"),
    databaseFile: join(env.XDG_DATA_HOME, "snack", "snack.sqlite3"),
    backupDir: join(env.XDG_DATA_HOME, "snack", "backups"),
  };
  return {
    root,
    stdout,
    stderr,
    paths,
    dataHome: env.XDG_DATA_HOME,
    options: {
      stdout,
      stderr,
      home: root,
      env,
      platform: /** @type {NodeJS.Platform} */ ("linux"),
      nodeVersion: "24.18.1",
      now: new Date("2026-01-02T03:04:05.000Z"),
      writeConfig: /** @type {typeof import("../src/config.js").writePrivateAtomic | undefined} */ (
        undefined
      ),
    },
  };
}

/** @param {string} root @param {string} [filename] */
async function createOpenCodeDatabase(root, filename = "opencode.db") {
  const databaseFile = join(root, filename);
  const sql = await readFile(
    new URL("./fixtures/opencode/supported-v1.sql", import.meta.url),
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
function executeOpenCodeSql(databaseFile, sql) {
  const database = new Database(databaseFile);
  try {
    database.exec(sql);
  } finally {
    database.close();
  }
}

function sink() {
  return {
    value: "",
    /** @param {string} chunk */
    write(chunk) {
      this.value += chunk;
    },
  };
}

/** @param {string} root */
async function readTree(root) {
  /** @type {string[]} */
  const values = [];
  /** @param {string} directory */
  async function visit(directory) {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) await visit(path);
      else values.push(await readFile(path, "utf8").catch(() => ""));
    }
  }
  await visit(root);
  return values.join("\n");
}
