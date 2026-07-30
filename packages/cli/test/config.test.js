import assert from "node:assert/strict";
import { readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, test } from "node:test";

import {
  getConfigValue,
  parseAndValidateConfig,
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

async function makeRoot() {
  const { mkdtemp } = await import("node:fs/promises");
  const root = await mkdtemp(join(tmpdir(), "snack-config-"));
  temporaryRoots.push(root);
  return root;
}
