import assert from "node:assert/strict";
import { test } from "node:test";

import { renderStats, renderStatus, renderStatusTable, sparkline } from "../src/render.js";

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
    // `createSourceStatus` always sets this from the forecast, so the fixture does too: a fixture
    // that omits a field the product cannot omit renders `model unknown` and tests a shape nobody
    // can reach.
    model_policy_version: "stage5-prediction-v2",
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

test("a selected source is a panel written in words", () => {
  // Labels in a fixed-width column, no box drawing -- a box survives neither a narrow terminal nor
  // a pipe, and this output is read through both -- and every value stated as a sentence rather
  // than as the quantity behind it. The reader is a developer deciding whether to send a prompt,
  // not a statistician auditing a model: `95-100%` still appears because it is the estimate, while
  // the percentile, the method and the policy versions identify it rather than state it, and live
  // behind `--verbose` and in the `--json` document.
  const text = renderStatus([statusFor()], { color: false });

  assert.equal(
    text,
    [
      "work",
      "  next prompt  95-100% chance it goes through · risk low",
      "  evidence     moderate — some history, but few refusals seen yet",
      "  pressure     high · above 90% of your own history · typical prompt",
      "  drivers      prompt count, input tokens",
      "  as of        40s ago · sync ok · period since 2026-01-02",
      "  ! Real provider capacity is unknown.",
      "",
    ].join("\n"),
  );
});

test("an estimate the prior alone produced is labelled as the heuristic it is", () => {
  // `docs/specification/analysis.md`: "The UI explicitly labels the method as an initial heuristic;
  // it must not relabel a weak prior as calibrated probability." That is a requirement on the human
  // surface, not on the JSON document, and it applies to the first screen a new source ever shows:
  // before any observation, `buildForecast` backs off to the prior and reports `initial-generic`.
  //
  // Labelled rather than identified: the specification asks the interface to say what the estimate
  // is, and `initial-generic@1` is a key for something that parses, not a statement to a reader.
  const initial = statusFor({
    method: { id: "initial-generic", version: "1" },
    evidence: { level: "very_low", policy_version: "1", gates: [] },
  });

  const heuristic = renderStatus([initial], { color: false });
  const learned = renderStatus([statusFor()], { color: false });

  assert.match(heuristic, / {2}method {7}initial heuristic — /u);
  assert.doesNotMatch(heuristic, /initial-generic/u, "a reader is owed the label, not the key");
  // The learned method identifies the estimate rather than warning about it, so the default panel
  // does not carry it; `--verbose` and every `--json` document do.
  assert.doesNotMatch(learned, / {2}method/u);
});

