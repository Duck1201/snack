import { styleText } from "node:util";

import { PLOT_POLICY } from "./analytics.js";
import { SEQUENCE_MAX_LENGTH } from "./prediction.js";
import { sparkline } from "./render.js";

/**
 * The widgets of `snack dash`, as one pure function: `renderDash(state, size, options)`.
 *
 * No widget reads a clock, an environment variable, a file or a stream. The frame's time is
 * `state.now`, its size is `size`, its colour decision is `options.color` -- all three made by the
 * controller once (`dash.js`) -- so every pane, banner and size is tested from a written-out state.
 * The result is the frame's lines, each already fitted to the terminal, and `drawn`: the aliases
 * whose forecast (interval, risk and evidence) a reader can see in this frame, which is how the
 * controller knows which snapshot was rendered (ADR-0008).
 *
 * Human formatting, like `render.js`, and not a public contract. The wording is the panel's: a
 * dash row says what the `status` panel says about the same reading, with the same rounding.
 */

/**
 * The subset of a source report (`createSourceStatus`'s return) the dash reads, stated as its own
 * shape for the reason `render.js` gives for `SourceStatusView`.
 *
 * @typedef {object} DashReport
 * @property {{alias: string, active_period: {started_at: string | null}}} source
 * @property {{lower: number, upper: number}} viability
 * @property {{label: string}} risk
 * @property {{level: string}} evidence
 * @property {{id: string, version: string}} method
 * @property {{score?: number | null, band: string, contributors?: {dimension: string, percentile: number | null, contribution: number | null}[]}} pressure
 * @property {string} expected_prompt_category
 * @property {{as_of: string | null}} freshness
 * @property {string[]} caveats
 * @property {ReportedView[]} [reported_capacity]
 */

/**
 * @typedef {object} ReportedView
 * @property {string | null} limit_id
 * @property {string} stated_at
 * @property {number} age_seconds
 * @property {{window_minutes: number, used_percent: number, resets_at: string | null, reset_passed: boolean}[]} windows
 */

/**
 * The sequence reading for the person's chosen length (decision D3), as the controller computed it
 * from the cached forecast with `assessSequence`.
 *
 * `caveats` carries `status.js`'s own sentences for this length, so the dash says word for word
 * what `status --sequence` says: `assumption` (null at one), `tooWide` (null unless
 * `sequence-width-v1` calls the interval too wide) and `priorTail` (the `sequence-prior-tail-v1`
 * diagnostic, null unless it applies).
 *
 * @typedef {object} DashSequence
 * @property {{length: number, viability: {lower: number, upper: number}, risk: {label: string}, width: {too_wide: boolean}}} assessment
 * @property {{assumption: string | null, tooWide: string | null, priorTail: string | null}} caveats
 */

/**
 * @typedef {object} DashSource
 * @property {string} alias
 * @property {DashReport | null} report Null until the first recompute produced a reading.
 * @property {(number | null)[]} series The plot, oldest first; null is a window with no prompt.
 * @property {string} seriesHorizon The primary horizon, an ISO 8601 duration (`PT1H`).
 * @property {"ok" | "failed" | "busy" | "waiting"} sync
 * @property {DashSequence} [sequence] Present when `sequenceLength` is set and computed.
 */

/**
 * The frozen interface of spec §9.2, with the D3 extension (`sequenceLength`, and `sequence` on a
 * source) and `report: null` for a source with no reading yet.
 *
 * @typedef {object} DashState
 * @property {string} now ISO instant of this frame.
 * @property {DashSource[]} sources In configuration order.
 * @property {number} selected
 * @property {"detail" | "help"} pane
 * @property {{phase: "idle" | "running", startedAt: string | null, endedAt: string | null, outcome: "ok" | "failed" | "storage_busy" | "storage_newer" | null, nextAt: string | null}} sync
 * @property {{computedAt: string | null, stale: boolean, storage: "ready" | "missing" | "pending" | "unprepared" | "newer", pendingMigrations: number}} reading
 * @property {number | null} sequenceLength The person's N for the `next N` row; null hides it.
 */

/** @typedef {Exclude<Parameters<typeof styleText>[0], readonly unknown[]>} Style */
/** @typedef {(value: string, style?: Style) => string} Paint */

/**
 * The narrowest terminal the dash draws in. The longest `next prompt` row -- `100-100% chance it
 * goes through · risk elevated`, 47 columns -- after the 16-column label indent still fits, with the
 * last column left unwritten.
 */
export const MINIMUM_COLUMNS = 64;

/**
 * Rows a frame needs: the header, a banner, the list header, one row per source, the rule, the
 * detail's essential rows, the key bar. The `next N` row reserves its widest form (a caveat
 * wrapped over three lines) whenever it is on, informative or not -- a terminal that turned too
 * small at one length and not at the next would mark exactly the edge the row must not reveal.
 *
 * @param {DashState} state
 */
