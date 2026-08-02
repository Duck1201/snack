import { styleText } from "node:util";

/**
 * Human formatting. Explicitly **not** a public contract (`docs/compatibility.md`): every line here
 * is free to change while behaviour and data are preserved, which is what lets the whole 1.x
 * interface work land in minor releases.
 *
 * Kept out of `main.js` so a layout question is answered by reading one file rather than by reading
 * command wiring, and so the drawing can be tested without a database, a clock, or a terminal.
 */

/** Eight levels, lightest to fullest. */
const BLOCKS = ["▁", "▂", "▃", "▄", "▅", "▆", "▇", "█"];

/**
 * Column widths, counted in characters from the start of the line.
 *
 * A panel is read by scanning down the label column, so the widths are fixed rather than fitted to
 * the content: fitting them would move every value whenever one alias got longer.
 */
const LABEL = 11;
const COLUMN_A = 10;
const COLUMN_B = 18;

/**
 * What the renderer reads, stated as its own shape rather than as `createSourceStatus`'s return.
 *
 * The renderer consumes a view, not a module: naming the fields it actually uses is what lets a
 * layout be tested against a written-out object instead of against a database, and it says plainly
 * that adding a field to the status payload does not oblige the panel to show it.
 *
 * @typedef {object} SourceStatusView
 * @property {{alias: string, active_period: {started_at: string | null}}} source
 * @property {{lower: number, upper: number}} viability
 * @property {{label: string}} risk
 * @property {{level: string}} evidence
 * @property {{id: string, version: string}} method
 * @property {{band: string, contributors?: {dimension: string, percentile: number | null, contribution: number | null}[], trend?: {scores: number[]} | null}} pressure
 * @property {string} expected_prompt_category
 * @property {{age_seconds: number | null}} freshness
 * @property {{status: string}} synchronization
 * @property {string[]} caveats
 */

/** @typedef {Exclude<Parameters<typeof styleText>[0], readonly unknown[]>} Style */

/**
 * Risk and pressure share one scale, so they share one set of colours: a reader learns it once.
 *
 * @type {Record<string, Style>}
 */
const SCALE = {
  low: "green",
  moderate: "yellow",
  elevated: "yellow",
  high: "red",
  unknown: "gray",
};

/**
 * The overview columns, in reading order.
 *
 * `SOURCE` is fitted to the aliases and every other column is fixed: a name is what the eye scans
 * down, so it must start at one x; a measurement is read against its own header, so it must not
 * move when a neighbouring source is renamed.
 *
 * `sacrifice` orders what a narrow terminal gives up, and it is deliberately not the reading order.
 * The column a reader can most afford to lose is not the rightmost one: `SYNC` reads `ok` almost
 * always, while `LAST SEEN` — printed further left — is what decides whether any of the other
 * numbers are worth reading at all. A column without a rank is never dropped.
 *
 * @type {{header: string, width: number, align: "left" | "center", sacrifice?: number, read: (status: SourceStatusView) => string, style?: (status: SourceStatusView) => Style | undefined}[]}
 */
const OVERVIEW = [
  { header: "SOURCE", width: 0, align: "left", read: (status) => status.source.alias },
  {
    header: "NEXT PROMPT",
    width: 11,
    align: "center",
    read: (status) => `${bare(status.viability.lower)}-${percent(status.viability.upper)}`,
  },
  {
    header: "RISK",
    width: 6,
    align: "center",
    sacrifice: 5,
    read: (status) => status.risk.label,
    style: (status) => SCALE[status.risk.label],
  },
  {
    header: "EVIDENCE",
    width: 8,
    align: "center",
    sacrifice: 2,
    read: (status) => status.evidence.level,
  },
  {
    header: "PRESSURE",
    width: 8,
    align: "center",
    sacrifice: 3,
    read: (status) => status.pressure.band,
    style: (status) => SCALE[status.pressure.band],
  },
  {
    header: "LAST SEEN",
    width: 9,
    align: "center",
    sacrifice: 4,
    // `never` rather than the dash the pressure column uses for an absent band: one symbol standing
    // for two different absences is how a reader learns to skip both.
    read: (status) =>
      status.freshness.age_seconds === null ? "never" : `${age(status.freshness.age_seconds)} ago`,
  },
  {
    header: "SYNC",
    width: 6,
    align: "center",
    sacrifice: 1,
    read: (status) => status.synchronization.status,
    // The word is `failed` before it is red, the same rule the panel follows: colour never carries
    // meaning on its own.
    style: (status) => (status.synchronization.status === "ok" ? undefined : "red"),
  },
];

