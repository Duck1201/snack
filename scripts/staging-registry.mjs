// Publish the release tarballs to an isolated registry and install from it, before npm ever sees
// them.
//
// PLAN.md Stage 10 Wave 3 requires this: the final artifacts pass a staging gate first, and only the
// same checksum-verified tarballs then go to official npm. `package-smoke.mjs` installs a tarball by
// file path, which proves the package's contents; it cannot prove the part that only a registry has
// -- that the manifest resolves, that the dependency the CLI declares is fetched rather than assumed
// present, and that `npm install <name>@<version>` reaches the artifact at all.
//
// Verdaccio is fetched by `npx` for the run and nothing is added to the repository's dependencies. A
// staging registry is used once per release, and pinning a server into the lockfile to run it twice
// a year buys reproducibility of the thing least likely to be the problem.
//
// Uplinks are disabled, so a package this registry cannot serve fails here rather than being
// fetched from npmjs.org and quietly passing. That is the whole point of "isolated": the CLI's own
// runtime dependencies are installed from the public registry through a separate step, and the
// staging registry answers only for the two packages under test.
import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

const execute = promisify(execFile);
const workspace = dirname(fileURLToPath(new URL("../package.json", import.meta.url)));
const npmCli = process.env.npm_execpath;
if (!npmCli) throw new Error("Run the staging registry through npm.");

/** The floor `docs/compatibility.md` declares. The staging gate rehearses the direct chain from it. */
const FLOOR = "0.6.0";