export function minimumRows(state) {
  return state.sources.length + 12 + (state.sequenceLength === null ? 0 : SEQUENCE_EXTRA_LINES);
}

/** The continuation lines a `next N` row may take beyond its first. */
const SEQUENCE_EXTRA_LINES = 2;

/** Where a detail row's value starts: one margin column, two of indent, the label column. */
const VALUE = 16;

/** The panel's label column (`render.js` `LABEL`). */
const LABEL = 13;

/** Risk and pressure share one scale, so they share one set of colours (`render.js` `SCALE`). */
/** @type {Record<string, Style>} */
const SCALE = {
  low: "green",
  moderate: "yellow",
  elevated: "yellow",
  high: "red",
  unknown: "gray",
};

/**
 * Draw one frame.
 *
 * @param {DashState} state
 * @param {{columns: number, rows: number}} size
 * @param {{color: boolean}} options
 * @returns {{lines: string[], drawn: string[]}}
 */
export function renderDash(state, size, options) {
  if (size.columns < MINIMUM_COLUMNS || size.rows < minimumRows(state)) {
    return { lines: tooSmall(state, size), drawn: [] };
  }
  const paint = painter(options.color);
  // The last column is never written. A terminal that has just printed into it holds a pending
  // wrap, and the erase-to-end-of-line every changed row ends with then erases that character.
  const width = size.columns - 1;
  const nowMs = Date.parse(state.now);

  const banner = describeBanner(state.reading);
  const list = listLines(state, width, nowMs, paint);
  const top = [
    fitLine(header(state, width, nowMs, paint), width),
    ...(banner === null ? [] : [fitLine(` ${paint(banner, "yellow")}`, width)]),
    ...list.lines,
    ` ${paint("─".repeat(width - 1), "dim")}`,
  ];
  const selected = state.sources[state.selected];
  /** @type {Line[]} */
  const body =
    state.pane === "help"
      ? helpLines(paint)
      : selected === undefined
        ? []
        : detailLines(selected, state, width, nowMs, paint);
  const budget = size.rows - top.length - 1;
  const kept = trim([...body, { text: "", priority: 0 }], budget);
  const lines = [
    ...top,
    ...kept.flatMap((line) => line.text.split("\n")).map((line) => fitLine(line, width)),
    fitLine(keyBar(state, width), width),
  ];

  const drawn = state.sources
    .filter(
      (source, index) =>
        source.report !== null &&
        (list.complete || (state.pane === "detail" && index === state.selected)),
    )
    .map((source) => source.alias);
  return { lines, drawn };
}

/**
 * @typedef {{text: string, priority: number}} Line
 *
 * A body block -- one screen line, or several joined by `\n` that stand or fall together, such as
 * a wrapped caveat -- and how much the reader loses without it. The frame is trimmed lowest
 * priority first, bottom first among equals, so a short terminal gives up the plot's axis before
 * the interval and never keeps half a sentence. 9 is never given up at the minimum height.
 */

/**
 * @param {Line[]} lines
 * @param {number} budget
 */
function trim(lines, budget) {
  const kept = [...lines];
  const height = () => kept.reduce((total, line) => total + line.text.split("\n").length, 0);
  while (kept.length > 0 && height() > budget) {
    let victim = -1;
    for (const [index, line] of kept.entries()) {
      if (victim === -1 || line.priority <= Number(kept[victim]?.priority)) victim = index;
    }
    kept.splice(victim, 1);
  }
  return kept;
}

/**
 * @param {DashState} state
 * @param {number} width
 * @param {number} nowMs
 * @param {Paint} paint
 */
function header(state, width, nowMs, paint) {
  const count = state.sources.length;
  const right = describeSync(state, nowMs);
  const left = ` snack dash · ${count} capacity source${count === 1 ? "" : "s"}`;
  for (const title of [left, " snack dash"]) {
    const gap = width - measure(title) - measure(right);
    if (gap >= 2) return `${paint(title, "bold")}${" ".repeat(gap)}${right}`;
  }
  return ` ${right}`;
}

/**
 * The header's right side: what synchronization is doing, from the state's own instants.
 *
 * @param {DashState} state
 * @param {number} nowMs
 */
function describeSync(state, nowMs) {
  const { sync, reading } = state;
  if (sync.phase === "running") {
    return `synchronizing… ${age(since(sync.startedAt, nowMs))}`;
  }
  if (
    reading.computedAt === null &&
    (reading.storage === "missing" || reading.storage === "pending")
  ) {
    return "preparing storage…";
  }
  const next =
    sync.nextAt === null
      ? ""
      : ` · next in ${age(Math.max(0, (Date.parse(sync.nextAt) - nowMs) / 1000))}`;
  switch (sync.outcome) {
    case "ok":
      return `synced ${age(since(sync.endedAt, nowMs))} ago${next}`;
    case "storage_busy":
      return `sync skipped — another snack command is using storage${next}`;
    case "failed":
      return `sync failed — run snack doctor${next}`;
    case "storage_newer":
      return "synchronization stopped";
    default:
      return `waiting to synchronize${next}`;
  }
}

