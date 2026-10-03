import assert from "node:assert/strict";
import { execFile, execFileSync, spawn, spawnSync } from "node:child_process";
import { mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, test } from "node:test";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { promisify } from "node:util";

import Database from "better-sqlite3";

import { run } from "../src/main.js";
import { setupJournalFile } from "../src/setup-journal.js";
import { withStorageOperationLock } from "../src/storage.js";
import {
  makeFakeClock,
  makeFakeSignals,
  makeFakeSync,
  makeFakeTerminal,
  realSync,
  startDash,
} from "./fixtures/fake-tty.js";
import {
  cleanupRunFixtures,
  createOpenCodeDatabase,
  executeOpenCodeSql,
  makeRunFixture,
  sink,
} from "./fixtures/run-fixture.js";

afterEach(cleanupRunFixtures);

const executeFile = promisify(execFile);
const cli = fileURLToPath(new URL("../src/cli.js", import.meta.url));

const TERMINAL_MESSAGE =
  "snack dash needs an interactive terminal; `snack status` gives the same reading through a pipe.";
const JSON_MESSAGE =
  "snack dash draws a screen and has no JSON form; `snack status --json` gives the same reading as a document.";

/** A configured, synchronized OpenCode source. */
async function configured() {
  const fixture = await makeRunFixture("snack-dash-command-");
  fixture.options.env.OPENCODE_DB = await createOpenCodeDatabase(fixture.root);
  const setup = ["setup", "opencode", "--non-interactive", "--source", "work"];
  setup.push("--provider", "anthropic", "--profile", "default", "--plan", "pro");
  assert.equal(await run(["node", "snack", ...setup], fixture.options), 0);
  assert.equal(await run(["node", "snack", "sync", "--full"], fixture.options), 0);
  return fixture;
}

/**
 * Run `dash` in process with a terminal that is, or is not, one.
 *
 * @param {Awaited<ReturnType<typeof configured>>} fixture
 * @param {{stdout?: boolean, stdin?: boolean, term?: string | undefined, argv?: string[]}} terminal
 */
async function dash(fixture, terminal) {
  const stdout = Object.assign(sink(), terminal.stdout === false ? {} : { isTTY: true });
  const stderr = sink();
  const env = { ...fixture.options.env };
  if (terminal.term !== undefined) Object.assign(env, { TERM: terminal.term });
  const code = await run(["node", "snack", ...(terminal.argv ?? ["dash"])], {
    ...fixture.options,
    env,
    stdout,
    stderr,
    stdin: /** @type {never} */ (terminal.stdin === false ? { isTTY: false } : { isTTY: true }),
  });
  return { code, stdout: stdout.value, stderr: stderr.value };
}

test("dash refuses --json, either side of the command, with one error envelope", async () => {
  const fixture = await configured();
  for (const argv of [
    ["dash", "--json"],
    ["--json", "dash"],
  ]) {
    const result = await dash(fixture, { term: "xterm-256color", argv });
    assert.equal(result.code, 2, argv.join(" "));
    const envelope = JSON.parse(result.stdout);
    // The command is named when it comes first; `--json dash` reports `snack`, as every command
    // invoked after a leading flag always has.
    assert.equal(envelope.command, argv[0] === "dash" ? "dash" : "snack");
    assert.equal(envelope.status, "error");
    assert.equal(envelope.data, null);
    assert.deepEqual(envelope.errors, [{ code: "dash_json_unsupported", message: JSON_MESSAGE }]);
    assert.equal(result.stderr, "");
  }
});

test("dash refuses a pipe, a non-terminal stdin, and a terminal that cannot address its cursor", async () => {
  const fixture = await configured();
  const cases = [
    { stdout: false, term: "xterm-256color" },
    { stdin: false, term: "xterm-256color" },
    { term: "dumb" },
    { term: "" },
    // TERM unset: the fixture environment carries none.
    {},
  ];
  for (const terminal of cases) {
    const result = await dash(fixture, terminal);
    assert.equal(result.code, 2, JSON.stringify(terminal));
    assert.equal(result.stdout, "", JSON.stringify(terminal));
    // It points at the command that gives the same reading where a screen cannot be drawn.
    assert.equal(result.stderr, `Error: ${TERMINAL_MESSAGE}\n`, JSON.stringify(terminal));
  }
});