/**
 * Render every capacity source as one row under one header.
 *
 * @param {SourceStatusView[]} statuses
 * @param {{color: boolean, columns: number}} options
 * @returns {string}
 */
export function renderStatusTable(statuses, options) {
  const paint = painter(options.color);
  const columns = fit(statuses, options.columns);
  const widths = columns.map((column) =>
    Math.max(column.width, ...[column.header, ...statuses.map(column.read)].map(measure)),
  );
  const lines = [
    columns.map((column, index) =>
      place(column.header, widths[index] ?? 0, column.align, paint, "dim"),
    ),
    ...statuses.map((status) =>
      columns.map((column, index) =>
        place(column.read(status), widths[index] ?? 0, column.align, paint, column.style?.(status)),
      ),
    ),
  ];
  const drawn = lines.map((cells) => `  ${cells.join("  ")}`.trimEnd());
  return `${[...drawn, ...warnings(statuses, columns, paint)].join("\n")}\n`;
}

/**
 * The lines a dropped column still owes the reader.
 *
 * Width is allowed to cost detail; it is not allowed to cost a warning. `SYNC` is droppable only
 * because it reads `ok` almost always -- when it does not, every other number in that row is
 * suspect, and losing the one word that says so would turn a layout decision into a correctness
 * one. A sync that worked is not reported: a footer that narrates the ordinary case costs exactly
 * as many lines as the column it replaced.
 *
 * @param {SourceStatusView[]} statuses
 * @param {typeof OVERVIEW} columns
 * @param {(value: string, style?: Style) => string} paint
 */
function warnings(statuses, columns, paint) {
  const dropped = columns.some((column) => column.header === "SYNC")
    ? []
    : statuses
        // Only `failed`. `not_requested` is what `--no-sync` means, and warning about it warns the
        // reader about their own flag.
        .filter((status) => status.synchronization.status === "failed")
        .map(
          (status) =>
            `  ${paint("!", "red")} sync ${status.synchronization.status} on ${status.source.alias}`,
        );
  // Every source closes with the same standing caveats, so four of them printed twelve identical
  // lines under a five-line table. A warning repeated per row is a warning a reader learns to skip;
  // said once, it is still read. Order is first-seen rather than sorted, so the sentence a source
  // adds for itself stays under the standing ones instead of jumping above them.
  const caveats = [...new Set(statuses.flatMap((status) => status.caveats))];
  return [...dropped, ...caveats.map((caveat) => `  ${paint("!", "gray")} ${caveat}`)];
}

/**
 * Give up columns in `sacrifice` order until the widest row fits.
 *
 * A row wider than the terminal wraps, and a wrapped row destroys the alignment that is the whole
 * reason a table beats one panel per source. The columns that survive keep their reading order:
 * dropping a column must not reshuffle the ones beside it.
 *
 * @param {SourceStatusView[]} statuses
 * @param {number} available
 */
function fit(statuses, available) {
  let columns = [...OVERVIEW];
  // A column with no rank is never given up: an overview that cannot say which source a number
  // belongs to, or what the number is, has stopped being an overview.
  const order = [...OVERVIEW]
    .filter((column) => column.sacrifice !== undefined)
    .sort((left, right) => Number(left.sacrifice) - Number(right.sacrifice));
  for (const doomed of order) {
    if (spans(statuses, columns) <= available) break;
    columns = columns.filter((column) => column !== doomed);
  }
  return columns;
}

