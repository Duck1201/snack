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
async function readSchema(name) {
  return JSON.parse(await readFile(new URL(`../schemas/${name}`, import.meta.url), "utf8"));
}

/**
 * The envelope routes each command to its payload schema by `$id`, so every command schema has to
 * be known to Ajv before the envelope compiles. Registered once, for the same reason the compiled
 * validators are cached: Ajv keys a schema by its `$id` and refuses to see the same one twice.
 */
let registered = false;
async function registerCommandSchemas() {
  if (registered) return;
  registered = true;
  for (const name of await readdir(new URL("../schemas/commands/", import.meta.url))) {
    ajv.addSchema(await readSchema(`commands/${name}`));
  }
}

/** @param {string} name */
async function compileSchema(name) {
  const cached = compiled.get(name);
  if (cached) return cached;
  await registerCommandSchemas();
  const schema = await readSchema(name);
  const validate = ajv.getSchema(schema.$id) ?? ajv.compile(schema);
  compiled.set(name, validate);
  return validate;
}

/**
 * Every command that emits an envelope, driven exactly as a user would. `command` is the string the
 * envelope carries, which is what the payload schemas are named and routed by; `name` is only how
 * the captured fixture is filed.
 */
const invocations = [
  {
    name: "setup-opencode",
    command: "setup opencode",
    argv: ["setup", "opencode", ...setupFlags("work")],
  },
  {
    name: "setup-claude",
    command: "setup claude",
    argv: ["setup", "claude", ...setupFlags("personal")],
  },
  { name: "sync", command: "sync", argv: ["sync", "--full"] },
  { name: "stats", command: "stats", argv: ["stats", "--verbose"] },
  { name: "status", command: "status", argv: ["status", "--no-sync"] },
  { name: "doctor", command: "doctor", argv: ["doctor"] },
  { name: "config-get", command: "config get", argv: ["config", "get"] },
  { name: "config-path", command: "config path", argv: ["config", "path"] },
  {
    name: "config-set",
    command: "config set",
    argv: ["config", "set", "analysis.horizons", '["PT2H"]'],
  },
  {
    name: "data-purge-dry-run",
    command: "data purge",
    argv: ["data", "purge", "--source", "work", "--dry-run"],
  },
  // `--dry-run`, so the payload is produced without a package manager anywhere near it. The layout
  // it resolves comes from the injected `modulePath` below: a workspace checkout is not an
  // installation and correctly refuses, which would make this invocation exit 4.
  { name: "update-dry-run", command: "update", argv: ["update", "--dry-run"] },
];

/** The published payload schema for a command, named by the command the envelope reports. */
const payloadSchemaFor = (/** @type {string} */ command) =>
  `${command.replaceAll(" ", "-")}.schema.json`;

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
  fixture.options.modulePath = "/usr/local/lib/node_modules/@snack-ai/cli/src/update.js";
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
  const schema = await readSchema("export.schema.json");
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
 * Every released version whose documents were captured while the tree still matched its tag. `0.6`
 * is the migration floor `docs/compatibility.md` declares, so it is the oldest corpus the freeze
 * has to answer for.
 *
 * Split at the freeze, because the two halves answer different questions. A pre-freeze document
 * declares envelope version 1 and must fail today's schema; a post-freeze one declares the current
 * version and must still pass it, unchanged. Stage 10 confirms the freeze rather than redefining
 * it, and this is that sentence written as a test.
 */
const PRE_FREEZE_VERSIONS = ["0.6", "0.7", "0.8"];
const FROZEN_VERSIONS = ["0.9"];
const CAPTURED_VERSIONS = [...PRE_FREEZE_VERSIONS, ...FROZEN_VERSIONS];

/**
 * Read a captured corpus, which is the record of what a released version emitted.
 *
 * @param {string} version
 */
async function capturedDocuments(version) {
  const directory = new URL(`./fixtures/contracts/${version}/`, import.meta.url);
  const names = await readdir(directory);
  // 0.6 predates the Claude client, so its corpus is one document shorter than the ones after it.
  assert.ok(names.length >= 10, `only ${names.length} captured documents for ${version}`);
  return Promise.all(
    names.map(async (name) => ({
      name,
      document: JSON.parse(await readFile(new URL(name, directory), "utf8")),
    })),
  );
}

/**
 * Every top-level property name a payload schema declares, gathered across the `oneOf` branches and
 * `$defs` it is written with. The union rather than one branch: `status` and `stats` answer with a
 * single report or with one per source, and both spellings are the same contract.
 *
 * @param {Record<string, unknown>} schema
 * @returns {Set<string>}
 */
