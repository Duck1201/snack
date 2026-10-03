import assert from "node:assert/strict";
import { chmod, readFile, readdir, utimes, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, test } from "node:test";

import Database from "better-sqlite3";

import { run } from "../src/main.js";
import { cleanupRunFixtures, createCodexHistory, makeRunFixture } from "./fixtures/run-fixture.js";

afterEach(cleanupRunFixtures);

/**
 * @param {Awaited<ReturnType<typeof makeRunFixture>>} fixture
 * @param {string[]} argv
 */
async function json(fixture, argv) {
  fixture.stdout.value = "";
  fixture.stderr.value = "";
  const exitCode = await run(["node", "snack", ...argv, "--json"], fixture.options);
  assert.equal(exitCode, 0, fixture.stderr.value);
  return JSON.parse(fixture.stdout.value);
}

/** @param {string} alias @param {string} provider */
function setupFlags(alias, provider) {
  return [
    "--non-interactive",
    "--source",
    alias,
    "--provider",
    provider,
    "--profile",
    "default",
    "--plan",
    "plus",
  ];
}

/**
 * Per prompt, the slices storage holds and their token total.
 *
 * @param {string} databaseFile
 * @returns {Map<string, {slices: number, tokens: number}>}
 */
function slicesByPrompt(databaseFile) {
  const database = new Database(databaseFile, { readonly: true });
  try {
    const rows = /** @type {{prompt: string, slices: number, tokens: number}[]} */ (
      database
        .prepare(
          `SELECT p.source_prompt_id AS prompt, COUNT(s.source_slice_id) AS slices,
                  COALESCE(SUM(COALESCE(s.input_tokens, 0) + COALESCE(s.output_tokens, 0)
                    + COALESCE(s.reasoning_tokens, 0) + COALESCE(s.cache_read_tokens, 0)
                    + COALESCE(s.cache_write_tokens, 0)), 0) AS tokens
             FROM prompt_execution AS p
             LEFT JOIN prompt_usage_slice AS s ON s.prompt_execution_id = p.id
            GROUP BY p.id`,
        )
        .all()
    );
    return new Map(rows.map((row) => [row.prompt, { slices: row.slices, tokens: row.tokens }]));
  } finally {
    database.close();
  }
}

test("a 0.147 rollout resumed by 0.159 keeps its old turns' slices across syncs", async () => {
  const fixture = await makeRunFixture("snack-codex-resumed-");
  const home = await createCodexHistory(fixture.root, "version-0-147-0.jsonl");
  fixture.options.env.CODEX_HOME = home;
  await json(fixture, ["setup", "codex", ...setupFlags("codex", "openai")]);
  await json(fixture, ["sync"]);

  const before = slicesByPrompt(fixture.paths.databaseFile);
  const total = (/** @type {Map<string, {slices: number, tokens: number}>} */ rows) =>
    [...rows.values()].reduce(
      (sum, row) => ({ slices: sum.slices + row.slices, tokens: sum.tokens + row.tokens }),
      { slices: 0, tokens: 0 },
    );
  assert.deepEqual(total(before), { slices: 3, tokens: 435 });

  // Codex 0.159 resumes the thread by appending to the very same rollout.
  const day = join(home, "sessions", "2026", "01", "02");
  const [name] = await readdir(day);
  const file = join(day, String(name));
  await writeFile(
    file,
    await readFile(
      new URL("./fixtures/codex/resumed-0-147-0-by-0-159-3.jsonl", import.meta.url),
      "utf8",
    ),
  );
  // Later than the first read, whatever the clock said when the fixture was written.
  const later = new Date(Date.now() + 60_000);
  await utimes(file, later, later);
  await json(fixture, ["sync"]);

  const after = slicesByPrompt(fixture.paths.databaseFile);
  assert.deepEqual(total(after), { slices: 4, tokens: 446 });
  // Totals only grow, and every old turn keeps exactly the slices it had.
  for (const [prompt, row] of before) assert.deepEqual(after.get(prompt), row, prompt);
  assert.deepEqual(after.get("00000000-0000-7000-8000-000000000103"), { slices: 1, tokens: 11 });

  // A full re-read agrees with the incremental one.
  await json(fixture, ["sync", "--full"]);
  assert.deepEqual(slicesByPrompt(fixture.paths.databaseFile), after);
});

/** @param {string} databaseFile */
function reportedAliases(databaseFile) {
  const database = new Database(databaseFile, { readonly: true });
  try {
    return database
      .prepare(
        "SELECT DISTINCT source_alias AS alias FROM reported_capacity_observation ORDER BY 1",
      )
      .all()
      .map((row) => /** @type {{alias: string}} */ (row).alias);
  } finally {
    database.close();
  }
}

for (const order of [
  ["az", "oa"],
  ["oa", "az"],
]) {
  test(`a stated figure reaches only the source of its provider (${order.join(" then ")})`, async () => {
    const fixture = await makeRunFixture("snack-codex-two-providers-");
    // One Codex installation, two capacity sources told apart by provider. Every rollout here
    // names `openai`, so every figure Codex stated belongs to `oa` and none to `az`.
    fixture.options.env.CODEX_HOME = await createCodexHistory(fixture.root, [
      "version-0-159-3.jsonl",
      "version-0-147-0.jsonl",
    ]);
    const providers = /** @type {Record<string, string>} */ ({ az: "azure", oa: "openai" });
    for (const alias of order) {
      await json(fixture, ["setup", "codex", ...setupFlags(alias, String(providers[alias]))]);
    }
    await json(fixture, ["sync", "--full"]);

    assert.deepEqual(reportedAliases(fixture.paths.databaseFile), ["oa"]);
    const status = await json(fixture, ["status", "--no-sync", "--source", "az"]);
    assert.deepEqual(status.data.reported_capacity ?? [], []);
    const stated = await json(fixture, ["status", "--no-sync", "--source", "oa"]);
    assert.ok(stated.data.reported_capacity.length > 0);
  });
}