test("the overview warns when a row is nothing but the prior", () => {
  // The overview is a human surface too, and a table of intervals invites reading every row as the
  // same kind of number. A row that is entirely the plan-profile prior is not a measurement of that
  // source at all, and `EVIDENCE very_low` alone does not say so.
  const initial = statusFor({
    source: { alias: "fresh", active_period: { started_at: null } },
    method: { id: "initial-generic", version: "1" },
    evidence: { level: "very_low", policy_version: "1", gates: [] },
  });

  const text = renderStatusTable([statusFor(), initial], { color: false, columns: 80 });

  assert.match(
    text,
    / {2}! fresh has no history of its own yet; that estimate is the plan profile\n/u,
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

/**
 * One statistics report, shaped as `buildSourceStats` builds it, carrying two horizons because one
 * cannot show that a table compares them and four would make the expectation unreadable. The
 * numbers are a real source's, so the formatting is exercised against magnitudes that actually
 * occur rather than against round ones chosen to be easy.
 *
 * @param {Record<string, unknown>} overrides
 */
function statsFor(overrides = {}) {
  /** @param {number} [value] @param {number} [sample] */
  const dimension = (value, sample = 8) =>
    value === undefined
      ? { unit: "tokens", sample_size: 0, missing: sample }
      : { value, unit: "tokens", sample_size: sample, missing: 0 };
  return {
    source: {
      alias: "work",
      provider: "anthropic",
      plan: "pro",
      plan_profile: { id: "generic", version: "1.0.0", provenance: "bundled", as_of: "2026-01-01" },
    },
    pressure: {
      band: "low",
      baseline_kind: "local",
      policy_version: "stage4-analytics-v1",
      trend: {
        status: "observed",
        direction: "steady",
        windows_compared: 5,
        baseline_windows: 22,
        reason: null,
        policy_version: "stage6-trend-v1",
      },
    },
    calibration: {
      snapshots: 30,
      undelivered_attempts: 0,
      live: {
        status: "reported",
        excluded: 0,
        brier: { value: 0.002, sample_size: 131 },
        interval: { coverage: 0, mean_width: 0.06, sample_size: 131 },
      },
      backtest: {
        brier: { value: 0.02, sample_size: 625 },
        interval: { coverage: 0.5, mean_width: 0.11, sample_size: 625 },
        forecasts: 625,
      },
      policy_version: "stage5-calibration-v1",
    },
    horizons: [
      {
        horizon: "PT1H",
        prompts: { count: 10, eligible: 8, excluded: 2 },
        restrictions: { by_class: {} },
        dimensions: {
          input_tokens: dimension(648),
          output_tokens: dimension(120195),
          reasoning_tokens: dimension(),
          cache_read_tokens: dimension(65468836),
          cache_write_tokens: dimension(2217259),
        },
        cost: { by_currency: {}, sample_size: 0, missing: 8 },
        duration: {
          p50: 158703,
          p90: 448230.39999999997,
          unit: "ms",
          sample_size: 8,
          missing: 0,
          complete: true,
        },
        effective_sample_size: { value: 7.87, unit: "prompts" },
        freshness: { as_of: "2026-01-02T03:04:10.000Z" },
        by_model: [],
      },
      {
        horizon: "P7D",
        prompts: { count: 430, eligible: 418, excluded: 12 },
        restrictions: { by_class: { rate_limit: 3 } },
        dimensions: {
          input_tokens: dimension(450174, 418),
          output_tokens: dimension(15040750, 418),
          reasoning_tokens: dimension(undefined, 418),
          cache_read_tokens: dimension(5104351653, 418),
          cache_write_tokens: dimension(93650724, 418),
        },
        cost: { by_currency: {}, sample_size: 0, missing: 418 },
        duration: {
          p50: 159559,
          p90: 1458804.9000000004,
          unit: "ms",
          sample_size: 418,
          missing: 0,
          complete: true,
        },
        effective_sample_size: { value: 172.04, unit: "prompts" },
        freshness: { as_of: "2026-01-02T03:04:10.000Z" },
        by_model: [],
      },
    ],
    ...overrides,
  };
}

test("stats compares its horizons down a column instead of along a sentence", () => {
  // The old shape put every measurement for one horizon on one run-on line, so comparing an hour
  // with a week meant reading two paragraphs and holding eight numbers. Horizons are rows because
  // the comparison across them is the only question this report exists to answer.
  const text = renderStats(statsFor(), { verbose: false });
  const rows = text.split("\n");
  const header = rows.findIndex((line) => /WINDOW +PROMPTS/u.test(line));

  assert.ok(header >= 0, `no window table in:\n${text}`);
  assert.match(
    rows[header] ?? "",
    /WINDOW +PROMPTS +COUNTED +REFUSED +SET ASIDE +COST +TYPICAL +SLOWEST 10%/u,
  );
  assert.match(rows[header + 1] ?? "", /^ {2}1h +10 +8 +— +2 /u);
  assert.match(rows[header + 2] ?? "", /^ {2}7d +430 +418 +3 rate limit +12 /u);
});

test("stats says a duration the way a person says it", () => {
  // `p50 158703ms p90 448230.39999999997ms` is a float that escaped, and no reader converts
  // milliseconds to minutes in their head to find out whether a prompt is slow today.
  const text = renderStats(statsFor(), { verbose: false });

  assert.match(text, /\b2m39s\b/u);
  assert.match(text, /\b7m28s\b/u);
  assert.doesNotMatch(text, /ms\b/u);
  assert.doesNotMatch(text, /\.39999/u);
});

test("token dimensions keep their own columns and their own names", () => {
  // `docs/specification/observation.md` forbids summing token classes into one consumption score:
  // human output may show subtotals, but a label must preserve its dimension. So the tokens get a
  // second table rather than a folded "tokens in" column, and each column is named for exactly one
  // stored dimension.
  const text = renderStats(statsFor(), { verbose: false });
  const rows = text.split("\n");
  const header = rows.findIndex((line) => /WINDOW +INPUT/u.test(line));

  assert.ok(header >= 0, `no token table in:\n${text}`);
  assert.match(rows[header] ?? "", /WINDOW +INPUT +OUTPUT +REASONING +CACHE READ +CACHE WRITE/u);
  // 5104351653 read at a glance, and a dimension with nothing sampled says so rather than showing
  // a zero it never measured.
  assert.match(rows[header + 2] ?? "", /^ {2}7d +450K +15\.0M +— +5\.10G +93\.7M/u);
});

test("stats states what calibration is worth without stating a Brier score", () => {
  // `live brier 0.002 (sample 131, coverage 0.00)` is four statistics and no sentence, and the
  // reader is a developer, not a modeller. The numbers keep every digit under `--verbose`; the
  // default says how much has been checked, which is the part that decides whether to trust the
  // estimate at all.
  const plain = renderStats(statsFor(), { verbose: false });
  const verbose = renderStats(statsFor(), { verbose: true });

  assert.doesNotMatch(plain, /brier|coverage/iu);
  assert.match(plain, /30 forecasts checked/u);
  assert.match(verbose, /brier 0\.002/u);
  assert.match(verbose, /stage5-calibration-v1/u);
});

test("--verbose breaks each window down by model", () => {
  // Specification 11: the same token dimensions broken down by model, counting usage slices rather
  // than prompts, because one prompt can span several models and counting it once per model would
  // report more prompts than were made.
  const first = statsFor().horizons[0];
  const report = statsFor({
    horizons: [
      {
        ...first,
        by_model: [
          {
            model: "opus",
            slices: { count: 6, unit: "usage slices" },
            dimensions: {
              input_tokens: { value: 600, unit: "tokens", sample_size: 6, missing: 0 },
            },
            cost: { by_currency: {}, sample_size: 0, missing: 6 },
          },
        ],
      },
    ],
  });

  const plain = renderStats(report, { verbose: false });
  const verbose = renderStats(report, { verbose: true });

  assert.doesNotMatch(plain, /opus/u);
  assert.match(verbose, /^ {2}1h +opus +6 +600\b/mu);
  assert.match(verbose, /usage slices/u);
});

test("the per-client comparison stays counts over denominators", () => {
  // A refusal share printed as a percentage reads as a measurement of the provider's real
  // behaviour, which is exactly the claim this product never makes. "87 of 1180 counted" says the
  // same thing while showing how much evidence is behind it.
  const report = statsFor({
    by_client: {
      groups: [
        {
          client: "opencode",
          restricted: 3,
          eligible: 418,
          restriction_share: { lower: 0.002, upper: 0.021 },
          difference: "not_detected",
        },
      ],
      unattributed: { prompts: 2 },
      reason: null,
      policy_version: "stage8-client-v1",
    },
  });

  const text = renderStats(report, { verbose: false });

  const clientLine = text.split("\n").find((line) => line.includes("opencode")) ?? "";

  assert.match(clientLine, /3 of 418 counted/u);
  assert.match(clientLine, /difference not detected/u);
  assert.match(text, /2 prompts could not be attributed/u);
  // Scoped to the client line rather than the whole report, which legitimately carries a `10%` in
  // the `SLOWEST 10%` heading. What must never appear is the refusal share as a percentage.
  assert.doesNotMatch(
    clientLine,
    /%/u,
    "a share printed as a percentage reads as a capacity claim",
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

  assert.match(text, / {2}drivers {6}nothing to compare against yet/u);
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

test("the verbose panel names the method and both policy versions", () => {
  // The invariant is that an estimate can always say which method produced it. `1.1.3` moved that
  // off the default panel, which is only allowed because `--verbose` and `--json` both carry it --
  // so this flag existing is part of the invariant rather than a convenience.
  const plain = renderStatus([statusFor()], { color: false });
  const verbose = renderStatus([statusFor({ model_policy_version: "stage5-model-v1" })], {
    color: false,
    verbose: true,
  });

  assert.doesNotMatch(plain, /bayesian-pressure-band/u);
  assert.match(verbose, / {2}method {7}bayesian-pressure-band@1 · model stage5-model-v1\n/u);
});

test("the verbose panel names every evidence gate and marks the limiting one", () => {
  // Which gate is holding the level down is the actionable half of the evidence ladder: a reader
  // whose estimate is capped by `completeness` has a synchronization problem, and one capped by
  // `restrictions` simply has not been refused enough times yet. Naming the level alone says
  // neither.
  const verbose = renderStatus(
    [
      statusFor({
        evidence: {
          level: "low",
          policy_version: "1",
          gates: [
            { id: "sample", level: "high", limiting: false },
            { id: "restrictions", level: "low", limiting: true },
            { id: "relevance", level: "moderate", limiting: false },
            { id: "completeness", level: "low", limiting: true },
          ],
        },
      }),
    ],
    { color: false, verbose: true },
  );

  assert.match(verbose, / {2}gates {8}sample high · restrictions low \(limiting\)/u);
  assert.match(verbose, /completeness low \(limiting\)/u);
});

test("the verbose panel ranks each driver without ever claiming a share of a capacity", () => {
  // The percentile is what `--verbose` adds to the drivers, and it is said the way the panel says
  // every other percentile: a rank against the reader's own history. `input_tokens 90th` asks the
  // reader to know what a percentile is; "above 90% of your own history" is the literal reading,
  // and pointedly not "90% used", which would be a share of a capacity nobody can see.
  const verbose = renderStatus([statusFor()], { color: false, verbose: true });

  // The top of the scale is a statement rather than `above 100%`, which reads as a share of
  // something rather than as a rank against the reader's own past.
  assert.match(verbose, /prompt count higher than every window in your own history/u);
  assert.match(verbose, /input tokens above 90% of your own history/u);
  assert.doesNotMatch(verbose, /\bused\b/u);
  // The default still names them and stops there.
  const plain = renderStatus([statusFor()], { color: false });
  assert.match(plain, / {2}drivers {6}prompt count, input tokens\n/u);
});

test("a verbose panel still labels an estimate the prior alone produced", () => {
  // The heuristic warning and the method identifier are two different requirements, and `--verbose`
  // is where both are visible at once. The warning carries no identifier by design; the method row
  // carries nothing else.
  const verbose = renderStatus([statusFor({ method: { id: "initial-generic", version: "1" } })], {
    color: false,
    verbose: true,
  });

  assert.match(verbose, /initial heuristic/u);
  assert.match(verbose, /initial-generic@1/u);
});

test("a verbose heuristic panel labels one method row, not two", () => {
  // The warning and the identifier are two different statements about the same estimate, and both
  // belong on a verbose panel. Printed as two rows they both claim the label `method`, and an
  // aligned label column exists so that a label identifies its row. The identifier becomes an
  // unlabelled continuation of the row the warning already owns.
  const verbose = renderStatus(
    [
      statusFor({
        method: { id: "initial-generic", version: "1" },
        evidence: { level: "very_low", policy_version: "1", gates: [] },
      }),
    ],
    { color: false, verbose: true },
  );

  const labelled = verbose.split("\n").filter((line) => /^ {2}method {7}\S/u.test(line));
  assert.equal(labelled.length, 1, verbose);
  assert.match(verbose, / {2}method {7}initial heuristic — /u);
  assert.match(verbose, /\n {15}initial-generic@1 · model /u);
});

test("panels state a caveat every source repeats once, and keep the ones that differ", () => {
  // The defect `1.1.3` fixed, reintroduced by `--verbose` rendering panels: four sources printed
  // twelve identical caveat lines under four panels. A warning repeated per panel is a warning a
  // reader learns to skip. A caveat only one source carries is not shared and stays with it, or the
  // footer would claim it of every source.
  const text = renderStatus(
    [
      statusFor({
        source: { alias: "one", active_period: { started_at: null } },
        caveats: ["shared one", "shared two", "only one"],
      }),
      statusFor({
        source: { alias: "two", active_period: { started_at: null } },
        caveats: ["shared one", "shared two"],
      }),
    ],
    { color: false },
  );

  assert.equal(text.split("\n").filter((line) => line.includes("shared one")).length, 1);
  assert.equal(text.split("\n").filter((line) => line.includes("shared two")).length, 1);
  // The one-source caveat stays inside that source's panel, above the shared block.
  assert.match(text, /^one$[\s\S]*^ {2}! only one$[\s\S]*^two$/mu);
  assert.match(text, /^two$[\s\S]*^ {2}! shared one$/mu);
});

test("a single panel keeps its caveats, because there is nothing to share them with", () => {
  // `status --source <alias>` is the shape this must not change: one panel, its caveats under it.
  const text = renderStatus([statusFor()], { color: false });

  assert.match(text, / {2}! Real provider capacity is unknown\.\n$/u);
});

test("the ends of the pressure scale are statements, not percentages", () => {
  // `above 0% of your own history` is true and says nothing. A score of 0 means no baseline window
  // ranked at or below the observed one -- `percentileRank` counts ties as half -- so the window is
  // the lightest on record, and that is what a reader is owed. Same at the top.
  const floor = renderStatus(
    [statusFor({ pressure: { band: "low", score: 0, contributors: [] } })],
    {
      color: false,
    },
  );
  const ceiling = renderStatus(
    [statusFor({ pressure: { band: "high", score: 1, contributors: [] } })],
    { color: false },
  );

  assert.match(floor, /lower than every window in your own history/u);
  assert.doesNotMatch(floor, /above 0%/u);
  assert.match(ceiling, /higher than every window in your own history/u);
  assert.doesNotMatch(ceiling, /above 100%/u);
});

test("a small but real rank does not borrow the sentence reserved for the floor", () => {
  // Contributions are weighted, so a rank of 1/60 on a quarter-weighted dimension lands near 0.004
  // and rounds to `0%`. Printing the floor's sentence there would claim the window was the lightest
  // on record when it was not. The same holds just under the ceiling.
  const low = renderStatus(
    [statusFor({ pressure: { band: "low", score: 0.004, contributors: [] } })],
    {
      color: false,
    },
  );
  const high = renderStatus(
    [statusFor({ pressure: { band: "high", score: 0.998, contributors: [] } })],
    { color: false },
  );

  assert.match(low, /in the lowest 1% of your own history/u);
  assert.doesNotMatch(low, /lower than every window/u);
  assert.match(high, /in the highest 1% of your own history/u);
  assert.doesNotMatch(high, /higher than every window/u);
});

test("an ordinary rank still reads as a rank against your own history", () => {
  const text = renderStatus([statusFor()], { color: false });
  assert.match(text, /above 90% of your own history/u);
});
