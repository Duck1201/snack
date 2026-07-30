import assert from "node:assert/strict";
import { test } from "node:test";

import { resolvePaths } from "../src/paths.js";

test("resolves XDG paths on Linux", () => {
  const paths = resolvePaths({
    platform: "linux",
    home: "/home/tester",
    env: {
      XDG_CONFIG_HOME: "/xdg/config",
      XDG_DATA_HOME: "/xdg/data",
      XDG_CACHE_HOME: "/xdg/cache",
      XDG_STATE_HOME: "/xdg/state",
    },
  });

  assert.equal(paths.configFile, "/xdg/config/snack/config.jsonc");
  assert.equal(paths.databaseFile, "/xdg/data/snack/snack.sqlite3");
  assert.equal(paths.cacheDir, "/xdg/cache/snack");
  assert.equal(paths.stateDir, "/xdg/state/snack");
});

test("uses platform-native library locations on macOS", () => {
  const paths = resolvePaths({ platform: "darwin", home: "/Users/tester", env: {} });

  assert.equal(paths.configFile, "/Users/tester/Library/Application Support/SNACK/config.jsonc");
  assert.equal(paths.cacheDir, "/Users/tester/Library/Caches/SNACK");
  assert.equal(paths.stateDir, "/Users/tester/Library/Logs/SNACK");
});

test("ignores relative XDG base directories", () => {
  const paths = resolvePaths({
    platform: "linux",
    home: "/home/tester",
    env: {
      XDG_CONFIG_HOME: "relative-config",
      XDG_DATA_HOME: "relative-data",
    },
  });

  assert.equal(paths.configFile, "/home/tester/.config/snack/config.jsonc");
  assert.equal(paths.databaseFile, "/home/tester/.local/share/snack/snack.sqlite3");
});
