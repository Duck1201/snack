import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, test } from "node:test";

import { ExitCode } from "../src/errors.js";
import { EXPORT_TABLES } from "../src/export.js";
import { run } from "../src/main.js";
import { ENVELOPE_SCHEMA_VERSION, createEnvelope } from "../src/output.js";
import {
  cleanupRunFixtures,
  createOpenCodeDatabase,
  executeOpenCodeSql,
  makeRunFixture,
} from "./fixtures/run-fixture.js";

const privacyCanaries = JSON.parse(
  await readFile(new URL("./fixtures/privacy-canaries.json", import.meta.url), "utf8"),
);

afterEach(cleanupRunFixtures);

/**
 * A source that has been synchronized and had one forecast delivered, so every exported table
 * has something in it: periods, prompts, usage slices, outcomes, and a prediction snapshot.
 */
async function makeExportableHistory() {
  const fixture = await makeRunFixture("snack-export-");
  fixture.options.env.OPENCODE_DB = await createOpenCodeDatabase(fixture.root);
  await run(
    [
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
    ],
    fixture.options,
  );
  await run(["node", "snack", "sync", "--full"], fixture.options);
  await run(["node", "snack", "status"], fixture.options);
  fixture.stdout.value = "";
  fixture.stderr.value = "";
  return fixture;
}

test("exports one JSON document carrying every table and the provenance to read it", async () => {
  const fixture = await makeExportableHistory();

  const exitCode = await run(
    ["node", "snack", "export", "--format", "json", "--output", "-"],
    fixture.options,
  );
  const document = JSON.parse(fixture.stdout.value);

  assert.equal(exitCode, 0);
  assert.equal(document.schema_version, ENVELOPE_SCHEMA_VERSION);
  assert.equal(document.command, "export");
  assert.equal(document.status, "ok");

  // The export schema versions separately from the envelope: it becomes a frozen public
  // contract at 1.0, on its own timeline.
  // Version 2 added the client each prompt was attributed to, and the bindings that say what an
  // attribution means. A consumer written against version 1 still finds every column it read.
  assert.equal(document.data.export.export_schema_version, "2");
  assert.deepEqual(Object.keys(document.data.tables).sort(), [
    "capacity_periods",
    "prediction_evaluations",
    "predictions",
    "prompts",
    "restrictions",
    "source_bindings",
    "usage_slices",
  ]);
  assert.equal(document.data.tables.prompts.length, 1);
  assert.equal(document.data.tables.capacity_periods.length, 1);
  assert.equal(document.data.tables.predictions.length, 1);

  // Row-level versions come from the rows and describe how each record was produced.
  assert.equal(document.data.tables.prompts[0].parser_version, "opencode-session-v1");
  assert.equal(document.data.tables.predictions[0].model_policy_version, "stage5-prediction-v2");
  // Document-level provenance names the exporting build, never re-stamping the rows. Asserted
  // against the manifest rather than against a shape: the point is that the export names the build
  // that produced it, and a regular expression only ever checked that it looked like a version.
  //
  // It also has to accept a prerelease. The published schema declares `cli_version` as a plain
  // string, so `1.0.0-rc.0` is a valid document -- but a `^\d+\.\d+\.\d+$` match here failed the
  // first release candidate this repository ever built, on an assumption nothing had tested because
  // every release before it was final.
  const manifest = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));
  assert.equal(document.data.provenance.cli_version, manifest.version);
  assert.equal(document.data.provenance.envelope_schema_version, ENVELOPE_SCHEMA_VERSION);
  assert.deepEqual(document.data.provenance.plan_profiles, [
    { source: "work", id: "generic", version: "1.0.0", provenance: "bundled", as_of: "2026-01-01" },
  ]);
});