const temporary = await mkdtemp(join(tmpdir(), "snack-staging-"));
/** @type {import("node:child_process").ChildProcess | undefined} */
let registry;
try {
  const cli = JSON.parse(
    await readFile(join(workspace, "packages", "cli", "package.json"), "utf8"),
  );
  // The tarballs come from the same `npm pack` the evidence measured, so what is staged is what is
  // published rather than a second build of the same source.
  const tarballs = {
    cli: await packInto(workspace, "@snack-ai/cli", join(temporary, "tarballs")),
    plugin: await packInto(workspace, "@snack-ai/opencode", join(temporary, "tarballs")),
  };
  const staged = {
    cli: await digestOf(tarballs.cli),
    plugin: await digestOf(tarballs.plugin),
  };

  // A free port chosen at run time rather than verdaccio's default 4873. A run that leaves a server
  // behind -- which the first version of this script did, see `startRegistry` -- would otherwise be
  // answered by that stale server on the next run, serving packages out of a directory this script
  // has already deleted. The failure reads as a corrupt verdaccio install and is nothing of the
  // kind.
  const port = await freePort();
  const url = `http://localhost:${port}`;
  registry = await startRegistry(join(temporary, "registry"), port);

  // The registry allows anonymous publish, but the npm client refuses to try without a token
  // configured for the host -- `ENEEDAUTH ... You need to authorize this machine using npm adduser`,
  // raised before any request is made. A dummy token in a throwaway userconfig satisfies the client;
  // verdaccio never checks it. This is why there is no account here and no `npm adduser`.
  const userconfig = join(temporary, "npmrc");
  await writeFile(userconfig, `//localhost:${port}/:_authToken=staging\n`, { mode: 0o600 });

  for (const tarball of [tarballs.cli, tarballs.plugin]) {
    await execute(
      process.execPath,
      // `--provenance=false` overrides `publishConfig.provenance` in both packages, which is right
      // for npmjs.org and impossible here: provenance is a signed statement about a CI run, and
      // there is no provider to sign it, so npm answers `EUSAGE ... not supported for provider:
      // null`. What is being staged is the tarball, and the tarball is byte-identical either way --
      // the attestation is generated at publish time from the workflow's OIDC identity and never
      // enters the archive. The real publish still carries `--provenance`.
      [
        npmCli,
        "publish",
        tarball,
        "--registry",
        url,
        "--userconfig",
        userconfig,
        "--provenance=false",
        "--tag",
        "latest",
      ],
      { cwd: temporary, env: { ...process.env, npm_config_cache: join(temporary, "npm-cache") } },
    );
  }

  // Resolved by name and version through the registry, which is the step a file-path install
  // cannot make. The floor comes from the public registry: this gate is about the candidate.
  const prefix = join(temporary, "install");
  await mkdir(prefix, { recursive: true });
  await writeFile(
    join(prefix, "package.json"),
    `${JSON.stringify(
      {
        private: true,
        allowScripts: { [`better-sqlite3@${cli.dependencies["better-sqlite3"]}`]: true },
      },
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
    OPENCODE_DB: await seedOpenCodeDatabase(join(temporary, "opencode.db")),
    npm_config_cache: join(temporary, "npm-cache"),
  };
  const binary = join(prefix, "node_modules", ".bin", "snack");
  /** @param {string[]} argv */
  const snack = async (argv) => {
    try {
      const { stdout } = await execute(binary, argv, {
        env: environment,
        maxBuffer: 10 * 1024 * 1024,
      });
      return { exitCode: 0, stdout };
    } catch (error) {
      const failure = /** @type {{code?: number, stdout?: string, stderr?: string}} */ (error);
      return { exitCode: failure.code ?? -1, stdout: `${failure.stdout}${failure.stderr}` };
    }
  };

  // The floor first, so the database the candidate upgrades was written by a real older release.
  await install(prefix, `@snack-ai/cli@${FLOOR}`, temporary, undefined);
  assert.equal((await snack(["--version"])).stdout.trim(), FLOOR);
  for (const argv of [
    ["setup", "opencode", "--non-interactive", "--source", "work", "--provider", "anthropic"],
    ["sync", "--full"],
  ]) {
    const answer = await snack(
      argv.concat(argv[0] === "setup" ? ["--profile", "default", "--plan", "pro"] : []),
    );
    assert.equal(answer.exitCode, 0, `${FLOOR} ${argv.join(" ")}: ${answer.stdout}`);
  }

  // Now the staged candidate, resolved from the isolated registry by name and version.
  await install(prefix, `@snack-ai/cli@${cli.version}`, temporary, url);
  assert.equal((await snack(["--version"])).stdout.trim(), cli.version);

  const upgrade = await snack(["sync", "--full", "--json"]);
  assert.equal(upgrade.exitCode, 0, `staged sync: ${upgrade.stdout}`);
  const doctor = await snack(["doctor", "--json"]);
  const document = JSON.parse(doctor.stdout);
  assert.equal(doctor.exitCode, 0, JSON.stringify(document.errors));
  assert.ok(
    document.data.checks.every((/** @type {{status: string}} */ check) => check.status !== "fail"),
    JSON.stringify(document.data.checks),
  );

  // What the registry served has to be byte-identical to what was staged. If it is not, the
  // artifact that passed the gates is not the artifact a consumer downloads, and there is nothing
  // to reason about.
  const served = await packFromRegistry(`@snack-ai/cli@${cli.version}`, url, temporary);
  assert.equal(await digestOf(served), staged.cli, "the registry served a different CLI tarball");

  process.stdout.write(
    `Staging registry passed: ${basename(tarballs.cli)} ${staged.cli}\n` +
      `                        ${basename(tarballs.plugin)} ${staged.plugin}\n` +
      `  ${FLOOR} -> ${cli.version} installed by name from an isolated registry, doctor clean.\n` +
      "  Publish these exact tarballs; a different digest means a different artifact.\n",
  );
} finally {
  if (registry) stop(registry);
  await rm(temporary, { recursive: true, force: true });
}

/**
 * Signal the whole process group, not the handle. See the comment on the spawn in `startRegistry`:
 * the handle is `npx`, and verdaccio is its child.
 *
 * @param {import("node:child_process").ChildProcess} child
 */
function stop(child) {
  if (child.pid === undefined) return;
  try {
    process.kill(-child.pid, "SIGTERM");
  } catch {
    // Already gone, which is the outcome this wanted.
  }
}

/** An ephemeral port the operating system says is free, released immediately before use. */
async function freePort() {
  const { createServer } = await import("node:net");
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address !== null ? address.port : 0;
      server.close(() => (port === 0 ? reject(new Error("no free port")) : resolve(port)));
    });
  });
}

/**
 * Verdaccio on a temporary storage directory with uplinks removed, ready when it answers.
 *
 * @param {string} storage
 * @param {number} port
 */
async function startRegistry(storage, port) {
  await mkdir(storage, { recursive: true });
  const configFile = join(storage, "config.yaml");
  await writeFile(
    configFile,
    [
      `storage: ${join(storage, "packages")}`,
      "uplinks: {}",
      "packages:",
      "  '**':",
      "    access: $all",
      // Anonymous publish, deliberately. This registry lives in a temporary directory for the
      // length of one run and is torn down in a `finally`; an account would only add the interactive
      // `npm adduser` and a token file to the things that can go wrong on the way to the gate.
      "    publish: $all",
      "log: { type: stdout, format: pretty, level: error }",
      "",
    ].join("\n"),
    { mode: 0o600 },
  );

  // `detached` so the whole group can be signalled at teardown. `npx` spawns verdaccio as its own
  // child, so killing the handle this function returns kills npx and leaves verdaccio running --
  // holding its port, serving a storage directory the `finally` has already removed, and failing the
  // next run with `Cannot find module '../encodings'` from inside its own deleted node_modules.
  //
  // The npx cache stays at its default location on purpose. Putting it under the run's temporary
  // directory means downloading verdaccio again on every run and deleting it again afterwards.
  const child = spawn(
    "npx",
    ["--yes", "verdaccio@6", "--config", configFile, "--listen", `${port}`],
    {
      stdio: ["ignore", "pipe", "pipe"],
      detached: true,
      env: { ...process.env, XDG_DATA_HOME: storage },
    },
  );
  child.once("error", (error) => {
    throw error;
  });

  // Ready when it answers, not after a fixed wait: `npx` may spend a minute fetching verdaccio the
  // first time and no time at all afterwards, and a sleep long enough for the first case wastes it
  // on every later one. `npm ping` is the readiness check because it is the same client the publish
  // and the install use -- a registry that answers a raw request but not npm is not ready.
  const deadline = Date.now() + 180_000;
  for (;;) {
    if (Date.now() > deadline) {
      stop(child);
      throw new Error("The staging registry did not start within three minutes.");
    }
    const answered = await execute(
      process.execPath,
      [npmCli, "ping", "--registry", `http://localhost:${port}`],
      { env: { ...process.env, npm_config_cache: join(storage, "npm-cache") } },
    ).then(
      () => true,
      () => false,
    );
    if (answered) return child;
    await delay(1000);
  }
}

