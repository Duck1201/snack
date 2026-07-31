import assert from "node:assert/strict";
import { readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, test } from "node:test";

import {
  getConfigValue,
  parseAndValidateConfig,
  prepareConfigValues,
  readConfig,
  setConfigValue,
  withConfigLock,
} from "../src/config.js";
import { SnackError } from "../src/errors.js";

/** @type {string[]} */
const temporaryRoots = [];

afterEach(async () => {
  await Promise.all(
    temporaryRoots.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

test("a missing configuration points at setup, the command that actually creates one", async () => {
  const root = await makeRoot();

  await assert.rejects(readConfig(join(root, "config", "config.jsonc")), (error) => {
    assert.ok(error instanceof SnackError);
    assert.equal(error.reason, "config_missing");
    // `config set` writes a key into a configuration; it is not the first-run entry point,
    // and sending a new user there leaves them without a capacity source.
    assert.match(error.message, /snack setup opencode/u);
    return true;
  });
});

test("a configured source names one client and the fingerprint family that client writes", () => {
  const openCodeSource = {
    alias: "work",
    installation_id: "11111111-2222-4333-8444-555555555555",
    adapter: "opencode",
    database: "/tmp/opencode.db",
    provider: "anthropic",
    profile: "default",
    plan: "pro",
    fingerprint: "oc-sqlite-msgpart-v1",
  };
  const claudeSource = {
    alias: "claude",
    installation_id: "22222222-3333-4444-8555-666666666666",
    adapter: "claude",
    projects: "/home/user/.claude/projects",
    provider: "anthropic",
    profile: "default",
    plan: "pro",
    fingerprint: "cc-jsonl-turntree-v1",
  };
  /** @param {unknown[]} sources */
  const validate = (sources) =>
    parseAndValidateConfig(JSON.stringify({ schema_version: 1, sources }));

  // A configuration written by 0.6 keeps validating untouched: the second client is added to the
  // schema, it does not replace the first.
  assert.ok(validate([openCodeSource]));
  assert.ok(validate([claudeSource]));
  assert.ok(validate([openCodeSource, claudeSource]));

  // Claude Code has no single database file, and OpenCode has no projects directory. Accepting a
  // source that claims the other client's shape would let setup record a source nothing can read.
  for (const invalid of [
    { ...claudeSource, fingerprint: "oc-sqlite-msgpart-v1" },
    { ...openCodeSource, adapter: "claude" },
    { ...claudeSource, database: "/tmp/opencode.db" },
    { ...claudeSource, adapter: "nothing-we-ship" },
  ]) {
    assert.throws(
      () => validate([invalid]),
      (error) => error instanceof SnackError && error.reason === "config_schema_error",
    );
  }
});

test("creates private configuration and preserves comments on update", async () => {
  const root = await makeRoot();
  const file = join(root, "config", "config.jsonc");

  await setConfigValue(file, "presentation.json", "true");
  let source = await readFile(file, "utf8");
  source = source.replace('"presentation": {', '// User preference\n  "presentation": {');
  await writeFile(file, source, { mode: 0o600 });

  await setConfigValue(file, "analysis.horizons", '["PT2H"]');
  const updated = await readFile(file, "utf8");
  const config = await readConfig(file);

  assert.match(updated, /User preference/u);
  assert.equal(getConfigValue(config, "presentation.json"), true);
  assert.deepEqual(getConfigValue(config, "analysis.horizons"), ["PT2H"]);
  assert.equal((await stat(join(root, "config"))).mode & 0o777, 0o700);
  assert.equal((await stat(file)).mode & 0o777, 0o600);
  assert.equal((await stat(`${file}.bak`)).mode & 0o777, 0o600);
});

test("rejects an invalid update before replacing valid configuration", async () => {
  const root = await makeRoot();
  const file = join(root, "config", "config.jsonc");
  await setConfigValue(file, "presentation.json", "false");
  const before = await readFile(file, "utf8");

  await assert.rejects(
    setConfigValue(file, "presentation.json", "chartreuse"),
    (error) => error instanceof SnackError && error.reason === "config_schema_error",
  );

  assert.equal(await readFile(file, "utf8"), before);
});

test("rejects unknown fields and malformed JSONC", () => {
  assert.throws(() => parseAndValidateConfig('{"schema_version":1,"secret":"no"}'));
  assert.throws(() => parseAndValidateConfig('{"schema_version":'));
});

test("normalizes configuration lock setup failures", async () => {
  const root = await makeRoot();
  const blocker = join(root, "blocker");
  await writeFile(blocker, "not a directory", { mode: 0o600 });

  await assert.rejects(
    withConfigLock(join(blocker, "config.jsonc"), async () => undefined),
    (error) =>
      error instanceof SnackError && error.reason === "config_lock_error" && error.exitCode === 3,
  );
});

test("addresses one configured source by index instead of rewriting the whole array", async () => {
  const file = await writeSourceConfig();

  const { config, content } = await prepareConfigValues(file, [
    ["sources.0.plan_profile", "metered-credit"],
  ]);

  assert.equal(getConfigValue(config, "sources.0.plan_profile"), "metered-credit");
  // Every neighbouring field of the edited source survives the targeted write.
  assert.equal(getConfigValue(config, "sources.0.provider"), "anthropic");
  assert.equal(getConfigValue(config, "sources.0.alias"), "work");
  assert.equal(getConfigValue(config, "sources.1.alias"), "personal");
  assert.match(content, /metered-credit/u);
});

test("an out-of-range source index is refused without replacing the configuration", async () => {
  const file = await writeSourceConfig();
  const before = await readFile(file, "utf8");

  // A JSONC edit clamps an out-of-range index to an append, so the write would invent a source
  // holding nothing but `plan_profile`. Schema validation runs before the replacement and
  // rejects it, which is why an index typo fails closed instead of corrupting the array.
  await assert.rejects(
    prepareConfigValues(file, [["sources.99.plan_profile", "metered-credit"]]),
    (error) =>
      error instanceof SnackError && error.reason === "config_schema_error" && error.exitCode === 3,
  );
  assert.equal(await readFile(file, "utf8"), before);
});

test("a key segment that is neither a name nor an index stays invalid", async () => {
  const file = await writeSourceConfig();

  for (const key of ["sources.-1.alias", "sources.0x1.alias", "sources.__proto__.alias"]) {
    await assert.rejects(
      prepareConfigValues(file, [[key, "x"]]),
      (error) => error instanceof SnackError && error.reason === "invalid_config_key",
      key,
    );
  }
});

/** Two configured sources, so an indexed edit has a neighbour that must not move. */
async function writeSourceConfig() {
  const root = await makeRoot();
  const file = join(root, "config.jsonc");
  /** @param {string} alias @param {string} profile */
  const source = (alias, profile) => ({
    alias,
    installation_id: "11111111-2222-4333-8444-555555555555",
    adapter: "opencode",
    database: join(root, "opencode.db"),
    provider: "anthropic",
    profile,
    plan: "generic",
    fingerprint: "oc-sqlite-msgpart-v1",
  });
  await writeFile(
    file,
    `${JSON.stringify(
      {
        schema_version: 1,
        sources: [source("work", "default"), source("personal", "personal")],
        analysis: { horizons: ["PT1H"] },
        presentation: { json: false },
        prospective_analysis: { enabled: false },
      },
      null,
      2,
    )}\n`,
    { mode: 0o600 },
  );
  return file;
}

async function makeRoot() {
  const { mkdtemp } = await import("node:fs/promises");
  const root = await mkdtemp(join(tmpdir(), "snack-config-"));
  temporaryRoots.push(root);
  return root;
}
