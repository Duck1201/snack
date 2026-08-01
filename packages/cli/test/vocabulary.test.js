import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, test } from "node:test";

import { run } from "../src/main.js";
import {
  cleanupRunFixtures,
  createOpenCodeDatabase,
  makeRunFixture,
} from "./fixtures/run-fixture.js";

afterEach(cleanupRunFixtures);

/**
 * Acceptance criterion 15: no interface calls observed usage a quota percentage or a remaining
 * balance. The vocabulary comes from the _Avoid_ lists in CONTEXT.md and from PLAN.md's rule that
 * SNACK never says "% of quota" or "N prompts remaining". Each pattern is a claim about the
 * provider's real capacity, which SNACK cannot observe and must never imply.
 */
const forbidden = [
  { label: "quota", pattern: /\bquotas?\b/iu },
  { label: "balance", pattern: /\bbalances?\b/iu },
  {
    label: "remaining or left capacity",
    pattern: /\b(?:prompts?|capacity|usage)\s+(?:remaining|left)\b/iu,
  },
  { label: "remaining prompts", pattern: /\bremaining\s+(?:prompts?|capacity|usage)\b/iu },
  { label: "percentage used or consumed", pattern: /\bper\s?cent(?:age)?\s+(?:used|consumed)\b/iu },
  { label: "capacity percentage", pattern: /\bcapacity\s+per\s?cent(?:age)?\b/iu },
  { label: "utilization", pattern: /\butili[sz]ation\b/iu },
];

test("no command calls observed usage a quota percentage or a remaining balance", async () => {
  const fixture = await makeRunFixture("snack-vocabulary-");
  fixture.options.env.OPENCODE_DB = await createOpenCodeDatabase(fixture.root);

  /** @type {string[][]} */
  const invocations = [
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
    ["stats", "--verbose"],
    ["doctor"],
    ["config", "get"],
    ["config", "path"],
    ["export", "--format", "json", "--output", "-"],
    ["data", "purge", "--source", "work", "--dry-run"],
    // An unconfigured source is the error surface, which is UI too.
    ["stats", "--source", "absent"],
  ];

  /** @type {{argv: string[], json: boolean, text: string}[]} */
  const outputs = [];
  for (const argv of invocations) {
    for (const json of [false, true]) {
      fixture.stdout.value = "";
      fixture.stderr.value = "";
      await run(["node", "snack", ...argv, ...(json ? ["--json"] : [])], fixture.options);
      outputs.push({
        argv,
        json,
        text: `${fixture.stdout.value}\n${fixture.stderr.value}`,
      });
    }
  }

  // Guard against a vacuous pass: the commands must really have produced the usage vocabulary
  // this test is policing the boundary of.
  const transcript = outputs.map((output) => output.text).join("\n");
  assert.match(transcript, /usage pressure/iu);
  assert.match(transcript, /viability/iu);

  for (const output of outputs) {
    for (const term of forbidden) {
      assert.doesNotMatch(
        output.text,
        term.pattern,
        `\`snack ${output.argv.join(" ")}\`${output.json ? " --json" : ""} says ${term.label}`,
      );
    }
  }
});

test("no command promises a number of prompts a plan still allows", async () => {
  const fixture = await makeRunFixture("snack-vocabulary-count-");
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

  for (const argv of [["status"], ["status", "--json"], ["stats"], ["stats", "--json"]]) {
    fixture.stdout.value = "";
    fixture.stderr.value = "";
    await run(["node", "snack", ...argv], fixture.options);
    const text = `${fixture.stdout.value}\n${fixture.stderr.value}`;

    // "12 prompts left", "about 40 more prompts", "up to 5 prompts": every shape of a count SNACK
    // would have to know the provider's real capacity to produce.
    assert.doesNotMatch(
      text,
      /\b(?:up to\s+)?\d+\s+(?:more\s+)?prompts?\s+(?:left|remaining|available|before)\b/iu,
      `\`snack ${argv.join(" ")}\` promises a prompt count`,
    );
  }
});

test("the export manifest cannot smuggle the vocabulary the interface refuses", async () => {
  const fixture = await makeRunFixture("snack-vocabulary-export-");
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
  fixture.stdout.value = "";
  await run(
    ["node", "snack", "export", "--format", "csv", "--output", join(fixture.root, "csv-out")],
    fixture.options,
  );

  const directory = join(fixture.root, "csv-out");
  const exported = await readdir(directory);
  assert.ok(exported.includes("manifest.json"), exported.join(", "));
  for (const entry of exported) {
    const content = await readFile(join(directory, entry), "utf8");
    for (const term of forbidden) {
      assert.doesNotMatch(content, term.pattern, `${entry} says ${term.label}`);
    }
  }
});

test("the domain and prediction modules do not know which client wrote a source", async () => {
  // The whole point of adding a second client is that the core stays client-neutral. These modules
  // consume domain-shaped values and produce domain-shaped results; if any of them has to name a
  // client, the adapter seam is in the wrong place and the third client would need the same edit
  // in the same places.
  const neutral = [
    "analytics.js",
    "beta.js",
    "calibration.js",
    "output.js",
    "prediction.js",
    "prompt-features.js",
    "status.js",
  ];
  for (const module of neutral) {
    const source = await readFile(new URL(`../src/${module}`, import.meta.url), "utf8");
    // Comments are allowed to name a client: explaining that a feature allowlist is shared with
    // the OpenCode capture plugin is prose about a real version identifier, not a branch. What
    // must not appear is code that behaves differently depending on which client is configured.
    const code = source.replaceAll(/\/\*[\s\S]*?\*\//gu, "").replaceAll(/\/\/[^\n]*/gu, "");
    assert.doesNotMatch(code, /\bopencode\b/iu, `${module} names OpenCode`);
    assert.doesNotMatch(code, /\bclaude\b/iu, `${module} names Claude Code`);
  }
});

test("storage names no type after the client that happened to be first", async () => {
  // Storage sits below the adapters and stores whatever any client observed, so a type of its own
  // named after one client describes the order the clients were built in rather than anything
  // about the data. The test that guards the domain modules cannot catch this one: it strips
  // comments, and a JSDoc type lives entirely in a comment.
  const source = await readFile(new URL("../src/storage.js", import.meta.url), "utf8");
  // String literals are stripped instead of comments here, and deliberately so. `opencode-session`
  // is the salt every stored session fingerprint was hashed with and `opencode-outcome-v1` is a
  // policy version written onto every outcome row; both are frozen wire values whose pre-images
  // are gone, so renaming their bytes would silently invalidate the history this test exists to
  // protect. Prose may say "OpenCode"; only an identifier that glues a client name to another word
  // is a type, a function, or a constant named after a client.
  const withoutLiterals = source
    .replaceAll(/"(?:[^"\\\n]|\\.)*"/gu, '""')
    .replaceAll(/'(?:[^'\\\n]|\\.)*'/gu, "''")
    .replaceAll(/`(?:[^`\\]|\\.)*`/gu, "``");
  const named = [...withoutLiterals.matchAll(/\b\w*(?:OpenCode|Claude)\w+\b/gu)].map(
    (match) => match[0],
  );
  assert.deepEqual([...new Set(named)], [], "storage.js names identifiers after a client");
});
