import assert from "node:assert/strict";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { afterEach, test } from "node:test";

import Ajv2020 from "ajv/dist/2020.js";

import { ExitCode } from "../src/errors.js";
import { EXPORT_TABLES } from "../src/export.js";
import { run } from "../src/main.js";
import { ENVELOPE_SCHEMA_VERSION } from "../src/output.js";
import {
  cleanupRunFixtures,
  createClaudeHistory,
  createOpenCodeDatabase,
  makeRunFixture,
} from "./fixtures/run-fixture.js";

afterEach(cleanupRunFixtures);

/**
 * These are the surfaces PLAN.md names as public contracts at 1.0: documented commands and flags,
 * exit-code categories, JSON output schemas, and export schemas. Stage 8 is where they become
 * candidates -- executable and tested, still free to evolve until the 0.9 freeze.
 *
 * The same Ajv configuration the product validates configuration with, so a schema that would be
 * rejected there is rejected here.
 */
const ajv = new Ajv2020.default({ allErrors: true, strict: true });

/**
 * Compiled once per schema and reused: Ajv keys a compiled schema by its `$id` and refuses to
 * register the same one twice, which a per-test compile would do.
 *
 * @type {Map<string, import("ajv").ValidateFunction>}
 */
const compiled = new Map();

/** @param {string} name */
async function compileSchema(name) {
  const cached = compiled.get(name);
  if (cached) return cached;
  const schema = JSON.parse(await readFile(new URL(`../schemas/${name}`, import.meta.url), "utf8"));
  const validate = ajv.compile(schema);
  compiled.set(name, validate);
  return validate;
}

/** Every command that emits an envelope, driven exactly as a user would. */
const invocations = [
  { name: "setup-opencode", argv: ["setup", "opencode", ...setupFlags("work")] },
  { name: "setup-claude", argv: ["setup", "claude", ...setupFlags("personal")] },
  { name: "sync", argv: ["sync", "--full"] },
  { name: "stats", argv: ["stats", "--verbose"] },
  { name: "status", argv: ["status", "--no-sync"] },
  { name: "doctor", argv: ["doctor"] },
  { name: "config-get", argv: ["config", "get"] },
  { name: "config-path", argv: ["config", "path"] },
  { name: "config-set", argv: ["config", "set", "analysis.horizons", '["PT2H"]'] },
  { name: "data-purge-dry-run", argv: ["data", "purge", "--source", "work", "--dry-run"] },
];

/** @param {string} alias */
function setupFlags(alias) {
  return [
    "--non-interactive",
    "--source",
    alias,
    "--provider",
    "anthropic",
    "--profile",
    "default",
    "--plan",
    "pro",
  ];
}

/** A fixture with both clients configured, so every command has something to describe. */
async function makeConfiguredFixture() {
  const fixture = await makeRunFixture("snack-contracts-");
  fixture.options.env.OPENCODE_DB = await createOpenCodeDatabase(fixture.root);
  fixture.options.env.CLAUDE_CONFIG_DIR = await createClaudeHistory(fixture.root);
  return fixture;
}

test("every command's JSON document validates against the published envelope schema", async () => {
  const validate = await compileSchema("envelope.schema.json");
  const fixture = await makeConfiguredFixture();

  for (const invocation of invocations) {
    fixture.stdout.value = "";
    fixture.stderr.value = "";
    const exitCode = await run(["node", "snack", ...invocation.argv, "--json"], fixture.options);
    assert.equal(exitCode, 0, `${invocation.name} exited ${exitCode}: ${fixture.stderr.value}`);
    const document = JSON.parse(fixture.stdout.value);
    assert.ok(
      validate(document),
      `${invocation.name}: ${JSON.stringify(validate.errors, null, 2)}`,
    );
  }
});

test("an error document is an envelope too", async () => {
  // The failure path is the one a script is most likely to meet and least likely to be tested
  // against. An error that arrived in some other shape would break exactly the consumer that was
  // careful enough to handle errors.
  const validate = await compileSchema("envelope.schema.json");
  const fixture = await makeConfiguredFixture();
  // Configured first, so the failure under test is the one being asked for -- an alias that is not
  // there -- rather than the missing configuration that would be reported before it.
  await run(["node", "snack", "setup", "opencode", ...setupFlags("work")], fixture.options);

  fixture.stdout.value = "";
  const exitCode = await run(
    ["node", "snack", "stats", "--source", "absent", "--json"],
    fixture.options,
  );

  assert.equal(exitCode, ExitCode.unavailable);
  const document = JSON.parse(fixture.stdout.value);
  assert.ok(validate(document), JSON.stringify(validate.errors, null, 2));
  assert.equal(document.status, "error");
  assert.equal(document.errors.length, 1);
});

