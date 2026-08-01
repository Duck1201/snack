// Prove the migration chains with published artifacts rather than with this tree.
//
// Every migration test in the suite reconstructs an older schema from today's migration files, so a
// migration edited in place after its release would pass all of them. This installs each real
// release from npm, lets it create and fill a database, then upgrades that database with the
// candidate built from this tree -- which is the only arrangement that can catch a released
// migration having changed underneath its checksum.
//
// Stage 10 needs the direct floor-to-1.0 chain and the representative intermediate ones, so the
// floor is a list rather than a constant. Each entry is an independent run against its own throwaway
// installation: chains are not composed here, because a real upgrade is one binary replacing
// another over a database, not a relay.
//
// Network-dependent, so it is not part of `npm run check`. Run it per release and record the result
// under `docs/release/`. Pass versions as arguments to run a subset while iterating:
//
//   npm run upgrade:smoke -- 0.6.0 0.9.0
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, open, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

const execute = promisify(execFile);
const workspace = dirname(fileURLToPath(new URL("../package.json", import.meta.url)));
// Resolved from the CLI workspace rather than from here: `better-sqlite3` is the CLI's dependency,
// and the root has no node_modules entry for it.
const Database = createRequire(join(workspace, "packages", "cli", "package.json"))(
  "better-sqlite3",
);
const npmCli = process.env.npm_execpath;
if (!npmCli) throw new Error("Run upgrade smoke through npm.");

/**
 * Every published release an upgrade has to arrive from. `0.6.0` is the floor
 * `docs/compatibility.md` declares, so the direct `0.6.0 -> candidate` chain is the one the stable
 * gate turns on; the rest are the representative adjacent and intermediate chains, one per minor,
 * taking each minor's newest patch because that is what an installation on that minor actually has.
 */
const FLOORS = ["0.6.0", "0.6.1", "0.7.0", "0.8.2", "0.9.0"];

const requested = process.argv.slice(2);
const floors = requested.length > 0 ? requested : FLOORS;
for (const floor of floors) {
  if (!FLOORS.includes(floor)) throw new Error(`${floor} is not a published floor release.`);
}

const cliManifest = JSON.parse(
  await readFile(join(workspace, "packages", "cli", "package.json"), "utf8"),
);
const sqliteVersion = cliManifest.dependencies?.["better-sqlite3"];
if (typeof sqliteVersion !== "string") throw new Error("better-sqlite3 version is missing.");

// Packed once and reused by every floor: the candidate is the same artifact whichever release it is
// upgrading, and packing it per floor would only measure npm pack five times.
const packDirectory = await mkdtemp(join(tmpdir(), "snack-upgrade-candidate-"));
try {
  const tarball = await packCli(packDirectory);
  for (const floor of floors) await upgradeFrom(floor, tarball);
  process.stdout.write(
    `Upgrade smoke passed for ${floors.join(", ")} -> ${cliManifest.version}, ` +
      `${basename(tarball)}.\n`,
  );
} finally {
  await rm(packDirectory, { recursive: true, force: true });
}

/**
 * One published release, seeded and then upgraded by the candidate over the database it left behind.
 *
 * @param {string} floorVersion
 * @param {string} tarball
 */
