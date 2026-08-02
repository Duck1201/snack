import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, test } from "node:test";

import Database from "better-sqlite3";

import { parseAndValidateConfig } from "../src/config.js";
import { resolvePaths } from "../src/paths.js";
import { resolvePlanProfile } from "../src/plan-profile.js";
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

/**
 * The two timestamps a period is bounded by, in insertion order rather than clock order — which is
 * the whole point when the question is whether the clock ran backwards.
 *
 * @param {string} databaseFile
 * @returns {{plan: string, started_at: string, ended_at: string | null}[]}
 */
function readPeriodBounds(databaseFile) {
  const database = new Database(databaseFile, { readonly: true, fileMustExist: true });
  try {
    return /** @type {{plan: string, started_at: string, ended_at: string | null}[]} */ (
      database
        .prepare(
          `SELECT plan, started_at, ended_at
           FROM capacity_period
           WHERE source_alias = 'work'
           ORDER BY id`,
        )
        .all()
    );
  } finally {
    database.close();
  }
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

/** @param {Partial<{plan: string, plan_profile: string}>} [overrides] */
function makeSource(overrides = {}) {
  return /** @type {{alias: string, installation_id: string, adapter: string, provider: string, profile: string, plan: string, fingerprint: string, plan_profile?: string}} */ ({
    alias: "work",
    installation_id: "11111111-1111-4111-8111-111111111111",
    adapter: "opencode",
    provider: "anthropic",
    profile: "default",
    plan: "pro",
    fingerprint: "oc-sqlite-msgpart-v1",
    ...overrides,
  });
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

test("a rotation at the instant the previous period started is still a rotation", async () => {
  // A period boundary is one instant, recorded as `ended_at` on the closing row and `started_at`
  // on the opening one, so the two rows carry the same timestamp whenever the clock does not move
  // between them. `capacity_period` was `UNIQUE (source_alias, started_at)` until migration 013 and
  // the pair collided, which surfaced as `internal_error` and exit 10 -- the worst code SNACK has,
  // for a caller that retried a millisecond too fast.
  //
  // It is also why no test ever reached the rotation path: every command test injects a frozen
  // clock, so re-running `setup` under one could not rotate at all. That is what hid finding 05.
  const databaseFile = await makeDatabase();
  const instant = new Date("2026-01-02T00:00:00.000Z");
  ensureCapacityPeriod(databaseFile, makeSource(), instant, {
    id: "anthropic-pro",
    version: "1.0.0",
  });

  const rotation = ensureCapacityPeriod(databaseFile, makeSource({ plan: "max" }), instant, {
    id: "anthropic-max",
    version: "1.0.0",
  });

  assert.equal(rotation.rotated, true);
  assert.deepEqual(readPeriods(databaseFile), [
    {
      plan: "pro",
      plan_profile_id: "anthropic-pro",
      plan_profile_version: "1.0.0",
      ended_at: "2026-01-02T00:00:00.000Z",
    },
    {
      plan: "max",
      plan_profile_id: "anthropic-max",
      plan_profile_version: "1.0.0",
      ended_at: null,
    },
  ]);
});

test("a rotation whose clock reads earlier than the open period cannot end it before it started", async () => {
  // Every command reads the clock once on entry and only then queues for the storage lock, so two
  // processes write their periods in lock order and not in clock order. The one that waited can
  // hold the earlier reading, and it was closing the open period with it: a row whose `ended_at`
  // precedes its own `started_at`, which is a false statement about the database. Observed on a
  // real installation by racing four `setup` runs on one alias.
  //
  // The boundary is one instant and it belongs to the period being closed, so it can never be
  // earlier than that period's own start. Clamping it here rather than in any caller is what makes
  // it hold: the transaction is the only place that can see both values.
  const databaseFile = await makeDatabase();
  ensureCapacityPeriod(databaseFile, makeSource(), new Date("2026-01-02T00:00:00.500Z"), {
    id: "anthropic-pro",
    version: "1.0.0",
  });

  // A millisecond earlier than the period it is about to close -- the losing process's reading.
  ensureCapacityPeriod(
    databaseFile,
    makeSource({ plan: "max" }),
    new Date("2026-01-02T00:00:00.499Z"),
    {
      id: "anthropic-max",
      version: "1.0.0",
    },
  );

  const [closed, opened] = readPeriodBounds(databaseFile);
  assert.ok(closed && opened);
  assert.equal(closed.ended_at, "2026-01-02T00:00:00.500Z");
  assert.ok(
    closed.ended_at !== null && closed.ended_at >= closed.started_at,
    `period ended ${closed.ended_at} having started ${closed.started_at}`,
  );
  // One boundary, so the period that opens carries the same instant the closing one ended on, and
  // never a start earlier than the regime it replaces.
  assert.equal(opened.started_at, closed.ended_at);
  assert.equal(opened.ended_at, null);
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

test("a plan profile declares the viability its prior assumes", async () => {
  const { profile } = resolvePlanProfile(makeSource({ plan: "generic" }));

  // The prior is a plan assumption, not a hidden constant in the forecast code.
  assert.equal(profile.prior_viability, 0.5);
  assert.equal(profile.prior_strength, 1);
});

test("a plan profile that omits the prior viability keeps the neutral default", async () => {
  const root = await mkdtemp(join(tmpdir(), "snack-plan-profile-"));
  temporaryRoots.push(root);
  const file = join(root, "custom.json");
  await writeFile(
    file,
    JSON.stringify({
      schema_version: 1,
      id: "custom",
      version: "1.0.0",
      as_of: "2026-01-01",
      provenance: "user-defined",
      prior_strength: 4,
      weights: { prompts: 1 },
    }),
    { mode: 0o600 },
  );

  const { profile } = resolvePlanProfile(makeSource({ plan: "custom", plan_profile: file }));

  assert.equal(profile.prior_viability, 0.5);
  assert.equal(profile.prior_strength, 4);
});

test("a plan profile may declare a different prior viability", async () => {
  const root = await mkdtemp(join(tmpdir(), "snack-plan-profile-"));
  temporaryRoots.push(root);
  const file = join(root, "optimistic.json");
  await writeFile(
    file,
    JSON.stringify({
      schema_version: 1,
      id: "optimistic",
      version: "1.0.0",
      as_of: "2026-01-01",
      provenance: "user-defined",
      prior_strength: 2,
      prior_viability: 0.9,
      weights: { prompts: 1 },
    }),
    { mode: 0o600 },
  );

  const { profile } = resolvePlanProfile(makeSource({ plan: "optimistic", plan_profile: file }));

  assert.equal(profile.prior_viability, 0.9);
});