test("a refused dash writes nothing: no database, no attempt", async () => {
  const fixture = await makeRunFixture("snack-dash-refused-");
  for (const terminal of [{ stdout: false }, { term: "dumb" }, { argv: ["dash", "--json"] }]) {
    await dash(/** @type {never} */ (fixture), { term: "xterm", ...terminal });
  }
  await assert.rejects(stat(fixture.paths.databaseFile), { code: "ENOENT" });
});

test("configuration, sources and storage are refused with their own exit codes", async () => {
  const fixture = await makeRunFixture("snack-dash-preconditions-");
  // No configuration at all is a configuration error, as it is for `status`.
  const missing = await dash(/** @type {never} */ (fixture), { term: "xterm" });
  assert.equal(missing.code, 3);
  // A configuration with no capacity source in it: nothing to watch.
  await mkdir(fixture.paths.configDir, { recursive: true, mode: 0o700 });
  await writeFile(fixture.paths.configFile, '{"schema_version": 1, "sources": []}\n', {
    mode: 0o600,
  });
  const none = await dash(/** @type {never} */ (fixture), { term: "xterm" });
  assert.equal(none.code, 4);
  assert.match(none.stderr, /capacity source is unavailable/u);

  const ready = await configured();
  const database = new Database(ready.paths.databaseFile);
  try {
    database
      .prepare(
        "INSERT INTO schema_migration (number, name, checksum, applied_at, application_version) VALUES (999, 'future', 'x', '2026-01-01T00:00:00.000Z', '9.9.9')",
      )
      .run();
  } finally {
    database.close();
  }
  const newer = await dash(ready, { term: "xterm" });
  assert.equal(newer.code, 5);
  assert.match(newer.stderr, /newer/u);

  await writeFile(ready.paths.configFile, "{ not json", { mode: 0o600 });
  const broken = await dash(ready, { term: "xterm" });
  assert.equal(broken.code, 3);
});

test("the real binary: dash into a pipe or with --json exits 2 and draws nothing", async () => {
  const fixture = await configured();
  const env = { ...process.env, ...fixture.options.env, HOME: fixture.root, TERM: "xterm" };
  // `snack dash | cat`: stdout is a pipe.
  const piped = await executeFile(process.execPath, [cli, "dash"], { env }).catch(
    (/** @type {{code: number, stdout: string, stderr: string}} */ error) => error,
  );
  assert.equal(/** @type {{code: number}} */ (piped).code, 2);
  assert.equal(piped.stdout, "");
  assert.equal(piped.stderr, `Error: ${TERMINAL_MESSAGE}\n`);

  const json = await executeFile(process.execPath, [cli, "dash", "--json"], { env }).catch(
    (/** @type {{code: number, stdout: string, stderr: string}} */ error) => error,
  );
  assert.equal(/** @type {{code: number}} */ (json).code, 2);
  const envelope = JSON.parse(json.stdout);
  assert.equal(envelope.errors[0].code, "dash_json_unsupported");
  assert.equal(json.stdout.trim().split("\n").length > 0, true);
});

/** @param {string} value */
function quote(value) {
  return `'${value.replaceAll("'", "''")}'`;
}

