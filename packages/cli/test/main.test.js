import assert from "node:assert/strict";
import { chmod, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, test } from "node:test";

import Database from "better-sqlite3";

import { getConfigValue, readConfig } from "../src/config.js";
import { ExitCode, SnackError } from "../src/errors.js";
import { run } from "../src/main.js";
import { classifyRisk } from "../src/prediction.js";
import { initializeDatabase, inspectDatabase } from "../src/storage.js";
import {
  cleanupRunFixtures,
  createClaudeHistory,
  createOpenCodeDatabase,
  executeOpenCodeSql,
  makeRunFixture,
  sink,
} from "./fixtures/run-fixture.js";

const privacyCanaries = JSON.parse(
  await readFile(new URL("./fixtures/privacy-canaries.json", import.meta.url), "utf8"),
);

afterEach(cleanupRunFixtures);

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
  assert.deepEqual(document.data.storage.applied, [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11]);
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
  // A directory where the database file belongs: SQLite cannot open it, and nothing else about
  // the install is broken. Blocking the whole data root instead would fail the configuration
  // first on macOS, where the config and data roots are the same directory.
  await mkdir(fixture.paths.databaseFile, { recursive: true, mode: 0o700 });

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

test("setup opencode configures an explicit source after a compatible dry-run", async () => {
  const fixture = await makeRunFixture();
  const openCodeDatabase = await createOpenCodeDatabase(fixture.root);
  fixture.options.env.OPENCODE_DB = openCodeDatabase;

  const exitCode = await run(
    [
      "node",
      "snack",
      "setup",
      "opencode",
      "--non-interactive",
      "--source",
      "personal-anthropic",
      "--provider",
      "anthropic",
      "--profile",
      "personal",
      "--plan",
      "generic",
      "--json",
    ],
    fixture.options,
  );
  const setup = JSON.parse(fixture.stdout.value);
  fixture.stdout.value = "";
  const configExitCode = await run(
    ["node", "snack", "config", "get", "sources", "--json"],
    fixture.options,
  );
  const configuredSources = JSON.parse(fixture.stdout.value).data?.value;

  assert.deepEqual(
    {
      exitCode,
      configExitCode,
      command: setup.command,
      status: setup.status,
      data: setup.data,
      configuredSources,
    },
    {
      exitCode: 0,
      configExitCode: 0,
      command: "setup opencode",
      status: "ok",
      data: {
        source: {
          alias: "personal-anthropic",
          installation_id: configuredSources[0].installation_id,
          adapter: "opencode",
          provider: "anthropic",
          profile: "personal",
          plan: "generic",
          plan_profile: "generic",
        },
        fingerprint: {
          family: "oc-sqlite-msgpart-v1",
          supported: true,
        },
        dry_run: { observations: 1 },
      },
      configuredSources: [
        {
          alias: "personal-anthropic",
          installation_id: configuredSources[0].installation_id,
          adapter: "opencode",
          database: openCodeDatabase,
          provider: "anthropic",
          profile: "personal",
          plan: "generic",
          plan_profile: "generic",
          fingerprint: "oc-sqlite-msgpart-v1",
        },
      ],
    },
  );
  assert.doesNotMatch(JSON.stringify(setup), /PRIVATE_PROMPT_CANARY/u);
});

test("full sync converges without duplicating OpenCode usage records", async () => {
  const fixture = await makeRunFixture();
  fixture.options.env.OPENCODE_DB = await createOpenCodeDatabase(fixture.root);
  await run(
    [
      "node",
      "snack",
      "setup",
      "opencode",
      "--non-interactive",
      "--source",
      "personal-anthropic",
      "--provider",
      "anthropic",
      "--profile",
      "personal",
      "--plan",
      "generic",
      "--json",
    ],
    fixture.options,
  );
  fixture.stdout.value = "";

  const firstExitCode = await run(
    ["node", "snack", "sync", "--source", "personal-anthropic", "--full", "--json"],
    fixture.options,
  );
  const first = JSON.parse(fixture.stdout.value);
  fixture.stdout.value = "";
  const secondExitCode = await run(
    ["node", "snack", "sync", "--source", "personal-anthropic", "--full", "--json"],
    fixture.options,
  );
  const second = JSON.parse(fixture.stdout.value);

  assert.deepEqual(
    {
      firstExitCode,
      first: first.data?.sources,
      secondExitCode,
      second: second.data?.sources,
    },
    {
      firstExitCode: 0,
      first: [
        {
          alias: "personal-anthropic",
          path: "backfill",
          read: 1,
          inserted: 1,
          updated: 0,
          unchanged: 0,
          excluded: 0,
          pending_mapping: 0,
          rejected_invalid: 0,
          tombstoned: 0,
          failed: 0,
        },
      ],
      secondExitCode: 0,
      second: [
        {
          alias: "personal-anthropic",
          path: "backfill",
          read: 1,
          inserted: 0,
          updated: 0,
          unchanged: 1,
          excluded: 0,
          pending_mapping: 0,
          rejected_invalid: 0,
          tombstoned: 0,
          failed: 0,
        },
      ],
    },
  );
});

test("human sync reports every required count", async () => {
  const fixture = await makeRunFixture();
  fixture.options.env.OPENCODE_DB = await createOpenCodeDatabase(fixture.root);
  await run(
    [
      "node",
      "snack",
      "setup",
      "opencode",
      "--non-interactive",
      "--source",
      "personal-anthropic",
      "--provider",
      "anthropic",
      "--profile",
      "personal",
      "--plan",
      "generic",
    ],
    fixture.options,
  );
  fixture.stdout.value = "";

  assert.equal(
    await run(
      ["node", "snack", "sync", "--source", "personal-anthropic", "--full"],
      fixture.options,
    ),
    0,
  );

  assert.match(
    fixture.stdout.value,
    /personal-anthropic: 1 read, 1 inserted, 0 updated, 0 unchanged, 0 excluded, 0 pending_mapping, 0 rejected_invalid, 0 tombstoned, 0 failed\./u,
  );
});

test("naming a real plan does not make every later command warn about the plan profile", async () => {
  const fixture = await makeRunFixture();
  fixture.options.env.OPENCODE_DB = await createOpenCodeDatabase(fixture.root);

  // `--plan` records what the user calls their plan. It is a label, not a bundled profile id,
  // so it must not be used to look one up: `pro` resolves to nothing and used to warn forever.
  const setupExitCode = await run(
    [
      "node",
      "snack",
      "setup",
      "opencode",
      "--non-interactive",
      "--source",
      "personal-anthropic",
      "--provider",
      "anthropic",
      "--profile",
      "personal",
      "--plan",
      "pro",
      "--json",
    ],
    fixture.options,
  );
  const configured = JSON.parse(fixture.stdout.value).data.source;
  fixture.stdout.value = "";

  const statusExitCode = await run(
    ["node", "snack", "status", "--source", "personal-anthropic", "--json"],
    fixture.options,
  );
  const document = JSON.parse(fixture.stdout.value);

  assert.equal(setupExitCode, 0);
  assert.equal(statusExitCode, 0);
  assert.equal(configured.plan, "pro");
  assert.equal(configured.plan_profile, "generic");
  assert.deepEqual(
    /** @type {{code: string}[]} */ (document.warnings).filter(
      (warning) => warning.code === "plan_profile_unavailable",
    ),
    [],
  );
  assert.equal(document.data.source.plan_profile.id, "generic");
  assert.equal(document.data.source.plan_profile.provenance, "bundled");
});

test("status reports a broad initial estimate with very low evidence", async () => {
  const fixture = await makeRunFixture();
  fixture.options.now = new Date("2026-01-02T03:05:00.000Z");
  fixture.options.env.OPENCODE_DB = await createOpenCodeDatabase(fixture.root);
  await run(
    [
      "node",
      "snack",
      "setup",
      "opencode",
      "--non-interactive",
      "--source",
      "personal-anthropic",
      "--provider",
      "anthropic",
      "--profile",
      "personal",
      "--plan",
      "generic",
      "--json",
    ],
    fixture.options,
  );
  fixture.stdout.value = "";
  await run(
    ["node", "snack", "sync", "--source", "personal-anthropic", "--full", "--json"],
    fixture.options,
  );
  fixture.stdout.value = "";

  const exitCode = await run(
    ["node", "snack", "status", "--source", "personal-anthropic", "--no-sync", "--json"],
    fixture.options,
  );
  const document = JSON.parse(fixture.stdout.value);

  // The interval itself is arithmetic proven at the prediction seam; here the contract is
  // that it is a bounded, ordered interval carrying its declared coverage target.
  const { viability, contributors } = document.data;
  // The decay weight of a 55-second-old observation is arithmetic owned by the prediction
  // seam; the command contract is that it is a near-undecayed sample folded onto the prior.
  const weight = contributors.evidence_window.weighted_successes;
  assert.ok(weight > 0.999 && weight <= 1, `decay weight ${weight}`);
  assert.equal(contributors.evidence_window.effective_samples, weight);
  assert.equal(contributors.evidence_window.alpha, contributors.prior.alpha + weight);
  assert.ok(
    0 < viability.lower && viability.lower < viability.point && viability.point < viability.upper,
    `interval out of order: ${JSON.stringify(viability)}`,
  );
  assert.ok(viability.upper < 1, `upper ${viability.upper}`);
  assert.equal(viability.coverage_target, 0.8);

  assert.deepEqual(
    {
      exitCode,
      command: document.command,
      status: document.status,
      data: {
        ...document.data,
        viability: undefined,
        contributors: {
          ...contributors,
          evidence_window: {
            ...contributors.evidence_window,
            weighted_successes: undefined,
            effective_samples: undefined,
            alpha: undefined,
          },
        },
      },
    },
    {
      exitCode: 0,
      command: "status",
      status: "degraded",
      data: {
        source: {
          alias: "personal-anthropic",
          provider: "anthropic",
          profile: "personal",
          plan: "generic",
          active_period: { started_at: "2026-01-02T03:05:00.000Z" },
          plan_profile: {
            id: "generic",
            version: "1.0.0",
            provenance: "bundled",
            as_of: "2026-01-01",
          },
        },
        viability: undefined,
        risk: { label: "high", policy_version: "stage2-risk-v2" },
        evidence: {
          level: "very_low",
          policy_version: "stage5-evidence-v2",
          gates: [
            { id: "sample", level: "very_low", limiting: true },
            { id: "restrictions", level: "moderate", limiting: false },
            // A single prompt cannot name a pressure band, so the forecast reads the
            // period aggregate, which is never treated as strong evidence.
            { id: "relevance", level: "very_low", limiting: true },
            { id: "completeness", level: "high", limiting: false },
          ],
        },
        method: { id: "bayesian-pressure-band", version: "1" },
        model_policy_version: "stage5-prediction-v2",
        contributors: {
          backoff_level: "period",
          evidence_window: {
            prompts_considered: 1,
            limit_prompts: 2000,
            successes: 1,
            restrictions: 0,
            excluded: 0,
            weighted_successes: undefined,
            weighted_restrictions: 0,
            effective_samples: undefined,
            alpha: undefined,
            beta: 0.5,
          },
          prior: { alpha: 0.5, beta: 0.5 },
        },
        pressure: {
          horizon: "PT1H",
          score: null,
          band: "unknown",
          policy_version: "stage4-analytics-v1",
          baseline_kind: "insufficient",
          baseline_windows: 0,
          completeness: "partial",
          contributors: [],
        },
        expected_prompt_category: "typical",
        prospective: null,
        observed: { prompts: 1, successes: 1, restrictions: 0, excluded: 0 },
        freshness: { as_of: "2026-01-02T03:04:10.000Z", age_seconds: 50 },
        completeness: { level: "complete", reasons: [], policy_version: "stage5-evidence-v2" },
        synchronization: { performed: false, status: "not_requested" },
        caveats: [
          "Sparse history; the weak plan-profile prior still dominates this estimate.",
          "Real provider capacity is unknown.",
          "Usage pressure compares this window with local history; it is not a share of capacity.",
        ],
      },
    },
  );
});