/**
 * @param {string | null} instant
 * @param {number} nowMs
 */
function since(instant, nowMs) {
  return instant === null ? 0 : Math.max(0, (nowMs - Date.parse(instant)) / 1000);
}

/**
 * @param {DashState["reading"]} reading
 * @returns {string | null}
 */
function describeBanner(reading) {
  switch (reading.storage) {
    case "pending": {
      const count = reading.pendingMigrations;
      return `Preparing storage — the first synchronization applies ${count} pending migration${count === 1 ? "" : "s"}; a backup is taken first.`;
    }
    case "missing":
      return "Preparing storage — the first synchronization creates it.";
    case "unprepared":
      return "Storage could not be prepared; run snack sync to see why.";
    case "newer":
      return "Storage was upgraded by a newer snack; quit and start snack dash again.";
    default:
      return null;
  }
}

/**
 * The overview, one row per source, with `▸` in the selected row's indent so no column moves.
 *
 * `complete` says whether every row kept the three columns a forecast is: a terminal narrow enough
 * for `fit` to give up `RISK` or `EVIDENCE` has not shown those sources' forecasts in the list.
 *
 * @param {DashState} state
 * @param {number} width
 * @param {number} nowMs
 * @param {Paint} paint
 */
function listLines(state, width, nowMs, paint) {
  const cells = state.sources.map((source) => listCells(source, nowMs));
  // One column of the width is the dash's margin; the overview draws in the rest.
  const columns = fit(cells, width - 1);
  const widths = columns.map((column) =>
    Math.max(column.width, ...[column.header, ...cells.map(column.read)].map(measure)),
  );
  const rows = [
    columns.map((column, index) =>
      place(column.header, widths[index] ?? 0, column.align, paint, "dim"),
    ),
    ...cells.map((cell) =>
      columns.map((column, index) =>
        place(column.read(cell), widths[index] ?? 0, column.align, paint, column.style?.(cell)),
      ),
    ),
  ];
  const overview = rows.map((row) => `  ${row.join("  ")}`.trimEnd());
  const lines = overview.map((line, index) =>
    index - 1 === state.selected ? ` ${paint("▸", "bold")}${line.slice(1)}` : ` ${line}`,
  );
  const headers = columns.map((column) => column.header);
  return {
    lines: lines.map((line) => fitLine(line, width)),
    complete: ["NEXT PROMPT", "RISK", "EVIDENCE"].every((name) => headers.includes(name)),
  };
}

/**
 * @typedef {{alias: string, next: string, risk: string, evidence: string, band: string, seen: string, sync: string, reading: boolean}} Cells
 */

/**
 * One list row's cells. `LAST SEEN` is computed from the frame's `now`, never from the cached
 * `age_seconds`, which was true only at the recompute.
 *
 * @param {DashSource} source
 * @param {number} nowMs
 * @returns {Cells}
 */
function listCells(source, nowMs) {
  const report = source.report;
  if (report === null) {
    return {
      alias: source.alias,
      next: "no reading",
      risk: "",
      evidence: "",
      band: "",
      seen: "",
      sync: source.sync,
      reading: false,
    };
  }
  const asOf = report.freshness.as_of;
  return {
    alias: source.alias,
    next: interval(report.viability),
    risk: report.risk.label,
    evidence: report.evidence.level,
    band: report.pressure.band,
    seen: asOf === null ? "never" : `${age(since(asOf, nowMs))} ago`,
    sync: source.sync,
    reading: true,
  };
}

/**
 * The overview columns (`render.js` `OVERVIEW`), read from list cells.
 * S1 replaces this, `fit`, `spans` and `place` with render.js `overviewLines()`.
 *
 * @type {{header: string, width: number, align: "left" | "center", sacrifice?: number, read: (cells: Cells) => string, style?: (cells: Cells) => Style | undefined}[]}
 */
const OVERVIEW = [
  { header: "SOURCE", width: 0, align: "left", read: (cells) => cells.alias },
  {
    header: "NEXT PROMPT",
    width: 11,
    align: "center",
    read: (cells) => cells.next,
    style: (cells) => (cells.reading ? undefined : "dim"),
  },
  {
    header: "RISK",
    width: 6,
    align: "center",
    sacrifice: 5,
    read: (cells) => cells.risk,
    style: (cells) => SCALE[cells.risk],
  },
  { header: "EVIDENCE", width: 8, align: "center", sacrifice: 2, read: (cells) => cells.evidence },
  {
    header: "PRESSURE",
    width: 8,
    align: "center",
    sacrifice: 3,
    read: (cells) => cells.band,
    style: (cells) => SCALE[cells.band],
  },
  { header: "LAST SEEN", width: 9, align: "center", sacrifice: 4, read: (cells) => cells.seen },
  {
    header: "SYNC",
    width: 6,
    align: "center",
    sacrifice: 1,
    read: (cells) => cells.sync,
    // A word first and a colour second: `busy` and `waiting` are not failures.
    style: (cells) =>
      cells.sync === "failed" ? "red" : cells.sync === "busy" ? "yellow" : undefined,
  },
];