async function upgradeFrom(floorVersion, tarball) {
  const floorTag = `v${floorVersion}`;
  const temporary = await mkdtemp(join(tmpdir(), "snack-upgrade-smoke-"));
  try {
    await runChain(floorVersion, floorTag, tarball, temporary);
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}

/**
 * @param {string} floorVersion
 * @param {string} floorTag
 * @param {string} tarball
 * @param {string} temporary
 */
async function runChain(floorVersion, floorTag, tarball, temporary) {
  // One prefix, installed into twice. The second install replaces the binary while the XDG
  // directories below keep the database the first one wrote, which is what an upgrade is.
  const prefix = join(temporary, "install");
  await mkdir(prefix, { recursive: true });
  await writeFile(
    join(prefix, "package.json"),
    `${JSON.stringify(
      { private: true, allowScripts: { [`better-sqlite3@${sqliteVersion}`]: true } },
      null,
      2,
    )}\n`,
  );

  const home = join(temporary, "home");
  await mkdir(home, { recursive: true });
  const environment = {
    ...process.env,
    HOME: home,
    XDG_CONFIG_HOME: join(home, "config"),
    XDG_DATA_HOME: join(home, "data"),
    XDG_STATE_HOME: join(home, "state"),
    XDG_CACHE_HOME: join(home, "cache"),
    OPENCODE_DB: await seedOpenCodeDatabase(join(temporary, "opencode.db"), floorTag),
    npm_config_cache: join(temporary, "npm-cache"),
  };
  const binary = join(
    prefix,
    "node_modules",
    ".bin",
    process.platform === "win32" ? "snack.cmd" : "snack",
  );
  /** @param {string[]} argv */
  const snack = async (argv) => {
    try {
      const { stdout, stderr } = await execute(binary, argv, {
        env: environment,
        maxBuffer: 10 * 1024 * 1024,
      });
      return { exitCode: 0, stdout, stderr };
    } catch (error) {
      const failure = /** @type {{code?: number, stdout?: string, stderr?: string}} */ (error);
      return {
        exitCode: failure.code ?? -1,
        stdout: failure.stdout ?? "",
        stderr: failure.stderr ?? "",
      };
    }
  };

  await install(prefix, `@snack-ai/cli@${floorVersion}`, temporary);
  const installed = (await snack(["--version"])).stdout.trim();
  assert.equal(installed, floorVersion, `expected the floor release, got ${installed}`);

  // The floor release creates the database, records a history, and produces a forecast -- the rows
  // an upgrade has to carry, written by the binary that actually wrote them at the time.
  for (const argv of [
    [
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
    ],
    ["sync", "--full"],
    ["status"],
  ]) {
    const answer = await snack(argv);
    assert.equal(
      answer.exitCode,
      0,
      `${floorVersion} ${argv.join(" ")} exited ${answer.exitCode}: ${answer.stderr}${answer.stdout}`,
    );
  }
  const databaseFile = join(home, "data", "snack", "snack.sqlite3");
  const before = tableCounts(databaseFile);
  assert.ok(before.prompt_execution > 0, "the floor release stored no prompts to carry forward");
  const migrationsBefore = before.schema_migration;

  // Now the candidate, over the database the floor release left behind.
  await install(prefix, tarball, temporary);
  const candidateVersion = (await snack(["--version"])).stdout.trim();
  assert.equal(candidateVersion, cliManifest.version);

  // Read-only commands refuse an unmigrated database by design, so the upgrade happens on the
  // first command that opens storage for write. That is the order a real upgrade happens in.
  const upgrade = await snack(["sync", "--full", "--json"]);
  assert.equal(upgrade.exitCode, 0, `candidate sync exited ${upgrade.exitCode}: ${upgrade.stdout}`);

  const doctor = await snack(["doctor", "--json"]);
  const doctorDocument = JSON.parse(doctor.stdout);
  assert.equal(doctor.exitCode, 0, JSON.stringify(doctorDocument.errors));
  assert.ok(
    doctorDocument.data.checks.every((check) => check.status !== "fail"),
    JSON.stringify(doctorDocument.data.checks),
  );

  const status = await snack(["status", "--no-sync", "--json"]);
  const statusDocument = JSON.parse(status.stdout);
  assert.equal(status.exitCode, 0, JSON.stringify(statusDocument.errors));
  assert.equal(statusDocument.schema_version, "2");

  // Nothing the floor release recorded may have been dropped. Growth is fine -- `status` writes the
  // forecast it just produced -- but no table may come out the far side smaller than it went in.
  const after = tableCounts(databaseFile);
  for (const [table, count] of Object.entries(before)) {
    assert.ok(after[table] >= count, `${table} lost rows: ${count} before, ${after[table]} after`);
  }

  // The backup is the only way back from a migration, so an upgrade that applied one and did not
  // take a backup is not a supported upgrade whatever the rows say. Conditional on migrations
  // actually running: the newest floor is already at the candidate's schema, and demanding a backup
  // there would fail a chain that had nothing to migrate -- which is what an unconditional version
  // of this assertion did on the first run.
  const migrationsApplied = after.schema_migration - migrationsBefore;
  const backups = await readdirOrEmpty(join(home, "data", "snack", "backups"));
  if (migrationsApplied > 0) {
    assert.ok(backups.length > 0, `${floorVersion}: migrated without taking a backup`);
  } else {
    assert.equal(backups.length, 0, `${floorVersion}: backed up without migrating anything`);
  }

  // Row counts say nothing about the pages under them. A migration that rebuilds a table -- which
  // is how SQLite changes a constraint at all -- can leave an index pointing at rows that moved,
  // and that damage reads as a full table right up until the query that trips over it.
  assert.equal(integrityCheck(databaseFile), "ok", `${floorVersion}: integrity check failed`);

  process.stdout.write(
    `  ${floorVersion} -> ${candidateVersion} over ${before.prompt_execution} prompts, ` +
      `${migrationsApplied} migrations applied, ` +
      `${migrationsApplied > 0 ? "backup taken" : "no backup needed"}, integrity ok.\n`,
  );
}

/** @param {string} prefix @param {string} specifier @param {string} cache */
async function install(prefix, specifier, cache) {
  await execute(
    process.execPath,
    [npmCli, "install", "--prefix", prefix, "--ignore-scripts=false", specifier],
    {
      cwd: workspace,
      env: { ...process.env, npm_config_cache: join(cache, "npm-cache") },
      maxBuffer: 10 * 1024 * 1024,
    },
  );
}

/**
 * The OpenCode fixture as the floor release knew it, read from that release's own tag.
 *
 * Today's fixture is deliberately not used: `0.6.x` shipped a fingerprint that demanded NOT NULL on
 * primary keys, which no real OpenCode database satisfies -- the P1 fixed in `0.8.1` -- and the
 * fixture was rewritten from a real database at the same time. Those releases reject the rewritten
 * fixture, so seeding with it would prove only that they had the bug we already know about. Reading
 * each floor's own fixture is what makes one seeding rule work for every floor: the candidate's
 * fingerprint is the loosest and accepts all of them.
 *
 * @param {string} databaseFile
 * @param {string} floorTag
 */
async function seedOpenCodeDatabase(databaseFile, floorTag) {
  const { stdout: sql } = await execute(
    "git",
    ["show", `${floorTag}:packages/cli/test/fixtures/opencode/supported-v1.sql`],
    { cwd: workspace, maxBuffer: 10 * 1024 * 1024 },
  );
  const database = new Database(databaseFile);
  try {
    database.exec(sql);
  } finally {
    database.close();
  }
  return databaseFile;
}

/** @param {string} databaseFile @returns {Record<string, number>} */
function tableCounts(databaseFile) {
  const database = new Database(databaseFile, { readonly: true });
  try {
    const tables = /** @type {{name: string}[]} */ (
      database
        .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'")
        .all()
    );
    return Object.fromEntries(
      tables.map((table) => [
        table.name,
        Number(
          /** @type {{total: number}} */ (
            database.prepare(`SELECT COUNT(*) AS total FROM "${table.name}"`).get()
          ).total,
        ),
      ]),
    );
  } finally {
    database.close();
  }
}

/** @param {string} databaseFile @returns {string} */
function integrityCheck(databaseFile) {
  const database = new Database(databaseFile, { readonly: true });
  try {
    const row = /** @type {{integrity_check?: unknown}} */ (
      database.prepare("PRAGMA integrity_check").get()
    );
    return String(row?.integrity_check ?? "missing");
  } finally {
    database.close();
  }
}

/** @param {string} path */
async function readdirOrEmpty(path) {
  const { readdir } = await import("node:fs/promises");
  return readdir(path).catch(() => []);
}

/**
 * npm 11 can suppress `pack --json` when its stdout is a child-process pipe, so the manifest is
 * directed to a file. Same reason as `package-smoke.mjs`.
 *
 * @param {string} destination
 */
async function packCli(destination) {
  const manifestFile = join(destination, "pack-manifest.json");
  const manifest = await open(manifestFile, "w", 0o600);
  try {
    await new Promise((resolve, reject) => {
      const child = spawn(
        "npm",
        ["pack", "--workspace", "@snack-ai/cli", "--json", "--pack-destination", destination],
        {
          cwd: workspace,
          env: { ...process.env, npm_config_cache: join(destination, "npm-cache") },
          stdio: ["ignore", manifest.fd, "pipe"],
        },
      );
      let stderr = "";
      child.stderr.on("data", (chunk) => {
        stderr += chunk;
      });
      child.once("error", reject);
      child.once("close", (code) => {
        if (code === 0) resolve();
        else reject(new Error(`npm pack failed with exit code ${code}: ${stderr}`));
      });
    });
  } finally {
    await manifest.close();
  }
  const [result] = JSON.parse(await readFile(manifestFile, "utf8"));
  if (!result || typeof result.filename !== "string") {
    throw new Error("npm pack returned an unexpected manifest.");
  }
  return join(destination, result.filename);
}
