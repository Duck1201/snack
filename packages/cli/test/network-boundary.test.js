import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { connect } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, test } from "node:test";

import { run } from "../src/main.js";
import {
  cleanupRunFixtures,
  createClaudeHistory,
  createOpenCodeDatabase,
  denyNetwork,
  makeRunFixture,
} from "./fixtures/run-fixture.js";

afterEach(cleanupRunFixtures);

/**
 * Every command SNACK documents, except `update`, driven against a real configured installation.
 *
 * ADR-0010 names them one by one, and so does this: a list derived from the program would grow a
 * new command silently, which is the case this test exists for.
 */
const localOnlyCommands = [
  ["sync", "--full"],
  ["sync"],
  ["status"],
  ["status", "--no-sync"],
  ["stats"],
  ["stats", "--verbose"],
  ["stats", "--by-client"],
  ["doctor"],
  ["config", "path"],
  ["config", "get", "sources"],
  ["data", "purge", "--source", "work", "--dry-run"],
];

test("no command except update touches the network", async () => {
  // Until ADR-0010, "no command opens a socket" was structural and needed no assertion. It stops
  // being structural the moment one command may install packages, so the boundary becomes a gate:
  // a future `status` that quietly checks for a new version fails here rather than in the wild.
  const fixture = await makeRunFixture("snack-network-");
  fixture.options.env.OPENCODE_DB = await createOpenCodeDatabase(fixture.root);
  fixture.options.env.CLAUDE_CONFIG_DIR = await createClaudeHistory(fixture.root);

  const denied = denyNetwork();
  try {
    // Setup runs inside the denial too: it registers a plugin specifier that OpenCode resolves
    // later, and ADR-0010 keeps "setup performs no package fetch itself" true.
    for (const [client, alias] of [
      ["opencode", "work"],
      ["claude", "personal"],
    ]) {
      await run(
        [
          "node",
          "snack",
          "setup",
          String(client),
          "--non-interactive",
          "--source",
          String(alias),
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
      assert.deepEqual(denied.attempts, [], `setup ${client} reached for the network`);
    }

    for (const argv of localOnlyCommands) {
      fixture.stdout.value = "";
      fixture.stderr.value = "";
      await run(["node", "snack", ...argv], fixture.options);
      assert.deepEqual(denied.attempts, [], `snack ${argv.join(" ")} reached for the network`);
    }

    fixture.stdout.value = "";
    await run(
      ["node", "snack", "export", "--format", "json", "--output", join(fixture.root, "out.json")],
      fixture.options,
    );
    assert.deepEqual(denied.attempts, [], "export reached for the network");
  } finally {
    denied.restore();
  }
});

test("the denial is real, so a green run above means something", async () => {
  // A gate that cannot fail proves nothing. This is the control: the same stubs, deliberately
  // tripped, showing they record and refuse rather than silently allowing the connection.
  const denied = denyNetwork();
  try {
    await assert.rejects(globalThis.fetch("https://registry.npmjs.org/@snack-ai/cli"));
    // The socket patch is the one that matters: `http`, `https`, `tls` and `fetch` all arrive
    // here, so a control that only trips `fetch` would leave the broad case unproven.
    assert.throws(() => connect(443, "registry.npmjs.org"));
    assert.deepEqual(
      denied.attempts.map((attempt) => attempt.split("(")[0]),
      ["fetch", "net.Socket.connect"],
    );
  } finally {
    denied.restore();
  }
});

/**
 * Every builtin that can open a connection. `dns` is here because resolving a name is already
 * reaching out, and `http2` and `dgram` because a boundary that lists only the obvious three is
 * a boundary someone routes around by accident.
 */
const NETWORKING_BUILTINS = new Set(
  ["net", "http", "https", "http2", "tls", "dns", "dns/promises", "dgram"].flatMap((name) => [
    name,
    `node:${name}`,
  ]),
);

/**
 * Every module reachable from `entry` by following relative imports, mapped to what it imports.
 *
 * Deliberately a text walk rather than a resolver: what is being asserted is what the source says,
 * and a module that is never executed is exactly the case the runtime denial cannot see.
 *
 * @param {string} entry
 * @returns {Promise<Map<string, string[]>>}
 */
async function importGraph(entry) {
  /** @type {Map<string, string[]>} */
  const graph = new Map();
  const queue = [entry];
  while (queue.length > 0) {
    const file = queue.pop();
    if (file === undefined || graph.has(file)) continue;
    const source = await readFile(file, "utf8");
    // `createRequire(...)("x")` counts as an edge. `spool.js` loads Ajv that way so a command that
    // reads no spool event never pays to compile the schema, and a walk that only read `import`
    // would stop seeing whatever a module pulls in through it -- which is the half of this file's
    // guarantee that covers code the tests never execute.
    const specifiers = [
      ...source.matchAll(
        /(?:\bfrom|\bimport)\s*\(?\s*["']([^"']+)["']|\bcreateRequire\s*\([^)]*\)\s*\(\s*["']([^"']+)["']/gu,
      ),
    ].map((match) => /** @type {string} */ (match[1] ?? match[2]));
    graph.set(file, specifiers);
    for (const specifier of specifiers) {
      if (specifier.startsWith(".")) queue.push(resolve(dirname(file), specifier));
    }
  }
  return graph;
}

/** @param {Map<string, string[]>} graph */
const networkingImports = (graph) =>
  [...graph]
    .flatMap(([file, specifiers]) =>
      specifiers.map((specifier) => /** @type {const} */ ([file, specifier])),
    )
    .filter(([, specifier]) => NETWORKING_BUILTINS.has(specifier))
    .map(([file, specifier]) => `${file} imports ${specifier}`);

test("no module SNACK ships imports a networking builtin", async () => {
  // The complement to the runtime denial above, which proves the paths its commands exercise and
  // says nothing about the paths they do not. This one reads the source instead, so a module that
  // never runs under test is still covered -- and a `status` that grows a version check three
  // releases from now fails here even if nothing calls it yet.
  //
  // The exception list is empty, which surprised the note that asked for this test. `update` is
  // allowed to reach the network under ADR-0010, and it does it by spawning the package manager;
  // it opens nothing itself. So the rule this file asserts is the simpler one: nothing in the
  // shipped source opens a socket, and the one command that installs packages delegates that.
  //
  // What it cannot see is a dependency. That is the half the runtime denial covers, and neither
  // is complete alone.
  const graph = await importGraph(fileURLToPath(new URL("../src/cli.js", import.meta.url)));

  assert.deepEqual(networkingImports(graph), []);
  // A walk that read one file and stopped would pass the assertion above without proving anything.
  assert.ok(graph.size > 20, `the walk reached ${graph.size} modules`);
  assert.ok(
    [...graph.keys()].some((file) => file.endsWith("update.js")),
    "the walk never reached the one command that may reach the network",
  );
});

test("the import walk finds a networking builtin behind a relative hop", async () => {
  // The control for the walk. Without it a regex that matches nothing passes forever.
  const root = await mkdtemp(join(tmpdir(), "snack-import-graph-"));
  try {
    await writeFile(join(root, "entry.js"), 'import { thing } from "./deep.js";\nthing();\n');
    await writeFile(
      join(root, "deep.js"),
      'import https from "node:https";\nexport const thing = () => https;\n',
    );

    const graph = await importGraph(join(root, "entry.js"));

    assert.equal(graph.size, 2);
    assert.deepEqual(networkingImports(graph), [`${join(root, "deep.js")} imports node:https`]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("the import walk finds a networking builtin loaded through createRequire", async () => {
  // The second control, for the second kind of edge. `createRequire` is invisible to an `import`
  // regex, so a module could reach a socket through it and the walk above would report nothing --
  // which is worse than not having the walk, because it reads as a clean bill of health.
  const root = await mkdtemp(join(tmpdir(), "snack-import-graph-require-"));
  try {
    await writeFile(join(root, "entry.js"), 'import { thing } from "./deep.js";\nthing();\n');
    await writeFile(
      join(root, "deep.js"),
      [
        'import { createRequire } from "node:module";',
        'export const thing = () => createRequire(import.meta.url)("node:https");',
      ].join("\n"),
    );

    const graph = await importGraph(join(root, "entry.js"));

    assert.deepEqual(networkingImports(graph), [`${join(root, "deep.js")} imports node:https`]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