/**
 * Give up columns in `sacrifice` order until the widest row fits (`render.js` `fit`).
 *
 * @param {Cells[]} cells
 * @param {number} available
 */
function fit(cells, available) {
  let columns = [...OVERVIEW];
  const order = [...OVERVIEW]
    .filter((column) => column.sacrifice !== undefined)
    .sort((left, right) => Number(left.sacrifice) - Number(right.sacrifice));
  for (const doomed of order) {
    if (spans(cells, columns) <= available) break;
    columns = columns.filter((column) => column !== doomed);
  }
  return columns;
}

/**
 * @param {Cells[]} cells
 * @param {typeof OVERVIEW} columns
 */
function spans(cells, columns) {
  const widths = columns.map((column) =>
    Math.max(column.width, ...[column.header, ...cells.map(column.read)].map(measure)),
  );
  return 2 + widths.reduce((total, width) => total + width, 0) + 2 * (columns.length - 1);
}

/**
 * @param {string} value
 * @param {number} width
 * @param {"left" | "center"} align
 * @param {Paint} paint
 * @param {Style} [style]
 */
function place(value, width, align, paint, style) {
  const padding = Math.max(0, width - measure(value));
  const before = align === "center" ? Math.floor(padding / 2) : 0;
  return " ".repeat(before) + paint(value, style) + " ".repeat(padding - before);
}

/**
 * The selected source's detail: `renderSource`'s rows without `--verbose`, `--sequence` or the
 * shadow, plus the scale, the plot and the D3 `next N` row. `as of` drops `sync …`, which the list
 * shows.
 *
 * @param {DashSource} source
 * @param {DashState} state
 * @param {number} width
 * @param {number} nowMs
 * @param {Paint} paint
 * @returns {Line[]}
 */
function detailLines(source, state, width, nowMs, paint) {
  const report = source.report;
  if (report === null) {
    return [
      { text: ` ${paint(source.alias, "bold")}`, priority: 9 },
      { text: "   no reading yet; it appears after the first synchronization", priority: 9 },
    ];
  }
  const band = report.pressure.band;
  const score = typeof report.pressure.score === "number" ? report.pressure.score : null;
  const sequence = sequenceLines(source, state.sequenceLength, width, paint);
  const asOf = report.freshness.as_of;
  const stale =
    state.reading.stale && state.reading.computedAt !== null
      ? ` · showing the reading from ${age(since(state.reading.computedAt, nowMs))} ago`
      : "";
  const caveats = [...report.caveats, ...(sequence.qualifier === null ? [] : [sequence.qualifier])];
  return [
    { text: ` ${paint(report.source.alias, "bold")}`, priority: 9 },
    {
      text: row(paint, "next prompt", [
        [`${interval(report.viability)} chance it goes through · `, undefined],
        [`risk ${report.risk.label}`, SCALE[report.risk.label]],
      ]),
      priority: 9,
    },
    ...sequence.lines,
    {
      text: row(paint, "evidence", [
        [report.evidence.level, undefined],
        [
          ` — ${EVIDENCE_MEANS[report.evidence.level] ?? "how far the local history reaches"}`,
          "dim",
        ],
      ]),
      priority: 9,
    },
    {
      text: row(paint, "pressure", [
        [band, SCALE[band]],
        [` · ${describePercentile(score)} · ${report.expected_prompt_category} prompt`, undefined],
      ]),
      priority: 9,
    },
    ...(score === null ? [] : scaleLines(score, band, width, paint)),
    ...plotLines(source, score, width, paint),
    {
      text: row(paint, "drivers", [
        [describeContributors(report.pressure.contributors ?? []), undefined],
      ]),
      priority: 3,
    },
    ...(report.reported_capacity === undefined
      ? []
      : [
          {
            text: row(paint, "reported", [[describeReported(report.reported_capacity), undefined]]),
            priority: 4,
          },
        ]),
    ...(report.method.id === "initial-generic"
      ? [
          {
            text: row(paint, "method", [
              ["initial heuristic", "yellow"],
              [" — no history of your own is behind this yet", "dim"],
            ]),
            priority: 8,
          },
        ]
      : []),
    {
      text: row(paint, "as of", [
        [
          `${asOf === null ? "unknown" : `${age(since(asOf, nowMs))} ago`} · period since ${day(report.source.active_period.started_at)}${stale}`,
          undefined,
        ],
      ]),
      priority: stale === "" ? 5 : 8,
    },
    ...caveats.map((caveat, index) => ({
      text: wrap(caveat, width - 5)
        .map((text, at) => (at === 0 ? `   ${paint("!", "gray")} ${text}` : `     ${text}`))
        .join("\n"),
      priority: caveat === "Real provider capacity is unknown." ? 6 : index === 0 ? 2 : 1,
    })),
  ];
}