function declaredProperties(schema) {
  /** @type {Set<string>} */
  const names = new Set();
  /** @param {unknown} node */
  const walk = (node) => {
    if (typeof node !== "object" || node === null) return;
    const { properties, oneOf, $defs } = /** @type {Record<string, unknown>} */ (node);
    if (typeof properties === "object" && properties !== null) {
      for (const name of Object.keys(properties)) names.add(name);
    }
    if (Array.isArray(oneOf)) for (const branch of oneOf) walk(branch);
    if (typeof $defs === "object" && $defs !== null) {
      for (const definition of Object.values($defs)) walk(definition);
    }
  };
  walk(schema);
  return names;
}

test("every payload declares each field it emits", async () => {
  // The other half of the freeze, and the half a validator cannot give. The published schemas stay
  // permissive about extra fields on purpose: a consumer pinned to 0.9.0 must survive a field a
  // later minor adds, so `additionalProperties: false` would break exactly the consumer the
  // compatibility policy promises to protect. The guard against a field entering the contract
  // unnoticed is therefore this test, not the validator -- the same trick that makes the
  // hand-written export schema trustworthy without generating it.
  const fixture = await makeConfiguredFixture();

  for (const invocation of invocations) {
    const schema = await readSchema(`commands/${payloadSchemaFor(invocation.command)}`);
    const declared = declaredProperties(schema);
    fixture.stdout.value = "";
    await run(["node", "snack", ...invocation.argv, "--json"], fixture.options);
    const { data } = JSON.parse(fixture.stdout.value);

    // `status` and `stats` answer with one report or with one per source under `sources`, and the
    // schema says so by being a `oneOf`. There the keys to check are the report's own. Everywhere
    // else `sources` is an ordinary property and the payload is what it looks like.
    const payloads = schema.oneOf && Array.isArray(data?.sources) ? data.sources : [data];
    for (const payload of payloads) {
      for (const key of Object.keys(payload ?? {})) {
        assert.ok(
          declared.has(key),
          `${invocation.command} emits ${key}, which its published schema never declares`,
        );
      }
    }
  }
});

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

  for (const version of PRE_FREEZE_VERSIONS) {
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

test("the freeze broke exactly one payload and left every other document alone", async () => {
  // The bump is not licence to reshape everything under cover of one break. Relabelling a captured
  // document with the new version is the question "would this still be valid today?", and the
  // answer has to be yes for every command except the one deliberately changed -- `config set`,
  // whose storage keys moved to snake_case. Any other name on this list is an unintended break.
  const envelope = await compileSchema("envelope.schema.json");
  /** @type {string[]} */
  const broken = [];

  for (const version of PRE_FREEZE_VERSIONS) {
    for (const { name, document } of await capturedDocuments(version)) {
      const relabelled = { ...document, schema_version: ENVELOPE_SCHEMA_VERSION };
      if (!envelope(relabelled)) broken.push(`${version}/${name}`);
    }
  }

  assert.deepEqual(broken, ["0.6/config-set.json", "0.7/config-set.json", "0.8/config-set.json"]);
});

test("a document captured after the freeze still validates, unchanged", async () => {
  // The freeze's whole claim, and the one Stage 10 exists to confirm: a consumer written against a
  // frozen release keeps working. Not relabelled, unlike the test above -- these documents already
  // declare the current version, so there is nothing to relabel and no intended break to name. An
  // empty list is the assertion, and any name appearing on it resets Stage 9.
  const envelope = await compileSchema("envelope.schema.json");
  const exported = await compileSchema("export.schema.json");
  /** @type {string[]} */
  const broken = [];

  for (const version of FROZEN_VERSIONS) {
    for (const { name, document } of await capturedDocuments(version)) {
      assert.equal(document.schema_version, ENVELOPE_SCHEMA_VERSION, `${version}/${name}`);
      const validate = name === "export.json" ? exported : envelope;
      if (!validate(document)) broken.push(`${version}/${name}`);
    }
  }

  assert.deepEqual(broken, []);
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

test("a configuration written by any supported release is still accepted", async () => {
  // Configuration is one of the surfaces PLAN.md freezes at 1.0, and it is the one whose breakage
  // is worst: a rejected configuration is not a degraded answer, it is a CLI that will not run at
  // all until the user edits a file by hand. Each document is lifted from what that release itself
  // reported through `config get`, so it is the real shape it wrote rather than one reconstructed
  // from today's assumptions.
  //
  // 0.6 is here because `docs/compatibility.md` names it the migration floor, and a floor the
  // configuration reader cannot actually read is not a floor. As of the freeze the three documents
  // happen to have the same shape, so this discovers nothing today; it exists for the release where
  // they stop coinciding, which is the release nobody will notice by hand.
  for (const version of CAPTURED_VERSIONS) {
    const captured = JSON.parse(
      await readFile(
        new URL(`./fixtures/contracts/${version}/config-get.json`, import.meta.url),
        "utf8",
      ),
    );
    const fixture = await makeConfiguredFixture();
    const asWritten = JSON.stringify(captured.data.value).replaceAll("{{root}}", fixture.root);
    await mkdir(dirname(fixture.paths.configFile), { recursive: true, mode: 0o700 });
    await writeFile(fixture.paths.configFile, `${asWritten}\n`, { mode: 0o600 });

    fixture.stdout.value = "";
    const exitCode = await run(["node", "snack", "config", "get", "--json"], fixture.options);

    assert.equal(exitCode, 0, `${version}: ${fixture.stderr.value}`);
    // Accepted and unchanged: a configuration silently rewritten on read is its own kind of break.
    assert.deepEqual(JSON.parse(fixture.stdout.value).data.value, JSON.parse(asWritten), version);
  }
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
    // `--finish` is deliberately absent: it is internal, hidden from help, and therefore invisible
    // to this test, which reads the help text rather than Commander's object graph. The test below
    // is what holds it to that.
    update: ["--yes", "--dry-run", "--json", "--help"],
  });
});

test("update --finish stays out of the help, because it is not a flag anyone should type", async () => {
  // It exists because a process cannot become a different version of itself, not because a user has
  // a reason to run it. Documenting it in the help would invite exactly the half-applied upgrade
  // -- a re-registration without an install -- that the two-process design exists to prevent.
  const fixture = await makeRunFixture("snack-contracts-finish-");

  await run(["node", "snack", "update", "--help"], fixture.options);

  assert.doesNotMatch(fixture.stdout.value, /--finish/u);
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

test("both packages test against a byte-identical set of privacy canaries", async () => {
  // Duplicated for the same reason the spool schema is: neither package may reach into the other's
  // tests. Duplicated on purpose still has to mean identical, or the two come to disagree about
  // what a leak is -- and a canary the plugin stopped planting is a leak nobody is looking for.
  const cli = await readFile(new URL("./fixtures/privacy-canaries.json", import.meta.url));
  const plugin = await readFile(
    new URL("../../opencode/test/privacy-canaries.json", import.meta.url),
  );

  assert.equal(cli.equals(plugin), true, "the two canary sets have drifted apart");
});

test("the published support matrix names families the adapters actually read", async () => {
  // The support matrix is a release artifact, not commentary: `check-release-readiness.mjs` already
  // blocks a release whose matrix says its own validation is unfinished. This is the other half --
  // a matrix that names a schema family no adapter reads is a promise about what SNACK ingests that
  // nothing in the product keeps. Cheap to assert, and the alternative is noticing by hand at the
  // one moment nobody is looking, which is the release.
  // Matched by the client's own prefix rather than by which document a name appears in: the
  // family-support policy is published once, in the OpenCode document, and names both clients'
  // families. A first version of this test scanned each document for every prefix and failed on
  // that shared table, which is the table doing its job.
  for (const [prefix, adapter] of [
    ["oc", "opencode-adapter.js"],
    ["cc", "claude-adapter.js"],
  ]) {
    const source = await readFile(new URL(`../src/${adapter}`, import.meta.url), "utf8");
    /** @type {Set<string>} */
    const families = new Set();
    for (const document of ["opencode-support.md", "claude-support.md", "compatibility.md"]) {
      const matrix = await readFile(new URL(`../../../docs/${document}`, import.meta.url), "utf8");
      for (const quoted of matrix.match(new RegExp(`\`${prefix}-[a-z0-9-]+-v\\d+\``, "gu")) ?? []) {
        families.add(quoted.replaceAll("`", ""));
      }
    }

    assert.ok(families.size > 0, `the published documents name no ${prefix} schema family at all`);
    for (const family of families) {
      assert.ok(source.includes(family), `the docs promise ${family}, ${adapter} never reads it`);
    }
  }
});

test("the packaged files carry every published schema", async () => {
  // A schema that does not ship is a contract nobody downstream can check against.
  const packageJson = JSON.parse(
    await readFile(new URL("../package.json", import.meta.url), "utf8"),
  );
  const schemas = await readdir(new URL("../schemas/", import.meta.url));

  assert.ok(packageJson.files.includes("schemas"), packageJson.files.join(", "));
  assert.deepEqual(schemas.sort(), [
    "commands",
    "config.schema.json",
    "envelope.schema.json",
    "export.schema.json",
    "plan-profile.schema.json",
    "spool-event.schema.json",
  ]);
});

test("every command that publishes a payload publishes a schema for it", async () => {
  // Derived from the command list rather than from the directory, or it would prove only that the
  // directory contains what it contains. A command added without a payload schema is a payload
  // outside the freeze. `export` is absent because its whole document, not just its `data`, already
  // has a published schema of its own.
  const published = await readdir(new URL("../schemas/commands/", import.meta.url));

  assert.deepEqual(
    published.sort(),
    invocations.map((invocation) => payloadSchemaFor(invocation.command)).sort(),
  );
});
