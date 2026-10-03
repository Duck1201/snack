import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { readFile, readdir } from "node:fs/promises";
import { afterEach, test } from "node:test";

import Database from "better-sqlite3";
import fc from "fast-check";

import { ExitCode } from "../src/errors.js";
import { run } from "../src/main.js";
import {
  PREDICTION_POLICY,
  SEQUENCE_MAX_LENGTH,
  assembleForecast,
  assessSequence,
} from "../src/prediction.js";
import {
  cleanupRunFixtures,
  createCodexHistory,
  createOpenCodeDatabase,
  makeRunFixture,
} from "./fixtures/run-fixture.js";

afterEach(cleanupRunFixtures);

/**
 * Sequence viability runs one way: `(posterior, N) -> probability`. SNACK never computes
 * `(posterior, probability) -> N`, because that N would be a count of prompts a plan still allows --
 * a claim about real capacity. These properties are the specification's §3.1, written as tests.
 */

/**
 * A forecast for an arbitrary `Beta(alpha, beta)` posterior, built by the real `assembleForecast`
 * over a `Beta(0.5, 0.5)` prior and the weighted cell that reaches it.
 *
 * @param {number} alpha
 * @param {number} beta
 */
function forecastFor(alpha, beta) {
  return assembleForecast({
    cell: {
      prompts_considered: 0,
      limit_prompts: PREDICTION_POLICY.evidence_window_prompts,
      successes: 0,
      restrictions: 0,
      excluded: 0,
      weighted_successes: alpha - 0.5,
      weighted_restrictions: beta - 0.5,
      effective_samples: alpha + beta - 1,
      alpha: 0,
      beta: 0,
    },
    level: "period_band_category",
    prior: { strength: 1, viability: 0.5 },
    policy: PREDICTION_POLICY,
    dataCompleteness: "complete",
  });
}

const parameter = fc.double({ min: 0.5, max: 60, noNaN: true, noDefaultInfinity: true });
const length = fc.integer({ min: 1, max: SEQUENCE_MAX_LENGTH });

test("the length is an echo: the posterior never moves it, and the interval orders", () => {
  fc.assert(
    fc.property(parameter, parameter, parameter, parameter, length, (a1, b1, a2, b2, n) => {
      const first = assessSequence(forecastFor(a1, b1), n);
      const second = assessSequence(forecastFor(a2, b2), n);
      assert.equal(first.length, n);
      assert.equal(second.length, first.length);
      for (const { viability } of [first, second]) {
        assert.ok(0 <= viability.lower, `${viability.lower}`);
        assert.ok(viability.lower <= viability.point, `${viability.lower} > ${viability.point}`);
        assert.ok(viability.point <= viability.upper, `${viability.point} > ${viability.upper}`);
        assert.ok(viability.upper <= 1, `${viability.upper}`);
      }
    }),
    { numRuns: 300 },
  );
});

test("a longer sequence is never more likely to go through", () => {
  fc.assert(
    fc.property(parameter, parameter, fc.integer({ min: 1, max: 99 }), (a, b, n) => {
      const base = forecastFor(a, b);
      const shorter = assessSequence(base, n).viability;
      const longer = assessSequence(base, n + 1).viability;
      assert.ok(longer.lower <= shorter.lower);
      assert.ok(longer.point <= shorter.point);
      assert.ok(longer.upper <= shorter.upper);
    }),
    { numRuns: 300 },
  );
});

test("a sequence of one is the single-prompt answer for any posterior", () => {
  fc.assert(
    fc.property(parameter, parameter, (a, b) => {
      const base = forecastFor(a, b);
      const sequence = assessSequence(base, 1);
      for (const member of /** @type {const} */ (["lower", "point", "upper", "coverage_target"])) {
        assert.ok(Object.is(sequence.viability[member], base.viability[member]), member);
      }
      assert.deepEqual(sequence.risk, base.risk);
      assert.deepEqual(sequence.evidence, base.evidence);
    }),
    { numRuns: 300 },
  );
});