/**
 * The `next N` row (decision D3): the person's length, never one the dash chose.
 *
 * Informative, it is `status`'s sequence row: the interval, "all N go through", the risk word -- the
 * risk moving to a continuation line rather than being cut on a narrow terminal. Too wide to inform
 * (`sequence-width-v1`), it prints **no number but N**: the interval would carry no information,
 * and the row says so in `status --sequence`'s own sentence, followed by the prior-tail diagnostic
 * when it applies. Nothing here depends on how informative another length would be.
 *
 * @param {DashSource} source
 * @param {number | null} length
 * @param {number} width
 * @param {Paint} paint
 * @returns {{lines: Line[], qualifier: string | null}}
 */
function sequenceLines(source, length, width, paint) {
  if (length === null) return { lines: [], qualifier: null };
  const label = `next ${length}`;
  const reading = source.sequence;
  if (reading === undefined || reading.assessment.length !== length) {
    return {
      lines: [{ text: row(paint, label, [["waiting for this reading", "dim"]]), priority: 9 }],
      qualifier: null,
    };
  }
  const { assessment, caveats } = reading;
  const room = width - VALUE;
  if (assessment.width.too_wide) {
    const statement = wrap(caveats.tooWide ?? TOO_WIDE_FALLBACK, room);
    const diagnostic = caveats.priorTail === null ? [] : wrap(caveats.priorTail, room);
    return {
      lines: [
        {
          text: statement
            .map((text, index) =>
              index === 0 ? row(paint, label, [[text, undefined]]) : continuation(text),
            )
            .join("\n"),
          priority: 9,
        },
        ...(diagnostic.length === 0
          ? []
          : [{ text: diagnostic.map((text) => continuation(text)).join("\n"), priority: 6 }]),
      ],
      qualifier: null,
    };
  }
  const outcome = length === 1 ? "it goes through" : `all ${length} go through`;
  const sentence = `${interval(assessment.viability)} chance ${outcome}`;
  const risk = `risk ${assessment.risk.label}`;
  const together = measure(`${sentence} · ${risk}`) <= room;
  return {
    lines: together
      ? [
          {
            text: row(paint, label, [
              [`${sentence} · `, undefined],
              [risk, SCALE[assessment.risk.label]],
            ]),
            priority: 9,
          },
        ]
      : [
          {
            text: [
              row(paint, label, [[sentence, undefined]]),
              continuation(`· ${paint(risk, SCALE[assessment.risk.label])}`),
            ].join("\n"),
            priority: 9,
          },
        ],
    qualifier: caveats.assumption,
  };
}

/** Said when the controller passed no `status` sentence; it carries no number either. */
const TOO_WIDE_FALLBACK = "This interval is too wide to say much, so no figure is shown.";

/** @param {string} text */
function continuation(text) {
  return `${" ".repeat(VALUE)}${text}`;
}

/**
 * Break `text` into lines of at most `width` screen columns, at spaces.
 *
 * @param {string} text
 * @param {number} width
 */
function wrap(text, width) {
  /** @type {string[]} */
  const lines = [];
  let current = "";
  for (const word of text.split(" ")) {
    const candidate = current === "" ? word : `${current} ${word}`;
    if (measure(candidate) <= width || current === "") {
      current = candidate;
    } else {
      lines.push(current);
      current = word;
    }
  }
  if (current !== "") lines.push(current);
  return lines;
}

/**
 * The scale: one marker on a track, between the two ends of the reader's own history.
 *
 * The track is one glyph on both sides of the marker, so neither side reads as consumed: this is a
 * rank against the reader's own windows, not a share of anything. Colour, when on, paints only the
 * marker; the band word on the row above carries the meaning.
 *
 * @param {number} score
 * @param {string} band
 * @param {number} width
 * @param {Paint} paint
 * @returns {Line[]}
 */
function scaleLines(score, band, width, paint) {
  const track = Math.min(25, width - VALUE - 20);
  if (track < 11) return [];
  const at = Math.round(Math.min(1, Math.max(0, score)) * (track - 1));
  const marker = paint("●", SCALE[band] ?? "bold");
  return [
    {
      text: `${" ".repeat(VALUE)}lightest ├${"─".repeat(at)}${marker}${"─".repeat(track - 1 - at)}┤ heaviest`,
      priority: 5,
    },
  ];
}