/** @param {string} prefix @param {string} specifier @param {string} cache @param {string | undefined} url */
async function install(prefix, specifier, cache, url) {
  const argv = [npmCli, "install", "--prefix", prefix, "--ignore-scripts=false", specifier];
  if (url) argv.push("--registry", url);
  await execute(process.execPath, argv, {
    cwd: workspace,
    env: { ...process.env, npm_config_cache: join(cache, "npm-cache") },
    maxBuffer: 10 * 1024 * 1024,
  });
}

/** @param {string} spec @param {string} url @param {string} destination */
async function packFromRegistry(spec, url, destination) {
  const into = join(destination, "served");
  await mkdir(into, { recursive: true });
  const { stdout } = await execute(
    process.execPath,
    [npmCli, "pack", spec, "--registry", url, "--json", "--pack-destination", into, "--silent"],
    { cwd: destination, env: { ...process.env, npm_config_cache: join(destination, "npm-cache") } },
  );
  const [result] = JSON.parse(stdout);
  return join(into, result.filename);
}

/** @param {string} root @param {string} name @param {string} destination */
async function packInto(root, name, destination) {
  await mkdir(destination, { recursive: true });
  const { stdout } = await execute(
    process.execPath,
    [npmCli, "pack", "--workspace", name, "--json", "--pack-destination", destination, "--silent"],
    { cwd: root, maxBuffer: 10 * 1024 * 1024 },
  );
  const [result] = JSON.parse(stdout);
  return join(destination, result.filename);
}

/** @param {string} file */
async function digestOf(file) {
  return `sha256:${createHash("sha256")
    .update(await readFile(file))
    .digest("hex")}`;
}

/** The floor release's own OpenCode fixture, for the reason `upgrade-smoke.mjs` explains at length. */
async function seedOpenCodeDatabase(databaseFile) {
  const { createRequire } = await import("node:module");
  const Database = createRequire(join(workspace, "packages", "cli", "package.json"))(
    "better-sqlite3",
  );
  const { stdout: sql } = await execute(
    "git",
    ["show", `v${FLOOR}:packages/cli/test/fixtures/opencode/supported-v1.sql`],
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