test("an unknown plan falls back to the generic profile without failing status", async () => {
  const fixture = await makeRunFixture();
  fixture.options.now = new Date("2026-01-02T03:05:00.000Z");
  fixture.options.env.OPENCODE_DB = await createOpenCodeDatabase(fixture.root);
  await run(
    [
      "node",
      "snack",
      "setup",
      "opencode",
      "--non-interactive",
      "--source",
      "personal-anthropic",
      "--provider",
      "anthropic",
      "--profile",
      "personal",
      "--plan",
      "some-unbundled-plan",
      "--json",
    ],
    fixture.options,
  );
  fixture.stdout.value = "";

  const exitCode = await run(
    ["node", "snack", "status", "--source", "personal-anthropic", "--no-sync", "--json"],
    fixture.options,
  );
  const document = JSON.parse(fixture.stdout.value);

  assert.equal(exitCode, 0);
  assert.deepEqual(document.data.source.plan_profile, {
    id: "generic",
    version: "1.0.0",
    provenance: "bundled",
    as_of: "2026-01-01",
  });
  assert.equal(document.data.source.plan, "some-unbundled-plan");
});

test("an invalid custom plan profile is rejected in favour of the generic profile", async () => {
  const fixture = await makeRunFixture();
  fixture.options.now = new Date("2026-01-02T03:05:00.000Z");
  fixture.options.env.OPENCODE_DB = await createOpenCodeDatabase(fixture.root);
  await run(
    [
      "node",
      "snack",
      "setup",
      "opencode",
      "--non-interactive",
      "--source",
      "personal-anthropic",
      "--provider",
      "anthropic",
      "--profile",
      "personal",
      "--plan",
      "generic",
      "--json",
    ],
    fixture.options,
  );
  // A profile without provenance or version cannot be interpreted, so it must not be used.
  const customProfile = join(fixture.root, "broken-profile.json");
  await writeFile(customProfile, JSON.stringify({ schema_version: 1, id: "broken" }), "utf8");
  const configured = JSON.parse(await readFile(fixture.paths.configFile, "utf8"));
  configured.sources[0].plan_profile = customProfile;
  await writeFile(fixture.paths.configFile, JSON.stringify(configured), "utf8");
  fixture.stdout.value = "";

  const exitCode = await run(
    ["node", "snack", "status", "--source", "personal-anthropic", "--no-sync", "--json"],
    fixture.options,
  );
  const document = JSON.parse(fixture.stdout.value);

  assert.equal(exitCode, 0);
  assert.equal(document.data.source.plan_profile.id, "generic");
  assert.equal(document.data.source.plan_profile.provenance, "bundled");
  // Silently ignoring the configured profile would hide a broken assumption.
  assert.ok(
    document.warnings.some(
      (/** @type {{code: string}} */ warning) => warning.code === "plan_profile_unavailable",
    ),
    `expected a plan_profile_unavailable warning, got ${JSON.stringify(document.warnings)}`,
  );
});

test("setup stamps the active capacity period with the resolved plan profile", async () => {
  const fixture = await makeRunFixture();
  fixture.options.env.OPENCODE_DB = await createOpenCodeDatabase(fixture.root);

  await run(
    [
      "node",
      "snack",
      "setup",
      "opencode",
      "--non-interactive",
      "--source",
      "personal-anthropic",
      "--provider",
      "anthropic",
      "--profile",
      "personal",
      "--plan",
      "generic",
      "--json",
    ],
    fixture.options,
  );

  const database = new Database(fixture.paths.databaseFile, { readonly: true });
  try {
    assert.deepEqual(
      database
        .prepare(
          `SELECT plan_profile_id, plan_profile_version
           FROM capacity_period WHERE source_alias = 'personal-anthropic'`,
        )
        .all(),
      [{ plan_profile_id: "generic", plan_profile_version: "1.0.0" }],
    );
  } finally {
    database.close();
  }
});

test("initial risk labels use the lower viability bound and its versioned thresholds", () => {
  assert.deepEqual(
    [0.49, 0.5, 0.749, 0.75].map((lower) => ({ lower, ...classifyRisk(lower) })),
    [
      { lower: 0.49, label: "high", policy_version: "stage2-risk-v2" },
      { lower: 0.5, label: "elevated", policy_version: "stage2-risk-v2" },
      { lower: 0.749, label: "elevated", policy_version: "stage2-risk-v2" },
      { lower: 0.75, label: "low", policy_version: "stage2-risk-v2" },
    ],
  );
});

test("status synchronizes incrementally by default", async () => {
  const fixture = await makeRunFixture();
  fixture.options.now = new Date("2026-01-02T03:05:00.000Z");
  fixture.options.env.OPENCODE_DB = await createOpenCodeDatabase(fixture.root);
  await run(
    [
      "node",
      "snack",
      "setup",
      "opencode",
      "--non-interactive",
      "--source",
      "personal-anthropic",
      "--provider",
      "anthropic",
      "--profile",
      "personal",
      "--plan",
      "generic",
      "--json",
    ],
    fixture.options,
  );
  fixture.stdout.value = "";

  const exitCode = await run(
    ["node", "snack", "status", "--source", "personal-anthropic", "--json"],
    fixture.options,
  );
  const document = JSON.parse(fixture.stdout.value);

  assert.deepEqual(
    {
      exitCode,
      observed: document.data.observed,
      synchronization: document.data.synchronization,
    },
    {
      exitCode: 0,
      observed: { prompts: 1, successes: 1, restrictions: 0, excluded: 0 },
      synchronization: { performed: true, status: "ok" },
    },
  );
});

test("doctor reports configured OpenCode fingerprint mapping and freshness", async () => {
  const fixture = await makeRunFixture();
  fixture.options.now = new Date("2026-01-02T03:05:00.000Z");
  fixture.options.env.OPENCODE_DB = await createOpenCodeDatabase(fixture.root);
  await run(
    [
      "node",
      "snack",
      "setup",
      "opencode",
      "--non-interactive",
      "--source",
      "personal-anthropic",
      "--provider",
      "anthropic",
      "--profile",
      "personal",
      "--plan",
      "generic",
      "--json",
    ],
    fixture.options,
  );
  fixture.stdout.value = "";
  await run(
    ["node", "snack", "sync", "--source", "personal-anthropic", "--full", "--json"],
    fixture.options,
  );
  fixture.stdout.value = "";

  const exitCode = await run(["node", "snack", "doctor", "--json"], fixture.options);
  const document = JSON.parse(fixture.stdout.value);
  const checks = /** @type {{id: string, status: string}[]} */ (document.data.checks);
  const sourceChecks = checks
    .filter((check) => check.id.startsWith("source_"))
    .map((check) => ({ id: check.id, status: check.status }));

  assert.deepEqual(
    { exitCode, status: document.status, sourceChecks },
    {
      exitCode: 0,
      status: "degraded",
      sourceChecks: [
        { id: "source_fingerprint:personal-anthropic", status: "pass" },
        { id: "source_mapping:personal-anthropic", status: "pass" },
        { id: "source_freshness:personal-anthropic", status: "pass" },
      ],
    },
  );
  assert.doesNotMatch(fixture.stdout.value, new RegExp(fixture.options.env.OPENCODE_DB, "u"));
});

test("incremental sync detects allowlisted metadata changes at the cursor timestamp", async () => {
  const fixture = await makeRunFixture();
  fixture.options.env.OPENCODE_DB = await createOpenCodeDatabase(fixture.root);
  await run(
    [
      "node",
      "snack",
      "setup",
      "opencode",
      "--non-interactive",
      "--source",
      "personal-anthropic",
      "--provider",
      "anthropic",
      "--profile",
      "personal",
      "--plan",
      "generic",
      "--json",
    ],
    fixture.options,
  );
  fixture.stdout.value = "";
  await run(
    ["node", "snack", "sync", "--source", "personal-anthropic", "--full", "--json"],
    fixture.options,
  );
  executeOpenCodeSql(
    fixture.options.env.OPENCODE_DB,
    `UPDATE part
     SET data = '{"type":"step-finish","reason":"stop","cost":0.003,"tokens":{"input":120,"output":25,"reasoning":5,"cache":{"read":10,"write":2}}}'
     WHERE id = 'step-finish-1';`,
  );
  fixture.stdout.value = "";

  const exitCode = await run(
    ["node", "snack", "sync", "--source", "personal-anthropic", "--json"],
    fixture.options,
  );
  const result = JSON.parse(fixture.stdout.value).data.sources[0];

  assert.deepEqual(
    { exitCode, read: result.read, updated: result.updated, unchanged: result.unchanged },
    { exitCode: 0, read: 1, updated: 1, unchanged: 0 },
  );
});

test("setup dry-run validates the proposal without creating SNACK state", async () => {
  const fixture = await makeRunFixture();
  fixture.options.env.OPENCODE_DB = await createOpenCodeDatabase(fixture.root);

  const exitCode = await run(
    [
      "node",
      "snack",
      "setup",
      "opencode",
      "--non-interactive",
      "--source",
      "personal-anthropic",
      "--provider",
      "anthropic",
      "--profile",
      "personal",
      "--plan",
      "generic",
      "--dry-run",
      "--json",
    ],
    fixture.options,
  );
  const setup = JSON.parse(fixture.stdout.value);
  fixture.stdout.value = "";
  const configExitCode = await run(
    ["node", "snack", "config", "get", "sources", "--json"],
    fixture.options,
  );
  const configResult = JSON.parse(fixture.stdout.value);

  assert.deepEqual(
    {
      exitCode,
      setupStatus: setup.status,
      dryRun: setup.data?.dry_run,
      configExitCode,
      configError: configResult.errors[0]?.code,
    },
    {
      exitCode: 0,
      setupStatus: "ok",
      dryRun: { observations: 1, applied: false },
      configExitCode: 3,
      configError: "config_missing",
    },
  );
});

test("unmatched provider metadata remains pending and degrades mapping health", async () => {
  const fixture = await makeRunFixture();
  fixture.options.env.OPENCODE_DB = await createOpenCodeDatabase(fixture.root);
  await run(
    [
      "node",
      "snack",
      "setup",
      "opencode",
      "--non-interactive",
      "--source",
      "personal-openai",
      "--provider",
      "openai",
      "--profile",
      "personal",
      "--plan",
      "generic",
      "--json",
    ],
    fixture.options,
  );
  fixture.stdout.value = "";

  const syncExitCode = await run(
    ["node", "snack", "sync", "--source", "personal-openai", "--full", "--json"],
    fixture.options,
  );
  const sync = JSON.parse(fixture.stdout.value).data.sources[0];
  fixture.stdout.value = "";
  const doctorExitCode = await run(["node", "snack", "doctor", "--json"], fixture.options);
  const doctor = JSON.parse(fixture.stdout.value);
  const checks = /** @type {{id: string, status: string}[]} */ (doctor.data.checks);
  const mapping = checks.find((check) => check.id === "source_mapping:personal-openai");

  assert.deepEqual(
    {
      syncExitCode,
      inserted: sync.inserted,
      pendingMapping: sync.pending_mapping,
      doctorExitCode,
      doctorStatus: doctor.status,
      mappingStatus: mapping?.status,
    },
    {
      syncExitCode: 0,
      inserted: 0,
      pendingMapping: 1,
      doctorExitCode: 0,
      doctorStatus: "degraded",
      mappingStatus: "warn",
    },
  );
});

