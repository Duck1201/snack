import assert from "node:assert/strict";
import { chmod, mkdir, readFile, readdir, rm, utimes, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, test } from "node:test";

import { runDoctor } from "../src/doctor.js";
import { ExitCode } from "../src/errors.js";
import { run } from "../src/main.js";
import { pluginPackageSpec } from "../src/opencode-config.js";
import { initializeDatabase, migrationDirectory } from "../src/storage.js";
import {
  cleanupRunFixtures,
  createClaudeHistory,
  createCodexHistory,
  createOpenCodeDatabase,
  makeRunFixture,
} from "./fixtures/run-fixture.js";

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
  const report = await runOpenCodeDoctor(plugins);
  const check = report.checks.find((candidate) => candidate.id === "opencode_plugin");
  assert.ok(check, "doctor did not report an opencode_plugin check");
  return check;
}

/**
 * @param {unknown[]} plugins
 * @param {(paths: import("../src/paths.js").SnackPaths) => Promise<void>} [prepare]
 */
async function runOpenCodeDoctor(plugins, prepare) {
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
  if (prepare) await prepare(paths);

  return runDoctor(paths, {
    nodeVersion: "24.18.1",
    platform: "linux",
    now,
    opencodeConfigFile,
  });
}

test("doctor warns about a spool writer lock that was abandoned", async () => {
  // A lock is held for the milliseconds one append takes; one left behind by a crashed writer whose
  // pid was reused kept capture off with nothing saying so.
  for (const ageMs of [10 * 60_000, 5_000]) {
    const report = await runOpenCodeDoctor([[pluginPackageSpec, pluginOptions]], async (paths) => {
      const directory = join(paths.spoolDir, "work");
      await mkdir(directory, { recursive: true, mode: 0o700 });
      await chmod(paths.spoolDir, 0o700);
      const lock = join(directory, ".writer.lock");
      await writeFile(lock, `${JSON.stringify({ pid: 1, token: "abandoned" })}\n`, {
        mode: 0o600,
      });
      const modified = new Date(now.getTime() - ageMs);
      await utimes(lock, modified, modified);
    });
    const check = report.checks.find((candidate) => candidate.id === "spool_lock:work");
    if (ageMs > 120_000) {
      assert.equal(check?.status, "warn", JSON.stringify(report.checks));
      assert.match(String(check?.message), /lock/u);
    } else {
      assert.equal(check, undefined, "a lock a writer may still hold is not reported");
    }
  }
});

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
  assert.ok(ids.includes("source_fingerprint:claude:claude"), ids.join(", "));
  assert.equal(document.status, "ok");
});

