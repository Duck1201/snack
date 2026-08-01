import assert from "node:assert/strict";
import { connect } from "node:net";
import { join } from "node:path";
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
