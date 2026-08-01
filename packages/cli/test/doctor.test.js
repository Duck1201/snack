import assert from "node:assert/strict";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, test } from "node:test";

import { runDoctor } from "../src/doctor.js";
import { run } from "../src/main.js";
import { pluginPackageSpec } from "../src/opencode-config.js";
import { initializeDatabase, migrationDirectory } from "../src/storage.js";
import { cleanupRunFixtures, createClaudeHistory, makeRunFixture } from "./fixtures/run-fixture.js";

afterEach(cleanupRunFixtures);

const now = new Date("2026-01-02T03:04:05.000Z");
const pluginOptions = {
  installation_id: "11111111-2222-4333-8444-555555555555",
  spool_directory: "/tmp/snack-spool",
  prospective_analysis: false,
  source_bindings: [],
};

/**
 * A doctor run over a configured OpenCode source, with the SNACK entry in OpenCode's own
 * configuration set to `plugins`.
 *
 * @param {unknown[]} plugins
 */
async function runDoctorWithPlugins(plugins) {
  const fixture = await makeRunFixture("snack-doctor-");
  const paths = fixture.paths;
  await initializeDatabase(paths, { applicationVersion: "0.5.0", now });

  const openCodeDatabase = join(fixture.root, "opencode.db");
  await writeFile(openCodeDatabase, "", { mode: 0o600 });
  await mkdir(paths.configDir, { recursive: true, mode: 0o700 });
  await writeFile(
    paths.configFile,
    `${JSON.stringify({
      schema_version: 1,
      sources: [
        {
          alias: "work",
          installation_id: pluginOptions.installation_id,
          adapter: "opencode",
          database: openCodeDatabase,
          provider: "anthropic",
          profile: "default",
          plan: "generic",
          fingerprint: "oc-sqlite-msgpart-v1",
        },
      ],
      analysis: { horizons: ["PT1H"] },
      presentation: { json: false },
      prospective_analysis: { enabled: false },
    })}\n`,
    { mode: 0o600 },
  );

  const opencodeConfigFile = join(fixture.root, "opencode.json");
  await writeFile(opencodeConfigFile, `${JSON.stringify({ plugin: plugins })}\n`, "utf8");

  const report = await runDoctor(paths, {
    nodeVersion: "24.18.1",
    platform: "linux",
    now,
    opencodeConfigFile,
  });
  const check = report.checks.find((candidate) => candidate.id === "opencode_plugin");
  assert.ok(check, "doctor did not report an opencode_plugin check");
  return check;
}

test("doctor warns rather than fails when the registered plugin version is merely outdated", async () => {
  // A correct install running a published plugin newer than the pinned specifier must not be
  // reported as a failure: it captures fine, it just has an upgrade available.
  const check = await runDoctorWithPlugins([["@snack-ai/opencode@0.0.9", pluginOptions]]);

  assert.equal(check.status, "warn");
  assert.match(check.message, /outdated|update/iu);
});

test("doctor passes the pinned plugin registration", async () => {
  const check = await runDoctorWithPlugins([[pluginPackageSpec, pluginOptions]]);

  assert.equal(check.status, "pass");
});

test("doctor fails a plugin registration SNACK cannot work with", async () => {
  const check = await runDoctorWithPlugins([[pluginPackageSpec, { unknown_option: true }]]);

  assert.equal(check.status, "fail");
});

test("a Claude-only installation is not told about the OpenCode plugin", async () => {
  const fixture = await makeRunFixture("snack-doctor-claude-");
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
    ],
    fixture.options,
  );
  await run(["node", "snack", "sync", "--full"], fixture.options);

  fixture.stdout.value = "";
  fixture.stderr.value = "";
  await run(["node", "snack", "doctor", "--json"], fixture.options);
  const document = JSON.parse(fixture.stdout.value);

  // Reporting an unregistered OpenCode plugin to someone who never configured OpenCode answers a
  // question they did not ask, and degrades a healthy installation for it.
  const ids = document.data.checks.map((/** @type {{id: string}} */ check) => check.id);
  assert.ok(!ids.includes("opencode_plugin"), ids.join(", "));
  assert.ok(ids.includes("source_fingerprint:claude"));
  assert.equal(document.status, "ok");
});

test("doctor names a newer-release database instead of calling storage inaccessible", async () => {
  // The check people actually reach for when something is wrong. Reporting "storage is invalid or
  // inaccessible" for a database a newer release merely upgraded describes damage that has not
  // happened and hides the one thing that would fix it: run the newer release.
  const fixture = await makeRunFixture("snack-doctor-ahead-");
  await initializeDatabase(fixture.paths, { applicationVersion: "0.8.0", now });

  const report = await runDoctor(fixture.paths, {
    now,
    nodeVersion: "24.18.1",
    platform: "linux",
    migrationsDir: await migrationsThrough(fixture.root, 11),
  });

  const byId = new Map(report.checks.map((check) => [check.id, check]));
  assert.equal(byId.get("storage")?.status, undefined, "storage was reported as unreadable");
  assert.equal(byId.get("storage_integrity")?.status, "pass");
  const migrations = byId.get("storage_migrations");
  assert.equal(migrations?.status, "fail");
  assert.match(migrations.message, /newer release/iu);
});

/**
 * Copy the released migrations up to a number, so an older application can be pointed at them.
 *
 * @param {string} root
 * @param {number} through
 */
async function migrationsThrough(root, through) {
  const directory = join(root, `migrations-${through}`);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  for (const name of await readdir(migrationDirectory)) {
    if (Number(name.slice(0, 3)) > through) continue;
    await writeFile(join(directory, name), await readFile(join(migrationDirectory, name), "utf8"));
  }
  return directory;
}