/**
 * The width of the widest row these columns would draw, indent and gutters included.
 *
 * @param {SourceStatusView[]} statuses
 * @param {typeof OVERVIEW} columns
 */
function spans(statuses, columns) {
  const widths = columns.map((column) =>
    Math.max(column.width, ...[column.header, ...statuses.map(column.read)].map(measure)),
  );
  return 2 + widths.reduce((total, width) => total + width, 0) + 2 * (columns.length - 1);
}

/**
 * Pad `value` to `width`, centred or left-aligned, painting the value but never its padding.
 *
 * The padding is measured from the bare value and applied outside the paint, because an escape
 * sequence has width in a string and none on a screen: padding a painted cell aligns the bytes and
 * misaligns the column. A centred cell splits an odd remainder to the right, so a column of values
 * one character apart does not shift its left edge every other row.
 *
 * @param {string} value
 * @param {number} width
 * @param {"left" | "center"} align
 * @param {(value: string, style?: Style) => string} paint
 * @param {Style} [style]
 */
function place(value, width, align, paint, style) {
  const padding = Math.max(0, width - measure(value));
  const before = align === "center" ? Math.floor(padding / 2) : 0;
  return " ".repeat(before) + paint(value, style) + " ".repeat(padding - before);
}

/**
 * How wide `value` is on a screen, which is not how long it is in memory.
 *
 * `String.length` counts UTF-16 code units, so an alias holding an emoji or a CJK name -- both of
 * which a user is free to type into their configuration -- reports a width no terminal agrees with,
 * and every column after it in the row slides. Escape sequences are the mirror case: they occupy
 * the string and nothing on the screen.
 *
 * @param {string} value
 */
