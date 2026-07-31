import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";

import Database from "better-sqlite3";

import { SnackOpenCodePlugin } from "../../opencode/src/plugin.js";
import { run } from "../src/main.js";
import {
  pluginPackageSpec,
  preparePluginRegistration,
  restorePluginRegistration,
  writePluginRegistration,
} from "../src/opencode-config.js";
import { resolvePaths } from "../src/paths.js";
import { readSpoolEvents } from "../src/spool.js";

/** @type {string[]} */
const temporaryRoots = [];

afterEach(async () => {
  await Promise.all(
    temporaryRoots.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

test("sync finalizes provisional live data and preserves a later restriction", async () => {
  const root = await mkdtemp(join(tmpdir(), "snack-spool-"));
  temporaryRoots.push(root);
  const database = join(root, "opencode.db");
  const sql = await readFile(
    new URL("./fixtures/opencode/supported-v1.sql", import.meta.url),
    "utf8",
  );
  const source = new Database(database);
  try {
    source.exec(sql);
  } finally {
    source.close();
  }
  const stdout = {
    value: "",
    write(/** @type {string} */ chunk) {
      this.value += chunk;
    },
  };
  const options = {
    home: root,
    now: new Date("2026-01-02T03:05:00.000Z"),
    env: { OPENCODE_DB: database },
    stdout,
    stderr: { write() {} },
  };
  const paths = resolvePaths({ home: root, env: options.env });

  assert.equal(
    await run(
      [
        "node",
        "snack",
        "setup",
        "opencode",
        "--non-interactive",
        "--source",
        "personal",
        "--provider",
        "anthropic",
        "--profile",
        "personal",
        "--plan",
        "generic",
        "--json",
      ],
      options,
    ),
    0,
  );
  const setup = JSON.parse(stdout.value);
  const plugin = await SnackOpenCodePlugin(
    {},
    {
      installation_id: setup.data.source.installation_id,
      spool_directory: paths.spoolDir,
      prospective_analysis: true,
      source_bindings: [
        {
          provider: "anthropic",
          source_alias: "personal",
          spool_directory: join(paths.spoolDir, "personal"),
        },
      ],
    },
  );
  await plugin["chat.message"](
    {
      sessionID: "session-1",
      messageID: "user-1",
      model: { providerID: "anthropic", modelID: "claude-sonnet" },
    },
    {
      message: {},
      parts: [{ type: "text", text: "PRIVATE_INPUT_FEATURE_CANARY" }],
    },
  );
  await waitForSpool(join(paths.spoolDir, "personal", "current.open"), "prompt_started");
  assert.doesNotMatch(
    await readFile(join(paths.spoolDir, "personal", "current.open"), "utf8"),
    /PRIVATE_INPUT_FEATURE_CANARY/u,
  );
  const offlineDatabase = `${database}.offline`;
  await rename(database, offlineDatabase);
  stdout.value = "";
  assert.equal(await run(["node", "snack", "sync", "--full", "--json"], options), 0);
  const offlineSync = JSON.parse(stdout.value);
  const offlineSources = /** @type {{path: string, inserted: number}[]} */ (
    offlineSync.data.sources
  );
  assert.equal(offlineSync.status, "degraded");
  assert.equal(
    offlineSources.find((result) => result.path === "spool")?.inserted,
    1,
    JSON.stringify(offlineSources),
  );
  await rename(offlineDatabase, database);

  stdout.value = "";
  assert.equal(await run(["node", "snack", "sync", "--full", "--json"], options), 0);
  stdout.value = "";
  assert.equal(await run(["node", "snack", "status", "--no-sync", "--json"], options), 0);
  assert.deepEqual(JSON.parse(stdout.value).data.observed, {
    prompts: 1,
    successes: 1,
    restrictions: 0,
    excluded: 0,
  });

  await plugin.event({
    event: {
      type: "session.error",
      properties: {
        sessionID: "session-1",
        error: { name: "APIError", data: { statusCode: 429 } },
        time: "2026-01-02T03:04:10.000Z",
      },
    },
  });
  await waitForSpool(join(paths.spoolDir, "personal", "current.open"));

  stdout.value = "";
  await rename(database, offlineDatabase);
  assert.equal(await run(["node", "snack", "sync", "--full", "--json"], options), 0);
  assert.equal(JSON.parse(stdout.value).status, "degraded");
  await rename(offlineDatabase, database);
  stdout.value = "";
  assert.equal(await run(["node", "snack", "sync", "--full", "--json"], options), 0);
  stdout.value = "";
  assert.equal(await run(["node", "snack", "status", "--no-sync", "--json"], options), 0);

  const status = JSON.parse(stdout.value);
  assert.deepEqual(status.data.observed, {
    prompts: 1,
    successes: 0,
    restrictions: 1,
    excluded: 0,
  });
  const canonical = new Database(paths.databaseFile, { readonly: true });
  try {
    assert.deepEqual(
      canonical
        .prepare(
          `SELECT prompt_execution.completion, prompt_execution.duration_ms,
                  prompt_source_outcome.outcome, prompt_execution.input_analyzer_version,
                  prompt_execution.input_line_count_bucket, prompt_execution.input_attachment_count,
                  COUNT(prompt_usage_slice.source_slice_id) AS usage_slices
             FROM prompt_execution
             JOIN prompt_source_outcome ON prompt_source_outcome.prompt_execution_id = prompt_execution.id
             LEFT JOIN prompt_usage_slice ON prompt_usage_slice.prompt_execution_id = prompt_execution.id
            GROUP BY prompt_execution.id`,
        )
        .get(),
      {
        completion: "completed",
        duration_ms: 5000,
        outcome: "restricted",
        input_analyzer_version: "opencode-input-v1",
        input_line_count_bucket: "1-10",
        input_attachment_count: 0,
        usage_slices: 1,
      },
    );
  } finally {
    canonical.close();
  }

  const pendingDirectory = join(paths.spoolDir, "_pending");
  const malformedSegment = join(pendingDirectory, "segment-malformed.ndjson");
  await mkdir(pendingDirectory, { recursive: true });
  await writeFile(malformedSegment, '{"prompt":"PRIVATE_MALFORMED_CANARY"}\n');
  stdout.value = "";
  assert.equal(await run(["node", "snack", "sync", "--full", "--json"], options), 0);
  await assert.rejects(readFile(malformedSegment, "utf8"));
  assert.doesNotMatch(stdout.value, /PRIVATE_MALFORMED_CANARY/u);

  const pendingSegment = join(pendingDirectory, "segment-unmapped.ndjson");
  await writeFile(
    pendingSegment,
    `${JSON.stringify({
      schema_version: 1,
      event_id: "openai-restriction-1",
      installation_id: setup.data.source.installation_id,
      event_type: "session_error",
      source_prompt_id: "openai-prompt-1",
      source_session_id: "openai-session-1",
      revision: "2026-01-02T03:04:20.000Z:session.error",
      revision_domain: "opencode-plugin-v1",
      parser_version: "opencode-plugin-v1",
      occurred_at: "2026-01-02T03:04:20.000Z",
      provider: "openai",
      model: "gpt-4o",
      completion: "completed",
      outcome: "restricted",
      usage_slices: [],
      restrictions: [
        {
          class: "rate_limit",
          source_code: "http_429",
          observed_at: "2026-01-02T03:04:20.000Z",
          classifier_version: "opencode-plugin-error-v1",
        },
      ],
    })}\n`,
  );
  stdout.value = "";
  assert.equal(await run(["node", "snack", "sync", "--full", "--json"], options), 0);
  await assert.rejects(readFile(pendingSegment, "utf8"));
  const retained = new Database(paths.databaseFile, { readonly: true });
  try {
    const row = /** @type {{count: number}} */ (
      retained.prepare("SELECT COUNT(*) AS count FROM pending_spool_observation").get()
    );
    assert.equal(row.count, 1);
  } finally {
    retained.close();
  }
  stdout.value = "";
  assert.equal(
    await run(
      [
        "node",
        "snack",
        "setup",
        "opencode",
        "--non-interactive",
        "--source",
        "work-openai",
        "--provider",
        "openai",
        "--profile",
        "work",
        "--plan",
        "generic",
        "--json",
      ],
      options,
    ),
    0,
  );
  stdout.value = "";
  assert.equal(await run(["node", "snack", "sync", "--full", "--json"], options), 0);
  await assert.rejects(readFile(pendingSegment, "utf8"));
  stdout.value = "";
  assert.equal(
    await run(
      ["node", "snack", "status", "--source", "work-openai", "--no-sync", "--json"],
      options,
    ),
    0,
  );
  assert.equal(JSON.parse(stdout.value).data.observed.restrictions, 1);
  const reconciled = new Database(paths.databaseFile, { readonly: true });
  try {
    const row = /** @type {{count: number}} */ (
      reconciled.prepare("SELECT COUNT(*) AS count FROM pending_spool_observation").get()
    );
    assert.equal(row.count, 0);
  } finally {
    reconciled.close();
  }
});

test("setup rejects unsafe prior plugin options without journaling their secret", async () => {
  const root = await mkdtemp(join(tmpdir(), "snack-plugin-secret-"));
  temporaryRoots.push(root);
  const database = join(root, "opencode.db");
  const sql = await readFile(
    new URL("./fixtures/opencode/supported-v1.sql", import.meta.url),
    "utf8",
  );
  const source = new Database(database);
  try {
    source.exec(sql);
  } finally {
    source.close();
  }
  const configFile = join(root, "opencode", "opencode.json");
  await mkdir(join(root, "opencode"), { recursive: true });
  await writeFile(
    configFile,
    '{"plugin":[["@snack-ai/opencode",{"token":"PRIVATE_PLUGIN_SECRET"}]]}\n',
  );
  const stdout = {
    value: "",
    write(/** @type {string} */ chunk) {
      this.value += chunk;
    },
  };
  const options = {
    home: root,
    env: { OPENCODE_DB: database, XDG_CONFIG_HOME: root },
    stdout,
    stderr: { write() {} },
  };

  assert.equal(
    await run(
      [
        "node",
        "snack",
        "setup",
        "opencode",
        "--non-interactive",
        "--source",
        "personal",
        "--provider",
        "anthropic",
        "--profile",
        "personal",
        "--plan",
        "generic",
        "--install-plugin",
        "--yes",
        "--json",
      ],
      options,
    ),
    3,
  );
  const paths = resolvePaths({ home: root, env: options.env });
  await assert.rejects(readFile(join(paths.stateDir, "setup-opencode-plugin.json"), "utf8"));
  assert.doesNotMatch(stdout.value, /PRIVATE_PLUGIN_SECRET/u);
  assert.match(await readFile(configFile, "utf8"), /PRIVATE_PLUGIN_SECRET/u);
});

test("plugin rollback restores an absent file and an absent plugin property", async () => {
  const root = await mkdtemp(join(tmpdir(), "snack-plugin-rollback-"));
  temporaryRoots.push(root);
  const missing = join(root, "missing", "opencode.json");
  const options = {
    installation_id: "installation-1",
    spool_directory: join(root, "spool"),
    prospective_analysis: false,
    source_bindings: [],
  };
  const created = await preparePluginRegistration(missing, options);
  await writePluginRegistration(missing, created.content, created.previous_content);
  await restorePluginRegistration(
    missing,
    created.previous_plugin,
    created.previous_plugin_index,
    created.config_existed,
    created.plugin_property_existed,
    created.installed_plugin_hash,
  );
  await assert.rejects(readFile(missing, "utf8"));

  const existing = join(root, "existing", "opencode.json");
  await mkdir(join(root, "existing"), { recursive: true });
  const original = '{\n  // preserved\n  "provider": {}\n}\n';
  await writeFile(existing, original);
  const updated = await preparePluginRegistration(existing, options);
  await writeFile(existing, '{\n  "provider": {"new": true}\n}\n');
  await assert.rejects(
    writePluginRegistration(existing, updated.content, updated.previous_content),
    (error) =>
      error instanceof Error && "reason" in error && error.reason === "opencode_config_changed",
  );
  await restorePluginRegistration(
    existing,
    updated.previous_plugin,
    updated.previous_plugin_index,
    false,
    false,
    updated.installed_plugin_hash,
  );
  assert.match(await readFile(existing, "utf8"), /"new": true/u);
  await writeFile(existing, original);
  await writePluginRegistration(existing, updated.content, updated.previous_content);
  await restorePluginRegistration(
    existing,
    updated.previous_plugin,
    updated.previous_plugin_index,
    updated.config_existed,
    updated.plugin_property_existed,
    updated.installed_plugin_hash,
  );
  assert.equal(await readFile(existing, "utf8"), original);
});

test("spool rotation waits for the writer lock and rejects schema-invalid restrictions", async () => {
  const root = await mkdtemp(join(tmpdir(), "snack-spool-lock-"));
  temporaryRoots.push(root);
  const directory = join(root, "spool");
  await mkdir(directory, { recursive: true });
  const valid = {
    schema_version: 1,
    event_id: "event-1",
    installation_id: "installation-1",
    event_type: "prompt_started",
    source_prompt_id: "prompt-1",
    source_session_id: "session-1",
    revision: "revision-1",
    revision_domain: "opencode-plugin-v1",
    parser_version: "opencode-plugin-v1",
    occurred_at: "2026-01-02T03:04:05.000Z",
    provider: "anthropic",
    model: "claude-sonnet",
    completion: "provisional",
    outcome: "excluded",
    usage_slices: [],
    restrictions: [],
  };
  await writeFile(join(directory, "current.open"), `${JSON.stringify(valid)}\n`);
  await writeFile(join(directory, ".writer.lock"), "");
  assert.deepEqual(
    (
      await readSpoolEvents({
        spoolDirectory: directory,
        installationId: "installation-1",
        cursors: new Map(),
      })
    ).observations,
    [],
  );
  assert.match(await readFile(join(directory, "current.open"), "utf8"), /event-1/u);
  await rm(join(directory, ".writer.lock"));
  assert.equal(
    (
      await readSpoolEvents({
        spoolDirectory: directory,
        installationId: "installation-1",
        cursors: new Map(),
      })
    ).observations.length,
    1,
  );

  const invalid = {
    ...valid,
    event_id: "event-2",
    event_type: "session_error",
    completion: "completed",
    outcome: "restricted",
    restrictions: [
      {
        class: "rate_limit",
        source_code: "x".repeat(101),
        observed_at: "2026-01-02T03:04:05.000Z",
        classifier_version: "opencode-plugin-error-v1",
      },
    ],
  };
  await writeFile(join(directory, "segment-invalid.ndjson"), `${JSON.stringify(invalid)}\n`);
  const batch = await readSpoolEvents({
    spoolDirectory: directory,
    installationId: "installation-1",
    cursors: new Map(),
  });
  assert.equal(batch.observations.length, 1);
  assert.equal(batch.rejected.length, 1);
});

test("setup registers the global plugin without exposing unrelated OpenCode settings", async () => {
  const root = await mkdtemp(join(tmpdir(), "snack-plugin-setup-"));
  temporaryRoots.push(root);
  const database = join(root, "opencode.db");
  const sql = await readFile(
    new URL("./fixtures/opencode/supported-v1.sql", import.meta.url),
    "utf8",
  );
  const source = new Database(database);
  try {
    source.exec(sql);
  } finally {
    source.close();
  }
  const configDirectory = join(root, "opencode");
  const configFile = join(configDirectory, "opencode.json");
  await mkdir(configDirectory, { recursive: true });
  await writeFile(configFile, '{"provider":{"private":"PRIVATE_CREDENTIAL_CANARY"}}\n');
  const stdout = {
    value: "",
    write(/** @type {string} */ chunk) {
      this.value += chunk;
    },
  };
  const options = {
    home: root,
    now: new Date("2026-01-02T03:05:00.000Z"),
    env: { OPENCODE_DB: database, XDG_CONFIG_HOME: root },
    stdout,
    stderr: { write() {} },
  };

  const exitCode = await run(
    [
      "node",
      "snack",
      "setup",
      "opencode",
      "--non-interactive",
      "--source",
      "personal",
      "--provider",
      "anthropic",
      "--profile",
      "personal",
      "--plan",
      "generic",
      "--install-plugin",
      "--enable-prospective-analysis",
      "--yes",
      "--json",
    ],
    options,
  );
  const output = stdout.value;
  const registered = JSON.parse(await readFile(configFile, "utf8"));

  assert.deepEqual(
    {
      exitCode,
      registration: JSON.parse(output).data.plugin_registration,
      plugin: registered.plugin,
      analysis: JSON.parse(output).data.source,
    },
    {
      exitCode: 0,
      registration: {
        target: "global",
        package: pluginPackageSpec,
        action: "add",
        prospective_analysis: true,
      },
      plugin: [
        [
          pluginPackageSpec,
          {
            installation_id: JSON.parse(output).data.source.installation_id,
            spool_directory: resolvePaths({ home: root, env: options.env }).spoolDir,
            prospective_analysis: true,
            source_bindings: [
              {
                provider: "anthropic",
                source_alias: "personal",
                spool_directory: join(
                  resolvePaths({ home: root, env: options.env }).spoolDir,
                  "personal",
                ),
              },
            ],
          },
        ],
      ],
      analysis: {
        alias: "personal",
        installation_id: JSON.parse(output).data.source.installation_id,
        adapter: "opencode",
        provider: "anthropic",
        profile: "personal",
        plan: "generic",
        plan_profile: "generic",
      },
    },
  );
  assert.doesNotMatch(output, /PRIVATE_CREDENTIAL_CANARY/u);
  const paths = resolvePaths({ home: root, env: options.env });
  await rm(paths.databaseFile, { force: true });
  stdout.value = "";
  assert.equal(await run(["node", "snack", "doctor", "--json"], options), 0);
  assert.notEqual(JSON.parse(stdout.value).reason, "internal_error");
});

test("setup recovers an interrupted plugin registration before applying its new proposal", async () => {
  const root = await mkdtemp(join(tmpdir(), "snack-plugin-recovery-"));
  temporaryRoots.push(root);
  const database = join(root, "opencode.db");
  const sql = await readFile(
    new URL("./fixtures/opencode/supported-v1.sql", import.meta.url),
    "utf8",
  );
  const source = new Database(database);
  try {
    source.exec(sql);
  } finally {
    source.close();
  }
  const configDirectory = join(root, "opencode");
  const configFile = join(configDirectory, "opencode.json");
  await mkdir(configDirectory, { recursive: true });
  await writeFile(configFile, '{"plugin":[["@snack-ai/opencode",{"stale":true}]]}\n');
  const paths = resolvePaths({ home: root, env: { XDG_CONFIG_HOME: root } });
  await mkdir(paths.stateDir, { recursive: true });
  await writeFile(
    join(paths.stateDir, "setup-opencode-plugin.json"),
    `${JSON.stringify({
      version: 3,
      opencode_config_file: configFile,
      config_existed: false,
      plugin_property_existed: false,
      previous_plugin: null,
      previous_plugin_index: -1,
      installed_plugin_hash: createHash("sha256")
        .update(JSON.stringify(["@snack-ai/opencode", { stale: true }]))
        .digest("hex"),
      previous_snack_config: null,
      database_backup_file: null,
    })}\n`,
  );
  const stdout = {
    value: "",
    write(/** @type {string} */ chunk) {
      this.value += chunk;
    },
  };
  const options = {
    home: root,
    now: new Date("2026-01-02T03:05:00.000Z"),
    env: { OPENCODE_DB: database, XDG_CONFIG_HOME: root },
    stdout,
    stderr: { write() {} },
  };

  const exitCode = await run(
    [
      "node",
      "snack",
      "setup",
      "opencode",
      "--non-interactive",
      "--source",
      "personal",
      "--provider",
      "anthropic",
      "--profile",
      "personal",
      "--plan",
      "generic",
      "--install-plugin",
      "--yes",
      "--json",
    ],
    options,
  );

  assert.equal(exitCode, 0);
  assert.equal(JSON.parse(stdout.value).data.recovered_setup_journal, true);
  await assert.rejects(readFile(join(paths.stateDir, "setup-opencode-plugin.json"), "utf8"));
});

/** @param {string} file @param {string} [eventType] */
async function waitForSpool(file, eventType = "session_error") {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try {
      if ((await readFile(file, "utf8")).includes(eventType)) {
        try {
          await readFile(join(file, "..", ".writer.lock"), "utf8");
        } catch {
          return;
        }
      }
    } catch {
      // The fail-open plugin write has not completed yet.
    }
    await delay(10);
  }
  const entries = await readdir(join(file, "..", ".."), { recursive: true }).catch(() => []);
  throw new Error(`Spool event was not written: ${entries.join(", ")}`);
}
