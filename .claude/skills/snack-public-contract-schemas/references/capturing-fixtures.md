# Capturing a released version's JSON documents

Load this when you are on step 2 of the skill. It is the script that produces
`packages/cli/test/fixtures/contracts/<version>/`, plus the two traps that each cost a run.

## Where to put it and how to run it

Put the script anywhere, but **run it with `packages/cli` as the working directory**, or use
absolute paths in its imports. Module resolution starts at the _script's_ location, so a script
sitting in a scratch directory fails twice over:

```
Error [ERR_MODULE_NOT_FOUND]: Cannot find module '<scratch>/src/main.js'
Error [ERR_MODULE_NOT_FOUND]: Cannot find package 'better-sqlite3'
```

The second one bites even after you fix the relative imports, because `better-sqlite3` resolves from
`node_modules` upward from the script. Either `cd packages/cli` first, or copy the script into
`packages/cli/` for the one run and delete it afterwards.

## The script

```js
// One-off: capture the JSON documents a released version produces, so a later release can be
// tested against them. Run while the tree is byte-identical to that release's tag.
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

const packageRoot = "/absolute/path/to/packages/cli";
const version = "0.7";

const { run } = await import(join(packageRoot, "src/main.js"));
const { cleanupRunFixtures, createClaudeHistory, createOpenCodeDatabase, makeRunFixture } =
  await import(join(packageRoot, "test/fixtures/run-fixture.js"));

const outputDirectory = join(packageRoot, `test/fixtures/contracts/${version}`);
await mkdir(outputDirectory, { recursive: true });

const fixture = await makeRunFixture("snack-capture-");
fixture.options.env.OPENCODE_DB = await createOpenCodeDatabase(fixture.root);
fixture.options.env.CLAUDE_CONFIG_DIR = await createClaudeHistory(fixture.root);

/** @param {string} alias */
const setupFlags = (client, alias) => [
  "setup",
  client,
  "--non-interactive",
  "--source",
  alias,
  "--provider",
  "anthropic",
  "--profile",
  "default",
  "--plan",
  "pro",
  "--json",
];

const invocations = [
  { name: "setup-opencode", argv: setupFlags("opencode", "work") },
  { name: "setup-claude", argv: setupFlags("claude", "personal") },
  { name: "sync", argv: ["sync", "--full", "--json"] },
  { name: "stats", argv: ["stats", "--verbose", "--json"] },
  { name: "status", argv: ["status", "--no-sync", "--json"] },
  { name: "doctor", argv: ["doctor", "--json"] },
  { name: "config-get", argv: ["config", "get", "--json"] },
  { name: "config-path", argv: ["config", "path", "--json"] },
  { name: "config-set", argv: ["config", "set", "analysis.horizons", '["PT2H"]', "--json"] },
  {
    name: "data-purge-dry-run",
    argv: ["data", "purge", "--source", "work", "--dry-run", "--json"],
  },
  { name: "export", argv: ["export", "--format", "json", "--output", "-"] },
];

for (const invocation of invocations) {
  fixture.stdout.value = "";
  fixture.stderr.value = "";
  const code = await run(["node", "snack", ...invocation.argv], fixture.options);
  if (code !== 0) throw new Error(`${invocation.name} exited ${code}: ${fixture.stderr.value}`);
  // The fixture root is a temporary directory that differs on every machine, and a committed
  // fixture must not carry one developer's paths.
  const redacted = fixture.stdout.value.replaceAll(fixture.root, "{{root}}");
  await writeFile(join(outputDirectory, `${invocation.name}.json`), redacted);
  console.log(`captured ${invocation.name}`);
}

await cleanupRunFixtures();
```

## Traps

- **Order matters.** `setup` before `sync` before `stats`/`status`/`export`. The loop is sequential
  on one fixture on purpose: each command builds the state the next one describes.
- **`config set` needs a real key.** `analysis.horizon` does not exist — the key is
  `analysis.horizons` and the value is a JSON array string, `'["PT2H"]'`. A wrong key exits `3`
  (config) and, because the script throws on a non-zero exit, aborts the capture with the earlier
  documents already written. Delete the directory and re-run rather than filling the gap by hand.
- **`export` takes no `--json`.** It is always a JSON document when `--format json`; passing
  `--json` is a usage error.
- **`makeRunFixture` injects `now`**, so `generated_at` is stable across captures. Do not replace it
  with the real clock or every recapture produces a spurious diff.
- **Two clients, two aliases.** Capturing `setup claude` onto the same alias as `setup opencode`
  changes what `stats` and `export` describe. Use separate aliases unless the shared-source case is
  specifically what you want recorded.

## After capture

```bash
grep -rl "/tmp/" packages/cli/test/fixtures/contracts/   # must print nothing
ls packages/cli/test/fixtures/contracts/0.7/             # 11 documents
```

`contracts.test.js` asserts at least 10 captured documents, so a capture that aborted halfway fails
loudly rather than quietly testing less than it claims.
