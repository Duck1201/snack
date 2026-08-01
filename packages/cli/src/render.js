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
  /** @type {(value: string, style?: Style) => string} */
  const paint = options.color
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
  return statuses.map((status) => renderSource(status, paint)).join("\n");
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