test("the streamed document is byte-identical to the envelope createEnvelope would build", async () => {
  const fixture = await makeExportableHistory();

  await run(["node", "snack", "export", "--format", "json", "--output", "-"], fixture.options);
  const streamed = JSON.parse(fixture.stdout.value);

  // The envelope is written by hand so a six-figure history never has to exist as one object
  // before it can be serialized. That hand-written skeleton can drift from output.js, and this
  // is what stops it: the assembled bytes must parse into exactly what the factory produces.
  const withoutData = (/** @type {Record<string, unknown>} */ document) =>
    Object.fromEntries(Object.entries(document).filter(([key]) => key !== "data"));
  assert.deepEqual(
    withoutData(streamed),
    withoutData(createEnvelope("export", null, { now: new Date(streamed.generated_at) })),
  );
});

test("every exported column is declared, so a later migration cannot widen an export silently", async () => {
  const fixture = await makeExportableHistory();

  await run(["node", "snack", "export", "--format", "json", "--output", "-"], fixture.options);
  const tables = JSON.parse(fixture.stdout.value).data.tables;

  // A privacy canary only catches values someone thought to plant. This catches a column that
  // a future migration adds to a table SNACK already exports.
  for (const table of EXPORT_TABLES) {
    for (const row of tables[table.name]) {
      assert.deepEqual(
        Object.keys(row).sort(),
        [...table.columns].sort(),
        `${table.name} exported unexpected columns`,
      );
    }
  }
});

test("no export carries prompt text, credentials, or local paths", async () => {
  const fixture = await makeRunFixture("snack-export-canary-");
  const openCodeDatabase = await createOpenCodeDatabase(fixture.root);
  // Plant the canaries in the source SNACK reads, so they travel the real backfill path
  // rather than being asserted against a database that never saw them.
  executeOpenCodeSql(
    openCodeDatabase,
    `UPDATE part SET data = json_set(data, '$.text', ${quote(
      `${privacyCanaries.prompt} ${privacyCanaries.response} ${privacyCanaries.credential} ${privacyCanaries.path}`,
    )});
     UPDATE session SET id = id;`,
  );
  fixture.options.env.OPENCODE_DB = openCodeDatabase;
  await run(
    [
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
    ],
    fixture.options,
  );
  await run(["node", "snack", "sync", "--full"], fixture.options);
  await run(["node", "snack", "status"], fixture.options);
  fixture.stdout.value = "";
  fixture.stderr.value = "";

  assert.equal(
    await run(["node", "snack", "export", "--format", "json", "--output", "-"], fixture.options),
    0,
  );

  // Without this the canary assertions below would also pass over an empty export, which is
  // the one way this test could look green while proving nothing.
  const document = JSON.parse(fixture.stdout.value);
  assert.equal(document.data.tables.prompts.length, 1);
  assert.equal(document.data.tables.usage_slices.length, 1);
  assert.match(await readFile(openCodeDatabase, "latin1"), /PROMPT_CANARY_DO_NOT_STORE/u);

  for (const canary of Object.values(privacyCanaries)) {
    const pattern = new RegExp(String(canary), "u");
    assert.doesNotMatch(fixture.stdout.value, pattern);
    assert.doesNotMatch(fixture.stderr.value, pattern);
  }
  // `pending_spool_observation.observation_json` is the one column where a future capture
  // schema could smuggle an unreviewed field into an export. It is never exported.
  assert.doesNotMatch(fixture.stdout.value, /observation_json/u);
});

/** @param {string} value */
function quote(value) {
  return `'${value.replaceAll("'", "''")}'`;
}

test("a JSON export to a path is written privately and summarized on stdout", async () => {
  const fixture = await makeExportableHistory();
  const target = join(fixture.root, "export.json");

  const exitCode = await run(
    ["node", "snack", "export", "--format", "json", "--output", target, "--json"],
    fixture.options,
  );
  const summary = JSON.parse(fixture.stdout.value);
  const written = JSON.parse(await readFile(target, "utf8"));

  assert.equal(exitCode, 0);
  assert.equal((await stat(target)).mode & 0o777, 0o600);
  assert.equal(summary.command, "export");
  assert.equal(summary.data.output, target);
  assert.equal(summary.data.counts.prompts, 1);
  // stdout summarizes; the document itself is the file, never both.
  assert.equal(summary.data.tables, undefined);
  assert.equal(written.data.tables.prompts.length, 1);
});