test("an older revision preserves finality while adding restriction evidence", async () => {
  const fixture = await makeRunFixture();
  fixture.options.now = new Date("2026-01-02T03:05:00.000Z");
  fixture.options.env.OPENCODE_DB = await createOpenCodeDatabase(fixture.root);
  await run(
    [
      "node",
      "snack",
      "setup",
      "opencode",
      "--non-interactive",
      "--source",
      "personal-anthropic",
      "--provider",
      "anthropic",
      "--profile",
      "personal",
      "--plan",
      "generic",
      "--json",
    ],
    fixture.options,
  );
  fixture.stdout.value = "";
  await run(
    ["node", "snack", "sync", "--source", "personal-anthropic", "--full", "--json"],
    fixture.options,
  );
  executeOpenCodeSql(
    fixture.options.env.OPENCODE_DB,
    `UPDATE message
     SET time_updated = 1767323049000,
         data = '{"role":"assistant","time":{"created":1767323046000,"completed":1767323049000},"parentID":"user-1","providerID":"anthropic","modelID":"claude-sonnet","error":{"name":"APIError","data":{"statusCode":429,"message":"PRIVATE_STALE_CANARY"}},"cost":0.003,"tokens":{"input":100,"output":25,"reasoning":5,"cache":{"read":10,"write":2}}}'
     WHERE id = 'assistant-1';
     UPDATE part SET time_updated = 1767323049000 WHERE id = 'step-finish-1';`,
  );
  fixture.stdout.value = "";

  await run(
    ["node", "snack", "sync", "--source", "personal-anthropic", "--full", "--json"],
    fixture.options,
  );
  const sync = JSON.parse(fixture.stdout.value).data.sources[0];
  fixture.stdout.value = "";
  await run(
    ["node", "snack", "status", "--source", "personal-anthropic", "--no-sync", "--json"],
    fixture.options,
  );
  const observed = JSON.parse(fixture.stdout.value).data.observed;

  assert.deepEqual(
    { updated: sync.updated, unchanged: sync.unchanged, observed },
    {
      updated: 0,
      unchanged: 1,
      observed: { prompts: 1, successes: 0, restrictions: 1, excluded: 0 },
    },
  );
  assert.doesNotMatch(fixture.stdout.value, /PRIVATE_STALE_CANARY/u);
});

test("two provider mappings for one OpenCode database share one installation identity", async () => {
  const fixture = await makeRunFixture();
  fixture.options.env.OPENCODE_DB = await createOpenCodeDatabase(fixture.root);
  const mappings = /** @type {[string, string][]} */ ([
    ["personal-anthropic", "anthropic"],
    ["personal-openai", "openai"],
  ]);
  for (const [alias, provider] of mappings) {
    await run(
      [
        "node",
        "snack",
        "setup",
        "opencode",
        "--non-interactive",
        "--source",
        alias,
        "--provider",
        provider,
        "--profile",
        "personal",
        "--plan",
        "generic",
        "--json",
      ],
      fixture.options,
    );
    fixture.stdout.value = "";
  }

  await run(["node", "snack", "config", "get", "sources", "--json"], fixture.options);
  const sources = /** @type {{alias: string, installation_id: string}[]} */ (
    JSON.parse(fixture.stdout.value).data.value
  );
  const firstSource = sources[0];
  assert.ok(firstSource);

  assert.deepEqual(
    {
      aliases: sources.map((source) => source.alias),
      installationIds: [...new Set(sources.map((source) => source.installation_id))],
    },
    {
      aliases: ["personal-anthropic", "personal-openai"],
      installationIds: [firstSource.installation_id],
    },
  );
  assert.match(firstSource.installation_id, /^[0-9a-f-]{36}$/u);
});

test("ambiguous OpenCode provider profiles remain pending without affecting forecasts", async () => {
  const fixture = await makeRunFixture();
  fixture.options.now = new Date("2026-01-02T03:05:00.000Z");
  fixture.options.env.OPENCODE_DB = await createOpenCodeDatabase(fixture.root);
  /** @param {string} alias @param {string} profile */
  const setup = (alias, profile) =>
    run(
      [
        "node",
        "snack",
        "setup",
        "opencode",
        "--non-interactive",
        "--source",
        alias,
        "--provider",
        "anthropic",
        "--profile",
        profile,
        "--plan",
        "generic",
        "--json",
      ],
      fixture.options,
    );

  assert.equal(await setup("personal-anthropic", "personal"), 0);
  fixture.stdout.value = "";
  assert.equal(await setup("work-anthropic", "work"), 0);
  fixture.stdout.value = "";
  assert.equal(await run(["node", "snack", "sync", "--full", "--json"], fixture.options), 0);
  const sync = /** @type {{alias: string, pending_mapping: number}[]} */ (
    JSON.parse(fixture.stdout.value).data.sources
  );
  fixture.stdout.value = "";
  await run(["node", "snack", "status", "--no-sync", "--json"], fixture.options);
  const statuses = /** @type {{source: {alias: string}, observed: {prompts: number}}[]} */ (
    JSON.parse(fixture.stdout.value).data.sources
  );
  fixture.stdout.value = "";
  await run(["node", "snack", "doctor", "--json"], fixture.options);
  const checks = /** @type {{id: string, status: string}[]} */ (
    JSON.parse(fixture.stdout.value).data.checks
  );

  assert.deepEqual(
    sync.map((result) => ({ alias: result.alias, pending_mapping: result.pending_mapping })),
    [
      { alias: "personal-anthropic", pending_mapping: 1 },
      { alias: "work-anthropic", pending_mapping: 1 },
    ],
  );
  assert.deepEqual(
    statuses.map((status) => ({ alias: status.source.alias, prompts: status.observed.prompts })),
    [
      { alias: "personal-anthropic", prompts: 0 },
      { alias: "work-anthropic", prompts: 0 },
    ],
  );
  assert.deepEqual(
    checks
      .filter((check) => check.id.startsWith("source_mapping:"))
      .map((check) => ({ id: check.id, status: check.status })),
    [
      { id: "source_mapping:personal-anthropic", status: "warn" },
      { id: "source_mapping:work-anthropic", status: "warn" },
    ],
  );
});

test("mapped providers do not create false pending mappings on sibling sources", async () => {
  const fixture = await makeRunFixture();
  fixture.options.env.OPENCODE_DB = await createOpenCodeDatabase(fixture.root);
  const mappings = /** @type {[string, string][]} */ ([
    ["personal-anthropic", "anthropic"],
    ["personal-openai", "openai"],
  ]);
  for (const [alias, provider] of mappings) {
    await run(
      [
        "node",
        "snack",
        "setup",
        "opencode",
        "--non-interactive",
        "--source",
        alias,
        "--provider",
        provider,
        "--profile",
        "personal",
        "--plan",
        "generic",
        "--json",
      ],
      fixture.options,
    );
    fixture.stdout.value = "";
  }

  await run(["node", "snack", "sync", "--full", "--json"], fixture.options);
  fixture.stdout.value = "";
  await run(["node", "snack", "doctor", "--json"], fixture.options);
  const checks = /** @type {{id: string, status: string}[]} */ (
    JSON.parse(fixture.stdout.value).data.checks
  );

  assert.deepEqual(
    checks
      .filter((check) => check.id.startsWith("source_mapping:"))
      .map((check) => ({ id: check.id, status: check.status })),
    [
      { id: "source_mapping:personal-anthropic", status: "pass" },
      { id: "source_mapping:personal-openai", status: "pass" },
    ],
  );
});

test("completed finality beats a newer provisional revision", async () => {
  const fixture = await makeRunFixture();
  fixture.options.now = new Date("2026-01-02T03:05:00.000Z");
  fixture.options.env.OPENCODE_DB = await createOpenCodeDatabase(fixture.root);
  await run(
    [
      "node",
      "snack",
      "setup",
      "opencode",
      "--non-interactive",
      "--source",
      "personal-anthropic",
      "--provider",
      "anthropic",
      "--profile",
      "personal",
      "--plan",
      "generic",
      "--json",
    ],
    fixture.options,
  );
  executeOpenCodeSql(
    fixture.options.env.OPENCODE_DB,
    `UPDATE message
     SET time_updated = 1767323060000,
         data = '{"role":"assistant","time":{"created":1767323046000},"parentID":"user-1","providerID":"anthropic","modelID":"claude-sonnet","cost":0.003,"tokens":{"input":100,"output":25,"reasoning":5,"cache":{"read":10,"write":2}}}'
     WHERE id = 'assistant-1';
     UPDATE part SET time_updated = 1767323060000 WHERE id = 'step-finish-1';`,
  );
  fixture.stdout.value = "";
  await run(
    ["node", "snack", "sync", "--source", "personal-anthropic", "--full", "--json"],
    fixture.options,
  );
  executeOpenCodeSql(
    fixture.options.env.OPENCODE_DB,
    `UPDATE message
     SET time_updated = 1767323050000,
         data = '{"role":"assistant","time":{"created":1767323046000,"completed":1767323050000},"parentID":"user-1","providerID":"anthropic","modelID":"claude-sonnet","finish":"stop","cost":0.003,"tokens":{"input":100,"output":25,"reasoning":5,"cache":{"read":10,"write":2}}}'
     WHERE id = 'assistant-1';
     UPDATE part SET time_updated = 1767323050000 WHERE id = 'step-finish-1';`,
  );
  fixture.stdout.value = "";

  await run(
    ["node", "snack", "sync", "--source", "personal-anthropic", "--full", "--json"],
    fixture.options,
  );
  const sync = JSON.parse(fixture.stdout.value).data.sources[0];
  fixture.stdout.value = "";
  await run(
    ["node", "snack", "status", "--source", "personal-anthropic", "--no-sync", "--json"],
    fixture.options,
  );
  const observed = JSON.parse(fixture.stdout.value).data.observed;

  assert.deepEqual(
    { updated: sync.updated, unchanged: sync.unchanged, observed },
    {
      updated: 1,
      unchanged: 0,
      observed: { prompts: 1, successes: 1, restrictions: 0, excluded: 0 },
    },
  );
});

test("revision ordering uses message id as the timestamp tiebreak", async () => {
  const fixture = await makeRunFixture();
  fixture.options.env.OPENCODE_DB = await createOpenCodeDatabase(fixture.root);
  await run(
    [
      "node",
      "snack",
      "setup",
      "opencode",
      "--non-interactive",
      "--source",
      "personal-anthropic",
      "--provider",
      "anthropic",
      "--profile",
      "personal",
      "--plan",
      "generic",
      "--json",
    ],
    fixture.options,
  );
  executeOpenCodeSql(
    fixture.options.env.OPENCODE_DB,
    `INSERT INTO message (id, session_id, time_created, time_updated, data)
       SELECT 'assistant-z', session_id, time_created, time_updated, data
       FROM message WHERE id = 'assistant-1';
     UPDATE part SET message_id = 'assistant-z' WHERE message_id = 'assistant-1';
     DELETE FROM message WHERE id = 'assistant-1';`,
  );
  fixture.stdout.value = "";
  await run(
    ["node", "snack", "sync", "--source", "personal-anthropic", "--full", "--json"],
    fixture.options,
  );
  executeOpenCodeSql(
    fixture.options.env.OPENCODE_DB,
    `INSERT INTO message (id, session_id, time_created, time_updated, data)
       SELECT 'assistant-a', session_id, time_created, time_updated, data
       FROM message WHERE id = 'assistant-z';
     UPDATE part SET message_id = 'assistant-a' WHERE message_id = 'assistant-z';
     DELETE FROM message WHERE id = 'assistant-z';`,
  );
  fixture.stdout.value = "";

  await run(
    ["node", "snack", "sync", "--source", "personal-anthropic", "--full", "--json"],
    fixture.options,
  );
  const sync = JSON.parse(fixture.stdout.value).data.sources[0];

  assert.deepEqual(
    { updated: sync.updated, unchanged: sync.unchanged },
    { updated: 0, unchanged: 1 },
  );
});