test("the export schema and the exported columns cannot drift apart", async () => {
  // This is what makes the schema file trustworthy without generating it: the declared columns are
  // the contract, and a column added to the exporter without being declared here fails.
  const schema = JSON.parse(
    await readFile(new URL("../schemas/export.schema.json", import.meta.url), "utf8"),
  );
  const declared = schema.properties.data.properties.tables;

  assert.deepEqual(
    Object.keys(declared.properties).sort(),
    EXPORT_TABLES.map((table) => table.name).sort(),
  );
  for (const table of EXPORT_TABLES) {
    assert.deepEqual(
      declared.properties[table.name].items.required,
      table.columns,
      `${table.name} columns drifted from the published export schema`,
    );
  }
});

test("an export validates against the published export schema", async () => {
  const validate = await compileSchema("export.schema.json");
  const fixture = await makeConfiguredFixture();
  await run(["node", "snack", "setup", "opencode", ...setupFlags("work")], fixture.options);
  await run(["node", "snack", "sync", "--full"], fixture.options);

  fixture.stdout.value = "";
  await run(["node", "snack", "export", "--format", "json", "--output", "-"], fixture.options);
  const document = JSON.parse(fixture.stdout.value);

  assert.ok(validate(document), JSON.stringify(validate.errors, null, 2));
  assert.equal(document.data.export.export_schema_version, "2");
});

/**
 * Read a captured corpus, which is the record of what a released version emitted.
 *
 * @param {string} version
 */
async function capturedDocuments(version) {
  const directory = new URL(`./fixtures/contracts/${version}/`, import.meta.url);
  const names = await readdir(directory);
  assert.ok(names.length >= 10, `only ${names.length} captured documents for ${version}`);
  return Promise.all(
    names.map(async (name) => ({
      name,
      document: JSON.parse(await readFile(new URL(name, directory), "utf8")),
    })),
  );
}

test("every command declares the frozen envelope version", async () => {
  const fixture = await makeConfiguredFixture();

  for (const invocation of invocations) {
    fixture.stdout.value = "";
    await run(["node", "snack", ...invocation.argv, "--json"], fixture.options);
    assert.equal(
      JSON.parse(fixture.stdout.value).schema_version,
      ENVELOPE_SCHEMA_VERSION,
      invocation.name,
    );
  }
  assert.equal(ENVELOPE_SCHEMA_VERSION, "2");
});

test("a document from before the freeze announces itself as version 1", async () => {
  // The freeze renamed the `config set` storage keys, which is a breaking change to a published
  // payload. The honest encoding is the one the export already uses: the old document does not
  // quietly pass as the new version, it says which version it is and fails the new schema.
  const envelope = await compileSchema("envelope.schema.json");

  for (const version of ["0.7", "0.8"]) {
    for (const { name, document } of await capturedDocuments(version)) {
      assert.equal(document.schema_version, "1", `${version} ${name}`);
      assert.equal(
        envelope(document),
        false,
        `${version} ${name} passed as version ${ENVELOPE_SCHEMA_VERSION}`,
      );
    }
  }
});

test("the envelope frame did not change beyond its version", async () => {
  // The bump is not licence to reshape the document. Every field a 0.7 or 0.8 consumer read is
  // still there, still named the same, still meaning the same -- so a captured document with only
  // its version relabelled validates. A frame change would have to be argued for on its own.
  const envelope = await compileSchema("envelope.schema.json");

  for (const version of ["0.7", "0.8"]) {
    for (const { name, document } of await capturedDocuments(version)) {
      const relabelled = { ...document, schema_version: ENVELOPE_SCHEMA_VERSION };
      assert.ok(
        envelope(relabelled),
        `${version} ${name}: ${JSON.stringify(envelope.errors, null, 2)}`,
      );
    }
  }
});

