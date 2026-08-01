import assert from "node:assert/strict";
import { test } from "node:test";

import { renderStatus, sparkline } from "../src/render.js";

test("a series of scores draws one block per window, low to high", () => {
  // Scores are percentiles in [0, 1] -- `computeUsagePressure().score` -- so the mapping is fixed
  // and does not rescale to the series. Rescaling would make a flat week of light usage look
  // identical to a flat week of heavy usage, which is the one comparison the drawing exists for.
  assert.equal(sparkline([0, 0.25, 0.5, 0.75, 1]), "▁▃▅▆█");
});

test("the two states computeUsageTrend actually produces are drawable", () => {
  // Not speculative shapes: `insufficient_baseline` and `insufficient_windows` both return
  // `scores: []`, and `above_baseline` returns a series where every score is 1 -- the case where a
  // percentile cannot rise any further while usage still can. Both reach the renderer.
  assert.equal(sparkline([]), "", "an absent series must draw nothing, not a placeholder");
  assert.equal(sparkline([1, 1, 1, 1, 1]), "█████");
});

/**
 * One source status, shaped as `createSourceStatus` builds it. Written out rather than produced by
 * driving a command: the renderer is what is under test, and a fixture needing a database would
 * make every layout question cost a migration.
 *
 * @param {Record<string, unknown>} overrides
 */
function statusFor(overrides = {}) {
  return {
    source: {
      alias: "work",
      provider: "anthropic",
      profile: "default",
      plan: "pro",
      active_period: { started_at: "2026-01-02T03:05:00.000Z" },
      plan_profile: { id: "generic", version: "1.0.0", provenance: "bundled", as_of: null },
    },
    viability: { lower: 0.95, point: 0.98, upper: 1, coverage_target: 0.8 },
    risk: { label: "low", policy_version: "1" },
    evidence: { level: "moderate", policy_version: "1", gates: [] },
    method: { id: "bayesian-pressure-band", version: "1" },
    pressure: {
      horizon: "PT1H",
      score: 0.9,
      band: "high",
      contributors: [
        { dimension: "prompts", percentile: 1, contribution: 0.6 },
        { dimension: "input_tokens", percentile: 0.9, contribution: 0.3 },
        { dimension: "output_tokens", percentile: 0.2, contribution: 0.1 },
      ],
      trend: { scores: [0, 0.4, 0.6, 0.9, 1], status: "observed", direction: "rising" },
    },
    expected_prompt_category: "typical",
    freshness: { as_of: "2026-01-02T03:04:10.000Z", age_seconds: 40 },
    synchronization: { performed: true, status: "ok" },
    caveats: ["Real provider capacity is unknown."],
    ...overrides,
  };
}

test("a source is a panel with an aligned label column", () => {
  // One panel per capacity source, labels in a fixed-width column, and no box drawing: a box
  // survives neither a narrow terminal nor a pipe, and this output is read through both. The
  // sparkline ends its line because its width varies with how many windows were observed, and a
  // variable-width cell in the middle of a row is what breaks an aligned column.
  const text = renderStatus([statusFor()], { color: false });

  assert.equal(
    text,
    [
      "work",
      "  viability  95-100%   risk low          evidence moderate",
      "  pressure   high      category typical  ▁▄▅▇█",
      "  drivers    prompts 100th, input_tokens 90th",
      "  method     bayesian-pressure-band@1",
      "  as of      40s ago · sync ok · period since 2026-01-02",
      "  ! Real provider capacity is unknown.",
      "",
    ].join("\n"),
  );
});

test("no escape sequence survives when colour is off", () => {
  // The load-bearing assertion for a captured log, a pipe, and NO_COLOR. Asserted over the whole
  // document rather than per field, so a colour added later to a line nobody thought about fails
  // here rather than in somebody's CI log.
  // eslint-disable-next-line no-control-regex -- matching the escape is the assertion
  assert.doesNotMatch(renderStatus([statusFor()], { color: false }), /\u001B/u);
});

test("colour is added without changing a single word", () => {
  // The rule the roadmap states and a colourblind reader depends on: colour never carries meaning
  // alone. `risk low` is a word that happens to be green, so a NO_COLOR terminal, a captured log
  // and a screen reader all get the same sentence. Asserted by stripping the escapes and demanding
  // the uncoloured document back, which no per-field assertion could give.
  const plain = renderStatus([statusFor()], { color: false });
  const coloured = renderStatus([statusFor()], { color: true });

  assert.notEqual(coloured, plain, "colour: true produced no colour");
  // eslint-disable-next-line no-control-regex -- matching the escape is the assertion
  assert.equal(coloured.replace(/\u001B\[[0-9;]*m/gu, ""), plain);
});

test("each risk label gets its own colour", () => {
  // Three bands, three colours. Without this, a renderer that painted every risk the same would
  // still pass the test above -- it strips to the same words -- while telling the reader nothing.
  const colourOf = (/** @type {string} */ label) => {
    const text = renderStatus([statusFor({ risk: { label, policy_version: "1" } })], {
      color: true,
    });
    const match = new RegExp(`\\u001B\\[([0-9;]+)mrisk ${label}\\u001B`, "u").exec(text);
    assert.ok(match, `risk ${label} was not coloured at all`);
    return match[1];
  };

  const seen = ["low", "elevated", "high"].map(colourOf);
  assert.equal(new Set(seen).size, 3, `risk colours were not distinct: ${seen.join(", ")}`);
});

test("a source with nothing ranked says so rather than showing an empty row", () => {
  // Specification 12.3 puts the top pressure contributors in the default human detail, and a
  // brand-new source has none: every dimension's contribution is null until there is a baseline to
  // rank against. An empty row would read as "no pressure" rather than "nothing to compare yet".
  const text = renderStatus([statusFor({ pressure: { band: "unknown", contributors: [] } })], {
    color: false,
  });

  assert.match(text, / {2}drivers {4}none ranked/u);
});