function measure(value) {
  let width = 0;
  // eslint-disable-next-line no-control-regex -- an escape sequence is exactly what is being removed
  for (const character of value.replace(/\u001B\[[0-9;]*m/gu, "")) {
    const code = character.codePointAt(0) ?? 0;
    width += isWide(code) ? 2 : 1;
  }
  return width;
}

/**
 * The East Asian Wide and Fullwidth ranges, plus the emoji blocks that render double-width.
 *
 * Kept as explicit ranges rather than pulled from a dependency: the whole table is what the CLI
 * needs, it never changes between Unicode revisions in a way that moves a column, and a chart
 * library is not worth adding to a package that ships five dependencies.
 *
 * @param {number} code
 */
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

/**
 * Render one panel per capacity source.
 *
 * `color` is decided by the caller rather than sniffed here, because the renderer never sees the
 * real stream: command tests write into an injected sink, and a sink has no `hasColors()`.
 *
 * @param {SourceStatusView[]} statuses
 * @param {{color: boolean}} options
 * @returns {string}
 */
export function renderStatus(statuses, options) {
  const paint = painter(options.color);
  return statuses.map((status) => renderSource(status, paint)).join("\n");
}

/**
 * Build the one function that decides whether a value is painted.
 *
 * @param {boolean} color
 * @returns {(value: string, style?: Style) => string}
 */
function painter(color) {
  return color
    ? (value, style) =>
        // `validateStream: false` because the decision was already made. Left at its default,
        // `styleText` consults `process.stdout` -- not the stream this text is going to -- and
        // returns plain text whenever that is not a TTY, which would silently disable colour in
        // every test and in every `snack status | less -R`.
        // An empty value is painted as nothing at all. Wrapping "" in escapes produces a cell
        // that is invisible on screen but not empty in the string, which strands the previous
        // cell's padding behind it where `trimEnd` cannot reach -- a trailing-whitespace defect
        // that only appears with colour on.
        style === undefined || value === ""
          ? value
          : styleText(style, value, { validateStream: false })
    : (value) => value;
}

/**
 * @param {SourceStatusView} status
 * @param {(value: string, style?: Style) => string} paint
 */
function renderSource(status, paint) {
  const scores = status.pressure.trend?.scores ?? [];
  const band = SCALE[status.pressure.band];
  const lines = [
    status.source.alias,
    row(paint, "viability", [
      [`${bare(status.viability.lower)}-${percent(status.viability.upper)}`, undefined, COLUMN_A],
      // The label is a word first and a colour second, so a colourblind reader, a NO_COLOR
      // terminal and a captured log all read the same sentence.
      [`risk ${status.risk.label}`, SCALE[status.risk.label], COLUMN_B],
      [`evidence ${status.evidence.level}`, undefined, 0],
    ]),
    row(paint, "pressure", [
      [status.pressure.band, band, COLUMN_A],
      [`category ${status.expected_prompt_category}`, undefined, COLUMN_B],
      // The sparkline is the pressure, so it carries the pressure's colour rather than one of
      // its own.
      [sparkline(scores), band, 0],
    ]),
    row(paint, "drivers", [
      [describeContributors(status.pressure.contributors ?? []), undefined, 0],
    ]),
    row(paint, "method", [[`${status.method.id}@${status.method.version}`, undefined, 0]]),
    row(paint, "as of", [
      [
        [
          status.freshness.age_seconds === null
            ? "unknown"
            : `${age(status.freshness.age_seconds)} ago`,
          `sync ${status.synchronization.status}`,
          `period since ${day(status.source.active_period.started_at)}`,
        ].join(" · "),
        undefined,
        0,
      ],
    ]),
    ...status.caveats.map((caveat) => `  ${paint("!", "gray")} ${caveat}`),
  ];
  return `${lines.join("\n")}\n`;
}

/**
 * One indented row: a dimmed label, then its cells.
 *
 * Padding is applied outside the colour rather than through `padEnd`, because an escape sequence
 * has width in a string and none on a screen -- padding a painted cell aligns the bytes and
 * misaligns the column. Trailing whitespace is then trimmed, which an empty last cell would
 * otherwise leave behind for a diff and a captured log to carry.
 *
 * @param {(value: string, style?: Style) => string} paint
 * @param {string} label
 * @param {[string, Style | undefined, number][]} cells
 */
function row(paint, label, cells) {
  const body = cells
    .map(
      ([value, style, width]) =>
        paint(value, style) + " ".repeat(Math.max(0, width - value.length)),
    )
    .join("");
  return `  ${paint(label.padEnd(LABEL), "dim")}${body}`.trimEnd();
}

/**
 * The two dimensions that moved the pressure band furthest, with where each ranks against the
 * user's own history. Specification 12.3 puts these in the default human detail, so a forecast
 * whose drivers are only in `--json` would be two contracts.
 *
 * @param {{dimension: string, percentile: number | null, contribution: number | null}[]} contributors
 */
function describeContributors(contributors) {
  const ranked = contributors
    .filter((contributor) => contributor.contribution !== null)
    .sort((left, right) => Number(right.contribution) - Number(left.contribution))
    .slice(0, 2);
  if (ranked.length === 0) return "none ranked";
  return ranked
    .map(
      (contributor) =>
        `${contributor.dimension} ${(Number(contributor.percentile) * 100).toFixed(0)}th`,
    )
    .join(", ");
}

/** @param {number} value */
function percent(value) {
  return `${bare(value)}%`;
}

/** The sign belongs to the range, not to each end of it. @param {number} value */
function bare(value) {
  return (value * 100).toFixed(0);
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

/**
 * Draw usage-pressure scores as one block per window, oldest first.
 *
 * The scale is fixed to [0, 1] because a score already **is** a percentile against the user's own
 * baseline. Rescaling to the series would make a flat week of light usage look identical to a flat
 * week of heavy usage, which is the one comparison the drawing exists to make.
 *
 * @param {number[]} scores
 * @returns {string}
 */
export function sparkline(scores) {
  return scores
    .map((score) => {
      const level = Math.round(Math.min(1, Math.max(0, score)) * (BLOCKS.length - 1));
      return BLOCKS[level];
    })
    .join("");
}