/**
 * The plot: the newest `PLOT_POLICY.windows` windows, oldest first, each against the reader's own
 * history. A window with no prompt is `·`, so "no prompts that hour" never looks like "the
 * lightest hour". Without a baseline there is nothing to rank against, and the row says so.
 *
 * @param {DashSource} source
 * @param {number | null} score
 * @param {number} width
 * @param {Paint} paint
 * @returns {Line[]}
 */
function plotLines(source, score, width, paint) {
  const unit = horizonUnit(source.seriesHorizon);
  const label = unit === "1h" ? "by hour" : "by window";
  const visible = Math.max(0, Math.min(PLOT_POLICY.windows, width - VALUE));
  const series = source.series.slice(-visible);
  if (score === null || series.every((value) => value === null) || visible === 0) {
    return [
      { text: row(paint, label, [["no baseline to compare against yet", undefined]]), priority: 4 },
    ];
  }
  const drawing = series
    .map((value) => (value === null ? paint("·", "dim") : sparkline([value])))
    .join("");
  const each = unit === "1h" ? "each hour" : "each window";
  const start = unit === "1h" ? `${series.length}h ago` : `${series.length} × ${unit} ago`;
  const axis =
    series.length >= measure(start) + 4
      ? `${start}${" ".repeat(series.length - measure(start) - 3)}now`
      : `${" ".repeat(Math.max(0, series.length - 3))}now`;
  return [
    {
      text: row(paint, label, [
        [drawing, undefined],
        [`  ${each} against your own history`, "dim"],
      ]),
      priority: 5,
    },
    { text: `${" ".repeat(VALUE)}${paint(axis, "dim")}`, priority: 2 },
  ];
}

/**
 * `PT1H` → `1h`, `PT5H` → `5h`, `PT30M` → `30m`, `P1D` → `1d`; anything else is said as given.
 *
 * @param {string} horizon
 */
function horizonUnit(horizon) {
  const match = /^P(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?)?$/u.exec(horizon);
  if (match === null) return horizon;
  const [, days, hours, minutes] = match;
  if (days !== undefined && hours === undefined && minutes === undefined) return `${days}d`;
  if (hours !== undefined && days === undefined && minutes === undefined) return `${hours}h`;
  if (minutes !== undefined && days === undefined && hours === undefined) return `${minutes}m`;
  return horizon;
}

/**
 * The help pane, which replaces the detail and leaves the list drawn. The sequence keys move N by
 * exactly one between 1 and `SEQUENCE_MAX_LENGTH` -- the bounds `status --sequence` accepts -- and
 * the help says nothing about which lengths inform.
 *
 * @param {Paint} paint
 * @returns {Line[]}
 */
function helpLines(paint) {
  const head = (/** @type {string} */ text) => ` ${paint(text, "bold")}`;
  const entry = (/** @type {string} */ keys, /** @type {string} */ text) =>
    `   ${paint(keys.padEnd(LABEL), "dim")}${text}`;
  return [
    { text: head("keys"), priority: 9 },
    { text: entry("↑ ↓  j k", "select a capacity source"), priority: 9 },
    { text: entry("s", "show or hide the next N row"), priority: 9 },
    { text: entry("+ -", `change N by one, from 1 to ${SEQUENCE_MAX_LENGTH}`), priority: 9 },
    { text: entry("r", "synchronize now (otherwise every 60 seconds)"), priority: 9 },
    { text: entry("? Esc", "close this help"), priority: 9 },
    { text: entry("q Ctrl+C", "quit"), priority: 9 },
    { text: head("reading this screen"), priority: 7 },
    {
      text: entry("NEXT PROMPT", "the chance the next prompt goes through, as an interval"),
      priority: 7,
    },
    {
      text: entry("next N", "the chance all N go through; no figure when too wide to inform"),
      priority: 5,
    },
    { text: entry("EVIDENCE", "how much of your own history supports that interval"), priority: 6 },
    {
      text: entry("PRESSURE", "this window against your own history, not a share of capacity"),
      priority: 6,
    },
    { text: `   Real provider capacity is unknown.`, priority: 7 },
    // The command first, so a narrow terminal cuts the explanation and never the command.
    {
      text: `   ${paint("snack status --json", "bold")}     the method and policy versions behind each estimate`,
      priority: 4,
    },
    {
      text: `   ${paint("snack status --verbose", "bold")}  shadow estimates, recorded to compare, never the answer`,
      priority: 4,
    },
  ];
}

/**
 * The key bar. The sequence keys are named while the row is on; off, only the key that shows it.
 * A bar too long for the terminal tightens its gutters, then gives up `+ -`, which the help names.
 *
 * @param {DashState} state
 * @param {number} width
 */