test("nothing searches for a length: one call site, and no solver anywhere in the source", async () => {
  // A loop calling `assessSequence` with a varying length is the only way to search for an N, so
  // pinning the call sites to the one that passes the parsed argv value rules the search out.
  const directory = new URL("../src/", import.meta.url);
  /** @type {string[]} */
  const callers = [];
  for (const name of (await readdir(directory)).filter((entry) => entry.endsWith(".js"))) {
    const source = await readFile(new URL(name, directory), "utf8");
    const calls = source.match(/\bassessSequence\s*\(/gu) ?? [];
    // The definition is `function assessSequence(` and is not a call.
    const definitions = source.match(/\bfunction\s+assessSequence\s*\(/gu) ?? [];
    for (let index = definitions.length; index < calls.length; index += 1) callers.push(name);
    // Declared names, not prose: `beta.js` rightly says its quantile "inverts" the CDF.
    const declared = [
      ...source.matchAll(/\b(?:function\*?|const|let|var|class)\s+([A-Za-z_$][\w$]*)/gu),
    ].map((match) => String(match[1]));
    for (const identifier of declared) {
      assert.doesNotMatch(
        identifier,
        /^(?:solve|invert|maxPrompts|promptsUntil|lengthFor|promptsLeft|remainingPrompts)/iu,
        `${name} declares ${identifier}, a solver for a count of prompts`,
      );
    }
  }
  assert.deepEqual(callers, ["status.js"]);
  const status = await readFile(new URL("status.js", directory), "utf8");
  assert.match(status, /assessSequence\(forecast, request\.sequenceLength\)/u);
});

/** One configured history with two sources, so every report and every path is exercised. */
async function configuredFixture() {
  const fixture = await makeRunFixture("snack-sequence-");
  fixture.options.env.OPENCODE_DB = await createOpenCodeDatabase(fixture.root);
  fixture.options.env.CODEX_HOME = await createCodexHistory(fixture.root, [
    "version-0-159-3.jsonl",
    "version-0-147-0.jsonl",
  ]);
  const setup = (
    /** @type {string} */ client,
    /** @type {string} */ alias,
    /** @type {string} */ provider,
    /** @type {string} */ plan,
  ) => [
    "node",
    "snack",
    "setup",
    client,
    "--non-interactive",
    "--source",
    alias,
    "--provider",
    provider,
    "--profile",
    "default",
    "--plan",
    plan,
  ];
  await run(setup("opencode", "work", "anthropic", "pro"), fixture.options);
  await run(setup("codex", "codex", "openai", "plus"), fixture.options);
  await run(["node", "snack", "sync", "--full"], fixture.options);
  return fixture;
}

/**
 * @param {Awaited<ReturnType<typeof configuredFixture>>} fixture
 * @param {string[]} argv
 */
async function statusJson(fixture, argv) {
  fixture.stdout.value = "";
  fixture.stderr.value = "";
  const code = await run(
    ["node", "snack", "status", "--no-sync", "--json", ...argv],
    fixture.options,
  );
  assert.equal(code, 0, fixture.stderr.value);
  return JSON.parse(fixture.stdout.value);
}

/**
 * Every key a `sequence` member may carry, at every depth. Deleting the member wholesale would hide
 * whatever else it carried -- an `informative_length`, a count -- so its exact shape is asserted
 * first, and every number in it but the user's own length must be a probability.
 *
 * @param {unknown} sequence
 * @param {number} n
 */
function assertSequenceShape(sequence, n) {
  const keys = (/** @type {unknown} */ value) => Object.keys(/** @type {object} */ (value)).sort();
  const member =
    /** @type {{length: number, viability: object, risk: object, evidence: {gates: object[]}, method: object, width: object}} */ (
      sequence
    );
  assert.deepEqual(keys(member), ["evidence", "length", "method", "risk", "viability", "width"]);
  assert.equal(member.length, n);
  assert.deepEqual(keys(member.viability), ["coverage_target", "lower", "point", "upper"]);
  assert.deepEqual(keys(member.risk), ["label", "policy_version"]);
  assert.deepEqual(keys(member.evidence), ["gates", "level", "policy_version"]);
  assert.ok(Array.isArray(member.evidence.gates));
  for (const gate of member.evidence.gates) {
    assert.deepEqual(keys(gate), ["id", "level", "limiting"]);
  }
  assert.deepEqual(keys(member.method), ["id", "version"]);
  assert.deepEqual(keys(member.width), ["max_width", "policy_version", "too_wide"]);

  /** @param {unknown} value @param {string} path */
  const probabilities = (value, path) => {
    if (typeof value === "number") {
      assert.ok(value >= 0 && value <= 1, `${path} = ${value} is not a probability`);
    } else if (value !== null && typeof value === "object") {
      for (const [key, child] of Object.entries(value)) probabilities(child, `${path}.${key}`);
    }
  };
  for (const [key, value] of Object.entries(member)) {
    if (key !== "length") probabilities(value, `sequence.${key}`);
  }
}

/**
 * The document with everything the sequence added taken away: its member, and the caveats that
 * name its length, which come last. A sequence of one that is not too wide adds no caveat at all.
 *
 * @param {unknown} document
 * @param {number} n
 */
function withoutSequence(document, n) {
  const copy = JSON.parse(JSON.stringify(document));
  for (const report of copy.data.sources ?? [copy.data]) {
    assertSequenceShape(report.sequence, n);
    delete report.sequence;
    const own = report.caveats.filter((/** @type {string} */ caveat) =>
      caveat.startsWith(`The ${n}-prompt `),
    );
    assert.ok(own.length <= 2, JSON.stringify(report.caveats));
    // The only integer a sequence caveat carries is the user's own length, echoed.
    for (const caveat of own) {
      assert.deepEqual(caveat.match(/\d+/gu)?.map(Number), [n]);
    }
    // `slice(-0)` is the whole array, so a report with no sequence caveat is left as it is.
    if (own.length > 0) {
      assert.deepEqual(report.caveats.slice(-own.length), own);
      report.caveats = report.caveats.slice(0, -own.length);
    }
  }
  return copy;
}

test("no field but the sequence depends on N, and without N no sequence exists", async () => {
  const fixture = await configuredFixture();
  const plain = await statusJson(fixture, []);
  await fc.assert(
    fc.asyncProperty(
      fc.integer({ min: 1, max: SEQUENCE_MAX_LENGTH }),
      fc.integer({ min: 1, max: SEQUENCE_MAX_LENGTH }),
      async (n1, n2) => {
        fc.pre(n1 !== n2);
        const first = await statusJson(fixture, ["--sequence", String(n1)]);
        const second = await statusJson(fixture, ["--sequence", String(n2)]);
        assert.deepEqual(withoutSequence(first, n1), plain);
        assert.deepEqual(withoutSequence(second, n2), plain);
      },
    ),
    { numRuns: 12 },
  );
});

/** @param {string} databaseFile */
function attemptCount(databaseFile) {
  const database = new Database(databaseFile, { readonly: true });
  try {
    return /** @type {{total: number}} */ (
      database.prepare("SELECT COUNT(*) AS total FROM prediction_attempt").get()
    ).total;
  } finally {
    database.close();
  }
}

test("--sequence accepts exactly the canonical whole numbers from 1 to 100", async () => {
  const fixture = await configuredFixture();
  // The answer to a rejected value, which every other rejected value must match byte for byte: an
  // error that changes with the input is an error that can echo it.
  fixture.stdout.value = "";
  fixture.stderr.value = "";
  assert.equal(
    await run(["node", "snack", "status", "--no-sync", "--sequence=0", "--json"], fixture.options),
    ExitCode.usage,
  );
  const rejectedJson = fixture.stdout.value;
  assert.deepEqual(JSON.parse(rejectedJson).errors, [
    { code: "sequence_length_invalid", message: "--sequence takes a whole number from 1 to 100." },
  ]);
  fixture.stdout.value = "";
  fixture.stderr.value = "";
  await run(["node", "snack", "status", "--no-sync", "--sequence=0"], fixture.options);
  const rejectedHuman = fixture.stderr.value;
  assert.equal(rejectedHuman, "Error: --sequence takes a whole number from 1 to 100.\n");

  const candidate = fc.oneof(
    fc.string({ maxLength: 6 }),
    fc.integer({ min: -5, max: 105 }).map(String),
    fc.integer({ min: 1, max: 100 }).map((value) => `0${value}`),
    fc.integer({ min: 1, max: 100 }).map((value) => `+${value}`),
    fc.integer({ min: 1, max: 100 }).map((value) => ` ${value}`),
    fc.integer({ min: 1, max: 100 }).map((value) => `${value}.0`),
    fc.constantFrom("1e1", "0x0A", "１０", "٣", "", "100", "101", "1", "99", "Infinity", "NaN"),
  );
  const before = attemptCount(fixture.paths.databaseFile);
  let accepted = 0;
  await fc.assert(
    fc.asyncProperty(candidate, fc.boolean(), async (value, json) => {
      fixture.stdout.value = "";
      fixture.stderr.value = "";
      const code = await run(
        [
          "node",
          "snack",
          "status",
          "--no-sync",
          `--sequence=${value}`,
          ...(json ? ["--json"] : []),
        ],
        fixture.options,
      );
      const valid = /^[1-9]\d*$/u.test(value) && Number(value) <= 100;
      if (valid) {
        accepted += 1;
        assert.equal(code, 0, `${JSON.stringify(value)}: ${fixture.stderr.value}`);
        return;
      }
      assert.equal(code, ExitCode.usage, JSON.stringify(value));
      if (json) assert.equal(fixture.stdout.value, rejectedJson, JSON.stringify(value));
      else assert.equal(fixture.stderr.value, rejectedHuman, JSON.stringify(value));
    }),
    { numRuns: 120 },
  );
  assert.ok(accepted > 0, "no generated value was accepted");
  // A rejected value records nothing: only the accepted runs added attempts, two sources each.
  assert.equal(attemptCount(fixture.paths.databaseFile), before + accepted * 2);
});

test("a rejected --sequence on a fresh installation creates no database", async () => {
  const fixture = await makeRunFixture("snack-sequence-fresh-");
  for (const value of ["0", "101", "abc", "-1"]) {
    const code = await run(
      ["node", "snack", "status", `--sequence=${value}`, "--json"],
      fixture.options,
    );
    assert.equal(code, ExitCode.usage, value);
    assert.equal(JSON.parse(fixture.stdout.value).errors[0].code, "sequence_length_invalid");
    fixture.stdout.value = "";
  }
  assert.equal(existsSync(fixture.paths.databaseFile), false);
  assert.equal(existsSync(fixture.paths.configFile), false);
});