test("plan changes keep historical prompts in their original capacity period", async () => {
  const fixture = await makeRunFixture();
  fixture.options.now = new Date("2026-01-02T03:05:00.000Z");
  fixture.options.env.OPENCODE_DB = await createOpenCodeDatabase(fixture.root);
  /** @param {string} plan @returns {string[]} */
  const setupArgs = (plan) => [
    "node",
    "snack",
    "setup",
    "opencode",
    "--non-interactive",
    "--source",
    "personal-anthropic",
    "--provider",
    "anthropic",
    "--profile",
    "personal",
    "--plan",
    plan,
    "--json",
  ];
  await run(setupArgs("generic"), fixture.options);
  fixture.stdout.value = "";
  await run(
    ["node", "snack", "sync", "--source", "personal-anthropic", "--full", "--json"],
    fixture.options,
  );
  fixture.options.now = new Date("2026-01-02T04:00:00.000Z");
  fixture.stdout.value = "";
  await run(setupArgs("pro"), fixture.options);
  fixture.stdout.value = "";
  await run(
    ["node", "snack", "status", "--source", "personal-anthropic", "--no-sync", "--json"],
    fixture.options,
  );
  const setupStatus = JSON.parse(fixture.stdout.value).data;
  assert.deepEqual(
    {
      activePeriod: setupStatus.source.active_period.started_at,
      observed: setupStatus.observed,
      plan: setupStatus.source.plan,
    },
    {
      activePeriod: "2026-01-02T04:00:00.000Z",
      observed: { prompts: 0, successes: 0, restrictions: 0, excluded: 0 },
      plan: "pro",
    },
  );
  fixture.stdout.value = "";
  await run(
    ["node", "snack", "sync", "--source", "personal-anthropic", "--full", "--json"],
    fixture.options,
  );
  executeOpenCodeSql(
    fixture.options.env.OPENCODE_DB,
    `INSERT INTO message (id, session_id, time_created, time_updated, data) VALUES
      ('user-late', 'session-1', 1767323060000, 1767323060000, '{"role":"user","time":{"created":1767323060000},"agent":"build","model":{"providerID":"anthropic","modelID":"claude-sonnet"}}'),
      ('assistant-late', 'session-1', 1767323061000, 1767323062000, '{"role":"assistant","time":{"created":1767323061000,"completed":1767323062000},"parentID":"user-late","providerID":"anthropic","modelID":"claude-sonnet","finish":"stop","cost":0,"tokens":{"input":0,"output":0,"reasoning":0,"cache":{"read":0,"write":0}}}');`,
  );
  fixture.stdout.value = "";
  await run(
    ["node", "snack", "sync", "--source", "personal-anthropic", "--full", "--json"],
    fixture.options,
  );
  fixture.stdout.value = "";

  await run(
    ["node", "snack", "status", "--source", "personal-anthropic", "--no-sync", "--json"],
    fixture.options,
  );
  const status = JSON.parse(fixture.stdout.value).data;

  assert.deepEqual(
    { plan: status.source.plan, observed: status.observed },
    {
      plan: "pro",
      observed: { prompts: 0, successes: 0, restrictions: 0, excluded: 0 },
    },
  );
});

test("status summarizes every configured source when none is selected", async () => {
  const fixture = await makeRunFixture();
  fixture.options.now = new Date("2026-01-02T03:05:00.000Z");
  fixture.options.env.OPENCODE_DB = await createOpenCodeDatabase(fixture.root);
  const mappings = /** @type {[string, string][]} */ ([
    ["personal-anthropic", "anthropic"],
    ["personal-openai", "openai"],
  ]);
  for (const [alias, provider] of mappings) {
    await run(
      [
        "node",
        "snack",
        "setup",
        "opencode",
        "--non-interactive",
        "--source",
        alias,
        "--provider",
        provider,
        "--profile",
        "personal",
        "--plan",
        "generic",
        "--json",
      ],
      fixture.options,
    );
    fixture.stdout.value = "";
  }
  await run(["node", "snack", "sync", "--full", "--json"], fixture.options);
  fixture.stdout.value = "";

  const exitCode = await run(["node", "snack", "status", "--no-sync", "--json"], fixture.options);
  const document = JSON.parse(fixture.stdout.value);

  assert.deepEqual(
    {
      exitCode,
      status: document.status,
      sources: /** @type {{source: {alias: string}, observed: unknown}[] | undefined} */ (
        document.data?.sources
      )?.map((source) => ({
        alias: source.source.alias,
        observed: source.observed,
      })),
    },
    {
      exitCode: 0,
      status: "degraded",
      sources: [
        {
          alias: "personal-anthropic",
          observed: { prompts: 1, successes: 1, restrictions: 0, excluded: 0 },
        },
        {
          alias: "personal-openai",
          observed: { prompts: 0, successes: 0, restrictions: 0, excluded: 0 },
        },
      ],
    },
  );
});

test("setup rolls back newly initialized storage when config commit fails", async () => {
  const fixture = await makeRunFixture();
  fixture.options.env.OPENCODE_DB = await createOpenCodeDatabase(fixture.root);
  fixture.options.writeConfig = async () => {
    throw new SnackError("Injected config commit failure.", {
      code: 3,
      reason: "config_write_error",
    });
  };

  const exitCode = await run(
    [
      "node",
      "snack",
      "setup",
      "opencode",
      "--non-interactive",
      "--source",
      "personal-anthropic",
      "--provider",
      "anthropic",
      "--profile",
      "personal",
      "--plan",
      "generic",
      "--json",
    ],
    fixture.options,
  );
  const storage = await inspectDatabase(fixture.paths.databaseFile);

  assert.deepEqual(
    { exitCode, error: JSON.parse(fixture.stdout.value).errors[0]?.code, storage },
    {
      exitCode: 3,
      error: "config_write_error",
      storage: { exists: false, integrity: "missing", migrations: "unknown" },
    },
  );
});

test("setup rejects source rebinds and ambiguous provider mappings", async () => {
  const fixture = await makeRunFixture();
  const firstDatabase = await createOpenCodeDatabase(fixture.root);
  const secondDatabase = await createOpenCodeDatabase(fixture.root, "opencode-second.db");
  /** @param {string} alias @param {string} provider */
  const setup = async (alias, provider) =>
    run(
      [
        "node",
        "snack",
        "setup",
        "opencode",
        "--non-interactive",
        "--source",
        alias,
        "--provider",
        provider,
        "--profile",
        "personal",
        "--plan",
        "generic",
        "--json",
      ],
      fixture.options,
    );
  fixture.options.env.OPENCODE_DB = firstDatabase;
  assert.equal(await setup("personal-anthropic", "anthropic"), 0);
  fixture.stdout.value = "";
  fixture.options.env.OPENCODE_DB = secondDatabase;
  const rebindExitCode = await setup("personal-anthropic", "anthropic");
  const rebindError = JSON.parse(fixture.stdout.value).errors[0]?.code;
  fixture.stdout.value = "";
  fixture.options.env.OPENCODE_DB = firstDatabase;
  const ambiguousExitCode = await setup("other-anthropic", "anthropic");
  const ambiguousError = JSON.parse(fixture.stdout.value).errors[0]?.code;

  assert.deepEqual(
    { rebindExitCode, rebindError, ambiguousExitCode, ambiguousError },
    {
      rebindExitCode: 3,
      rebindError: "source_rebind_rejected",
      ambiguousExitCode: 3,
      ambiguousError: "source_mapping_ambiguous",
    },
  );
});

test("status isolates a failed source and returns stale summaries", async () => {
  const fixture = await makeRunFixture();
  fixture.options.now = new Date("2026-01-02T03:05:00.000Z");
  const anthropicDatabase = await createOpenCodeDatabase(fixture.root);
  const openaiDatabase = await createOpenCodeDatabase(fixture.root, "opencode-openai.db");
  executeOpenCodeSql(
    openaiDatabase,
    `UPDATE message
     SET data = json_set(data, '$.model.providerID', 'openai')
     WHERE json_extract(data, '$.role') = 'user';
     UPDATE message
     SET data = json_set(data, '$.providerID', 'openai')
     WHERE json_extract(data, '$.role') = 'assistant';`,
  );
  for (const [alias, provider, database] of /** @type {[string, string, string][]} */ ([
    ["personal-anthropic", "anthropic", anthropicDatabase],
    ["personal-openai", "openai", openaiDatabase],
  ])) {
    fixture.options.env.OPENCODE_DB = database;
    await run(
      [
        "node",
        "snack",
        "setup",
        "opencode",
        "--non-interactive",
        "--source",
        alias,
        "--provider",
        provider,
        "--profile",
        "personal",
        "--plan",
        "generic",
        "--json",
      ],
      fixture.options,
    );
    fixture.stdout.value = "";
  }
  await run(["node", "snack", "sync", "--full", "--json"], fixture.options);
  await rm(openaiDatabase, { force: true });
  fixture.stdout.value = "";

  const exitCode = await run(["node", "snack", "status", "--json"], fixture.options);
  const document = JSON.parse(fixture.stdout.value);
  const sources =
    /** @type {{source: {alias: string}, observed: {prompts: number}, synchronization: {performed: boolean, status: string}}[] | undefined} */ (
      document.data?.sources
    );

  assert.deepEqual(
    {
      exitCode,
      status: document.status,
      sources: sources?.map((source) => ({
        alias: source.source.alias,
        prompts: source.observed.prompts,
        synchronization: source.synchronization,
      })),
    },
    {
      exitCode: 0,
      status: "degraded",
      sources: [
        {
          alias: "personal-anthropic",
          prompts: 1,
          synchronization: { performed: true, status: "ok" },
        },
        {
          alias: "personal-openai",
          prompts: 1,
          synchronization: { performed: true, status: "failed" },
        },
      ],
    },
  );
});

test("doctor warns when synchronized source data is stale", async () => {
  const fixture = await makeRunFixture();
  fixture.options.now = new Date("2026-01-04T03:05:00.000Z");
  fixture.options.env.OPENCODE_DB = await createOpenCodeDatabase(fixture.root);
  await run(
    [
      "node",
      "snack",
      "setup",
      "opencode",
      "--non-interactive",
      "--source",
      "personal-anthropic",
      "--provider",
      "anthropic",
      "--profile",
      "personal",
      "--plan",
      "generic",
      "--json",
    ],
    fixture.options,
  );
  fixture.stdout.value = "";
  await run(
    ["node", "snack", "sync", "--source", "personal-anthropic", "--full", "--json"],
    fixture.options,
  );
  fixture.stdout.value = "";

  await run(["node", "snack", "doctor", "--json"], fixture.options);
  const document = JSON.parse(fixture.stdout.value);
  const checks = /** @type {{id: string, status: string}[]} */ (document.data.checks);
  const freshness = checks.find((check) => check.id === "source_freshness:personal-anthropic");

  assert.deepEqual(
    { status: document.status, freshness: freshness?.status },
    { status: "degraded", freshness: "warn" },
  );
});