test("a CSV export writes one file per table beside a manifest", async () => {
  const fixture = await makeExportableHistory();
  const target = join(fixture.root, "csv-export");

  const exitCode = await run(
    ["node", "snack", "export", "--format", "csv", "--output", target],
    fixture.options,
  );
  const written = (await readdir(target)).sort();
  const prompts = await readFile(join(target, "prompts.csv"), "utf8");
  const manifest = JSON.parse(await readFile(join(target, "manifest.json"), "utf8"));

  assert.equal(exitCode, 0);
  assert.deepEqual(written, [
    "capacity_periods.csv",
    "manifest.json",
    "prediction_evaluations.csv",
    "predictions.csv",
    "prompts.csv",
    "restrictions.csv",
    "source_bindings.csv",
    "usage_slices.csv",
  ]);
  assert.equal((await stat(target)).mode & 0o777, 0o700);
  assert.equal((await stat(join(target, "prompts.csv"))).mode & 0o777, 0o600);
  // The header is the declared column list, so CSV and JSON carry the same records.
  const table = EXPORT_TABLES.find((candidate) => candidate.name === "prompts");
  assert.equal(prompts.split("\n")[0], table?.columns.join(","));
  assert.equal(prompts.trimEnd().split("\n").length, 2);
  assert.equal(manifest.export_schema_version, "2");
  assert.equal(manifest.provenance.plan_profiles[0].id, "generic");
});

test("CSV refuses to stream to stdout rather than emit an ambiguous join", async () => {
  const fixture = await makeExportableHistory();

  const exitCode = await run(
    ["node", "snack", "export", "--format", "csv", "--output", "-", "--json"],
    fixture.options,
  );
  const document = JSON.parse(fixture.stdout.value);

  // Six related tables cannot share one stream without either duplicating prompt columns per
  // slice or inventing a separator no CSV reader understands. Fail closed and name the fix.
  assert.equal(exitCode, 2);
  assert.equal(document.errors[0].code, "csv_stream_unsupported");
  assert.match(document.errors[0].message, /--output/u);
});

test("an unconfigured source is refused before any bytes are produced", async () => {
  const fixture = await makeExportableHistory();

  const exitCode = await run(
    [
      "node",
      "snack",
      "export",
      "--format",
      "json",
      "--output",
      "-",
      "--source",
      "absent",
      "--json",
    ],
    fixture.options,
  );

  assert.equal(exitCode, 4);
  assert.equal(JSON.parse(fixture.stdout.value).errors[0].code, "source_not_configured");
});

test("a half-open window includes its lower bound and excludes its upper bound", async () => {
  const fixture = await makeExportableHistory();
  await run(["node", "snack", "export", "--format", "json", "--output", "-"], fixture.options);
  const startedAt = JSON.parse(fixture.stdout.value).data.tables.prompts[0].started_at;
  fixture.stdout.value = "";

  await run(
    ["node", "snack", "export", "--format", "json", "--output", "-", "--since", startedAt],
    fixture.options,
  );
  const included = JSON.parse(fixture.stdout.value).data.tables.prompts;
  fixture.stdout.value = "";

  await run(
    ["node", "snack", "export", "--format", "json", "--output", "-", "--until", startedAt],
    fixture.options,
  );
  const excluded = JSON.parse(fixture.stdout.value).data.tables.prompts;

  assert.equal(included.length, 1);
  assert.equal(excluded.length, 0);
});

test("an unparseable time bound is a usage error", async () => {
  const fixture = await makeExportableHistory();

  const exitCode = await run(
    [
      "node",
      "snack",
      "export",
      "--format",
      "json",
      "--output",
      "-",
      "--since",
      "yesterday",
      "--json",
    ],
    fixture.options,
  );

  assert.equal(exitCode, 2);
  assert.equal(JSON.parse(fixture.stdout.value).errors[0].code, "export_bound_invalid");
});

