import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, test } from "node:test";

import Database from "better-sqlite3";

import { parseAndValidateConfig } from "../src/config.js";
import { resolvePaths } from "../src/paths.js";
import { ensureCapacityPeriod, initializeDatabase } from "../src/storage.js";

/** @type {string[]} */
const temporaryRoots = [];

afterEach(async () => {
  while (temporaryRoots.length > 0) {
    const root = temporaryRoots.pop();
    if (root !== undefined) {
      await rm(root, { recursive: true, force: true });
    }
  }
});

/** Create a migrated, empty SNACK database. */
async function makeDatabase() {
  const root = await mkdtemp(join(tmpdir(), "snack-plan-profile-"));
  temporaryRoots.push(root);
  const paths = resolvePaths({
    env: { XDG_DATA_HOME: join(root, "data"), XDG_STATE_HOME: join(root, "state") },
    platform: "linux",
    home: root,
  });
  await initializeDatabase(paths, {
    applicationVersion: "0.4.0",
    now: new Date("2026-01-01T00:00:00.000Z"),
  });
  return paths.databaseFile;
}

/** @param {string} databaseFile */
function readPeriods(databaseFile) {
  const database = new Database(databaseFile, { readonly: true, fileMustExist: true });
  try {
    return database
      .prepare(
        `SELECT plan, plan_profile_id, plan_profile_version, ended_at
         FROM capacity_period
         WHERE source_alias = 'work'
         ORDER BY started_at, id`,
      )
      .all();
  } finally {
    database.close();
  }
}

/** @param {Partial<{plan: string}>} [overrides] */
function makeSource(overrides = {}) {
  return {
    alias: "work",
    installation_id: "11111111-1111-4111-8111-111111111111",
    adapter: "opencode",
    provider: "anthropic",
    profile: "default",
    plan: "pro",
    fingerprint: "oc-sqlite-msgpart-v1",
    ...overrides,
  };
}

test("a source may select a plan profile explicitly", () => {
  const config = parseAndValidateConfig(
    JSON.stringify({
      schema_version: 1,
      sources: [
        {
          alias: "work",
          installation_id: "11111111-1111-4111-8111-111111111111",
          adapter: "opencode",
          database: "/tmp/opencode.db",
          provider: "anthropic",
          profile: "default",
          plan: "pro",
          plan_profile: "generic",
          fingerprint: "oc-sqlite-msgpart-v1",
        },
      ],
    }),
  );

  const sources = /** @type {{plan_profile?: string}[]} */ (config.sources);
  assert.equal(sources[0]?.plan_profile, "generic");
});

test("ensureCapacityPeriod records the plan profile that was active when it opened", async () => {
  const databaseFile = await makeDatabase();

  ensureCapacityPeriod(databaseFile, makeSource(), new Date("2026-01-02T00:00:00.000Z"), {
    id: "anthropic-pro",
    version: "1.0.0",
  });

  assert.deepEqual(readPeriods(databaseFile), [
    {
      plan: "pro",
      plan_profile_id: "anthropic-pro",
      plan_profile_version: "1.0.0",
      ended_at: null,
    },
  ]);
});

test("switching to another plan profile starts a new capacity period", async () => {
  const databaseFile = await makeDatabase();
  ensureCapacityPeriod(databaseFile, makeSource(), new Date("2026-01-02T00:00:00.000Z"), {
    id: "anthropic-pro",
    version: "1.0.0",
  });

  // Same provider, profile, and plan: only the selected profile changes.
  ensureCapacityPeriod(databaseFile, makeSource(), new Date("2026-01-03T00:00:00.000Z"), {
    id: "my-custom-pro",
    version: "1.0.0",
  });

  assert.deepEqual(readPeriods(databaseFile), [
    {
      plan: "pro",
      plan_profile_id: "anthropic-pro",
      plan_profile_version: "1.0.0",
      ended_at: "2026-01-03T00:00:00.000Z",
    },
    {
      plan: "pro",
      plan_profile_id: "my-custom-pro",
      plan_profile_version: "1.0.0",
      ended_at: null,
    },
  ]);
});

test("a bundled plan profile version bump keeps the active capacity period", async () => {
  const databaseFile = await makeDatabase();
  ensureCapacityPeriod(databaseFile, makeSource(), new Date("2026-01-02T00:00:00.000Z"), {
    id: "anthropic-pro",
    version: "1.0.0",
  });

  // Shipping a newer bundled profile must not reset local evidence on every upgrade.
  ensureCapacityPeriod(databaseFile, makeSource(), new Date("2026-01-03T00:00:00.000Z"), {
    id: "anthropic-pro",
    version: "1.1.0",
  });

  assert.deepEqual(readPeriods(databaseFile), [
    {
      plan: "pro",
      plan_profile_id: "anthropic-pro",
      plan_profile_version: "1.0.0",
      ended_at: null,
    },
  ]);
});
