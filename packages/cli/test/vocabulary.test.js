import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, test } from "node:test";

import { commandSurface } from "../../../scripts/man-surface.mjs";
import { compareOutcomeGroups } from "../src/analytics.js";
import { minimumRows, renderDash } from "../src/dash-view.js";
import { run } from "../src/main.js";
import { createScreen } from "../src/screen.js";
import { everyDashState } from "./fixtures/dash-states.js";
import {
  makeFakeClock,
  makeFakeSignals,
  makeFakeSync,
  makeFakeTerminal,
  realSync,
  startDash,
} from "./fixtures/fake-tty.js";
import { makeVirtualScreen } from "./fixtures/fake-screen.js";
import {
  cleanupRunFixtures,
  createCodexHistory,
  createOpenCodeDatabase,
  makeRunFixture,
  plantStatements,
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
  // Added with the reported-capacity shadow in 1.5.0: a headroom model, or a stated figure turned
  // into what is left of a window, would be an inference about real capacity by another route.
  { label: "headroom", pattern: /\bheadroom\b/iu },
  { label: "a percentage left", pattern: /\b\d+(?:\.\d+)?%\s+(?:left|remaining|free)\b/iu },
];

test("no command calls observed usage a quota percentage or a remaining balance", async () => {
  const fixture = await makeRunFixture("snack-vocabulary-");
  fixture.options.env.OPENCODE_DB = await createOpenCodeDatabase(fixture.root);
  // A Codex source whose rollouts state capacity figures, so the `reported` row and the
  // `reported_capacity` field -- the one place SNACK quotes a percentage of a provider's window --
  // are on the surface this test polices.
  fixture.options.env.CODEX_HOME = await createCodexHistory(fixture.root, [
    "version-0-159-3.jsonl",
    "version-0-147-0.jsonl",
  ]);

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
    [
      "setup",
      "codex",
      "--non-interactive",
      "--source",
      "codex",
      "--provider",
      "openai",
      "--profile",
      "default",
      "--plan",
      "plus",
    ],
    ["sync", "--full"],
    ["status"],
    ["status", "--source", "codex"],
    // The verbose panel is where the pressure percentiles reach a human surface, which is the one
    // number in this product most likely to be read as a share of a capacity.
    ["status", "--verbose"],
    // Sequence viability is the one surface that sets a number of prompts beside a probability, so
    // every shape of it is policed: the row, the verbose method row, the identity at one, the help,
    // and the usage error.
    ["status", "--sequence", "10"],
    ["status", "--verbose", "--sequence", "10"],
    ["status", "--source", "codex", "--sequence", "1"],
    ["status", "--sequence", "100"],
    ["status", "--help"],
    ["status", "--sequence", "0"],
    ["stats", "--verbose"],
    // The per-client comparison renders refusal counts and intervals, which is exactly the shape of
    // output that drifts into sounding like a share of real capacity.
    ["stats", "--by-client"],
    ["doctor"],
    ["config", "get"],
    ["config", "path"],
    ["export", "--format", "json", "--output", "-"],
    ["data", "purge", "--source", "work", "--dry-run"],
    // An unconfigured source is the error surface, which is UI too.
    ["stats", "--source", "absent"],
    // `snack dash` through a pipe, and with `--json`: both refusals, in words and as an envelope.
    ["dash"],
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
  assert.match(transcript, /Codex states \d+% of its \w+ window/u);
  assert.match(transcript, /"reported_capacity"/u);
  assert.match(transcript, /chance all 10 go through/u);
  assert.match(transcript, /"sequence"/u);
  assert.match(transcript, /interval is too wide to say much/u);
  // The prior-tail diagnostic (`sequence-prior-tail-v1`, 1.6.0) is on the policed surface too.
  assert.match(transcript, /comes from SNACK's starting assumption rather than from your history/u);
  assert.match(transcript, /--sequence <n>/u);
  assert.match(transcript, /snack dash needs an interactive terminal/u);
  assert.match(transcript, /"dash_json_unsupported"/u);
  // The weighting variants (1.6.0): their verbose lines, the half-lives in words, and the JSON.
  assert.match(transcript, /recency half-life/u);
  assert.match(transcript, /not the answer above/u);
  assert.match(transcript, /bayesian-pressure-band-hl50@1 would say/u);
  assert.match(transcript, /"bayesian-pressure-band-hl100"/u);
  for (const output of outputs.filter((entry) => entry.argv.includes("--verbose"))) {
    // A half-life is said "50-prompt", never a number set before the word.
    assert.doesNotMatch(output.text, countBeforePrompts, `\`snack ${output.argv.join(" ")}\``);
  }

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

test("the shadow never reads as capacity, as the answer, or as a stated figure inside an estimate", async () => {
  // Codex stating a window nearly full, then full, at the fixture clock: the shadow is computed in
  // both bands, and in `full` from the starting assumption, so every one of its wordings is on the
  // surface this test polices.
  const fixture = await makeRunFixture("snack-vocabulary-shadow-");
  fixture.options.env.CODEX_HOME = await createCodexHistory(fixture.root, [
    "version-0-159-3.jsonl",
    "version-0-147-0.jsonl",
  ]);
  await run(
    [
      "node",
      "snack",
      "setup",
      "codex",
      "--non-interactive",
      "--source",
      "codex",
      "--provider",
      "openai",
      "--profile",
      "default",
      "--plan",
      "plus",
      "--json",
    ],
    fixture.options,
  );
  const installationId = JSON.parse(fixture.stdout.value).data.source.installation_id;
  await run(["node", "snack", "sync", "--full"], fixture.options);
  const now = /** @type {Date} */ (fixture.options.now);

  /** @type {{argv: string[], json: boolean, text: string}[]} */
  const outputs = [];
  for (const [index, usedPercent] of [90, 100].entries()) {
    plantStatements(
      fixture.paths.databaseFile,
      "codex",
      installationId,
      [
        {
          observation_key: String(index + 1).padStart(64, "0"),
          observed_at: new Date(now.getTime() - (2 - index) * 60_000).toISOString(),
          limit_id: "codex",
          plan_type: "plus",
          windows: [
            {
              window_minutes: 300,
              used_percent: usedPercent,
              resets_at: new Date(now.getTime() + 3_600_000).toISOString(),
            },
            { window_minutes: 10080, used_percent: 40, resets_at: null },
          ],
          parser_version: "codex-rate-limits-v1",
        },
      ],
      now,
    );
    for (const argv of [
      ["status"],
      ["status", "--verbose"],
      ["status", "--sequence", "10"],
      ["status", "--verbose", "--sequence", "10"],
      ["stats", "--verbose"],
    ]) {
      for (const json of [false, true]) {
        fixture.stdout.value = "";
        fixture.stderr.value = "";
        await run(
          ["node", "snack", ...argv, "--no-sync", ...(json ? ["--json"] : [])].filter(
            (word) => !(argv[0] === "stats" && word === "--no-sync"),
          ),
          fixture.options,
        );
        outputs.push({ argv, json, text: `${fixture.stdout.value}\n${fixture.stderr.value}` });
      }
    }
  }

  const transcript = outputs.map((output) => output.text).join("\n");
  // Vacuity guards: both bands and the starting assumption were really on the surface.
  assert.match(transcript, /reads what Codex states about its 5h window — in the near band/u);
  assert.match(transcript, /starting assumption — Codex states its 5h window is full/u);
  assert.match(transcript, /not the answer above/u);
  assert.match(transcript, /"reported-capacity"/u);
  assert.match(transcript, /by method/u);
  // A stated band is SNACK's grouping, not something Codex said, and a full window can end early
  // with a plan change: the shadow neither paraphrases the threshold as Codex's words nor promises
  // how long a window stays full.
  assert.doesNotMatch(transcript, /nearly full|until it resets/u);

  for (const output of outputs) {
    const where = `\`snack ${output.argv.join(" ")}\`${output.json ? " --json" : ""}`;
    for (const term of forbidden) {
      assert.doesNotMatch(output.text, term.pattern, `${where} says ${term.label}`);
    }
    if (output.json) continue;
    const lines = output.text.split("\n");
    // The estimate's own lines never carry a stated percentage: not the answer, not the sequence,
    // and not the shadow, whose figure is quoted once on the `reported` row.
    for (const line of lines.filter((text) => /^\s{2}(?:next |shadow\b)/u.test(text))) {
      assert.doesNotMatch(line, /\d+(?:\.\d+)?% of\b/u, `${where}: ${line}`);
    }
    // The shadow is a `--verbose` surface only: the default panel never shows it.
    if (!output.argv.includes("--verbose")) {
      assert.ok(!lines.some((text) => /^\s{2}shadow\b/u.test(text)), `${where} shows the shadow`);
      assert.doesNotMatch(output.text, /reported-capacity/u, where);
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

  for (const argv of [
    ["status"],
    ["status", "--json"],
    ["status", "--sequence", "5"],
    ["status", "--sequence", "5", "--json"],
    ["status", "--sequence", "100", "--verbose"],
    ["stats"],
    ["stats", "--json"],
  ]) {
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
    // "send up to 12", "run about 40": a count offered as an instruction rather than an allowance.
    assert.doesNotMatch(
      text,
      /\b(?:send|run|make)\s+(?:up to\s+|about\s+)?\d+\b/iu,
      `\`snack ${argv.join(" ")}\` offers a count to send`,
    );
    // "prompts until", "prompts to go": a countdown, which is a count with a direction.
    assert.doesNotMatch(
      text,
      /\bprompts?\s+(?:until|to go)\b/iu,
      `\`snack ${argv.join(" ")}\` counts down prompts`,
    );
  }
});

/**
 * A count set before the word "prompts": a number or a placeholder for one, up to two words, then
 * "prompts" as a word of its own.
 *
 * CONTEXT.md, Sequence viability: the user's count is said as "all 10 go through" or a "10-prompt"
 * estimate, never "10 prompts" -- that phrase is one word away from an allowance, and a qualifier
 * between them ("10 more prompts", "N consecutive prompts", "the 10 next prompts") does not move it
 * any further away. The number is a whole one, so "1.5 prompts" is not a count; the placeholder is
 * `<n>`, `<N>`, `n` or `N` standing alone, so "N prompt-sized" and "prompt-sized" are not either.
 */
const countBeforePrompts =
  /(?:(?<![\w.,])\d+(?:,\d{3})*(?![.,]?\d)|<[nN]>|(?<![\w<\\-])[nN](?![\w>-]))\s+(?:[A-Za-z]+\s+){0,2}prompts?(?![\w-])/u;

/**
 * The man page as a reader sees it: roff font changes dropped, an escaped space a space.
 *
 * `\fIn\fR prompts` renders as "n prompts", and `n\ prompts` as "n prompts"; read raw, the font
 * escape glues the placeholder to a letter and the escaped space hides the separator.
 *
 * @param {string} roff
 */
function asRendered(roff) {
  return roff
    .replaceAll(/\\f(?:\(..|\[[^\]]*\]|.)/gu, "")
    .replaceAll(/\\[ ~0|^&]/gu, (escape) =>
      escape === "\\&" || escape === "\\|" || escape === "\\^" ? "" : " ",
    );
}

test("the count-before-prompts pattern catches every shape of a count and nothing else", () => {
  for (const phrase of [
    "10 prompts",
    "1 prompt",
    "1,000 prompts",
    "N prompts",
    "n prompts",
    "<n> prompts",
    "<N> prompts",
    "N consecutive prompts",
    "next <n> consecutive prompts",
    "10 more prompts",
    "the 10 next prompts",
    "send 10 more consecutive prompts",
    "(10 prompts)",
  ]) {
    assert.match(phrase, countBeforePrompts, phrase);
  }
  for (const roff of ["n\\ prompts", "\\fIn\\fR prompts", "\\fI<n>\\fP consecutive prompts"]) {
    assert.match(asRendered(roff), countBeforePrompts, roff);
  }
  for (const phrase of [
    "N prompt-sized",
    "a prompt-sized request",
    "1.5 prompts",
    "the 10-prompt estimate",
    "all 10 go through",
    "next 10 go through",
    "between prompts",
    "an1 prompts",
    "the next prompts",
    "within 10 minutes of three other things and prompts",
    "IN prompts",
  ]) {
    assert.doesNotMatch(phrase, countBeforePrompts, phrase);
  }
});

test("no dash screen says what the panels refuse to, at any size or pane", () => {
  // The dash is a screen rather than a stream, so it is policed as a reader sees it: every widget
  // state is drawn at three widths and two heights besides its minimum, pushed through the screen
  // buffer onto a virtual terminal, and the final screen -- colour on, escapes applied -- is held
  // to the same patterns as every command's output. Each state is drawn over the previous one, so
  // a row the frame diff forgot to clear would be read here too.
  /** @type {{where: string, text: string}[]} */
  const screens = [];
  for (const columns of [64, 80, 120]) {
    for (const rows of [24, 60]) {
      const terminal = makeVirtualScreen({ columns, rows });
      const screen = createScreen(terminal);
      screen.enter();
      for (const [name, state] of everyDashState()) {
        for (const height of [minimumRows(state), rows]) {
          if (height > rows) continue;
          screen.frame(renderDash(state, { columns, rows: height }, { color: true }).lines);
          screens.push({ where: `${name} at ${columns}x${height}`, text: terminal.text() });
        }
      }
      // Too small is a widget too.
      const [, first] = /** @type {[string, import("../src/dash-view.js").DashState]} */ (
        everyDashState()[0]
      );
      screen.frame(renderDash(first, { columns: 58, rows: 20 }, { color: true }).lines);
      screens.push({ where: `too small under ${columns}x${rows}`, text: terminal.text() });
      screen.leave();
    }
  }

  // Vacuity guards: the panes, the sequence row in both forms, the drawings and the too-small
  // sentence were all really on a screen.
  const transcript = screens.map((screen) => screen.text).join("\n");
  assert.match(transcript, /chance all 10 go through/u);
  assert.match(transcript, /interval is too wide to say much/u);
  assert.match(transcript, /lightest ├─*●─*┤ heaviest/u);
  assert.match(transcript, /each hour against your own history/u);
  assert.match(transcript, /reading this screen/u);
  assert.match(transcript, /Codex states \d+% of its \w+ window/u);
  assert.match(transcript, /snack dash needs at least 64 columns/u);

  for (const { where, text } of screens) {
    for (const term of forbidden) {
      assert.doesNotMatch(text, term.pattern, `${where} says ${term.label}`);
    }
    assert.doesNotMatch(text, countBeforePrompts, `${where} sets a count before "prompts"`);
    assert.doesNotMatch(
      text,
      /\b(?:up to\s+)?\d+\s+(?:more\s+)?prompts?\s+(?:left|remaining|available|before)\b/iu,
      `${where} promises a prompt count`,
    );
    assert.doesNotMatch(text, /\bprompts?\s+(?:until|to go)\b/iu, `${where} counts down prompts`);
    // The two drawings are where a picture could say what a sentence never would: a scale with a
    // used side, a plot with an empty end.
    const drawings = text
      .split("\n")
      .filter((line) => /lightest|by hour|by window|\bago +now$/u.test(line));
    for (const line of drawings) {
      assert.doesNotMatch(line, /\b(?:full|empty|used|left|remaining)\b/iu, `${where}: ${line}`);
    }
  }
});

test("no help page or manual sets a number directly before the word prompts", async () => {
  const fixture = await makeRunFixture("snack-vocabulary-help-");
  /** @type {Map<string, string>} */
  const pages = new Map();
  // Every page the program itself lists, read the way `snack.1` is built: from the root help down
  // through every group, so a command added tomorrow is scanned without being named here.
  await commandSurface(async (argv) => {
    fixture.stdout.value = "";
    fixture.stderr.value = "";
    await run(["node", "snack", ...argv, "--help"], fixture.options);
    const text = `${fixture.stdout.value}\n${fixture.stderr.value}`;
    pages.set(argv.join(" "), text);
    return fixture.stdout.value;
  });
  assert.ok(pages.size >= 17, [...pages.keys()].join(", "));
  for (const command of ["status", "setup codex", "data purge", "update"]) {
    assert.ok(pages.has(command), `the walk reached \`snack ${command}\``);
  }
  for (const [command, text] of pages) {
    assert.doesNotMatch(text, countBeforePrompts, `\`snack ${command} --help\``);
  }
  assert.match([...pages.values()].join("\n"), /--sequence <n>/u);
  const manual = await readFile(new URL("../man/snack.1", import.meta.url), "utf8");
  assert.match(manual, /--sequence/u);
  assert.doesNotMatch(asRendered(manual), countBeforePrompts, "man/snack.1");
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

test("the comparison treats a group key as a label it never reads", () => {
  // The regex guards catch a client named in code. They cannot catch a branch on a value arriving
  // from configuration, and that is the leak that would actually hurt: a comparison that works only
  // for the two clients someone thought of is not a client-neutral core, it is two special cases.
  //
  // An unknown client cannot be configured to test this from the outside -- the configuration
  // schema fail-closes on an adapter it does not know, which is the intended behavior. So the claim
  // is tested where the key can actually vary: rename every group and nothing but the names may
  // move. A comparison that recognized a client would answer differently here.
  const counts = (/** @type {number} */ restricted, /** @type {number} */ eligible) => ({
    prompts: eligible,
    eligible,
    restricted,
  });

  const named = compareOutcomeGroups([
    { key: "installation-opencode", ...counts(5, 200) },
    { key: "installation-claude", ...counts(40, 200) },
  ]);
  const anonymous = compareOutcomeGroups([
    { key: "sardine-cli-installation", ...counts(5, 200) },
    { key: "☃", ...counts(40, 200) },
  ]);

  const withoutKeys = (/** @type {typeof named} */ comparison) => ({
    ...comparison,
    groups: comparison.groups.map((group) => ({ ...group, key: null })),
  });
  assert.deepEqual(withoutKeys(anonymous), withoutKeys(named));
  assert.deepEqual(
    anonymous.groups.map((group) => group.difference),
    ["lower_than_others", "higher_than_others"],
  );
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

test("a live dash session says what the panels refuse to, through every pane and size", async () => {
  // The widgets are policed state by state above; this is the session itself -- real storage, a
  // real sync, Codex's stated figure on the `reported` row, every key -- read off the screen.
  const fixture = await makeRunFixture("snack-vocabulary-dash-");
  fixture.options.env.OPENCODE_DB = await createOpenCodeDatabase(fixture.root);
  fixture.options.env.CODEX_HOME = await createCodexHistory(fixture.root, [
    "version-0-159-3.jsonl",
    "version-0-147-0.jsonl",
  ]);
  for (const [client, alias, provider, plan] of [
    ["opencode", "work", "anthropic", "pro"],
    ["codex", "codex", "openai", "plus"],
  ]) {
    const setup = ["setup", String(client), "--non-interactive", "--source", String(alias)];
    setup.push("--provider", String(provider), "--profile", "default", "--plan", String(plan));
    assert.equal(await run(["node", "snack", ...setup], fixture.options), 0);
  }
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
  /** @type {{where: string, text: string}[]} */
  const screens = [];
  const keep = (/** @type {string} */ where) => screens.push({ where, text: terminal.text() });
  keep("start");
  for (const key of ["j", "s", "+", "?", "escape", "k", "r", "-", "s"]) {
    terminal.press(key);
    await session.settle();
    keep(`after ${key}`);
  }
  terminal.press("s");
  for (const [columns, rows] of [
    [64, 24],
    [80, 24],
    [200, 60],
    [50, 12],
  ]) {
    terminal.resize(Number(columns), Number(rows));
    keep(`${columns}x${rows}`);
  }
  await clock.advance(90_000);
  keep("after a sync");
  terminal.press("q");
  assert.equal(await session.done, 0);

  const transcript = screens.map((screen) => screen.text).join("\n");
  assert.match(transcript, /Codex states \d+% of its \w+ window/u);
  assert.match(transcript, /next \d+ /u);
  assert.match(transcript, /reading this screen/u);
  for (const { where, text } of screens) {
    for (const term of forbidden) {
      assert.doesNotMatch(text, term.pattern, `${where} says ${term.label}`);
    }
    assert.doesNotMatch(text, countBeforePrompts, `${where} sets a count before "prompts"`);
    const drawings = text
      .split("\n")
      .filter((line) => /lightest|by hour|by window|\bago +now$/u.test(line));
    for (const line of drawings) {
      assert.doesNotMatch(line, /\b(?:full|empty|used|left|remaining)\b/iu, `${where}: ${line}`);
    }
  }
});