function keyBar(state, width) {
  const on = state.sequenceLength !== null;
  const full = [
    "↑↓ select",
    on ? "s hide next N" : "s next N",
    ...(on ? ["+ - change N"] : []),
    "r sync now",
    "? help",
    "q quit",
  ];
  const short = full.filter((item) => item !== "+ - change N");
  for (const items of [full, short]) {
    for (const gutter of ["   ", "  "]) {
      const bar = ` ${items.join(gutter)}`;
      if (measure(bar) <= width) return bar;
    }
  }
  return ` ${short.join(" ")}`;
}

/**
 * The one sentence a terminal below the minimum gets, wrapped and centred. Nothing is drawn as a
 * forecast, so nothing is delivered.
 *
 * @param {DashState} state
 * @param {{columns: number, rows: number}} size
 */
function tooSmall(state, size) {
  const width = size.columns - 1;
  if (width < 1 || size.rows < 1) return [];
  const count = state.sources.length;
  const sentence = `snack dash needs at least ${MINIMUM_COLUMNS} columns and ${minimumRows(state)} rows for ${count} source${count === 1 ? "" : "s"}; this terminal has ${size.columns}×${size.rows}. q quits.`;
  const lines = wrap(sentence, width)
    .slice(0, size.rows)
    .map((line) => fitLine(line, width));
  const top = Math.floor((size.rows - lines.length) / 2);
  return [
    ...Array.from({ length: top }, () => ""),
    ...lines.map((line) => `${" ".repeat(Math.floor((width - measure(line)) / 2))}${line}`),
  ];
}

// --- S1 replaces these with render.js exports (shownInterval, the panel's row builders). ---

/**
 * A viability interval in whole percents, rounded outward, exactly as `render.js` `interval()`:
 * floor the lower end, ceil the upper, snap float error, and keep 50 strictly inside an interval
 * that straddles even odds.
 * S1 replaces this with render.js shownInterval().
 *
 * @param {{lower: number, upper: number}} viability
 */
function interval(viability) {
  const lower = clampPercent(Math.floor(snap(viability.lower * 100)));
  const upper = clampPercent(Math.ceil(snap(viability.upper * 100)));
  const low = viability.lower < 0.5 ? Math.min(lower, 49) : lower;
  const high = viability.upper > 0.5 ? Math.max(upper, 51) : upper;
  return `${low}-${Math.max(low, high)}%`;
}

/** @param {number} value */
function snap(value) {
  const whole = Math.round(value);
  return Math.abs(value - whole) < 1e-9 ? whole : value;
}

/** @param {number} value */
function clampPercent(value) {
  return Math.min(100, Math.max(0, value));
}

/** @type {Record<string, string>} */
const EVIDENCE_MEANS = {
  very_low: "barely any history yet — mostly a starting assumption",
  low: "a little history, still thin",
  moderate: "some history, but few refusals seen yet",
  high: "enough of your own history to lean on",
};

/** @param {number | null} score */
function describePercentile(score) {
  if (score === null) return "no baseline to compare against yet";
  if (score <= 0) return "lower than every window in your own history";
  if (score >= 1) return "higher than every window in your own history";
  const rank = Math.round(score * 100);
  if (rank === 0) return "in the lowest 1% of your own history";
  if (rank === 100) return "in the highest 1% of your own history";
  return `above ${rank}% of your own history`;
}

/** @param {{dimension: string, contribution: number | null}[]} contributors */
function describeContributors(contributors) {
  const ranked = contributors
    .filter((contributor) => contributor.contribution !== null)
    .sort((left, right) => Number(right.contribution) - Number(left.contribution))
    .slice(0, 2);
  if (ranked.length === 0) return "nothing to compare against yet";
  return ranked
    .map((contributor) =>
      contributor.dimension === "prompts"
        ? "prompt count"
        : contributor.dimension.replaceAll("_", " "),
    )
    .join(", ");
}

/**
 * What Codex states about its own windows, in its words (`render.js` `describeReported`).
 *
 * @param {ReportedView[]} reported
 */
function describeReported(reported) {
  if (reported.length === 0) return "no figure stated by Codex yet";
  return reported
    .map((entry) => {
      const nowMs = Date.parse(entry.stated_at) + entry.age_seconds * 1000;
      const live = entry.windows.filter((window) => !window.reset_passed);
      const ended = entry.windows.filter((window) => window.reset_passed);
      const named = reported.length > 1 && entry.limit_id !== null ? ` (${entry.limit_id})` : "";
      const parts = [];
      if (live.length > 0) {
        parts.push(
          `Codex${named} states ${live
            .map((window) => {
              const resets =
                window.resets_at === null ? "" : `, resets ${until(window.resets_at, nowMs)}`;
              return `${Number(window.used_percent.toFixed(1))}% of its ${windowLength(window.window_minutes)} window${resets}`;
            })
            .join(" · ")}`,
        );
      }
      for (const window of ended) {
        parts.push(
          `Codex's${named} ${windowLength(window.window_minutes)} window reset ${String(window.resets_at).slice(11, 16)} UTC; no figure stated since`,
        );
      }
      parts.push(`${age(entry.age_seconds)} ago`);
      return parts.join(" · ");
    })
    .join(" · ");
}