/**
 * The percentages every stored figure of `alias` states, sorted.
 *
 * @param {string} databaseFile
 * @param {string} alias
 */
function statedPercents(databaseFile, alias) {
  const database = new Database(databaseFile, { readonly: true });
  try {
    return database
      .prepare(
        `SELECT used_percent AS percent FROM reported_capacity_observation
          WHERE source_alias = ? ORDER BY used_percent`,
      )
      .all(alias)
      .map((row) => /** @type {{percent: number}} */ (row).percent);
  } finally {
    database.close();
  }
}

for (const order of [
  ["az", "oa"],
  ["oa", "az"],
]) {
  test(`each thread's stated figure reaches the source its own provider names (${order.join(" then ")})`, async () => {
    const fixture = await makeRunFixture("snack-codex-mixed-providers-");
    // Two threads in one Codex history: one on `openai`, one on `azure`. The azure copy states
    // different percentages, so a figure routed by anything but its own thread lands visibly wrong.
    const home = await createCodexHistory(fixture.root, "version-0-159-3.jsonl");
    const day = join(home, "sessions", "2026", "01", "02");
    const base = await readFile(
      new URL("./fixtures/codex/version-0-159-3.jsonl", import.meta.url),
      "utf8",
    );
    const azure = base
      .replaceAll('"model_provider":"openai"', '"model_provider":"azure"')
      .replaceAll("00000000-0000-7000-8000-0000000001", "00000000-0000-7000-8000-0000000009")
      .replaceAll("00000000-0000-7000-8000-000000000002", "00000000-0000-7000-8000-000000000992")
      .replaceAll("resp_test_", "resp_az_")
      .replaceAll('"used_percent":34', '"used_percent":71')
      .replaceAll('"used_percent":19', '"used_percent":83');
    assert.notEqual(azure, base);
    await writeFile(join(day, "rollout-2026-01-02T02-00-00-azure.jsonl"), azure, { mode: 0o600 });
    fixture.options.env.CODEX_HOME = home;
    const providers = /** @type {Record<string, string>} */ ({ az: "azure", oa: "openai" });
    for (const alias of order) {
      await json(fixture, ["setup", "codex", ...setupFlags(alias, String(providers[alias]))]);
    }
    await json(fixture, ["sync", "--full"]);

    assert.deepEqual(statedPercents(fixture.paths.databaseFile, "az"), [71, 71, 83, 83]);
    assert.deepEqual(statedPercents(fixture.paths.databaseFile, "oa"), [19, 19, 34, 34]);
    for (const [alias, percents] of [
      ["az", [71, 83]],
      ["oa", [19, 34]],
    ]) {
      const status = await json(fixture, ["status", "--no-sync", "--source", String(alias)]);
      const shown = JSON.stringify(status.data.reported_capacity);
      for (const percent of percents)
        assert.match(shown, new RegExp(`"used_percent":${percent}\\b`));
    }
  });
}

test(
  "one unreadable rollout fails the Codex sync and points at doctor, without a path",
  {
    skip: process.getuid?.() === 0 ? "root reads a file whatever its mode" : false,
  },
  async () => {
    const fixture = await makeRunFixture("snack-codex-unreadable-");
    const home = await createCodexHistory(fixture.root, [
      "version-0-159-3.jsonl",
      "version-0-147-0.jsonl",
    ]);
    fixture.options.env.CODEX_HOME = home;
    await json(fixture, ["setup", "codex", ...setupFlags("codex", "openai")]);
    const day = join(home, "sessions", "2026", "01", "02");
    const unreadable = join(
      day,
      String((await readdir(day)).find((name) => name.includes("0-147"))),
    );
    await chmod(unreadable, 0);
    try {
      // Fail closed: one rollout SNACK cannot read refuses the whole source, unlike Claude Code's
      // adapter, which skips one unreadable session file (spec R8).
      const sync = await json(fixture, ["sync"]);
      assert.equal(sync.status, "degraded");
      assert.equal(sync.data.sources[0].failed, 1);
      const [warning] = sync.warnings;
      assert.equal(warning.code, "source_sync_failed");
      assert.match(warning.message, /`snack doctor`/u);
      assert.ok(!warning.message.includes(fixture.root), warning.message);

      fixture.stdout.value = "";
      await run(["node", "snack", "doctor", "--json"], fixture.options);
      const checks = JSON.parse(fixture.stdout.value).data.checks;
      const fingerprint = checks.find(
        (/** @type {{id: string}} */ check) => check.id === "source_fingerprint:codex:codex",
      );
      assert.equal(fingerprint?.status, "fail");
      assert.match(String(fingerprint?.message), /inaccessible/u);
    } finally {
      await chmod(unreadable, 0o600);
    }
    // Recoverable: once the permission returns, the same source syncs again.
    const again = await json(fixture, ["sync"]);
    assert.equal(again.status, "ok");
  },
);