test("a Claude family appended past the fingerprint sample is refused by sync and failed by doctor", async () => {
  // A session resumed by a later Claude Code gains that client's records at its tail. The head is
  // read first, the session is then resumed in a shape SNACK does not read, past the 200 records
  // the per-sync check samples: `sync` has to refuse it rather than store a prompt with null
  // tokens, and `doctor` has to say so rather than pass on the head of the file.
  const fixtureName = "resumed-2-1-220-by-drifted-usage.jsonl";
  const fixtureText = await readFile(
    new URL(`./fixtures/claude/${fixtureName}`, import.meta.url),
    "utf8",
  );
  const lines = fixtureText.split("\n");
  const fixture = await makeRunFixture("snack-doctor-claude-resumed-");
  const configDir = await createClaudeHistory(fixture.root, fixtureName);
  const sessionFile = join(
    configDir,
    "projects",
    "-fixture-project",
    "aaaaaaaa-0000-4000-8000-000000000001.jsonl",
  );
  await writeFile(sessionFile, `${lines.slice(0, 202).join("\n")}\n`, { mode: 0o600 });
  fixture.options.env.CLAUDE_CONFIG_DIR = configDir;
  const setup = await run(
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
  assert.equal(setup, 0, fixture.stderr.value);
  assert.equal(await run(["node", "snack", "sync", "--full"], fixture.options), 0);
  const countPrompts = async () => {
    const { default: Database } = await import("better-sqlite3");
    const database = new Database(fixture.paths.databaseFile, { readonly: true });
    try {
      return /** @type {{total: number}} */ (
        database.prepare("SELECT COUNT(*) AS total FROM prompt_execution").get()
      ).total;
    } finally {
      database.close();
    }
  };
  // Guard against a vacuous pass: the head of the session really was read.
  assert.equal(await countPrompts(), 101);

  await writeFile(sessionFile, fixtureText, { mode: 0o600 });
  const canaries = JSON.parse(
    await readFile(new URL("./fixtures/privacy-canaries.json", import.meta.url), "utf8"),
  );
  for (const argv of [
    ["sync", "--json"],
    ["sync", "--full", "--json"],
  ]) {
    fixture.stdout.value = "";
    fixture.stderr.value = "";
    await run(["node", "snack", ...argv], fixture.options);
    // A source that refuses is a degraded sync, as drift at the head of a file is: the other
    // sources still synchronize, and this one writes nothing.
    const document = JSON.parse(fixture.stdout.value);
    assert.equal(document.status, "degraded", fixture.stdout.value);
    assert.equal(document.data.sources[0].failed, 1);
    assert.equal(document.data.sources[0].inserted + document.data.sources[0].updated, 0);
    assert.equal(document.warnings[0].code, "source_sync_failed");
    for (const canary of Object.values(canaries)) {
      assert.doesNotMatch(fixture.stdout.value + fixture.stderr.value, new RegExp(canary, "u"));
    }
  }
  assert.equal(await countPrompts(), 101);
  const database = await readFile(fixture.paths.databaseFile, "latin1");
  for (const canary of Object.values(canaries)) {
    assert.doesNotMatch(database, new RegExp(canary, "u"));
  }

  fixture.stdout.value = "";
  await run(["node", "snack", "doctor", "--json"], fixture.options);
  const check = JSON.parse(fixture.stdout.value).data.checks.find(
    (/** @type {{id: string}} */ entry) => entry.id === "source_fingerprint:claude:claude",
  );
  assert.equal(check?.status, "fail");
});

test("doctor refuses a capacity source that is not configured", async () => {
  // Every other command rejects an unknown alias with exit 4. Doctor answered a typo with a clean
  // bill of health -- the per-source checks simply selected nothing, so what remained all passed.
  const fixture = await makeRunFixture("snack-doctor-unknown-");
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

  fixture.stdout.value = "";
  fixture.stderr.value = "";
  const exitCode = await run(
    ["node", "snack", "doctor", "--source", "absent", "--json"],
    fixture.options,
  );

  assert.equal(exitCode, ExitCode.unavailable, fixture.stdout.value);
  const document = JSON.parse(fixture.stdout.value);
  assert.equal(document.status, "error");
  assert.equal(document.errors[0].code, "source_not_configured");
  // The alias arrives from argv, which is exactly where someone pastes something private by
  // accident. A rejected value must not travel into a document that gets shared.
  assert.doesNotMatch(fixture.stdout.value, /absent/u);
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

test("two clients behind one capacity source do not produce two of the same check", async () => {
  // A capacity source is one lineage however many clients feed it, and most of what `doctor` asks
  // about it -- its plan profile, its mapping, how fresh it is, what ingestion refused -- is a
  // question about the source, not about each client. Asked once per configured client, every one
  // of those answers appeared twice under an identical id, so a machine consumer could not key on
  // the id and one refusal read as two.
  const fixture = await makeRunFixture("snack-doctor-shared-");
  fixture.options.env.OPENCODE_DB = await createOpenCodeDatabase(fixture.root);
  fixture.options.env.CLAUDE_CONFIG_DIR = await createClaudeHistory(fixture.root);
  for (const client of ["opencode", "claude"]) {
    await run(
      [
        "node",
        "snack",
        "setup",
        client,
        "--non-interactive",
        "--source",
        "work",
        "--provider",
        "anthropic",
        "--profile",
        "default",
        "--plan",
        "pro",
      ],
      fixture.options,
    );
  }
  await run(["node", "snack", "sync", "--full"], fixture.options);

  fixture.stdout.value = "";
  await run(["node", "snack", "doctor", "--json"], fixture.options);
  const checks = /** @type {{id: string}[]} */ (JSON.parse(fixture.stdout.value).data.checks);

  const duplicated = [...new Set(checks.map((check) => check.id))].filter(
    (id) => checks.filter((check) => check.id === id).length > 1,
  );
  assert.deepEqual(duplicated, [], `duplicate check ids: ${duplicated.join(", ")}`);

  // The one question that really is per client keeps an answer per client, and says which is which
  // in the id rather than only in the prose.
  const fingerprints = checks
    .filter((check) => check.id.startsWith("source_fingerprint:"))
    .map((check) => check.id);
  assert.deepEqual(fingerprints.sort(), [
    "source_fingerprint:work:claude",
    "source_fingerprint:work:opencode",
  ]);
});

test("every check doctor can report is documented in the troubleshooting guide", async () => {
  // `doctor` is the command someone runs when something is wrong, and an id with no entry anywhere
  // is a diagnosis that names a problem and offers nothing. The guide is checked against the ids a
  // real installation produces rather than against a list kept by hand, so a check added later
  // fails here instead of shipping undocumented -- the same trick that makes the export schema
  // trustworthy without generating it.
  const guide = await readFile(
    new URL("../../../docs/troubleshooting.md", import.meta.url),
    "utf8",
  );
  const fixture = await makeRunFixture("snack-doctor-docs-");
  fixture.options.env.OPENCODE_DB = await createOpenCodeDatabase(fixture.root);
  fixture.options.env.CLAUDE_CONFIG_DIR = await createClaudeHistory(fixture.root);
  // A Codex history with both gaps doctor reports for it, so its coverage checks are produced too.
  fixture.options.env.CODEX_HOME = await createCodexHistory(fixture.root, [
    "version-0-147-0.jsonl",
    "fork-0-146-0.jsonl",
  ]);
  await writeFile(
    join(fixture.options.env.CODEX_HOME, "sessions", "2026", "01", "02", "rollout-x.jsonl.zst"),
    "zstd",
  );
  for (const client of ["opencode", "claude", "codex"]) {
    await run(
      [
        "node",
        "snack",
        "setup",
        client,
        "--non-interactive",
        "--source",
        client === "opencode" ? "work" : client === "claude" ? "personal" : "codex",
        "--provider",
        "anthropic",
        "--profile",
        "default",
        "--plan",
        "pro",
        ...(client === "opencode" ? ["--install-plugin", "--yes"] : []),
      ],
      fixture.options,
    );
  }
  await run(["node", "snack", "sync", "--full"], fixture.options);

  fixture.stdout.value = "";
  await run(["node", "snack", "doctor", "--json"], fixture.options);
  const checks = JSON.parse(fixture.stdout.value).data.checks;

  assert.ok(checks.length > 10, `only ${checks.length} checks were produced`);
  for (const check of checks) {
    // A per-source check is documented once, under the id without the alias: the alias is which
    // source, not which kind of problem.
    const documented = String(check.id).split(":")[0];
    // Anchored on the closing backtick or the `:` that starts an alias, so a short id cannot pass
    // by being the prefix of a longer one that happens to be documented.
    assert.match(
      guide,
      new RegExp(`\`${documented}(?:\`|:)`, "u"),
      `doctor reports ${check.id}, which docs/troubleshooting.md never explains`,
    );
  }
});

/**
 * @param {Awaited<ReturnType<typeof makeRunFixture>>} fixture
 * @param {string} alias
 */
async function setupCodex(fixture, alias = "codex") {
  return run(
    [
      "node",
      "snack",
      "setup",
      "codex",
      "--non-interactive",
      "--source",
      alias,
      "--provider",
      "openai",
      "--profile",
      "default",
      "--plan",
      "plus",
    ],
    fixture.options,
  );
}

/** @param {Awaited<ReturnType<typeof makeRunFixture>>} fixture */
async function doctorChecks(fixture) {
  fixture.stdout.value = "";
  await run(["node", "snack", "doctor", "--json"], fixture.options);
  const document = JSON.parse(fixture.stdout.value);
  return /** @type {{id: string, status: string, message: string}[]} */ (document.data.checks);
}

test("doctor keeps passing a Codex source when Codex moves to the next supported family", async () => {
  const fixture = await makeRunFixture("snack-doctor-codex-family-");
  const home = await createCodexHistory(fixture.root, "version-0-147-0.jsonl");
  fixture.options.env.CODEX_HOME = home;
  assert.equal(await setupCodex(fixture), 0);
  // Codex upgraded: a newer rollout in the usage-record family is now the most recent file, while
  // the configuration still names the token-count family setup saw.
  await writeFile(
    join(home, "sessions", "2026", "01", "02", "rollout-later.jsonl"),
    await readFile(new URL("./fixtures/codex/version-0-159-3.jsonl", import.meta.url), "utf8"),
  );

  const checks = await doctorChecks(fixture);
  const fingerprint = checks.find((check) => check.id === "source_fingerprint:codex:codex");
  assert.equal(fingerprint?.status, "pass", JSON.stringify(fingerprint));
  assert.ok(!checks.some((check) => check.id.startsWith("source_coverage:")));
});

test("doctor keeps passing a Codex source once the family setup saw is gone", async () => {
  const fixture = await makeRunFixture("snack-doctor-codex-family-gone-");
  const home = await createCodexHistory(fixture.root, "version-0-147-0.jsonl");
  fixture.options.env.CODEX_HOME = home;
  assert.equal(await setupCodex(fixture), 0);
  // The old rollouts were deleted; only the next supported family remains, and sync reads it.
  const day = join(home, "sessions", "2026", "01", "02");
  for (const name of await readdir(day)) await rm(join(day, name));
  await writeFile(
    join(day, "rollout-later.jsonl"),
    await readFile(new URL("./fixtures/codex/version-0-159-3.jsonl", import.meta.url), "utf8"),
  );
  assert.equal(await run(["node", "snack", "sync"], fixture.options), 0, fixture.stderr.value);

  const checks = await doctorChecks(fixture);
  const fingerprint = checks.find((check) => check.id === "source_fingerprint:codex:codex");
  assert.equal(fingerprint?.status, "pass", JSON.stringify(fingerprint));
});

test("doctor does not call an empty Codex history unsupported, since sync reads it fine", async () => {
  const fixture = await makeRunFixture("snack-doctor-codex-empty-");
  const home = await createCodexHistory(fixture.root, "version-0-159-3.jsonl");
  fixture.options.env.CODEX_HOME = home;
  assert.equal(await setupCodex(fixture), 0);
  // Every rollout was deleted after setup; `sync` finds nothing to read and exits 0.
  const day = join(home, "sessions", "2026", "01", "02");
  for (const name of await readdir(day)) await rm(join(day, name));
  assert.equal(await run(["node", "snack", "sync"], fixture.options), 0, fixture.stderr.value);

  const checks = await doctorChecks(fixture);
  const fingerprint = checks.find((check) => check.id === "source_fingerprint:codex:codex");
  assert.equal(fingerprint?.status, "warn", JSON.stringify(fingerprint));
  assert.doesNotMatch(String(fingerprint?.message), /unsupported|update SNACK/u);
  assert.match(String(fingerprint?.message), /no Codex CLI rollouts/iu);
});

test("doctor still warns about a legacy forked subagent once 0.159 resumes it", async () => {
  const fixture = await makeRunFixture("snack-doctor-codex-resumed-fork-");
  fixture.options.env.CODEX_HOME = await createCodexHistory(fixture.root, [
    "version-0-147-0.jsonl",
    "fork-0-146-0-resumed-by-0-159-3.jsonl",
  ]);
  assert.equal(await setupCodex(fixture), 0);

  const checks = await doctorChecks(fixture);
  const forks = checks.find((check) => check.id === "source_coverage:codex:codex:forked_subagents");
  assert.equal(forks?.status, "warn", JSON.stringify(checks));
  assert.match(String(forks?.message), /^1 forked subagent/u);
  assert.match(String(forks?.message), /later Codex/u);
});

test("doctor fails a drifted Codex history with output that says what to do", async () => {
  const fixture = await makeRunFixture("snack-doctor-codex-drift-");
  const home = await createCodexHistory(fixture.root, "version-0-159-3.jsonl");
  fixture.options.env.CODEX_HOME = home;
  assert.equal(await setupCodex(fixture), 0);
  await writeFile(
    join(home, "sessions", "2026", "01", "02", "rollout-drift.jsonl"),
    await readFile(new URL("./fixtures/codex/drifted-usage.jsonl", import.meta.url), "utf8"),
  );

  const exitCode = await run(["node", "snack", "doctor"], fixture.options);
  assert.notEqual(exitCode, 0);
  const checks = await doctorChecks(fixture);
  const fingerprint = checks.find((check) => check.id === "source_fingerprint:codex:codex");
  assert.equal(fingerprint?.status, "fail");
  assert.match(String(fingerprint?.message), /Codex CLI schema fingerprint is unsupported/u);
  assert.match(String(fingerprint?.message), /support matrix/u);
});

test("doctor warns about Codex history it deliberately does not read", async () => {
  const fixture = await makeRunFixture("snack-doctor-codex-coverage-");
  const home = await createCodexHistory(fixture.root, [
    "version-0-147-0.jsonl",
    "fork-0-146-0.jsonl",
    "subagent-0-147-0.jsonl",
    "stated-percent-out-of-range.jsonl",
  ]);
  fixture.options.env.CODEX_HOME = home;
  await mkdir(join(home, "archived_sessions"), { recursive: true });
  await writeFile(join(home, "archived_sessions", "rollout-old.jsonl.zst"), "zstd");
  assert.equal(await setupCodex(fixture), 0);

  const checks = await doctorChecks(fixture);
  const forks = checks.find((check) => check.id === "source_coverage:codex:codex:forked_subagents");
  const compressed = checks.find(
    (check) => check.id === "source_coverage:codex:codex:compressed_rollouts",
  );
  assert.equal(forks?.status, "warn");
  assert.match(String(forks?.message), /^1 forked subagent/u);
  assert.equal(compressed?.status, "warn");
  assert.match(String(compressed?.message), /^1 compressed Codex rollout/u);
  const turns = checks.find((check) => check.id === "source_coverage:codex:codex:subagent_turns");
  assert.equal(turns?.status, "warn");
  assert.match(String(turns?.message), /^1 subagent turn/u);
  const figures = checks.find((check) => check.id === "source_coverage:codex:codex:stated_figures");
  assert.equal(figures?.status, "warn");
  assert.match(String(figures?.message), /^1 figure Codex stated/u);
});