/** @param {number} minutes */
function windowLength(minutes) {
  if (minutes % 1440 === 0) return `${minutes / 1440}d`;
  if (minutes % 60 === 0) return `${minutes / 60}h`;
  return `${minutes}m`;
}

/** @param {string} resetsAt @param {number} nowMs */
function until(resetsAt, nowMs) {
  const seconds = Math.max(0, (Date.parse(resetsAt) - nowMs) / 1000);
  if (seconds >= 86400) {
    const weekday = new Date(resetsAt).toLocaleDateString("en-US", {
      weekday: "short",
      timeZone: "UTC",
    });
    return `${weekday} UTC`;
  }
  const total = Math.round(seconds / 60);
  const hours = Math.floor(total / 60);
  const minutes = total % 60;
  return hours === 0 ? `in ${minutes}m` : `in ${hours}h ${minutes}m`;
}

/**
 * One detail row: margin, indent, a dimmed label in the label column, then its cells.
 *
 * @param {Paint} paint
 * @param {string} label
 * @param {[string, Style | undefined][]} cells
 */
function row(paint, label, cells) {
  const body = cells.map(([value, style]) => paint(value, style)).join("");
  return `   ${paint(label.padEnd(LABEL), "dim")}${body}`.trimEnd();
}

/** @param {number} seconds */
function age(seconds) {
  if (seconds < 60) return `${Math.round(seconds)}s`;
  if (seconds < 3600) return `${Math.round(seconds / 60)}m`;
  if (seconds < 86400) return `${Math.round(seconds / 3600)}h`;
  return `${Math.round(seconds / 86400)}d`;
}

/** @param {string | null} timestamp */
function day(timestamp) {
  return timestamp === null ? "unknown" : (timestamp.split("T")[0] ?? "unknown");
}

// --- end of the S1 replacements ---

/**
 * @param {boolean} color
 * @returns {Paint}
 */
function painter(color) {
  return color
    ? (value, style) =>
        // `validateStream: false`: the decision was made once, by the controller, for the real
        // terminal; `styleText` would otherwise consult `process.stdout`.
        style === undefined || value === ""
          ? value
          : styleText(style, value, { validateStream: false })
    : (value) => value;
}

/**
 * Cut a line to `width` screen columns, ending in `…` when anything was cut.
 *
 * Escape sequences are kept and cost nothing; a cut inside a painted run closes it with a reset,
 * so the colour-off frame and the colour-on frame with its escapes removed are the same text.
 *
 * @param {string} line
 * @param {number} width
 */
function fitLine(line, width) {
  if (measure(line) <= width) return line;
  let out = "";
  let used = 0;
  let painted = false;
  // eslint-disable-next-line no-control-regex -- an escape sequence is a token of its own here
  for (const [token] of line.matchAll(/\u001B\[[0-9;]*m|[\s\S]/gu)) {
    if (token.startsWith("\u001B[")) {
      out += token;
      painted = true;
      continue;
    }
    const cost = isWide(token.codePointAt(0) ?? 0) ? 2 : 1;
    if (used + cost > width - 1) break;
    out += token;
    used += cost;
  }
  return `${out}…${painted ? "\u001B[0m" : ""}`;
}

/**
 * How wide `value` is on a screen (`render.js` `measure`): escapes cost nothing, East Asian wide
 * characters and emoji cost two.
 *
 * @param {string} value
 */
export function measure(value) {
  let width = 0;
  // eslint-disable-next-line no-control-regex -- an escape sequence is exactly what is being removed
  for (const character of value.replace(/\u001B\[[0-9;]*m/gu, "")) {
    width += isWide(character.codePointAt(0) ?? 0) ? 2 : 1;
  }
  return width;
}

/** @param {number} code */
function isWide(code) {
  return (
    (code >= 0x1100 && code <= 0x115f) ||
    (code >= 0x2e80 && code <= 0xa4cf && code !== 0x303f) ||
    (code >= 0xac00 && code <= 0xd7a3) ||
    (code >= 0xf900 && code <= 0xfaff) ||
    (code >= 0xfe30 && code <= 0xfe6f) ||
    (code >= 0xff00 && code <= 0xff60) ||
    (code >= 0xffe0 && code <= 0xffe6) ||
    (code >= 0x1f300 && code <= 0x1f64f) ||
    (code >= 0x1f900 && code <= 0x1f9ff) ||
    (code >= 0x20000 && code <= 0x3fffd)
  );
}