test("the export changed shape under a new version rather than under the old one", async () => {
  // The export gained the client attribution and the bindings that give it meaning, and both are
  // declared required. That is a breaking change for a consumer written against the old document,
  // and the only honest way to make it is to bump the version -- which is exactly what
  // `export_schema_version` is for.
  //
  // So the rule for the export is not "old documents still validate". It is that an old document
  // announces itself as old: the 0.7 export declares version 1, today's declares 2, and a consumer
  // reads the version before the tables. Silently adding a required table under version 1 is the
  // failure this guards against.
  const captured = JSON.parse(
    await readFile(new URL("./fixtures/contracts/0.7/export.json", import.meta.url), "utf8"),
  );
  const current = await compileSchema("export.schema.json");

  assert.equal(captured.data.export.export_schema_version, "1");
  assert.equal(current({ ...captured }), false, "a version 1 export must not pass as version 2");
  // The envelope around it is unchanged, which is the point of versioning the two separately.
  assert.equal(captured.schema_version, "1");
});

test("a configuration written by 0.7 is still accepted", async () => {
  // Configuration is one of the surfaces PLAN.md freezes at 1.0, and it is the one whose breakage
  // is worst: a rejected configuration is not a degraded answer, it is a CLI that will not run at
  // all until the user edits a file by hand. The document is lifted from what 0.7 itself reported
  // through `config get`, so it is the real shape that release wrote rather than one reconstructed
  // from today's assumptions.
  const captured = JSON.parse(
    await readFile(new URL("./fixtures/contracts/0.7/config-get.json", import.meta.url), "utf8"),
  );
  const fixture = await makeConfiguredFixture();
  const asWritten = JSON.stringify(captured.data.value).replaceAll("{{root}}", fixture.root);
  await mkdir(dirname(fixture.paths.configFile), { recursive: true, mode: 0o700 });
  await writeFile(fixture.paths.configFile, `${asWritten}\n`, { mode: 0o600 });

  fixture.stdout.value = "";
  const exitCode = await run(["node", "snack", "config", "get", "--json"], fixture.options);

  assert.equal(exitCode, 0, fixture.stderr.value);
  // Accepted and unchanged: a configuration silently rewritten on read is its own kind of break.
  assert.deepEqual(JSON.parse(fixture.stdout.value).data.value, JSON.parse(asWritten));
});

test("a configuration naming a client SNACK does not know is refused", async () => {
  // Guards the test above against passing for the wrong reason. If configuration validation were
  // off, or the schema had been loosened to make the 0.7 document fit, this would be accepted too
  // -- and an unknown adapter is exactly what must fail closed rather than be guessed at.
  const captured = JSON.parse(
    await readFile(new URL("./fixtures/contracts/0.7/config-get.json", import.meta.url), "utf8"),
  );
  const fixture = await makeConfiguredFixture();
  const tampered = JSON.stringify(captured.data.value)
    .replaceAll("{{root}}", fixture.root)
    .replace('"adapter": "opencode"', '"adapter": "sardine-cli"')
    .replace('"adapter":"opencode"', '"adapter":"sardine-cli"');
  await mkdir(dirname(fixture.paths.configFile), { recursive: true, mode: 0o700 });
  await writeFile(fixture.paths.configFile, `${tampered}\n`, { mode: 0o600 });

  fixture.stdout.value = "";
  const exitCode = await run(["node", "snack", "config", "get", "--json"], fixture.options);

  assert.equal(exitCode, ExitCode.config);
});

test("the published exit codes have not changed", () => {
  // Exit-code categories are a public contract at 1.0, and a script reading them cannot be
  // rewritten by a release note. Asserted against literals rather than against the map itself,
  // which would pass for any value the map happened to hold.
  assert.deepEqual(
    { ...ExitCode },
    { success: 0, usage: 2, config: 3, unavailable: 4, storage: 5, io: 6, internal: 10 },
  );
});

