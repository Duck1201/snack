import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, test } from "node:test";

import Database from "better-sqlite3";

import { resolvePaths } from "../src/paths.js";
import {
  initializeDatabase,
  migrationDirectory,
  purgeScope,
  readStatedBandRows,
  storeObservations,
} from "../src/storage.js";

// Instants are stored in the one spelling `Date#toISOString` writes, because storage compares and
// orders them as text: the stated-band restate, the purge and export windows, the selection of a
// prompt's capacity period. An offset or a fraction of another length sorts out of time order as
// text -- `01:30:00-03:00` is 04:30 UTC and sorts before `04:00:00.000Z`.

const now = new Date("2026-01-03T00:00:00.000Z");

/** @type {string[]} */
const temporaryRoots = [];

afterEach(async () => {
  await Promise.all(
    temporaryRoots.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

/** @param {string} [migrationsDir] */
async function makeStorage(migrationsDir) {
  const root = await mkdtemp(join(tmpdir(), "snack-instants-"));
  temporaryRoots.push(root);
  const paths = resolvePaths({
    env: { XDG_DATA_HOME: join(root, "data"), XDG_STATE_HOME: join(root, "state") },
    platform: /** @type {NodeJS.Platform} */ ("linux"),
    home: root,
  });
  await initializeDatabase(paths, {
    applicationVersion: "1.6.0",
    now,
    ...(migrationsDir === undefined ? {} : { migrationsDir }),
  });
  const database = new Database(paths.databaseFile);
  try {
    database
      .prepare("INSERT INTO capacity_source (alias, created_at) VALUES ('work', ?)")
      .run(now.toISOString());
  } finally {
    database.close();
  }
  return paths;
}

/** @param {number} through */
async function copyMigrationsThrough(through) {
  const root = await mkdtemp(join(tmpdir(), "snack-instants-migrations-"));
  temporaryRoots.push(root);
  const directory = join(root, "migrations");
  await mkdir(directory, { mode: 0o700 });
  for (const name of (await readdir(migrationDirectory)).sort()) {
    if (Number(name.slice(0, 3)) > through) continue;
    await writeFile(join(directory, name), await readFile(join(migrationDirectory, name), "utf8"));
  }
  return directory;
}

/** @param {string} databaseFile */
function configuredSource(databaseFile) {
  return {
    alias: "work",
    installation_id: "11111111-2222-4333-8444-555555555555",
    adapter: /** @type {"opencode"} */ ("opencode"),
    database: databaseFile,
    provider: "anthropic",
    profile: "default",
    plan: "pro",
    fingerprint: "oc-sqlite-msgpart-v1",
  };
}

/**
 * @param {string} id
 * @param {string} startedAt
 * @param {string} [observedAt] a restriction's instant, when the prompt was restricted
 * @returns {import("../src/storage.js").Observation}
 */
function observation(id, startedAt, observedAt) {
  return {
    source_prompt_id: id,
    source_session_id: "session-1",
    revision: "1",
    revision_domain: "opencode-message-v1",
    parser_version: "opencode-session-v1",
    started_at: startedAt,
    completed_at: startedAt,
    duration_ms: 1000,
    completion: "completed",
    outcome: observedAt === undefined ? "success" : "restricted",
    provider: "anthropic",
    model: "claude-sonnet",
    usage_slices: [],
    restrictions:
      observedAt === undefined
        ? []
        : [
            {
              class: "usage_limit",
              source_code: "rate_limit",
              observed_at: observedAt,
              classifier_version: "1",
              provenance: "backfill",
            },
          ],
  };
}

// Four spellings a source can hand storage, each with the instant it names.
const spelled = [
  { id: "offset", written: "2026-01-02T01:30:00-03:00", instant: "2026-01-02T04:30:00.000Z" },
  { id: "canonical", written: "2026-01-02T04:00:00.000Z", instant: "2026-01-02T04:00:00.000Z" },
  { id: "micro", written: "2026-01-02T04:15:00.123456Z", instant: "2026-01-02T04:15:00.123Z" },
  { id: "seconds", written: "2026-01-02T04:20:00Z", instant: "2026-01-02T04:20:00.000Z" },
];

/** @param {string} databaseFile */
function storedInstants(databaseFile) {
  const database = new Database(databaseFile, { readonly: true });
  try {
    return {
      prompts: database
        .prepare(
          `SELECT source_prompt_id AS id, started_at, completed_at
             FROM prompt_execution ORDER BY source_prompt_id`,
        )
        .all(),
      restrictions: database
        .prepare(
          `SELECT prompt_execution.source_prompt_id AS id, restriction_observation.observed_at
             FROM restriction_observation
             JOIN prompt_execution ON prompt_execution.id = restriction_observation.prompt_execution_id
            ORDER BY prompt_execution.source_prompt_id, restriction_observation.observed_at`,
        )
        .all(),
    };
  } finally {
    database.close();
  }
}

test("an offset or a fraction is stored as the instant it names, so text order is time order", async () => {
  const paths = await makeStorage();
  const source = configuredSource(paths.databaseFile);
  const counts = storeObservations(
    paths.databaseFile,
    source,
    {
      observations: spelled.map(({ id, written }) => observation(id, written, written)),
      cursor: null,
    },
    now,
  );
  assert.equal(counts.inserted, spelled.length);

  const sorted = [...spelled].sort((left, right) => (left.instant < right.instant ? -1 : 1));
  assert.deepEqual(storedInstants(paths.databaseFile), {
    prompts: spelled
      .map(({ id, instant }) => ({ id, started_at: instant, completed_at: instant }))
      .sort((left, right) => (left.id < right.id ? -1 : 1)),
    restrictions: spelled
      .map(({ id, instant }) => ({ id, observed_at: instant }))
      .sort((left, right) => (left.id < right.id ? -1 : 1)),
  });

  // The restate's read: oldest first, by instant.
  assert.deepEqual(
    readStatedBandRows(paths.databaseFile, "work").map((row) => row.started_at),
    sorted.map(({ instant }) => instant),
  );
  // Its lookback filter: 04:30 UTC is after 04:20, though `01:30-03:00` is not as text.
  assert.deepEqual(
    readStatedBandRows(paths.databaseFile, "work", { from: "2026-01-02T04:20:00.000Z" }).map(
      (row) => row.started_at,
    ),
    ["2026-01-02T04:20:00.000Z", "2026-01-02T04:30:00.000Z"],
  );
  // A purge window selects by the same comparison.
  const preview = await purgeScope(
    paths,
    { source: "work", since: "2026-01-02T04:25:00.000Z" },
    { now, preview: true },
  );
  assert.equal(preview.counts.prompts, 1);
});

test("re-reading a prompt in the spelling it was first read in changes nothing", async () => {
  const paths = await makeStorage();
  const source = configuredSource(paths.databaseFile);
  const batch = {
    observations: spelled.map(({ id, written }) => observation(id, written, written)),
    cursor: null,
  };
  storeObservations(paths.databaseFile, source, batch, now);
  const again = storeObservations(paths.databaseFile, source, batch, now);
  assert.equal(again.unchanged, spelled.length);
  assert.equal(again.updated, 0);
});

test("an instant that does not parse is refused, never stored", async () => {
  const paths = await makeStorage();
  const source = configuredSource(paths.databaseFile);
  const counts = storeObservations(
    paths.databaseFile,
    source,
    {
      observations: [
        { ...observation("start", "not a time"), completed_at: null },
        { ...observation("end", "2026-01-02T04:00:00.000Z"), completed_at: "later" },
        observation("restriction", "2026-01-02T04:00:00.000Z", "2026-13-40T99:00:00Z"),
      ],
      cursor: null,
    },
    now,
  );
  assert.equal(counts.inserted, 0);
  assert.equal(counts.rejected_invalid, 3);
  assert.deepEqual(storedInstants(paths.databaseFile), { prompts: [], restrictions: [] });
});

test("an instant that names no offset is refused, not read in the local time zone", async () => {
  // `Date.parse` reads a date-time without an offset as local time and accepts spellings no client
  // writes, so the same line stored a different instant on machines in different zones. Storage
  // holds an instant to the rule the spool contract already states: RFC 3339, with `Z` or an
  // offset. Every Claude Code and Codex timestamp in a real history is spelled that way.
  const paths = await makeStorage();
  const source = configuredSource(paths.databaseFile);
  const counts = storeObservations(
    paths.databaseFile,
    source,
    {
      observations: [
        { ...observation("local", "2026-01-02T04:00:00.000"), completed_at: null },
        { ...observation("date", "2026-01-02"), completed_at: null },
        { ...observation("prose", "Fri, 02 Jan 2026 04:00:00 GMT"), completed_at: null },
        { ...observation("end", "2026-01-02T04:00:00.000Z"), completed_at: "2026-01-02T04:01:00" },
        observation("restriction", "2026-01-02T04:00:00.000Z", "2026-01-02T04:00:30"),
      ],
      cursor: null,
    },
    now,
  );
  assert.equal(counts.inserted, 0);
  assert.equal(counts.rejected_invalid, 5);
  assert.deepEqual(storedInstants(paths.databaseFile), { prompts: [], restrictions: [] });
});

test("migration 020 rewrites stored instants in place, and the next read finds them unchanged", async () => {
  // A 1.6.0 database: stored as the source wrote them, hashed as the source wrote them.
  const paths = await makeStorage(await copyMigrationsThrough(19));
  const source = configuredSource(paths.databaseFile);
  const batch = {
    observations: spelled.map(({ id, written }) => observation(id, written, written)),
    cursor: null,
  };
  storeObservations(paths.databaseFile, source, batch, now);
  const database = new Database(paths.databaseFile);
  try {
    database.pragma("foreign_keys = ON");
    const promptId = database.prepare("SELECT id FROM prompt_execution WHERE source_prompt_id = ?");
    for (const { id, written } of spelled) {
      const row = /** @type {{id: number}} */ (promptId.get(id));
      // What 1.6.0 stored: the instants as written, and the hash of the observation as written.
      const hash = createHash("sha256")
        .update(JSON.stringify(observation(id, written, written)))
        .digest("hex");
      database
        .prepare(
          `UPDATE prompt_execution SET started_at = ?, completed_at = ?, observation_hash = ?
            WHERE id = ?`,
        )
        .run(written, written, hash, row.id);
      database
        .prepare("UPDATE restriction_observation SET observed_at = ? WHERE prompt_execution_id = ?")
        .run(written, row.id);
    }
    // One instant restricted twice in two spellings: one restriction once rewritten.
    const offset = /** @type {{id: number}} */ (promptId.get("offset"));
    database
      .prepare(
        `INSERT INTO restriction_observation
           (prompt_execution_id, class, source_code, observed_at, classifier_version, provenance)
         VALUES (?, 'usage_limit', 'rate_limit', '2026-01-02T04:30:00.000Z', '1', 'spool')`,
      )
      .run(offset.id);
    database
      .prepare(
        `INSERT INTO stated_band_projection (source_alias, policy_version, stale_from)
         VALUES ('work', 'current', NULL)
         ON CONFLICT (source_alias) DO UPDATE SET policy_version = 'current', stale_from = NULL`,
      )
      .run();
  } finally {
    database.close();
  }

  const upgrade = await initializeDatabase(paths, { applicationVersion: "1.6.1", now });
  assert.deepEqual(upgrade.applied, [20]);
  assert.equal(upgrade.backupCreated, true);

  const byId = (/** @type {{id: string}} */ left, /** @type {{id: string}} */ right) =>
    left.id < right.id ? -1 : 1;
  assert.deepEqual(storedInstants(paths.databaseFile), {
    prompts: spelled
      .map(({ id, instant }) => ({ id, started_at: instant, completed_at: instant }))
      .sort(byId),
    restrictions: spelled.map(({ id, instant }) => ({ id, observed_at: instant })).sort(byId),
  });
  const reopened = new Database(paths.databaseFile, { readonly: true });
  try {
    // The projection may have read them in another order: the whole active period is recomputed.
    assert.deepEqual(
      reopened.prepare("SELECT policy_version, stale_from FROM stated_band_projection").get(),
      { policy_version: "current", stale_from: "" },
    );
  } finally {
    reopened.close();
  }

  // The hash is of the observation as the source delivered it, so a re-read moves nothing.
  const again = storeObservations(paths.databaseFile, source, batch, now);
  assert.equal(again.unchanged, spelled.length);
  assert.equal(again.updated, 0);
});

test("migration 020 leaves a canonical database exactly as it was", async () => {
  const paths = await makeStorage(await copyMigrationsThrough(19));
  const source = configuredSource(paths.databaseFile);
  storeObservations(
    paths.databaseFile,
    source,
    {
      observations: [observation("a", "2026-01-02T04:00:00.000Z", "2026-01-02T04:00:01.000Z")],
      cursor: null,
    },
    now,
  );
  const database = new Database(paths.databaseFile);
  try {
    database
      .prepare(
        `INSERT INTO stated_band_projection (source_alias, policy_version, stale_from)
         VALUES ('work', 'current', NULL)
         ON CONFLICT (source_alias) DO UPDATE SET policy_version = 'current', stale_from = NULL`,
      )
      .run();
  } finally {
    database.close();
  }
  const before = storedInstants(paths.databaseFile);
  await initializeDatabase(paths, { applicationVersion: "1.6.1", now });
  assert.deepEqual(storedInstants(paths.databaseFile), before);
  const reopened = new Database(paths.databaseFile, { readonly: true });
  try {
    assert.deepEqual(
      reopened.prepare("SELECT policy_version, stale_from FROM stated_band_projection").get(),
      { policy_version: "current", stale_from: null },
    );
  } finally {
    reopened.close();
  }
});

/**
 * @param {number} n
 * @param {string} observedAt
 * @returns {import("../src/storage.js").ReportedCapacitySnapshot}
 */
function snapshot(n, observedAt) {
  return {
    observation_key: n.toString(16).padStart(64, "0"),
    observed_at: observedAt,
    limit_id: "codex",
    plan_type: "plus",
    windows: [{ window_minutes: 300, used_percent: 34, resets_at: "2026-01-02T14:30:00Z" }],
    parser_version: "codex-rate-limits-v1",
    provider: "openai",
  };
}

/** @returns {import("../src/storage.js").ConfiguredSource} */
function codexSource() {
  return {
    alias: "codex",
    installation_id: "33333333-4444-4555-8666-777777777777",
    adapter: "codex",
    provider: "openai",
    profile: "default",
    plan: "plus",
    fingerprint: "cx-rollout-usagerecord-v1",
  };
}

/**
 * @param {string} databaseFile
 * @param {import("../src/storage.js").ReportedCapacitySnapshot[]} reported
 */
function storeReported(databaseFile, reported) {
  return storeObservations(
    databaseFile,
    codexSource(),
    { observations: [], cursor: { files: {} }, reported_capacity: reported },
    now,
  );
}

/** @param {string} databaseFile */
function storedStatements(databaseFile) {
  const database = new Database(databaseFile, { readonly: true });
  try {
    return {
      rows: database
        .prepare(
          `SELECT substr(observation_key, -1) AS key, observed_at, resets_at
             FROM reported_capacity_observation ORDER BY observation_key`,
        )
        .all(),
      latest: database
        .prepare(
          "SELECT substr(observation_key, -1) AS key, observed_at FROM reported_capacity_latest",
        )
        .all(),
    };
  } finally {
    database.close();
  }
}

test("a statement made without a fraction is stored with one, so it does not outrank a later one", async () => {
  const paths = await makeStorage();
  // `12:00:00Z` is half a second before `12:00:00.500Z`, and sorts after it as text.
  storeReported(paths.databaseFile, [snapshot(1, "2026-01-02T12:00:00.500Z")]);
  storeReported(paths.databaseFile, [snapshot(2, "2026-01-02T12:00:00Z")]);
  assert.deepEqual(storedStatements(paths.databaseFile), {
    rows: [
      { key: "1", observed_at: "2026-01-02T12:00:00.500Z", resets_at: "2026-01-02T14:30:00.000Z" },
      { key: "2", observed_at: "2026-01-02T12:00:00.000Z", resets_at: "2026-01-02T14:30:00.000Z" },
    ],
    latest: [{ key: "1", observed_at: "2026-01-02T12:00:00.500Z" }],
  });
});

test("migration 020 rewrites a statement stored without its fraction", async () => {
  const paths = await makeStorage(await copyMigrationsThrough(19));
  storeReported(paths.databaseFile, [snapshot(1, "2026-01-02T12:00:00.000Z")]);
  const database = new Database(paths.databaseFile);
  try {
    database.exec(`
      UPDATE reported_capacity_observation
         SET observed_at = '2026-01-02T12:00:00Z', resets_at = '2026-01-02T14:30:00Z';
      UPDATE reported_capacity_latest SET observed_at = '2026-01-02T12:00:00Z';
      UPDATE stated_band_projection SET policy_version = 'current', stale_from = NULL;`);
  } finally {
    database.close();
  }
  await initializeDatabase(paths, { applicationVersion: "1.6.1", now });
  assert.deepEqual(storedStatements(paths.databaseFile), {
    rows: [
      { key: "1", observed_at: "2026-01-02T12:00:00.000Z", resets_at: "2026-01-02T14:30:00.000Z" },
    ],
    latest: [{ key: "1", observed_at: "2026-01-02T12:00:00.000Z" }],
  });
  const reopened = new Database(paths.databaseFile, { readonly: true });
  try {
    assert.deepEqual(
      reopened
        .prepare("SELECT stale_from FROM stated_band_projection WHERE source_alias = 'codex'")
        .get(),
      { stale_from: "" },
    );
  } finally {
    reopened.close();
  }
});