test("a closed pipe ends the export quietly instead of crashing", async () => {
  const fixture = await makeExportableHistory();
  const cliEntry = fileURLToPath(new URL("../src/cli.js", import.meta.url));

  // `snack export --output - | jq ...` is the documented way to read an export. A reader that
  // stops early closes the pipe, and a streaming writer must treat that as the end of the job,
  // not as an unhandled EPIPE with a stack trace where the JSON was supposed to be.
  const { stdout, stderr, code } = await new Promise((resolve) => {
    const child = spawn(
      "sh",
      [
        "-c",
        `${JSON.stringify(process.execPath)} ${JSON.stringify(cliEntry)} export --format json --output - | head -c 200`,
      ],
      { env: { ...process.env, ...fixture.options.env, HOME: fixture.root } },
    );
    let out = "";
    let err = "";
    child.stdout.on("data", (chunk) => (out += chunk));
    child.stderr.on("data", (chunk) => (err += chunk));
    child.on("close", (status) => resolve({ stdout: out, stderr: err, code: status }));
  });

  assert.equal(code, 0);
  assert.doesNotMatch(stderr, /EPIPE/u);
  assert.doesNotMatch(stderr, /at Command|Unhandled/u);
  assert.match(stdout, /"command": "export"/u);
});

test("a CSV destination that cannot be created is an export I/O failure, not a crash", async () => {
  const fixture = await makeExportableHistory();
  const occupied = join(fixture.root, "already-a-file");
  await writeFile(occupied, "", { mode: 0o600 });

  // `--output` naming an existing file is an ordinary typo on a flag that writes a directory.
  // The JSON format already classifies every destination failure as export I/O; CSV creates its
  // directory before the first file is opened, and that step has to answer the same way.
  for (const output of [occupied, join(occupied, "nested")]) {
    fixture.stdout.value = "";
    fixture.stderr.value = "";
    const exitCode = await run(
      ["node", "snack", "export", "--format", "csv", "--output", output, "--json"],
      fixture.options,
    );

    assert.equal(exitCode, ExitCode.io, output);
    assert.equal(JSON.parse(fixture.stdout.value).errors[0].code, "export_write_error", output);
  }
});

test("a window that closes before it opens is a usage error, not an empty success", async () => {
  const fixture = await makeExportableHistory();

  for (const argv of [
    ["export", "--format", "json", "--output", "-"],
    ["data", "purge", "--all", "--yes"],
  ]) {
    fixture.stdout.value = "";
    fixture.stderr.value = "";
    const exitCode = await run(
      [
        "node",
        "snack",
        ...argv,
        "--since",
        "2026-07-31T12:00:00.000Z",
        "--until",
        "2026-07-31T06:00:00.000Z",
        "--json",
      ],
      fixture.options,
    );

    assert.equal(exitCode, ExitCode.usage, argv.join(" "));
    assert.equal(JSON.parse(fixture.stdout.value).errors[0].code, "time_window_invalid");
  }
});

test("an export that fails partway leaves no file that looks like a finished one", async () => {
  const fixture = await makeExportableHistory();
  const directory = join(fixture.root, "csv-out");
  await mkdir(directory, { recursive: true, mode: 0o700 });
  // A directory where the fourth table's staged file belongs: the first three are already
  // written when the export fails. The manifest is what makes CSVs interpretable and can only
  // be written once every row is counted, so a set without it must not survive at all.
  await mkdir(join(directory, "restrictions.csv.partial"), { recursive: true, mode: 0o700 });

  const exitCode = await run(
    ["node", "snack", "export", "--format", "csv", "--output", directory, "--json"],
    fixture.options,
  );

  assert.equal(exitCode, ExitCode.io);
  const written = await readdir(directory);
  assert.deepEqual(
    written.filter((entry) => entry.endsWith(".csv") || entry === "manifest.json"),
    [],
    written.join(", "),
  );
});
