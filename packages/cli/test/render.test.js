import assert from "node:assert/strict";
import { test } from "node:test";

import { renderStatus, renderStatusTable, sparkline } from "../src/render.js";

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

test("the overview is one header and one row per source", () => {
  // Without a selection the question is which source to reach for, and that is a comparison across
  // sources rather than a reading of one. A row per source answers it in one glance; four panels
  // make the reader hold four numbers in their head. `SOURCE` stays left because a column of names
  // aligned on their left edge is the anchor the eye scans down; every measurement is centred under
  // the word that names it.
  const text = renderStatusTable([statusFor()], { color: false, columns: 80 });

  assert.equal(
    text,
    [
      "  SOURCE  NEXT PROMPT   RISK   EVIDENCE  PRESSURE  LAST SEEN   SYNC",
      "  work      95-100%     low    moderate    high     40s ago     ok",
      "  ! Real provider capacity is unknown.",
      "",
    ].join("\n"),
  );
});

test("an alias whose characters are double-width still lines its row up", () => {
  // An alias comes from the user's configuration, so it can hold anything they can type. `工作` is
  // two code points and four columns on a terminal, and padding it by `String.length` pads it two
  // short -- which slides every measurement in that row two characters left of its own header,
  // silently, and only for the people who name things in their own script.
  const text = renderStatusTable(
    [statusFor(), statusFor({ source: { alias: "工作", active_period: { started_at: null } } })],
    { color: false, columns: 80 },
  );
  const [, ascii, wide] = text.split("\n");

  // Asserted as one row against the other rather than by index: an index into the string is a count
  // of code units, which is the very unit that gets this wrong. Two aliases of equal screen width
  // must produce rows that differ in nothing but the alias.
  assert.equal(wide, ascii?.replace("work", "工作"));
});

test("an alias that looks like an escape sequence is still counted as text", () => {
  // The width count has to ignore escape sequences, and the cheap way to write that is to match the
  // bracket-and-letter tail. An alias is typed by the user, so that tail can arrive as ordinary
  // characters that do occupy the screen -- and a width counted as zero collapses the column for
  // every other source in the table.
  const text = renderStatusTable(
    [statusFor({ source: { alias: "[31m", active_period: { started_at: null } } }), statusFor()],
    { color: false, columns: 80 },
  );
  const [, escapeish, ascii] = text.split("\n");

  assert.equal(escapeish, ascii?.replace("work", "[31m"));
});

test("colour never moves a column in the overview", () => {
  // The panel learned this the hard way: an escape sequence has width in a string and none on a
  // screen, so padding a painted cell aligns the bytes and misaligns the column. A table makes the
  // failure worse than a panel did -- one painted risk label pushes every column after it out of
  // true on that row alone, so the misalignment reads as a data difference.
  const plain = renderStatusTable([statusFor()], { color: false, columns: 80 });
  const coloured = renderStatusTable([statusFor()], { color: true, columns: 80 });

  assert.notEqual(coloured, plain, "colour: true produced no colour");
  // eslint-disable-next-line no-control-regex -- matching the escape is the assertion
  assert.equal(coloured.replace(/\u001B\[[0-9;]*m/gu, ""), plain);
});

test("a narrow terminal drops columns from the least load-bearing end", () => {
  // A row wider than the terminal wraps, and a wrapped row destroys the alignment that is the only
  // reason the table beat four panels. Dropping is ordered by what the reader loses: `SYNC` is
  // almost always `ok`, `EVIDENCE` qualifies the estimate, and `PRESSURE` and the interval are the
  // reading itself.
  const wide = renderStatusTable([statusFor()], { color: false, columns: 80 });
  const narrow = renderStatusTable([statusFor()], { color: false, columns: 60 });
  const narrower = renderStatusTable([statusFor()], { color: false, columns: 48 });

  assert.match(wide, /SYNC/u);
  assert.doesNotMatch(narrow, /SYNC/u);
  assert.match(narrow, /EVIDENCE/u);
  assert.doesNotMatch(narrower, /EVIDENCE/u);
  assert.match(narrower, /NEXT PROMPT/u, "the reading itself is never dropped");

  for (const line of narrow.split("\n")) {
    assert.ok(line.length <= 60, `line overflowed 60 columns: ${JSON.stringify(line)}`);
  }
});

test("a failed sync survives losing its column", () => {
  // Dropping `SYNC` for width is safe only because it almost always reads `ok`. The moment it does
  // not, every other number in that row is suspect, and silently dropping the one word that says so
  // would turn a width decision into a correctness one.
  const failed = statusFor({ synchronization: { performed: true, status: "failed" } });
  const narrow = renderStatusTable([failed], { color: false, columns: 60 });

  assert.doesNotMatch(narrow, /SYNC/u, "the column itself should still be dropped");
  assert.match(narrow, / {2}! sync failed on work\n/u);
});

test("nothing is said about a sync that worked or was never asked for", () => {
  // The footer exists to carry a dropped warning, not to narrate. A line reading "sync ok on work"
  // under every source would cost exactly as many lines as the column it replaced. `not_requested`
  // is the same: it is what `--no-sync` means, so warning about it is warning the reader about
  // their own flag.
  for (const status of ["ok", "not_requested"]) {
    const narrow = renderStatusTable([statusFor({ synchronization: { status } })], {
      color: false,
      columns: 60,
    });

    assert.doesNotMatch(narrow, /sync/u, `sync ${status} should be silent`);
  }
});

test("a caveat every source repeats is stated once", () => {
  // `createSourceStatus` gives every source the same three closing caveats, so four configured
  // sources printed twelve identical lines under a five-line table. Repetition is how a reader
  // learns to skip a warning; stating it once is what keeps it readable. A caveat only some sources
  // carry is still printed, because there it is telling them apart.
  const text = renderStatusTable(
    [
      statusFor(),
      statusFor({
        source: { alias: "personal", active_period: { started_at: null } },
        caveats: ["Real provider capacity is unknown.", "Sparse history; the prior dominates."],
      }),
    ],
    { color: false, columns: 80 },
  );

  assert.equal(text.match(/Real provider capacity is unknown\./gu)?.length, 1);
  assert.match(text, / {2}! Sparse history; the prior dominates\.\n/u);
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

test("two sources are two panels separated by a blank line", () => {
  // Specification 12.3 gives every configured source its own panel. Without a separator they run
  // together and the second alias reads as another row of the first, which is the one thing a
  // panel layout has to get right that a single dense line never had to.
  const text = renderStatus(
    [
      statusFor(),
      statusFor({ source: { alias: "personal", active_period: { started_at: null } } }),
    ],
    { color: false },
  );

  assert.match(text, /\n\npersonal\n/u);
  assert.equal(text.match(/^\S/gmu)?.length, 2, "expected exactly two unindented alias lines");
  // A source configured but never synchronized has no period to name, and says so rather than
  // printing an empty tail after `period since`.
  assert.match(text, /period since unknown/u);
});
