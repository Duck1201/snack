import assert from "node:assert/strict";
import { test } from "node:test";

import fc from "fast-check";

import { PLOT_POLICY, TREND_POLICY } from "../src/analytics.js";
import { MINIMUM_COLUMNS, measure, minimumRows, renderDash } from "../src/dash-view.js";
import { renderStatus } from "../src/render.js";
import {
  CODEX,
  FRESH,
  NOW,
  SERIES,
  ago,
  everyDashState,
  reportFor,
  sequenceStateFor,
  stateFor,
} from "./fixtures/dash-states.js";

/** @typedef {import("../src/dash-view.js").DashState} DashState */

const WIDTHS = [64, 80, 120];

/** @param {string} value */
function plain(value) {
  // eslint-disable-next-line no-control-regex -- an escape sequence is exactly what is removed
  return value.replace(/\u001B\[[0-9;]*m/gu, "");
}

test("the list and the detail at 80 columns read as the specification draws them", () => {
  const { lines, drawn } = renderDash(stateFor(), { columns: 80, rows: 24 }, { color: false });
  assert.deepEqual(lines, [
    " snack dash · 3 capacity sources                   synced 12s ago · next in 48s",
    "   SOURCE  NEXT PROMPT    RISK    EVIDENCE  PRESSURE  LAST SEEN   SYNC",
    " ▸ work      95-100%      low       high    moderate   2m ago      ok",
    "   codex     61-99%     elevated    low       high     4m ago      ok",
    "   home       2-98%       high    very_low  unknown     never    failed",
    " ──────────────────────────────────────────────────────────────────────────────",
    " work",
    "   next prompt  95-100% chance it goes through · risk low",
    "   evidence     high — enough of your own history to lean on",
    "   pressure     moderate · above 62% of your own history · typical prompt",
    "                lightest ├───────────────●─────────┤ heaviest",
    "   by hour      ▂▃▂·▄▅▆▅▃▂··▂▃▄▅▇█▆▅▄▃▁▅  each hour against your own history",
    "                24h ago              now",
    "   drivers      prompt count, output tokens",
    "   as of        2m ago · period since 2026-09-30",
    "   ! The estimate is not yet calibrated against observed outcomes.",
    "   ! Real provider capacity is unknown.",
    "   ! Usage pressure compares this window with local history; it is not a share",
    "     of capacity.",
    "",
    " ↑↓ select   s next N   r sync now   ? help   q quit",
  ]);
  assert.deepEqual(drawn, ["work", "codex", "home"]);
});

test("every widget fits 64, 80 and 120 columns, and draws every forecast it lists", () => {
  for (const [name, state] of everyDashState()) {
    for (const columns of WIDTHS) {
      for (const rows of [minimumRows(state), 24, 60]) {
        const { lines, drawn } = renderDash(state, { columns, rows }, { color: true });
        const where = `${name} at ${columns}x${rows}`;
        assert.ok(lines.length <= rows, `${where}: ${lines.length} rows`);
        for (const line of lines) {
          // The last column is never written: a terminal holding a pending wrap there erases the
          // character on the following erase-to-end-of-line.
          assert.ok(measure(line) < columns, `${where}: ${JSON.stringify(plain(line))}`);
        }
        const withReport = state.sources.filter((source) => source.report !== null);
        assert.deepEqual(
          drawn,
          withReport.map((source) => source.alias),
          where,
        );
        assert.match(plain(lines.at(-1) ?? ""), /q quit/u, `${where}: key bar`);
      }
    }
  }
});

test("the selected row carries the marker and no other row does", () => {
  for (const selected of [0, 1, 2]) {
    const { lines } = renderDash(
      stateFor({ selected }),
      { columns: 80, rows: 24 },
      { color: false },
    );
    const marked = lines.filter((line) => line.startsWith(" ▸ "));
    assert.equal(marked.length, 1);
    assert.match(
      String(marked[0]),
      new RegExp(`^ ▸ ${["work", "codex", "home"][selected]}\\b`, "u"),
    );
  }
});

test("the detail is the selected source's", () => {
  const { lines } = renderDash(
    stateFor({ selected: 1 }),
    { columns: 80, rows: 30 },
    { color: false },
  );
  const text = lines.join("\n");
  assert.match(
    text,
    /\n codex\n {3}next prompt {2}61-99% chance it goes through · risk elevated\n/u,
  );
  assert.match(
    text,
    /\n {3}reported {5}Codex states 40% of its 5h window, resets in 1h 0m · 5m ago/u,
  );
});

test("an estimate that is the plan profile alone is labelled, and its plot owns its absence", () => {
  const { lines } = renderDash(
    stateFor({ selected: 2 }),
    { columns: 80, rows: 30 },
    { color: false },
  );
  const text = lines.join("\n");
  assert.match(
    text,
    / {3}method {7}initial heuristic — no history of your own is behind this yet/u,
  );
  assert.match(text, / {3}by hour {6}no baseline to compare against yet/u);
  assert.doesNotMatch(text, /lightest/u, "no score, no scale");
  assert.match(text, / {3}as of {8}unknown · period since 2026-09-30/u);
});

test("the help pane replaces the detail and leaves the list drawn", () => {
  const { lines, drawn } = renderDash(
    stateFor({ pane: "help" }),
    { columns: 80, rows: 30 },
    {
      color: false,
    },
  );
  const text = lines.join("\n");
  assert.match(text, /\n keys\n/u);
  assert.match(text, /snack status --verbose/u);
  assert.match(text, /snack status --json/u);
  assert.doesNotMatch(text, /next prompt {2}/u);
  assert.match(text, / ▸ work/u);
  assert.deepEqual(drawn, ["work", "codex", "home"]);
});

test("too small: one sentence, no forecast, nothing drawn", () => {
  const state = stateFor();
  assert.equal(minimumRows(state), 15, "three sources need fifteen rows");
  for (const size of [
    { columns: 58, rows: 20 },
    { columns: MINIMUM_COLUMNS - 1, rows: 40 },
    { columns: 120, rows: 14 },
  ]) {
    const { lines, drawn } = renderDash(state, size, { color: true });
    assert.deepEqual(drawn, []);
    const text = lines
      .map((line) => line.trim())
      .filter((line) => line !== "")
      .join(" ");
    assert.match(
      text,
      new RegExp(
        `^snack dash needs at least 64 columns and 15 rows for 3 sources; this terminal has ${size.columns}×${size.rows}\\. q quits\\.$`,
        "u",
      ),
    );
    assert.ok(lines.length <= size.rows);
    for (const line of lines) assert.ok(measure(line) < size.columns, line);
    assert.doesNotMatch(text, /%/u);
  }
  // Exactly at the minimum it draws.
  assert.deepEqual(renderDash(state, { columns: 64, rows: 15 }, { color: false }).drawn, [
    "work",
    "codex",
    "home",
  ]);
});

test("the sequence row's height is reserved whether or not it informs", () => {
  // The minimum depends on whether the row is on, never on what it says: a terminal that turned
  // too small at one length and not the next would mark the edge the row exists not to reveal.
  const informative = sequenceStateFor(10, { tooWide: false });
  const wide = sequenceStateFor(10, { tooWide: true, priorTail: true });
  assert.equal(minimumRows(informative), minimumRows(wide));
  assert.equal(minimumRows(informative), minimumRows(stateFor()) + 2);
});

test("a tiny terminal still gets the sentence, cut to what fits", () => {
  const { lines, drawn } = renderDash(stateFor(), { columns: 20, rows: 3 }, { color: false });
  assert.deepEqual(drawn, []);
  assert.ok(lines.length <= 3);
  for (const line of lines) assert.ok(measure(line) < 20, line);
});

test("NO_COLOR draws no escape sequence, and colour changes nothing but escapes", () => {
  for (const [name, state] of everyDashState()) {
    for (const columns of WIDTHS) {
      const size = { columns, rows: 30 };
      const off = renderDash(state, size, { color: false });
      const on = renderDash(state, size, { color: true });
      for (const line of off.lines) assert.ok(!line.includes("\u001B["), `${name}: ${line}`);
      assert.deepEqual(on.lines.map(plain), off.lines, `${name} at ${columns}`);
      assert.deepEqual(on.drawn, off.drawn);
    }
  }
  const coloured = renderDash(stateFor(), { columns: 80, rows: 24 }, { color: true });
  assert.ok(
    coloured.lines.some((line) => line.includes("\u001B[")),
    "colour on paints something",
  );
});

/** @param {string[]} lines */
function scaleLine(lines) {
  return lines.map(plain).find((line) => line.includes("lightest"));
}

test("the scale is a marker on a track, never a filled bar", () => {
  fc.assert(
    fc.property(
      fc.double({ min: 0, max: 1, noNaN: true }),
      fc.constantFrom(...WIDTHS),
      (score, columns) => {
        const report = reportFor({ pressure: { ...reportFor().pressure, score } });
        const state = stateFor();
        const first = /** @type {DashState["sources"][number]} */ (state.sources[0]);
        const { lines } = renderDash(
          { ...state, sources: [{ ...first, report }, ...state.sources.slice(1)] },
          { columns, rows: 30 },
          { color: true },
        );
        const line = String(scaleLine(lines)).trim();
        const match = /^lightest ├(─*)●(─*)┤ heaviest$/u.exec(line);
        assert.ok(match, line);
        assert.equal(line.split("●").length - 1, 1, "exactly one marker");
        assert.doesNotMatch(line, /[█▓▒░■▮▁▂▃▄▅▆▇=#]/u, "no glyph that fills");
        const track = String(match[1]).length + 1 + String(match[2]).length;
        assert.equal(String(match[1]).length, Math.round(score * (track - 1)));
      },
    ),
  );
});

test("the scale paints only its marker", () => {
  const { lines } = renderDash(stateFor(), { columns: 80, rows: 24 }, { color: true });
  const line = String(lines.find((text) => text.includes("lightest")));
  // eslint-disable-next-line no-control-regex -- the escape sequences around a painted run
  const painted = [...line.matchAll(/\u001B\[[0-9;]*m([^\u001B]*)\u001B\[[0-9;]*m/gu)].map(
    (match) => match[1],
  );
  assert.deepEqual(painted, ["●"]);
});

test("no score means no scale line at all", () => {
  const report = reportFor({ pressure: { horizon: "PT1H", band: "unknown", contributors: [] } });
  const state = stateFor();
  const first = /** @type {DashState["sources"][number]} */ (state.sources[0]);
  const { lines } = renderDash(
    { ...state, sources: [{ ...first, report }, ...state.sources.slice(1)] },
    { columns: 80, rows: 24 },
    { color: false },
  );
  assert.equal(scaleLine(lines), undefined);
});

test("the plot draws the dash's own 24 windows, not the trend's five", () => {
  assert.equal(PLOT_POLICY.windows, 24);
  assert.equal(TREND_POLICY.windows, 5, "the published trend does not move");
  assert.equal(SERIES.length, PLOT_POLICY.windows);
  for (const columns of WIDTHS) {
    const { lines } = renderDash(stateFor(), { columns, rows: 24 }, { color: false });
    const index = lines.findIndex((line) => line.startsWith("   by hour"));
    const plot = String(lines[index]).slice(16, 16 + PLOT_POLICY.windows);
    assert.match(plot, /^[▁▂▃▄▅▆▇█·]{24}$/u, `${columns}: ${plot}`);
    // An hour with no prompt is an absence, never the lightest hour.
    assert.equal(
      [...plot]
        .map((glyph, at) => (glyph === "·" ? at : -1))
        .filter((at) => at >= 0)
        .join(),
      "3,10,11",
    );
    const axis = String(lines[index + 1]);
    assert.equal(axis.trim(), `24h ago${" ".repeat(14)}now`);
    assert.equal(axis.length, 16 + PLOT_POLICY.windows, "now sits under the newest window");
  }
});

test("a window that is not an hour is named a window", () => {
  const state = stateFor();
  const first = /** @type {DashState["sources"][number]} */ (state.sources[0]);
  const { lines } = renderDash(
    { ...state, sources: [{ ...first, seriesHorizon: "PT5H" }, ...state.sources.slice(1)] },
    { columns: 80, rows: 24 },
    { color: false },
  );
  assert.ok(lines.some((line) => /^ {3}by window {4}\S{24} {2}each window against/u.test(line)));
  assert.ok(lines.some((line) => /^ {16}24 × 5h ago {10}now$/u.test(line)));
});

test("the interval the dash prints is the interval status prints, for any viability", () => {
  fc.assert(
    fc.property(
      fc.double({ min: 0, max: 1, noNaN: true }),
      fc.double({ min: 0, max: 1, noNaN: true }),
      (a, b) => {
        const viability = {
          lower: Math.min(a, b),
          point: (a + b) / 2,
          upper: Math.max(a, b),
          coverage_target: 0.8,
        };
        const report = reportFor({ viability });
        const panel = renderStatus([/** @type {never} */ (report)], { color: false });
        const shown = String(/next prompt {2}(\S+) chance/u.exec(panel)?.[1]);
        const state = stateFor();
        const first = /** @type {DashState["sources"][number]} */ (state.sources[0]);
        const { lines } = renderDash(
          { ...state, sources: [{ ...first, report }, ...state.sources.slice(1)] },
          { columns: 80, rows: 24 },
          { color: false },
        );
        const text = lines.join("\n");
        assert.ok(text.includes(`   next prompt  ${shown} chance`), shown);
        assert.ok(String(lines[2]).includes(` ${shown} `), String(lines[2]));
      },
    ),
  );
});

test("an informative sequence row states its interval beneath next prompt", () => {
  const { lines } = renderDash(
    sequenceStateFor(10, { tooWide: false }),
    { columns: 80, rows: 26 },
    {
      color: false,
    },
  );
  const at = lines.indexOf("   next prompt  95-100% chance it goes through · risk low");
  assert.equal(lines[at + 1], "   next 10      52-100% chance all 10 go through · risk elevated");
  assert.ok(
    lines.some((line) => line.includes("The 10-prompt estimate assumes each prompt")),
    "the assumption that qualifies the numbers is stated with them",
  );
});

test("an informative sequence row keeps its risk word at 64 columns", () => {
  const { lines } = renderDash(
    sequenceStateFor(100, { tooWide: false }),
    { columns: 64, rows: 24 },
    {
      color: false,
    },
  );
  const at = lines.findIndex((line) => line.startsWith("   next 100"));
  assert.equal(lines[at], "   next 100     52-100% chance all 100 go through");
  assert.equal(lines[at + 1], "                · risk elevated");
});

/**
 * The sequence block: the `next N` row and its continuation lines, up to the next label.
 *
 * @param {string[]} lines
 * @param {number} length
 */
function sequenceBlock(lines, length) {
  const start = lines.findIndex((line) => line.startsWith(`   next ${length} `));
  assert.ok(start >= 0, `a next ${length} row:\n${lines.join("\n")}`);
  const end = lines.findIndex((line, at) => at > start && /^ {3}\S/u.test(line));
  return lines.slice(start, end);
}

test("a sequence too wide to inform prints no number but its length", () => {
  for (const length of [1, 2, 7, 10, 23, 50, 100]) {
    for (const priorTail of [false, true]) {
      for (const columns of WIDTHS) {
        const state = sequenceStateFor(length, { tooWide: true, priorTail });
        for (const rows of [minimumRows(state), 40]) {
          const { lines } = renderDash(state, { columns, rows }, { color: false });
          const block = sequenceBlock(lines, length)
            .map((line) => line.trim())
            .join(" ");
          const where = `next ${length} at ${columns}x${rows}`;
          assert.match(block, /too wide to say much/u, where);
          assert.doesNotMatch(block, /%/u, where);
          const digits = block.replaceAll(new RegExp(`(?<!\\d)${length}(?!\\d)`, "gu"), "");
          assert.doesNotMatch(digits, /\d/u, `${where}: ${block}`);
          if (priorTail && rows === 40) assert.match(block, /starting assumption/u, where);
        }
      }
    }
  }
});

test("too wide: the row is the status caveat, word for word", () => {
  const { lines } = renderDash(
    sequenceStateFor(10, { tooWide: true, priorTail: true }),
    {
      columns: 120,
      rows: 40,
    },
    { color: false },
  );
  const block = sequenceBlock(lines, 10);
  assert.equal(
    block.map((line) => line.slice(16)).join(" "),
    "The 10-prompt interval is too wide to say much; it cannot tell whether all of them going through is more likely than not. " +
      "Your recent history has no restriction to learn from, so the low end of this interval comes from SNACK's starting assumption rather than from your history.",
  );
  assert.ok(!lines.some((line) => line.includes("assumes each prompt")), "no figure to qualify");
});

test("a length the reading has not reached yet waits rather than guessing", () => {
  const { lines } = renderDash(
    stateFor({ sequenceLength: 7 }),
    { columns: 80, rows: 24 },
    {
      color: false,
    },
  );
  const block = sequenceBlock(lines, 7).join("\n");
  assert.equal(block, "   next 7       waiting for this reading");
});

test("the key bar names the sequence keys only while the row is on", () => {
  const off = renderDash(stateFor(), { columns: 80, rows: 24 }, { color: false }).lines.at(-1);
  const on = renderDash(
    sequenceStateFor(10, { tooWide: false }),
    { columns: 80, rows: 26 },
    {
      color: false,
    },
  ).lines.at(-1);
  assert.equal(off, " ↑↓ select   s next N   r sync now   ? help   q quit");
  assert.equal(on, " ↑↓ select   s hide next N   + - change N   r sync now   ? help   q quit");
});

test("header states read as the specification words them", () => {
  const base = stateFor();
  /** @type {[Partial<DashState>, RegExp][]} */
  const cases = [
    [{}, /synced 12s ago · next in 48s$/u],
    [
      { sync: { phase: "running", startedAt: ago(3), endedAt: null, outcome: null, nextAt: null } },
      /synchronizing… 3s$/u,
    ],
    [
      { sync: { ...base.sync, outcome: "storage_busy" } },
      /sync skipped — another snack command is using storage · next in 48s$/u,
    ],
    [
      { sync: { ...base.sync, outcome: "failed" } },
      /sync failed — run snack doctor · next in 48s$/u,
    ],
    [
      {
        sync: { phase: "idle", startedAt: null, endedAt: null, outcome: null, nextAt: null },
        reading: { computedAt: null, stale: false, storage: "missing", pendingMigrations: 0 },
      },
      /preparing storage…$/u,
    ],
  ];
  for (const [overrides, expected] of cases) {
    const { lines } = renderDash(stateFor(overrides), { columns: 120, rows: 24 }, { color: false });
    assert.match(String(lines[0]), expected);
  }
});

test("banners say what storage is doing, under the header", () => {
  /** @type {[DashState["reading"], string][]} */
  const cases = [
    [
      { computedAt: null, stale: false, storage: "pending", pendingMigrations: 2 },
      " Preparing storage — the first synchronization applies 2 pending migrations; a backup is taken first.",
    ],
    [
      { computedAt: null, stale: false, storage: "pending", pendingMigrations: 1 },
      " Preparing storage — the first synchronization applies 1 pending migration; a backup is taken first.",
    ],
    [
      { computedAt: null, stale: false, storage: "missing", pendingMigrations: 0 },
      " Preparing storage — the first synchronization creates it.",
    ],
    [
      { computedAt: null, stale: false, storage: "unprepared", pendingMigrations: 0 },
      " Storage could not be prepared; run snack sync to see why.",
    ],
    [
      { computedAt: ago(60), stale: true, storage: "newer", pendingMigrations: 0 },
      " Storage was upgraded by a newer snack; quit and start snack dash again.",
    ],
  ];
  for (const [reading, banner] of cases) {
    const { lines } = renderDash(
      stateFor({ reading }),
      { columns: 120, rows: 24 },
      {
        color: false,
      },
    );
    assert.equal(lines[1], banner);
  }
});

test("a stale reading says how old it is", () => {
  const base = stateFor();
  const { lines } = renderDash(
    stateFor({ reading: { ...base.reading, computedAt: ago(240), stale: true } }),
    { columns: 120, rows: 24 },
    { color: false },
  );
  assert.ok(
    lines.includes(
      "   as of        2m ago · period since 2026-09-30 · showing the reading from 4m ago",
    ),
  );
});

test("a source with no reading yet is listed and not counted as drawn", () => {
  const state = stateFor();
  const first = /** @type {DashState["sources"][number]} */ (state.sources[0]);
  const { lines, drawn } = renderDash(
    { ...state, sources: [{ ...first, report: null, sync: "waiting" }, ...state.sources.slice(1)] },
    { columns: 80, rows: 24 },
    { color: false },
  );
  assert.match(String(lines[2]), /^ ▸ work +no reading/u);
  assert.ok(lines.includes("   no reading yet; it appears after the first synchronization"));
  assert.deepEqual(drawn, ["codex", "home"]);
});

test("the view reads its time from the state alone", () => {
  // A second later the ages move and nothing else does: the redraw clock is the state's `now`.
  const state = stateFor();
  const later = { ...state, now: new Date(Date.parse(NOW) + 1000).toISOString() };
  const first = renderDash(state, { columns: 80, rows: 24 }, { color: false }).lines;
  const second = renderDash(later, { columns: 80, rows: 24 }, { color: false }).lines;
  assert.deepEqual(
    first.map((line, at) => (line === second[at] ? null : at)).filter((at) => at !== null),
    [0],
  );
  assert.deepEqual(renderDash(state, { columns: 80, rows: 24 }, { color: false }).lines, first);
});

test("any state and any size fits, and drawn is every reading unless too small", () => {
  const score = fc.option(fc.double({ min: 0, max: 1, noNaN: true }), { nil: null });
  fc.assert(
    fc.property(
      fc.integer({ min: 1, max: 220 }),
      fc.integer({ min: 1, max: 70 }),
      fc.integer({ min: 0, max: 2 }),
      fc.constantFrom("detail", "help"),
      fc.array(score, { maxLength: 30 }),
      fc.option(fc.integer({ min: 1, max: 100 }), { nil: null }),
      fc.boolean(),
      fc.boolean(),
      (columns, rows, selected, pane, series, length, tooWide, color) => {
        const sequenced =
          length === null ? stateFor() : sequenceStateFor(length, { tooWide, priorTail: tooWide });
        /** @type {DashState} */
        const state = {
          ...sequenced,
          selected,
          pane: /** @type {"detail" | "help"} */ (pane),
          sources: sequenced.sources.map((source) => ({ ...source, series })),
        };
        const { lines, drawn } = renderDash(state, { columns, rows }, { color });
        assert.ok(lines.length <= rows);
        for (const line of lines) assert.ok(measure(line) < columns || columns === 1, line);
        const small = columns < MINIMUM_COLUMNS || rows < minimumRows(state);
        assert.deepEqual(drawn, small ? [] : ["work", "codex", "home"]);
      },
    ),
  );
});

test("the fixtures are the reports the view says it reads", () => {
  // Guards the fixtures themselves: a field the view reads and the fixture lacks would test a
  // shape nobody can reach.
  for (const report of [reportFor(), CODEX, FRESH]) {
    assert.ok(report.viability && report.risk && report.evidence && report.method);
    assert.ok(Array.isArray(report.caveats));
  }
});