test("human status includes every required uncertainty field", async () => {
  const fixture = await makeRunFixture();
  fixture.options.now = new Date("2026-01-02T03:05:00.000Z");
  fixture.options.env.OPENCODE_DB = await createOpenCodeDatabase(fixture.root);
  await run(
    [
      "node",
      "snack",
      "setup",
      "opencode",
      "--non-interactive",
      "--source",
      "personal-anthropic",
      "--provider",
      "anthropic",
      "--profile",
      "personal",
      "--plan",
      "generic",
    ],
    fixture.options,
  );
  fixture.stdout.value = "";

  await run(["node", "snack", "status", "--source", "personal-anthropic"], fixture.options);

  assert.match(
    fixture.stdout.value,
    /risk high; evidence very_low; method bayesian-pressure-band@1; period 2026-01-02T03:05:00.000Z; pressure unknown; contributors none ranked; category typical; as_of 2026-01-02T03:04:10.000Z; sync ok/u,
  );
  assert.match(
    fixture.stdout.value,
    /Caveat: Sparse history; the weak plan-profile prior still dominates/u,
  );
});

test("human status names the period it describes and what moved the pressure band", async () => {
  const fixture = await makeRunFixture();
  fixture.options.env.OPENCODE_DB = await createOpenCodeDatabase(fixture.root);
  await setupAndSync(fixture);

  fixture.stdout.value = "";
  await run(["node", "snack", "status", "--no-sync"], fixture.options);
  const human = fixture.stdout.value;

  fixture.stdout.value = "";
  await run(["node", "snack", "status", "--no-sync", "--json"], fixture.options);
  const status = JSON.parse(fixture.stdout.value).data;

  // Specification §12.3: the default human detail includes the active period and the top pressure
  // contributors. A forecast whose scope and drivers are only in `--json` is two contracts.
  assert.match(human, new RegExp(`period ${status.source.active_period.started_at}`, "u"));
  const ranked = status.pressure.contributors.filter(
    (/** @type {{percentile: number | null}} */ contributor) => contributor.percentile !== null,
  );
  if (ranked.length > 0) {
    assert.match(human, new RegExp(`contributors[^\\n]*${ranked[0].dimension}`, "u"));
  } else {
    assert.match(human, /contributors none ranked/u);
  }
});

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

test("stats refuses an unconfigured capacity source", async () => {
  const fixture = await makeRunFixture();
  await run(["node", "snack", "config", "set", "presentation.json", "false"], fixture.options);
  fixture.stdout.value = "";

  const exitCode = await run(["node", "snack", "stats", "--json"], fixture.options);
  const document = JSON.parse(fixture.stdout.value);

  assert.equal(exitCode, ExitCode.unavailable);
  assert.equal(document.command, "stats");
  assert.equal(document.status, "error");
  assert.deepEqual(
    document.errors.map((/** @type {{code: string}} */ error) => error.code),
    ["source_unavailable"],
  );
});

test("stats describes each configured analysis horizon", async () => {
  const fixture = await makeRunFixture();
  fixture.options.now = new Date("2026-01-02T03:05:00.000Z");
  fixture.options.env.OPENCODE_DB = await createOpenCodeDatabase(fixture.root);
  await setupAndSync(fixture);

  const exitCode = await run(
    ["node", "snack", "stats", "--source", "personal-anthropic", "--json"],
    fixture.options,
  );
  const document = JSON.parse(fixture.stdout.value);

  assert.equal(exitCode, 0);
  assert.equal(document.command, "stats");
  assert.equal(document.status, "ok");
  assert.equal(document.data.source.alias, "personal-anthropic");
  // The default horizons come from analysis.horizons in the configuration.
  assert.deepEqual(
    document.data.horizons.map((/** @type {{horizon: string}} */ entry) => entry.horizon),
    ["PT1H", "PT5H", "P1D", "P7D"],
  );
  const firstHorizon = document.data.horizons[0];
  assert.deepEqual(firstHorizon.window, {
    from: "2026-01-02T02:05:00.000Z",
    to: "2026-01-02T03:05:00.000Z",
  });
  assert.deepEqual(firstHorizon.prompts, {
    count: 1,
    eligible: 1,
    successes: 1,
    restrictions: 0,
    excluded: 0,
    unit: "prompts",
  });
});

test("stats restricts the report to a requested horizon", async () => {
  const fixture = await makeRunFixture();
  fixture.options.now = new Date("2026-01-02T03:05:00.000Z");
  fixture.options.env.OPENCODE_DB = await createOpenCodeDatabase(fixture.root);
  await setupAndSync(fixture);

  await run(
    ["node", "snack", "stats", "--source", "personal-anthropic", "--horizon", "PT1H", "--json"],
    fixture.options,
  );
  const document = JSON.parse(fixture.stdout.value);

  assert.deepEqual(
    document.data.horizons.map((/** @type {{horizon: string}} */ entry) => entry.horizon),
    ["PT1H"],
  );
});

/** @param {Awaited<ReturnType<typeof makeRunFixture>>} fixture */
async function setupAndSync(fixture) {
  await run(
    [
      "node",
      "snack",
      "setup",
      "opencode",
      "--non-interactive",
      "--source",
      "personal-anthropic",
      "--provider",
      "anthropic",
      "--profile",
      "personal",
      "--plan",
      "generic",
      "--json",
    ],
    fixture.options,
  );
  await run(
    ["node", "snack", "sync", "--source", "personal-anthropic", "--full", "--json"],
    fixture.options,
  );
  fixture.stdout.value = "";
}

test("verbose stats report unknown dimensions without substituting zero", async () => {
  const fixture = await makeRunFixture();
  fixture.options.now = new Date("2026-01-02T03:05:00.000Z");
  fixture.options.env.OPENCODE_DB = await createOpenCodeDatabase(fixture.root);
  await setupAndSync(fixture);

  const exitCode = await run(
    ["node", "snack", "stats", "--source", "personal-anthropic", "--horizon", "PT1H", "--verbose"],
    fixture.options,
  );

  assert.equal(exitCode, 0);
  assert.match(fixture.stdout.value, /PT1H: 1 prompts \(1 eligible, 0 excluded\)/u);
  assert.match(fixture.stdout.value, /input_tokens: 100 tokens \(sample 1, missing 0\)/u);

  // A horizon with no observations reports unknown, never a fabricated zero.
  fixture.options.now = new Date("2026-01-10T00:00:00.000Z");
  fixture.stdout.value = "";
  await run(
    ["node", "snack", "stats", "--source", "personal-anthropic", "--horizon", "PT1H", "--verbose"],
    fixture.options,
  );

  assert.match(fixture.stdout.value, /PT1H: 0 prompts/u);
  assert.match(fixture.stdout.value, /input_tokens: unknown tokens \(sample 0, missing 0\)/u);
  assert.doesNotMatch(fixture.stdout.value, /input_tokens: 0 /u);
});

test("stats never emit prompt content", async () => {
  const fixture = await makeRunFixture();
  fixture.options.now = new Date("2026-01-02T03:05:00.000Z");
  fixture.options.env.OPENCODE_DB = await createOpenCodeDatabase(fixture.root);
  await setupAndSync(fixture);

  for (const argv of [
    ["node", "snack", "stats", "--source", "personal-anthropic"],
    ["node", "snack", "stats", "--source", "personal-anthropic", "--verbose"],
    ["node", "snack", "stats", "--source", "personal-anthropic", "--json"],
  ]) {
    fixture.stdout.value = "";
    fixture.stderr.value = "";
    assert.equal(await run(argv, fixture.options), 0);
    for (const canary of Object.values(privacyCanaries)) {
      const pattern = new RegExp(String(canary), "u");
      assert.doesNotMatch(fixture.stdout.value, pattern);
      assert.doesNotMatch(fixture.stderr.value, pattern);
      assert.doesNotMatch(await readTree(fixture.root), pattern);
    }
  }
});

test("status reports a real pressure band instead of the Stage 2 placeholder", async () => {
  const fixture = await makeRunFixture();
  fixture.options.now = new Date("2026-01-02T03:05:00.000Z");
  fixture.options.env.OPENCODE_DB = await createOpenCodeDatabase(fixture.root);
  await setupAndSync(fixture);

  const exitCode = await run(
    ["node", "snack", "status", "--source", "personal-anthropic", "--no-sync", "--json"],
    fixture.options,
  );
  const document = JSON.parse(fixture.stdout.value);

  assert.equal(exitCode, 0);
  assert.equal(document.data.pressure.policy_version, "stage4-analytics-v1");
  // One prompt and no prior history cannot rank as the heaviest window on record.
  assert.equal(document.data.pressure.band, "unknown");
  assert.equal(document.data.pressure.baseline_kind, "insufficient");
  assert.equal(document.data.pressure.baseline_windows, 0);
  assert.ok(Array.isArray(document.data.pressure.contributors));
  assert.ok(
    !document.data.caveats.some((/** @type {string} */ caveat) => /Stage 2/u.test(caveat)),
    `Stage 2 pressure caveat still present: ${JSON.stringify(document.data.caveats)}`,
  );
});

test("status ranks the current window once enough local history exists", async () => {
  const fixture = await makeRunFixture();
  fixture.options.now = new Date("2026-01-02T03:05:00.000Z");
  fixture.options.env.OPENCODE_DB = await createOpenCodeDatabase(fixture.root);
  // One prompt in each of the eight preceding hours, then a heavy current hour.
  const baseMs = Date.parse("2026-01-02T03:00:00.000Z");
  const hour = 3_600_000;
  let sql = "";
  for (let index = 1; index <= 8; index += 1) {
    const created = baseMs - index * hour;
    sql += insertOpenCodePrompt(`past-${index}`, created);
  }
  for (let index = 1; index <= 5; index += 1) {
    sql += insertOpenCodePrompt(`now-${index}`, baseMs - index * 60_000);
  }
  executeOpenCodeSql(fixture.options.env.OPENCODE_DB, sql);
  await setupAndSync(fixture);

  await run(
    ["node", "snack", "status", "--source", "personal-anthropic", "--no-sync", "--json"],
    fixture.options,
  );
  const { pressure } = JSON.parse(fixture.stdout.value).data;

  assert.equal(pressure.baseline_kind, "local");
  assert.equal(pressure.baseline_windows, 8);
  // Six prompts this hour against one per hour before it is the heaviest window seen.
  assert.equal(pressure.band, "high");
  assert.equal(
    /** @type {{dimension: string}[]} */ (pressure.contributors)[0]?.dimension,
    "prompts",
  );
  assert.ok(
    pressure.contributors.every(
      (/** @type {{percentile: number}} */ contributor) =>
        contributor.percentile >= 0 && contributor.percentile <= 1,
    ),
  );
});

/**
 * @param {string} id
 * @param {number} createdMs
 */
function insertOpenCodePrompt(id, createdMs) {
  const completed = createdMs + 4000;
  return (
    `INSERT INTO message (id, session_id, time_created, time_updated, data) VALUES
       ('user-${id}', 'session-1', ${createdMs}, ${createdMs},
        '{"role":"user","time":{"created":${createdMs}},"agent":"build","model":{"providerID":"anthropic","modelID":"claude-sonnet"}}'),
       ('assistant-${id}', 'session-1', ${createdMs + 1000}, ${completed},
        '{"role":"assistant","time":{"created":${createdMs + 1000},"completed":${completed}},"parentID":"user-${id}","providerID":"anthropic","modelID":"claude-sonnet","finish":"stop","cost":0.003,"tokens":{"input":100,"output":25,"reasoning":5,"cache":{"read":10,"write":2}}}');\n` +
    `INSERT INTO part (id, message_id, session_id, time_created, time_updated, data) VALUES
       ('step-${id}', 'assistant-${id}', 'session-1', ${completed}, ${completed},
        '{"type":"step-finish","reason":"stop","cost":0.003,"tokens":{"input":100,"output":25,"reasoning":5,"cache":{"read":10,"write":2}}}');\n`
  );
}