test("the published command and flag surface has not changed", async () => {
  // A flag removed or renamed breaks every script that used it, and is exactly the change nobody
  // notices making. Listed as literals so the diff shows what moved.
  const fixture = await makeRunFixture("snack-contracts-surface-");
  const surface = await commandSurface(fixture);

  assert.deepEqual(surface, {
    snack: ["--version", "--json", "--help"],
    "config get": ["--json", "--help"],
    "config path": ["--json", "--help"],
    "config set": ["--json", "--help"],
    "data purge": [
      "--source",
      "--all",
      "--since",
      "--until",
      "--include-config",
      "--prevent-reimport",
      "--dry-run",
      "--yes",
      "--json",
      "--help",
    ],
    doctor: ["--source", "--json", "--help"],
    export: ["--format", "--output", "--source", "--since", "--until", "--json", "--help"],
    "setup claude": [
      "--non-interactive",
      "--source",
      "--provider",
      "--profile",
      "--plan",
      "--plan-profile",
      "--dry-run",
      "--enable-prospective-analysis",
      "--json",
      "--help",
    ],
    "setup opencode": [
      "--non-interactive",
      "--source",
      "--provider",
      "--profile",
      "--plan",
      "--plan-profile",
      "--dry-run",
      "--install-plugin",
      "--yes",
      "--enable-prospective-analysis",
      "--json",
      "--help",
    ],
    stats: ["--source", "--horizon", "--verbose", "--by-client", "--json", "--help"],
    status: ["--source", "--no-sync", "--prompt-file", "--json", "--help"],
    sync: ["--source", "--full", "--json", "--help"],
  });
});

/**
 * Read the commands and flags out of the help text, which is the surface a user is actually
 * promised. Reading them out of Commander instead would test the object graph rather than the
 * contract, and would still pass if the help stopped mentioning a flag entirely.
 *
 * @param {Awaited<ReturnType<typeof makeRunFixture>>} fixture
 */
async function commandSurface(fixture) {
  /** @param {string[]} argv */
  const help = async (argv) => {
    fixture.stdout.value = "";
    fixture.stderr.value = "";
    await run(["node", "snack", ...argv, "--help"], fixture.options);
    return `${fixture.stdout.value}${fixture.stderr.value}`;
  };
  /** @param {string} text */
  const flagsIn = (text) => {
    const options = text.split(/^Options:$/mu)[1]?.split(/^Commands:$/mu)[0] ?? "";
    return [...options.matchAll(/^\s+(?:-\w, )?(--[a-z-]+)/gmu)].map((match) => String(match[1]));
  };
  /** @param {string} text */
  const commandsIn = (text) => {
    const listed = text.split(/^Commands:$/mu)[1] ?? "";
    return [...listed.matchAll(/^ {2}(\w[\w-]*)/gmu)].map((match) => String(match[1]));
  };

  const root = await help([]);
  /** @type {Record<string, string[]>} */
  const surface = { snack: flagsIn(root) };
  for (const command of commandsIn(root)) {
    if (command === "help") continue;
    const text = await help([command]);
    const children = commandsIn(text);
    if (children.length === 0) {
      surface[command] = flagsIn(text);
      continue;
    }
    for (const child of children) {
      if (child === "help") continue;
      surface[`${command} ${child}`] = flagsIn(await help([command, child]));
    }
  }
  return Object.fromEntries(
    Object.entries(surface).sort(([left], [right]) => (left < right ? -1 : 1)),
  );
}

test("both packages ship a byte-identical spool event schema", async () => {
  // The spool is the boundary between two packages that version independently, so the schema is
  // duplicated on purpose -- each ships its own copy. Duplicated on purpose still has to mean
  // identical, or the capture plugin and the reader disagree about what a valid event is.
  const cli = await readFile(new URL("../schemas/spool-event.schema.json", import.meta.url));
  const plugin = await readFile(
    new URL("../../opencode/schemas/spool-event.schema.json", import.meta.url),
  );

  assert.equal(cli.equals(plugin), true, "the two spool schemas have drifted apart");
});

test("the packaged files carry every published schema", async () => {
  // A schema that does not ship is a contract nobody downstream can check against.
  const packageJson = JSON.parse(
    await readFile(new URL("../package.json", import.meta.url), "utf8"),
  );
  const schemas = await readdir(new URL("../schemas/", import.meta.url));

  assert.ok(packageJson.files.includes("schemas"), packageJson.files.join(", "));
  assert.deepEqual(schemas.sort(), [
    "config.schema.json",
    "envelope.schema.json",
    "export.schema.json",
    "plan-profile.schema.json",
    "spool-event.schema.json",
  ]);
});