test("no dash frame, row or file carries a canary, and the files it touches stay private", async () => {
  const canaries = JSON.parse(
    await readFile(new URL("./fixtures/privacy-canaries.json", import.meta.url), "utf8"),
  );
  const fixture = await makeRunFixture("snack-dash-privacy-");
  const openCode = await createOpenCodeDatabase(fixture.root);
  executeOpenCodeSql(
    openCode,
    `UPDATE part SET data = json_set(data, '$.text', ${quote(
      `${canaries.prompt} ${canaries.response} ${canaries.credential} ${canaries.path}`,
    )});
     UPDATE session SET title = ${quote(String(canaries.title))},
                        directory = ${quote(String(canaries.path))};
     UPDATE project SET worktree = ${quote(String(canaries.path))};`,
  );
  fixture.options.env.OPENCODE_DB = openCode;
  const setup = ["setup", "opencode", "--non-interactive", "--source", "work"];
  setup.push("--provider", "anthropic", "--profile", "default", "--plan", "pro");
  assert.equal(await run(["node", "snack", ...setup], fixture.options), 0);

  const start = /** @type {Date} */ (fixture.options.now);
  const clock = makeFakeClock(start);
  const terminal = makeFakeTerminal({ columns: 120, rows: 40 });
  const session = await startDash(
    { ...fixture.options, now: start },
    {
      terminal,
      clock,
      sync: makeFakeSync(realSync(fixture.options, clock.now)),
      signals: makeFakeSignals(),
    },
  );
  /** @type {string[]} */
  const screens = [terminal.text()];
  for (const key of ["s", "+", "?", "escape", "-", "r"]) {
    terminal.press(key);
    await session.settle();
    screens.push(terminal.text());
  }
  await clock.advance(120_000);
  screens.push(terminal.text());
  terminal.press("q");
  assert.equal(await session.done, 0);

  // Non-vacuity: the canaries are in the source, and the dash drew a reading of it.
  assert.match(await readFile(openCode, "latin1"), /PROMPT_CANARY_DO_NOT_STORE/u);
  assert.ok(screens.some((screen) => /next prompt {2}\d+-\d+%/u.test(screen)));
  assert.ok(screens.some((screen) => /reading this screen/u.test(screen)));
  const database = new Database(fixture.paths.databaseFile, { readonly: true });
  /** @type {string} */
  let rows;
  try {
    rows = JSON.stringify(
      ["prediction_attempt", "prediction_delivery", "prediction_shadow"].map((table) =>
        database.prepare(`SELECT * FROM ${table}`).all(),
      ),
    );
    assert.ok(
      /** @type {{n: number}} */ (
        database
          .prepare("SELECT COUNT(*) AS n FROM prediction_delivery WHERE format = 'dash'")
          .get()
      ).n > 0,
    );
  } finally {
    database.close();
  }
  const frames = terminal.writes.join("");
  for (const [name, canary] of Object.entries(canaries)) {
    const pattern = new RegExp(String(canary), "u");
    assert.doesNotMatch(frames, pattern, `${name} reached a frame`);
    assert.doesNotMatch(rows, pattern, `${name} reached a row the dash wrote`);
  }
  // Everything under the state directory the session touched is the owner's alone.
  for (const entry of await readdir(fixture.paths.stateDir, { withFileTypes: true })) {
    const mode = (await stat(join(fixture.paths.stateDir, entry.name))).mode & 0o777;
    assert.ok(entry.isDirectory() ? mode === 0o700 : mode === 0o600, `${entry.name} ${mode}`);
  }
  assert.equal((await stat(fixture.paths.databaseFile)).mode & 0o777, 0o600);
});

/**
 * Run the real binary under a pseudo-terminal (`script`), feed it, and collect what it drew.
 * `exec` makes the node process `script`'s own child, so a signal can be aimed at it.
 *
 * @param {Record<string, string | undefined>} env
 * @param {(child: {pid: number, write(text: string): void}) => Promise<void>} drive
 */
async function underPty(env, drive) {
  // `script` gives the child a pty of no size; set one, or every frame is the too-small sentence
  // and no reading is ever drawn or delivered.
  const command = `stty cols 80 rows 24; exec ${process.execPath} ${cli} dash`;
  const script = spawn("script", ["-qec", command, "/dev/null"], {
    env: { ...env, TERM: "xterm-256color" },
    stdio: ["pipe", "pipe", "pipe"],
  });
  let output = "";
  script.stdout.on("data", (chunk) => {
    output += chunk.toString("latin1");
  });
  const closed = new Promise((resolve) =>
    script.on("close", (code, signal) => resolve({ code, signal })),
  );
  // Wait for the first frame: the alternate buffer entered.
  for (let waited = 0; !output.includes("\u001B[?1049h") && waited < 15_000; waited += 50) {
    await delay(50);
  }
  assert.ok(output.includes("\u001B[?1049h"), `no frame drawn: ${JSON.stringify(output)}`);
  const pid = Number(
    execFileSync("ps", ["-o", "pid=", "--ppid", String(script.pid)], { encoding: "utf8" }).trim(),
  );
  await drive({ pid, write: (text) => script.stdin.write(text) });
  // The feeder stays open until the command has ended, or `script` tears the pty down early.
  const result = /** @type {{code: number | null, signal: string | null}} */ (await closed);
  script.stdin.end();
  return { ...result, output };
}