test("doctor reports plan profile provenance and flags a stale profile", async () => {
  const fixture = await makeRunFixture();
  fixture.options.env.OPENCODE_DB = await createOpenCodeDatabase(fixture.root);
  await setupAndSync(fixture);

  await run(["node", "snack", "doctor", "--json"], fixture.options);
  const fresh = JSON.parse(fixture.stdout.value);
  /** @type {{id: string, status: string, message: string}[]} */
  const freshChecks = fresh.data.checks;
  const freshProfile = freshChecks.find((check) =>
    check.id.startsWith("plan_profile:personal-anthropic"),
  );

  assert.ok(freshProfile, `no plan profile check in ${freshChecks.map((c) => c.id).join(", ")}`);
  assert.equal(freshProfile.status, "pass");
  assert.match(freshProfile.message, /bundled/u);

  // The bundled profile carries a fixed as_of, so a much later clock makes it stale.
  fixture.options.now = new Date("2030-01-01T00:00:00.000Z");
  fixture.stdout.value = "";
  fixture.stderr.value = "";
  await run(["node", "snack", "doctor", "--json"], fixture.options);
  /** @type {{id: string, status: string}[]} */
  const staleChecks = JSON.parse(fixture.stdout.value).data.checks;

  assert.ok(
    staleChecks.some(
      (check) => check.id.startsWith("plan_profile:personal-anthropic") && check.status === "warn",
    ),
    "a profile years past its as_of date must warn",
  );
});

test("concise stats report every field the specification requires", async () => {
  const fixture = await makeRunFixture();
  fixture.options.now = new Date("2026-01-02T03:05:00.000Z");
  fixture.options.env.OPENCODE_DB = await createOpenCodeDatabase(fixture.root);
  await setupAndSync(fixture);

  const exitCode = await run(
    ["node", "snack", "stats", "--source", "personal-anthropic", "--horizon", "PT5H"],
    fixture.options,
  );

  assert.equal(exitCode, 0);
  const output = fixture.stdout.value;
  assert.match(output, /PT5H: 1 prompts \(1 eligible, 0 excluded\)/u, "prompt counts");
  assert.match(output, /restrictions none/u, "restrictions by class");
  assert.match(output, /input_tokens 100/u, "token dimensions stay separate");
  assert.match(output, /output_tokens 25/u, "token dimensions stay separate");
  assert.match(output, /cost unknown 0\.003/u, "observed cost with its currency");
  assert.match(output, /duration p50 5000ms p90 5000ms/u, "duration percentiles");
  assert.match(output, /pressure \w+/u, "current pressure");
  assert.match(output, /as_of 2026-01-02T03:04:10\.000Z/u, "freshness");
});

test("prospective analysis sizes the next prompt from a file without retaining it", async () => {
  const fixture = await makeRunFixture();
  fixture.options.now = new Date("2026-01-02T03:05:00.000Z");
  fixture.options.env.OPENCODE_DB = await createOpenCodeDatabase(fixture.root);
  await setupAndSync(fixture);
  const promptFile = join(fixture.root, "prompt.txt");
  await writeFile(
    promptFile,
    `${privacyCanaries.prompt}\n${privacyCanaries.credential}\n${"context line\n".repeat(400)}`,
    { mode: 0o600 },
  );

  fixture.stdout.value = "";
  const exitCode = await run(
    [
      "node",
      "snack",
      "status",
      "--source",
      "personal-anthropic",
      "--no-sync",
      "--prompt-file",
      promptFile,
      "--json",
    ],
    fixture.options,
  );
  const document = JSON.parse(fixture.stdout.value);

  assert.equal(exitCode, 0);
  assert.equal(document.data.expected_prompt_category, "large");
  assert.deepEqual(document.data.prospective, {
    analyzer_version: "snack-input-v1",
    policy_version: "stage5-category-v1",
    baseline_kind: "generic",
    // The OpenCode backfill carries no input features; only the capture plugin does, so
    // there is no local token baseline to size against yet.
    baseline_sample: 0,
  });
  for (const canary of Object.values(privacyCanaries)) {
    const pattern = new RegExp(String(canary), "u");
    assert.doesNotMatch(fixture.stdout.value, pattern);
    assert.doesNotMatch(fixture.stderr.value, pattern);
    assert.doesNotMatch(await readTree(fixture.dataHome), pattern);
  }
});

test("prospective analysis reads stdin when the prompt file is a dash", async () => {
  const fixture = await makeRunFixture();
  fixture.options.now = new Date("2026-01-02T03:05:00.000Z");
  fixture.options.env.OPENCODE_DB = await createOpenCodeDatabase(fixture.root);
  await setupAndSync(fixture);
  fixture.stdout.value = "";
  const exitCode = await run(
    [
      "node",
      "snack",
      "status",
      "--source",
      "personal-anthropic",
      "--no-sync",
      "--prompt-file",
      "-",
      "--json",
    ],
    { ...fixture.options, stdin: ["short question"] },
  );
  const document = JSON.parse(fixture.stdout.value);

  assert.equal(exitCode, 0);
  assert.equal(document.data.expected_prompt_category, "small");
  assert.equal(document.data.prospective.analyzer_version, "snack-input-v1");
});

test("an unreadable prompt file warns and falls back to a typical prompt", async () => {
  const fixture = await makeRunFixture();
  fixture.options.now = new Date("2026-01-02T03:05:00.000Z");
  fixture.options.env.OPENCODE_DB = await createOpenCodeDatabase(fixture.root);
  await setupAndSync(fixture);

  fixture.stdout.value = "";
  const exitCode = await run(
    [
      "node",
      "snack",
      "status",
      "--source",
      "personal-anthropic",
      "--no-sync",
      "--prompt-file",
      join(fixture.root, "absent.txt"),
      "--json",
    ],
    fixture.options,
  );
  const document = JSON.parse(fixture.stdout.value);

  // A forecast is still useful without the prospective feature vector; refusing to report
  // one because a file is missing would be worse than assuming a typical prompt.
  assert.equal(exitCode, 0);
  assert.equal(document.data.expected_prompt_category, "typical");
  assert.equal(document.data.prospective, null);
  assert.ok(
    document.warnings.some(
      (/** @type {{code: string}} */ warning) => warning.code === "prospective_analysis_failed",
    ),
    JSON.stringify(document.warnings),
  );
});

test("sync assigns a size category to every ingested prompt", async () => {
  const fixture = await makeRunFixture();
  fixture.options.now = new Date("2026-01-02T03:05:00.000Z");
  fixture.options.env.OPENCODE_DB = await createOpenCodeDatabase(fixture.root);
  await setupAndSync(fixture);

  const database = new Database(fixture.paths.databaseFile, { readonly: true });
  try {
    const rows = database
      .prepare("SELECT size_category, category_policy_version FROM prompt_execution")
      .all();
    assert.ok(rows.length > 0);
    for (const row of rows) {
      assert.equal(
        /** @type {{category_policy_version: string}} */ (row).category_policy_version,
        "stage5-category-v1",
      );
      assert.ok(
        ["small", "typical", "large"].includes(
          /** @type {{size_category: string}} */ (row).size_category,
        ),
        JSON.stringify(row),
      );
    }
  } finally {
    database.close();
  }
});

/**
 * @param {string} databaseFile
 * @returns {{attempts: number, deliveries: number, attempt: Record<string, unknown> | undefined}}
 */
function readPredictionState(databaseFile) {
  const database = new Database(databaseFile, { readonly: true });
  try {
    return {
      attempts: Number(
        /** @type {{count: number}} */ (
          database.prepare("SELECT COUNT(*) AS count FROM prediction_attempt").get()
        ).count,
      ),
      deliveries: Number(
        /** @type {{count: number}} */ (
          database.prepare("SELECT COUNT(*) AS count FROM prediction_delivery").get()
        ).count,
      ),
      attempt: /** @type {Record<string, unknown> | undefined} */ (
        database.prepare("SELECT * FROM prediction_attempt ORDER BY id DESC LIMIT 1").get()
      ),
    };
  } finally {
    database.close();
  }
}

test("a delivered status forecast becomes a prediction snapshot", async () => {
  const fixture = await makeRunFixture();
  fixture.options.now = new Date("2026-01-02T03:05:00.000Z");
  fixture.options.env.OPENCODE_DB = await createOpenCodeDatabase(fixture.root);
  await setupAndSync(fixture);

  fixture.stdout.value = "";
  const exitCode = await run(
    ["node", "snack", "status", "--source", "personal-anthropic", "--no-sync", "--json"],
    fixture.options,
  );
  const document = JSON.parse(fixture.stdout.value);
  const state = readPredictionState(fixture.paths.databaseFile);

  assert.equal(exitCode, 0);
  assert.equal(state.attempts, 1);
  assert.equal(state.deliveries, 1);
  // The stored attempt reproduces the emitted forecast and names every policy behind it.
  assert.equal(state.attempt?.lower, document.data.viability.lower);
  assert.equal(state.attempt?.risk_label, document.data.risk.label);
  assert.equal(state.attempt?.evidence_level, document.data.evidence.level);
  assert.equal(state.attempt?.model_policy_version, "stage5-prediction-v2");
  assert.equal(state.attempt?.evidence_policy_version, "stage5-evidence-v2");
  assert.equal(state.attempt?.risk_policy_version, "stage2-risk-v2");
  assert.equal(state.attempt?.analytics_policy_version, "stage4-analytics-v1");
});

test("a forecast that never reached the user stays an attempt", async () => {
  const fixture = await makeRunFixture();
  fixture.options.now = new Date("2026-01-02T03:05:00.000Z");
  fixture.options.env.OPENCODE_DB = await createOpenCodeDatabase(fixture.root);
  await setupAndSync(fixture);

  const exitCode = await run(
    ["node", "snack", "status", "--source", "personal-anthropic", "--no-sync", "--json"],
    {
      ...fixture.options,
      stdout: {
        write() {
          throw new Error("stdout is gone");
        },
      },
    },
  );
  const state = readPredictionState(fixture.paths.databaseFile);

  // Delivery cannot share a transaction with stdout, so an unconfirmed forecast is
  // excluded from calibration rather than counted as one the user saw.
  assert.notEqual(exitCode, 0);
  assert.equal(state.attempts, 1);
  assert.equal(state.deliveries, 0);
});

test("stats separate live snapshot calibration from backtesting", async () => {
  const fixture = await makeRunFixture();
  fixture.options.now = new Date("2026-01-02T03:05:00.000Z");
  fixture.options.env.OPENCODE_DB = await createOpenCodeDatabase(fixture.root);
  await setupAndSync(fixture);

  fixture.stdout.value = "";
  assert.equal(
    await run(
      ["node", "snack", "stats", "--source", "personal-anthropic", "--json"],
      fixture.options,
    ),
    0,
  );
  const document = JSON.parse(fixture.stdout.value);

  // With one prompt and no forecast that preceded it, both streams must say so instead of
  // reporting a zero that would read as a perfect score.
  assert.equal(document.data.calibration.live.status, "not_available");
  assert.equal(document.data.calibration.live.brier.value, null);
  assert.equal(document.data.calibration.live.brier.sample_size, 0);
  assert.equal(document.data.calibration.backtest.status, "not_available");
  assert.equal(document.data.calibration.backtest.forecasts, 0);
  assert.equal(document.data.calibration.policy_version, "stage5-calibration-v1");
  assert.equal(document.data.calibration.snapshots, 0);
  assert.equal(document.data.calibration.undelivered_attempts, 0);
});

