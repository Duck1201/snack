import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, test } from "node:test";

import {
  inspectPluginRegistration,
  pluginPackageSpec,
  preparePluginRegistration,
  resolveOpenCodeConfig,
} from "../src/opencode-config.js";
import { cleanupRunFixtures, makeRunFixture } from "./fixtures/run-fixture.js";

afterEach(cleanupRunFixtures);

const options = {
  installation_id: "11111111-2222-4333-8444-555555555555",
  spool_directory: "/tmp/snack-spool",
  prospective_analysis: false,
  source_bindings: [],
};

/** @param {unknown[]} plugins */
async function writeOpenCodeConfig(plugins) {
  const fixture = await makeRunFixture("snack-opencode-config-");
  const configFile = join(fixture.root, "opencode.json");
  await writeFile(configFile, `${JSON.stringify({ plugin: plugins }, null, 2)}\n`, "utf8");
  return configFile;
}

test("the OpenCode configuration is located through XDG_CONFIG_HOME, like OpenCode locates it", () => {
  // Real CLI invocations pass no `env`, so reading it only off the argument silently sends the
  // plugin registration to ~/.config while OpenCode reads $XDG_CONFIG_HOME. Live capture would
  // then never happen, and doctor would still report "compatible" by looking in the same wrong
  // place. `resolvePaths` already falls back to `process.env`; this must match it.
  const previous = { home: process.env.HOME, configHome: process.env.XDG_CONFIG_HOME };
  try {
    process.env.HOME = "/home/tester";
    process.env.XDG_CONFIG_HOME = "/home/tester/elsewhere";

    assert.equal(resolveOpenCodeConfig(), "/home/tester/elsewhere/opencode/opencode.json");

    delete process.env.XDG_CONFIG_HOME;
    assert.equal(resolveOpenCodeConfig(), "/home/tester/.config/opencode/opencode.json");
  } finally {
    if (previous.home === undefined) delete process.env.HOME;
    else process.env.HOME = previous.home;
    if (previous.configHome === undefined) delete process.env.XDG_CONFIG_HOME;
    else process.env.XDG_CONFIG_HOME = previous.configHome;
  }
});

test("a plugin registered at another version of the same package is outdated, not incompatible", async () => {
  // The published plugin moves ahead of the version SNACK pins. Every 0.1.x emits the same
  // `spool-event-v1`, so a version difference is an upgrade notice, not a broken install.
  const configFile = await writeOpenCodeConfig([["@snack-ai/opencode@0.0.9", options]]);

  assert.equal(await inspectPluginRegistration(configFile), "outdated");
});

test("the pinned plugin version is compatible", async () => {
  const configFile = await writeOpenCodeConfig([[pluginPackageSpec, options]]);

  assert.equal(await inspectPluginRegistration(configFile), "compatible");
});

test("the pinned plugin version is the one this workspace publishes", async () => {
  // The pin names another package's version, so nothing about bumping that package forces this
  // constant to move. `1.0.0` shipped a CLI that installed `0.1.2` and then told anyone already on
  // `1.0.0` to re-run setup -- advice that downgraded them. The gate is this test: the release
  // cannot go green while the two disagree.
  const manifest = JSON.parse(
    await readFile(new URL("../../opencode/package.json", import.meta.url), "utf8"),
  );

  assert.equal(pluginPackageSpec, `${manifest.name}@${manifest.version}`);
});

test("a plugin registered without options cannot route the spool and is incompatible", async () => {
  const configFile = await writeOpenCodeConfig(["@snack-ai/opencode@0.1.1"]);

  assert.equal(await inspectPluginRegistration(configFile), "incompatible");
});

test("a plugin carrying unrecognized options is incompatible at any version", async () => {
  const configFile = await writeOpenCodeConfig([
    [pluginPackageSpec, { ...options, unknown_option: true }],
  ]);

  assert.equal(await inspectPluginRegistration(configFile), "incompatible");
});

test("re-running setup upgrades an outdated pin in place instead of duplicating the entry", async () => {
  const configFile = await writeOpenCodeConfig([
    "other-plugin@1.0.0",
    ["@snack-ai/opencode@0.0.9", { ...options, prospective_analysis: true }],
    "trailing-plugin@2.0.0",
  ]);

  const prepared = await preparePluginRegistration(configFile, options);
  /** @type {unknown[]} */
  const plugins = JSON.parse(prepared.content).plugin;
  const snackEntries = /** @type {[string, Record<string, unknown>][]} */ (
    plugins.filter(
      (entry) => Array.isArray(entry) && String(entry[0]).startsWith("@snack-ai/opencode"),
    )
  );

  assert.equal(snackEntries.length, 1, JSON.stringify(plugins));
  const [snackEntry] = snackEntries;
  assert.ok(snackEntry);
  assert.equal(snackEntry[0], pluginPackageSpec);
  assert.equal(prepared.change.action, "update");
  // The upgrade rewrites SNACK's own entry and leaves every neighbour where it was.
  assert.deepEqual(
    plugins.filter((entry) => typeof entry === "string"),
    ["other-plugin@1.0.0", "trailing-plugin@2.0.0"],
  );
  assert.equal(plugins.indexOf(snackEntry), 1);
  // Consent is re-read from the current setup run, never inherited from the old entry.
  assert.equal(snackEntry[1].prospective_analysis, false);
});