test(
  "under a real pseudo-terminal, q and SIGTERM both leave the terminal as it was found",
  {
    skip:
      process.platform !== "linux"
        ? "uses util-linux script and ps --ppid"
        : spawnSync("script", ["--version"]).error !== undefined
          ? "util-linux script is not installed"
          : false,
  },
  async () => {
    const fixture = await configured();
    const env = { ...process.env, ...fixture.options.env, HOME: fixture.root };
    const quit = await underPty(env, async (child) => {
      await delay(1_500);
      child.write("q");
    });
    assert.equal(quit.code, 0);
    assert.ok(
      quit.output.endsWith("\u001B[0m\u001B[?25h\u001B[?1049l"),
      JSON.stringify(quit.output.slice(-40)),
    );
    // An 80x24 pty, so the frame was a real reading and its forecast was delivered as a snapshot.
    assert.match(quit.output, /next prompt/u);
    const database = new Database(fixture.paths.databaseFile, { readonly: true });
    try {
      const delivered = /** @type {{n: number}} */ (
        database
          .prepare("SELECT COUNT(*) AS n FROM prediction_delivery WHERE format = 'dash'")
          .get()
      );
      assert.ok(delivered.n > 0, "the dash delivered nothing under the pty");
    } finally {
      database.close();
    }

    const terminated = await underPty(env, async (child) => {
      await delay(1_500);
      process.kill(child.pid, "SIGTERM");
    });
    // Restored first, then ended by the signal itself.
    assert.ok(terminated.output.includes("\u001B[0m\u001B[?25h\u001B[?1049l"));
    assert.ok(
      terminated.code === 143 || terminated.signal === "SIGTERM",
      JSON.stringify(terminated.code),
    );
  },
);

test("dash opens while another command holds the lock, and never recovers its journal", async () => {
  // A `snack setup` in flight -- or a long `sync --full`, a migration with its backup, a purge --
  // holds the storage lock, and setup has written its journal. A busy lock does not end the
  // session (spec §1.3): the dash opens on the configuration as it reads now, says storage is busy,
  // and leaves the journal alone. Recovering it from outside the lock would roll back a setup that
  // has not failed -- rewriting the configuration and, with no backup named, deleting the database.
  const fixture = await configured();
  const configBefore = await readFile(fixture.paths.configFile, "utf8");
  const journal = setupJournalFile(fixture.paths);
  await withStorageOperationLock(fixture.paths, async () => {
    await writeFile(
      journal,
      JSON.stringify({
        version: 3,
        opencode_config_file: join(fixture.root, "absent.json"),
        config_existed: false,
        plugin_property_existed: false,
        previous_plugin: null,
        previous_plugin_index: -1,
        installed_plugin_hash: "x",
        previous_snack_config: configBefore.replace('"work"', '"rolled-back"'),
        database_backup_file: null,
      }),
      { mode: 0o600 },
    );
    const terminal = makeFakeTerminal();
    // The child meets the same lock and says so, as the real one would.
    const locked = {
      exitCode: 5,
      envelope: { status: "error", data: null, errors: [{ code: "storage_locked" }] },
    };
    const dash = await startDash(fixture.options, {
      terminal,
      clock: makeFakeClock(fixture.options.now),
      sync: makeFakeSync(async () => locked),
    });
    const state = dash.controller.state();
    assert.deepEqual(
      state.sources.map((source) => source.alias),
      ["work"],
    );
    assert.equal(state.reading.computedAt, null, "no reading was taken past the lock");
    assert.ok(state.sources.every((source) => source.sync === "busy"));
    assert.match(terminal.text(), /another snack command is using storage/u);
    terminal.press("q");
    assert.equal(await dash.done, 0);
    // Nothing was rolled back.
    assert.ok(await stat(fixture.paths.databaseFile).then(() => true));
    assert.equal(await readFile(fixture.paths.configFile, "utf8"), configBefore);
    assert.ok(await stat(journal).then(() => true));
  });
});