test("stats report a live Brier score once forecasts precede outcomes", async () => {
  const fixture = await makeRunFixture();
  fixture.options.now = new Date("2026-01-02T03:05:00.000Z");
  fixture.options.env.OPENCODE_DB = await createOpenCodeDatabase(fixture.root);
  await setupAndSync(fixture);

  // A delivered forecast, then a later prompt that the next sync ingests and evaluates.
  await run(
    ["node", "snack", "status", "--source", "personal-anthropic", "--no-sync", "--json"],
    fixture.options,
  );
  executeOpenCodeSql(
    fixture.options.env.OPENCODE_DB,
    insertOpenCodePrompt("later-1", Date.parse("2026-01-02T04:00:00.000Z")),
  );
  fixture.options.now = new Date("2026-01-02T05:00:00.000Z");
  await run(["node", "snack", "sync", "--source", "personal-anthropic", "--json"], fixture.options);

  fixture.stdout.value = "";
  assert.equal(
    await run(
      ["node", "snack", "stats", "--source", "personal-anthropic", "--json"],
      fixture.options,
    ),
    0,
  );
  const { calibration } = JSON.parse(fixture.stdout.value).data;

  assert.equal(calibration.snapshots, 1);
  assert.equal(calibration.live.status, "ok");
  assert.equal(calibration.live.brier.sample_size, 1);
  assert.ok(calibration.live.brier.value >= 0 && calibration.live.brier.value <= 1);
  assert.equal(calibration.live.reliability.length, 1);
  assert.equal(calibration.live.reliability[0].sample_size, 1);
});

test("human stats describe the same calibration the JSON document reports", async () => {
  const fixture = await makeRunFixture();
  fixture.options.now = new Date("2026-01-02T03:05:00.000Z");
  fixture.options.env.OPENCODE_DB = await createOpenCodeDatabase(fixture.root);
  await setupAndSync(fixture);
  await run(
    ["node", "snack", "status", "--source", "personal-anthropic", "--no-sync", "--json"],
    fixture.options,
  );
  executeOpenCodeSql(
    fixture.options.env.OPENCODE_DB,
    insertOpenCodePrompt("parity-1", Date.parse("2026-01-02T04:00:00.000Z")),
  );
  fixture.options.now = new Date("2026-01-02T05:00:00.000Z");
  await run(["node", "snack", "sync", "--source", "personal-anthropic", "--json"], fixture.options);

  fixture.stdout.value = "";
  await run(
    ["node", "snack", "stats", "--source", "personal-anthropic", "--json"],
    fixture.options,
  );
  const { calibration } = JSON.parse(fixture.stdout.value).data;
  fixture.stdout.value = "";
  await run(["node", "snack", "stats", "--source", "personal-anthropic"], fixture.options);
  const human = fixture.stdout.value;

  // Both renderings must state the same facts: how many snapshots exist, what the live
  // score is with its sample size, and that backtesting is a separate stream.
  assert.match(human, /calibration/iu);
  assert.match(human, new RegExp(`${calibration.snapshots} snapshot`, "u"));
  assert.match(human, new RegExp(`brier ${calibration.live.brier.value.toFixed(3)}`, "u"));
  assert.match(human, new RegExp(`sample ${calibration.live.brier.sample_size}`, "u"));
  assert.match(human, /backtest/iu);
});

test("high risk and very low evidence still exit zero", async () => {
  const fixture = await makeRunFixture();
  fixture.options.now = new Date("2026-01-02T03:05:00.000Z");
  fixture.options.env.OPENCODE_DB = await createOpenCodeDatabase(fixture.root);
  await setupAndSync(fixture);

  fixture.stdout.value = "";
  const exitCode = await run(
    ["node", "snack", "status", "--source", "personal-anthropic", "--no-sync", "--json"],
    fixture.options,
  );
  const document = JSON.parse(fixture.stdout.value);

  assert.equal(document.data.risk.label, "high");
  assert.equal(document.data.evidence.level, "very_low");
  assert.equal(exitCode, 0);
});

test("prediction attempts, deliveries, and evaluations retain no prompt content", async () => {
  const fixture = await makeRunFixture();
  fixture.options.now = new Date("2026-01-02T03:05:00.000Z");
  fixture.options.env.OPENCODE_DB = await createOpenCodeDatabase(fixture.root);
  await setupAndSync(fixture);
  const promptFile = join(fixture.root, "canary-prompt.txt");
  await writeFile(promptFile, Object.values(privacyCanaries).join("\n"), { mode: 0o600 });

  await run(
    [
      "node",
      "snack",
      "status",
      "--source",
      "personal-anthropic",
      "--no-sync",
      "--prompt-file",
      promptFile,
      "--json",
    ],
    fixture.options,
  );
  executeOpenCodeSql(
    fixture.options.env.OPENCODE_DB,
    insertOpenCodePrompt("canary-1", Date.parse("2026-01-02T04:00:00.000Z")),
  );
  fixture.options.now = new Date("2026-01-02T05:00:00.000Z");
  await run(["node", "snack", "sync", "--source", "personal-anthropic", "--json"], fixture.options);
  fixture.stdout.value = "";
  await run(
    ["node", "snack", "stats", "--source", "personal-anthropic", "--verbose", "--json"],
    fixture.options,
  );

  const database = new Database(fixture.paths.databaseFile, { readonly: true });
  let stored = "";
  try {
    for (const table of ["prediction_attempt", "prediction_delivery", "prediction_evaluation"]) {
      stored += JSON.stringify(database.prepare(`SELECT * FROM ${table}`).all());
    }
    assert.ok(stored.includes("stage5-prediction-v2"), "the attempt table must not be empty");
  } finally {
    database.close();
  }

  for (const canary of Object.values(privacyCanaries)) {
    const pattern = new RegExp(String(canary), "u");
    assert.doesNotMatch(stored, pattern);
    assert.doesNotMatch(fixture.stdout.value, pattern);
    assert.doesNotMatch(await readTree(fixture.dataHome), pattern);
  }
});

test("status reports real ingestion completeness instead of assuming the worst", async () => {
  const fixture = await makeRunFixture();
  fixture.options.now = new Date("2026-01-02T03:05:00.000Z");
  fixture.options.env.OPENCODE_DB = await createOpenCodeDatabase(fixture.root);
  await setupAndSync(fixture);

  fixture.stdout.value = "";
  await run(
    ["node", "snack", "status", "--source", "personal-anthropic", "--no-sync", "--json"],
    fixture.options,
  );
  const document = JSON.parse(fixture.stdout.value);

  // A clean backfill with a committed cursor and nothing rejected is complete, and the
  // completeness gate stops being the thing that caps evidence.
  assert.deepEqual(document.data.completeness, {
    level: "complete",
    reasons: [],
    policy_version: "stage5-evidence-v2",
  });
  const completenessGate = document.data.evidence.gates.find(
    (/** @type {{id: string}} */ gate) => gate.id === "completeness",
  );
  assert.equal(completenessGate.level, "high");
  assert.equal(completenessGate.limiting, false);
});

test("a source that was never synchronized reports unknown completeness", async () => {
  const fixture = await makeRunFixture();
  fixture.options.now = new Date("2026-01-02T03:05:00.000Z");
  fixture.options.env.OPENCODE_DB = await createOpenCodeDatabase(fixture.root);
  await run(
    [
      "node",
      "snack",
      "setup",
      "opencode",
      "--non-interactive",
      "--source",
      "personal-anthropic",
      "--provider",
      "anthropic",
      "--profile",
      "personal",
      "--plan",
      "generic",
      "--json",
    ],
    fixture.options,
  );

  fixture.stdout.value = "";
  await run(
    ["node", "snack", "status", "--source", "personal-anthropic", "--no-sync", "--json"],
    fixture.options,
  );
  const document = JSON.parse(fixture.stdout.value);

  assert.equal(document.data.completeness.level, "unknown");
  assert.deepEqual(document.data.completeness.reasons, ["never_synchronized"]);
});

test("a forecast is evaluated even when the user never syncs again", async () => {
  const fixture = await makeRunFixture();
  fixture.options.now = new Date("2026-01-02T03:05:00.000Z");
  fixture.options.env.OPENCODE_DB = await createOpenCodeDatabase(fixture.root);
  await setupAndSync(fixture);
  await run(
    ["node", "snack", "status", "--source", "personal-anthropic", "--no-sync", "--json"],
    fixture.options,
  );

  // A later prompt arrives and status picks it up through its own incremental sync; the
  // evaluation must not wait for a separate `snack sync` invocation.
  executeOpenCodeSql(
    fixture.options.env.OPENCODE_DB,
    insertOpenCodePrompt("evaluated-1", Date.parse("2026-01-02T04:00:00.000Z")),
  );
  fixture.options.now = new Date("2026-01-02T05:00:00.000Z");
  await run(
    ["node", "snack", "status", "--source", "personal-anthropic", "--json"],
    fixture.options,
  );

  fixture.stdout.value = "";
  await run(
    ["node", "snack", "stats", "--source", "personal-anthropic", "--json"],
    fixture.options,
  );
  const { calibration } = JSON.parse(fixture.stdout.value).data;

  assert.equal(calibration.live.brier.sample_size, 1);
  assert.equal(calibration.live.status, "ok");
});

test("verbose stats break usage down by model, as the flag promises", async () => {
  const fixture = await makeRunFixture();
  fixture.options.now = new Date("2026-01-02T03:05:00.000Z");
  fixture.options.env.OPENCODE_DB = await createOpenCodeDatabase(fixture.root);
  await setupAndSync(fixture);
  fixture.stdout.value = "";

  const exitCode = await run(
    ["node", "snack", "stats", "--source", "personal-anthropic", "--verbose"],
    fixture.options,
  );

  assert.equal(exitCode, 0);
  // `--verbose` advertises per-model detail; before this it only repeated the dimensions.
  assert.match(
    fixture.stdout.value,
    /model claude-sonnet: 1 usage slices; input_tokens 100, output_tokens 25/u,
  );
});

test("verbose stats report per-model usage in the JSON contract too", async () => {
  const fixture = await makeRunFixture();
  fixture.options.now = new Date("2026-01-02T03:05:00.000Z");
  fixture.options.env.OPENCODE_DB = await createOpenCodeDatabase(fixture.root);
  await setupAndSync(fixture);
  fixture.stdout.value = "";

  await run(
    ["node", "snack", "stats", "--source", "personal-anthropic", "--json"],
    fixture.options,
  );
  const horizon = JSON.parse(fixture.stdout.value).data.horizons.find(
    (/** @type {{horizon: string}} */ entry) => entry.horizon === "PT5H",
  );

  assert.deepEqual(
    horizon.by_model.map((/** @type {{model: string}} */ entry) => entry.model),
    ["claude-sonnet"],
  );
  assert.equal(horizon.by_model[0].slices.count, 1);
  assert.equal(horizon.by_model[0].slices.unit, "usage slices");
  assert.equal(horizon.by_model[0].dimensions.input_tokens.value, 100);
  assert.deepEqual(horizon.by_model[0].cost.by_currency, { unknown: "0.003" });
});

