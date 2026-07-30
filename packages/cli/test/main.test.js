import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, test } from "node:test";

import { getConfigValue, readConfig } from "../src/config.js";
import { run } from "../src/main.js";
import { initializeDatabase } from "../src/storage.js";

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
  assert.deepEqual(document.data.storage.applied, [1]);
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

async function makeRunFixture() {
  const root = await mkdtemp(join(tmpdir(), "snack-main-"));
  temporaryRoots.push(root);
  const stdout = sink();
  const stderr = sink();
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
    },
  };
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