test("every warning the JSON document carries is also spoken to stderr", async () => {
  const fixture = await makeRunFixture();
  fixture.options.env.OPENCODE_DB = await createOpenCodeDatabase(fixture.root);
  await setupAndSync(fixture);
  const missingPrompt = join(fixture.root, "no-such-prompt.txt");

  // Acceptance criterion 6 and specification §12.1: human warnings go to stderr. A user who
  // mistypes `--prompt-file` otherwise reads a forecast built on a different assumption than
  // the one they believe, with nothing on screen to say so.
  for (const argv of [
    ["status", "--no-sync", "--prompt-file", missingPrompt],
    ["status", "--no-sync"],
  ]) {
    fixture.stdout.value = "";
    fixture.stderr.value = "";
    await run(["node", "snack", ...argv, "--json"], fixture.options);
    const warnings = JSON.parse(fixture.stdout.value).warnings;
    assert.ok(warnings.length > 0, `${argv.join(" ")} produced no warning to compare against`);

    fixture.stdout.value = "";
    fixture.stderr.value = "";
    await run(["node", "snack", ...argv], fixture.options);
    for (const warning of warnings) {
      assert.match(fixture.stderr.value, new RegExp(escapeForPattern(warning.message), "u"));
    }
    // Warnings belong on stderr so a piped forecast stays machine-readable.
    assert.doesNotMatch(fixture.stdout.value, /Warning:/u);
  }
});

/** @param {string} value */
function escapeForPattern(value) {
  return value.replaceAll(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

test("the flags the specification documents are the flags the CLI accepts", async () => {
  const fixture = await makeRunFixture();
  fixture.options.env.OPENCODE_DB = await createOpenCodeDatabase(fixture.root);
  await setupAndSync(fixture);

  // §12.4 documents `--horizon <duration|all>`; `all` asks for every configured horizon at once,
  // which is what a source with several of them makes worth asking for.
  fixture.stdout.value = "";
  const statsExit = await run(
    ["node", "snack", "stats", "--source", "personal-anthropic", "--horizon", "all", "--json"],
    fixture.options,
  );
  const stats = JSON.parse(fixture.stdout.value);
  assert.equal(statsExit, 0, fixture.stdout.value.slice(0, 200));
  assert.ok(stats.data.horizons.length > 1, JSON.stringify(stats.data.horizons));

  // §12.6 documents `snack doctor [--source <alias>]`, which narrows the report to one source's
  // checks rather than every configured one.
  fixture.stdout.value = "";
  const doctorExit = await run(
    ["node", "snack", "doctor", "--source", "personal-anthropic", "--json"],
    fixture.options,
  );
  const doctor = JSON.parse(fixture.stdout.value);
  assert.notEqual(doctorExit, 2, fixture.stdout.value.slice(0, 200));
  assert.ok(
    doctor.data.checks.some((/** @type {{id: string}} */ check) =>
      check.id.endsWith(":personal-anthropic"),
    ),
    JSON.stringify(doctor.data.checks.map((/** @type {{id: string}} */ check) => check.id)),
  );
});

test("a history the prior no longer dominates is not described as sparse", async () => {
  const fixture = await makeRunFixture();
  fixture.options.env.OPENCODE_DB = await createOpenCodeDatabase(fixture.root);
  // Fifty successful prompts against a prior worth one pseudo-observation: whatever the forecast
  // backed off to, the plan-profile prior is a rounding error in that posterior. Saying it still
  // dominates is a statement the same document contradicts.
  fixture.options.now = new Date("2026-01-02T03:05:00.000Z");
  const baseMs = Date.parse("2026-01-02T03:00:00.000Z");
  let sql = "";
  for (let index = 1; index <= 50; index += 1) {
    sql += insertOpenCodePrompt(`bulk-${index}`, baseMs - index * 60_000);
  }
  executeOpenCodeSql(fixture.options.env.OPENCODE_DB, sql);
  await setupAndSync(fixture);

  fixture.stdout.value = "";
  await run(["node", "snack", "status", "--no-sync", "--json"], fixture.options);
  const status = JSON.parse(fixture.stdout.value).data;

  const priorMass = status.contributors.prior.alpha + status.contributors.prior.beta;
  const posteriorMass =
    status.contributors.evidence_window.alpha + status.contributors.evidence_window.beta;
  assert.ok(priorMass * 2 < posteriorMass, `prior ${priorMass} of ${posteriorMass}`);
  assert.ok(
    !status.caveats.some((/** @type {string} */ caveat) => caveat.includes("still dominates")),
    JSON.stringify(status.caveats),
  );
});

test("SNACK_DEBUG explains an unexpected failure without changing what it reports", async () => {
  const fixture = await makeRunFixture();
  fixture.options.env.OPENCODE_DB = await createOpenCodeDatabase(fixture.root);
  const argv = [
    "node",
    "snack",
    "setup",
    "opencode",
    "--non-interactive",
    "--source",
    "work",
    "--provider",
    "anthropic",
    "--profile",
    "default",
    "--plan",
    "pro",
    "--json",
  ];
  /** @type {() => Promise<never>} */
  const failWriting = async () => {
    throw new Error("DIAGNOSTIC_CANARY");
  };

  const quiet = await run(argv, { ...fixture.options, writeConfig: failWriting });
  const quietDocument = JSON.parse(fixture.stdout.value);

  assert.equal(quiet, ExitCode.internal);
  assert.equal(quietDocument.errors[0].code, "internal_error");
  assert.doesNotMatch(fixture.stderr.value, /DIAGNOSTIC_CANARY/u);

  fixture.stdout.value = "";
  fixture.stderr.value = "";
  const verbose = await run(argv, {
    ...fixture.options,
    env: { ...fixture.options.env, SNACK_DEBUG: "1" },
    writeConfig: failWriting,
  });
  const verboseDocument = JSON.parse(fixture.stdout.value);

  // Same exit code, same document: the diagnostic goes to stderr and nowhere else, because the
  // JSON contract is what other programs read.
  assert.equal(verbose, ExitCode.internal);
  assert.deepEqual(verboseDocument.errors, quietDocument.errors);
  assert.match(fixture.stderr.value, /DIAGNOSTIC_CANARY/u);
  assert.doesNotMatch(fixture.stdout.value, /DIAGNOSTIC_CANARY/u);
});

test("every command group answers for a Claude-only capacity source", async () => {
  const fixture = await makeRunFixture("snack-claude-parity-");
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

  // The exit criterion is the same conformance the MVP demanded, answered for the second client:
  // a source is a source, and no command group is allowed to be OpenCode-only.
  /** @type {[string, string[]][]} */
  const invocations = [
    ["sync", ["sync"]],
    ["status", ["status", "--no-sync"]],
    ["stats", ["stats"]],
    ["doctor", ["doctor"]],
    ["config get", ["config", "get"]],
    ["export", ["export", "--format", "json", "--output", "-"]],
    ["data purge", ["data", "purge", "--source", "claude", "--dry-run"]],
  ];
  for (const [name, argv] of invocations) {
    fixture.stdout.value = "";
    fixture.stderr.value = "";
    const exitCode = await run(["node", "snack", ...argv, "--json"], fixture.options);
    assert.equal(
      exitCode,
      0,
      `snack ${argv.join(" ")} exited ${exitCode}: ${fixture.stderr.value}`,
    );
    const document = JSON.parse(fixture.stdout.value);
    assert.notEqual(document.status, "error", `snack ${argv.join(" ")} reported an error`);
    assert.equal(document.schema_version, "1", name);
  }

  // Export is the document that has to actually carry the observations, not merely succeed.
  fixture.stdout.value = "";
  await run(["node", "snack", "export", "--format", "json", "--output", "-"], fixture.options);
  const exported = JSON.parse(fixture.stdout.value);
  assert.equal(exported.data.tables.prompts.length, 1);
  assert.equal(exported.data.tables.usage_slices.length, 2);
});

test("two clients behind one capacity source add up instead of splitting", async () => {
  const fixture = await makeRunFixture("snack-shared-source-");
  fixture.options.env.OPENCODE_DB = await createOpenCodeDatabase(fixture.root);
  fixture.options.env.CLAUDE_CONFIG_DIR = await createClaudeHistory(fixture.root);
  /** @param {string} client */
  const setup = (client) =>
    run(
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
        "--json",
      ],
      fixture.options,
    );

  assert.equal(await setup("opencode"), 0);
  assert.equal(await setup("claude"), 0, fixture.stderr.value);
  await run(["node", "snack", "sync", "--full"], fixture.options);

  fixture.stdout.value = "";
  await run(["node", "snack", "export", "--format", "json", "--output", "-"], fixture.options);
  const exported = JSON.parse(fixture.stdout.value).data.tables;

  // One provider, one profile, one plan: the two clients compete for the same real capacity, so
  // their usage belongs to one lineage. Splitting it would describe a developer who used half as
  // much through each of two capacities that do not exist.
  assert.equal(exported.prompts.length, 2);
  assert.equal(exported.usage_slices.length, 3);
  assert.equal(
    new Set(exported.prompts.map((/** @type {{source_alias: string}} */ p) => p.source_alias)).size,
    1,
  );
  assert.equal(exported.capacity_periods.length, 1);

  // And it is one capacity source to the user, not two rows that happen to share a name.
  fixture.stdout.value = "";
  await run(["node", "snack", "stats", "--json"], fixture.options);
  // One document, not one per configured client: `stats` reports the capacity source, and the
  // clients feeding it are an ingestion detail the user did not ask about.
  const stats = JSON.parse(fixture.stdout.value);
  assert.equal(stats.data.source.alias, "work");
  assert.equal(fixture.stdout.value.match(/"command": "stats"/gu)?.length, 1);
});

test("a refusal one client saw survives another client succeeding on the same source", async () => {
  const fixture = await makeRunFixture("snack-shared-restriction-");
  fixture.options.env.OPENCODE_DB = await createOpenCodeDatabase(fixture.root);
  fixture.options.env.CLAUDE_CONFIG_DIR = await createClaudeHistory(
    fixture.root,
    "restricted-turn.jsonl",
  );
  for (const client of ["claude", "opencode"]) {
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
  await run(["node", "snack", "export", "--format", "json", "--output", "-"], fixture.options);
  const tables = JSON.parse(fixture.stdout.value).data.tables;

  // Falling back to another client and getting an answer does not mean the first client was not
  // refused. Combining the usage of a shared capacity source must not combine away the evidence
  // that the provider said no, which is the scarcest thing a forecast learns from.
  assert.equal(tables.restrictions.length, 1);
  assert.equal(tables.restrictions[0].class, "rate_limit");
  const outcomes = tables.prompts
    .map((/** @type {{outcome: string}} */ prompt) => prompt.outcome)
    .sort();
  assert.deepEqual(outcomes, ["restricted", "success"]);
  assert.equal(tables.capacity_periods.length, 1);
});

test("status synchronizes every client behind a shared capacity source", async () => {
  const fixture = await makeRunFixture("snack-status-shared-sync-");
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

  // `status` is the command people actually run, and it synchronizes on the way. Reporting one row
  // per capacity source is right; reading one client per capacity source is not — the other
  // client's prompts would only ever arrive if someone thought to run `sync` by hand.
  await run(["node", "snack", "status"], fixture.options);

  fixture.stdout.value = "";
  await run(["node", "snack", "export", "--format", "json", "--output", "-"], fixture.options);
  const tables = JSON.parse(fixture.stdout.value).data.tables;
  assert.equal(tables.prompts.length, 2);
  assert.equal(tables.usage_slices.length, 3);
});
