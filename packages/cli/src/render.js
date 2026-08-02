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
 * The panel's label column, counted in screen columns from the start of the line.
 *
 * A panel is read by scanning down the label column, so the width is fixed rather than fitted to
 * the content: fitting it would move every value whenever one label got longer.
 */
const LABEL = 13;

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
 * @property {{level: string, gates?: {id: string, level: string, limiting: boolean}[]}} evidence
 * @property {{id: string, version: string}} method
 * @property {string} [model_policy_version]
 * @property {{band: string, score?: number, contributors?: {dimension: string, percentile: number | null, contribution: number | null}[], trend?: {scores: number[]} | null}} pressure
 * @property {string} expected_prompt_category
 * @property {{age_seconds: number | null}} freshness
 * @property {{status: string}} synchronization
 * @property {string[]} caveats
 */

/**
 * One measured token dimension, or the record that nothing was measured.
 *
 * The two shapes are the report's own: `buildSourceStats` omits `value` entirely when a source
 * never reported that dimension, rather than writing a zero it did not observe.
 *
 * @typedef {{value: number, unit: string, sample_size: number, missing: number}
 *   | {unit: string, sample_size: number, missing: number}} Dimension
 */

/**
 * One analysis horizon's row in the statistics report.
 *
 * @typedef {object} HorizonView
 * @property {string} horizon
 * @property {{count: number, eligible: number, excluded: number}} prompts
 * @property {{by_class: Record<string, number>}} restrictions
 * @property {Record<string, Dimension>} dimensions
 * @property {{by_currency: Record<string, string | number>, sample_size: number, missing: number}} cost
 * @property {{unit: string, sample_size: number, missing: number, complete: boolean} & ({p50: number, p90: number} | {status: string})} duration
 * @property {{value: number, unit: string}} effective_sample_size
 * @property {{as_of: string | null}} freshness
 * @property {{model: string, slices: {count: number, unit: string}, dimensions: Record<string, Dimension>, cost: {by_currency: Record<string, string | number>}}[]} [by_model]
 */

/**
 * What `renderStats` reads, stated as its own shape for the same reason `SourceStatusView` is:
 * a layout can then be tested against a written-out object instead of against a database.
 *
 * @typedef {object} StatsReportView
 * @property {{alias: string, provider: string, plan: string, plan_profile: {id: string, version: string, provenance: string, as_of: string | null}}} source
 * @property {{band: string, baseline_kind: string, policy_version: string, trend?: {status: string, direction?: string | null, reason?: string | null}}} pressure
 * @property {{snapshots: number, undelivered_attempts: number, live: CalibrationStream, backtest: CalibrationStream, policy_version: string}} calibration
 * @property {HorizonView[]} horizons
 * @property {ClientComparisonView} [by_client]
 */

/**
 * One calibration stream. The score and its sample size travel together in one object because a
 * score without its sample size invites over-reading, and `summarizeCalibration` reports a null
 * score with a zero sample rather than a zero score.
 *
 * @typedef {{status?: string, excluded?: number, brier: {value: number | null, sample_size: number}, interval: {coverage: number | null, mean_width?: number | null, sample_size: number}, forecasts?: number}} CalibrationStream
 */

/** One model's usage inside one horizon, carried with the horizon it belongs to. */
/** @typedef {{horizon: HorizonView, entry: NonNullable<HorizonView["by_model"]>[number]}} ModelRow */

/**
 * @typedef {object} ClientComparisonView
 * @property {{client: string | null, installation_id?: string, restricted: number, eligible: number, restriction_share: {lower: number, upper: number}, difference: string}[]} groups
 * @property {{prompts: number}} unattributed
 * @property {string | null} reason
 * @property {string} policy_version
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
 * The counting columns of the statistics report, one row per analysis horizon.
 *
 * Horizons are rows because comparing them is the only question this report exists to answer, and
 * the old shape -- every measurement for one horizon on one run-on line -- made that comparison a
 * matter of reading two paragraphs and holding eight numbers.
 *
 * @type {{header: string, align: "left" | "center", read: (horizon: HorizonView) => string}[]}
 */
const WINDOWS = [
  { header: "WINDOW", align: "left", read: (horizon) => horizonLabel(horizon.horizon) },
  { header: "PROMPTS", align: "center", read: (horizon) => String(horizon.prompts.count) },
  { header: "COUNTED", align: "center", read: (horizon) => String(horizon.prompts.eligible) },
  {
    header: "REFUSED",
    align: "center",
    // The class is named beside the count rather than dropped or footnoted. "3" alone invites the
    // reader to assume the worst kind of refusal, and which kind it was is the whole content.
    read: (horizon) => {
      const classes = Object.entries(horizon.restrictions.by_class);
      if (classes.length === 0) return "—";
      return classes.map(([name, count]) => `${count} ${plainly(name)}`).join(", ");
    },
  },
  { header: "SET ASIDE", align: "center", read: (horizon) => String(horizon.prompts.excluded) },
  {
    header: "COST",
    align: "center",
    // Never totalled across currencies and never converted between them: the report has no rate to
    // convert with, and inventing one would be a number the user cannot check. A source that named
    // no currency is grouped under an explicit unknown rather than dropped.
    read: (horizon) => {
      const currencies = Object.entries(horizon.cost.by_currency);
      if (currencies.length === 0) return "—";
      return currencies.map(([currency, amount]) => `${amount} ${currency}`).join(", ");
    },
  },
  {
    header: "TYPICAL",
    align: "center",
    read: (horizon) => ("p50" in horizon.duration ? duration(horizon.duration.p50) : "—"),
  },
  {
    header: "SLOWEST 10%",
    align: "center",
    read: (horizon) => ("p90" in horizon.duration ? duration(horizon.duration.p90) : "—"),
  },
];

/**
 * The stored token dimensions, each in its own column under its own name.
 *
 * `docs/specification/observation.md` forbids summing token classes into one consumption score:
 * human output may show subtotals, but a label must preserve its dimension. A folded "tokens in"
 * column adding input to cache reads would be exactly that sum, so the tokens get a second table
 * instead -- seven columns of ten-digit numbers cannot share a row with the counts and still fit a
 * terminal.
 *
 * @type {{header: string, align: "left" | "center", read: (horizon: HorizonView) => string}[]}
 */
const TOKENS = [
  { header: "WINDOW", align: "left", read: (horizon) => horizonLabel(horizon.horizon) },
  ...["input", "output", "reasoning", "cache_read", "cache_write"].map((dimension) => ({
    header: plainly(dimension).toUpperCase(),
    align: /** @type {"center"} */ ("center"),
    read: (/** @type {HorizonView} */ horizon) => {
      const measured = horizon.dimensions[`${dimension}_tokens`];
      // A dimension the source never reported prints the same dash an absent value prints
      // everywhere else, rather than a zero it did not measure.
      return measured && "value" in measured ? count(measured.value) : "—";
    },
  })),
];

/**
 * Render the statistics report for one capacity source.
 *
 * @param {StatsReportView} report
 * @param {{verbose?: boolean}} options
 * @returns {string}
 */
export function renderStats(report, options) {
  const verbose = options.verbose === true;
  const plain = painter(false);
  const profile = report.source.plan_profile;
  // A source with too little baseline gets no trend at all, and the headline still has to read as a
  // sentence rather than as `undefined`. `computeUsageTrend` also returns a trend whose direction is
  // null with a stated reason, which is not the same thing as no trend and reads as its status.
  const trend = report.pressure.trend;
  const moving = trend ? (trend.direction ?? trend.status) : "no trend yet";
  const lines = [
    `${report.source.alias} · ${report.source.provider} ${report.source.plan} · ${profile.id}@${profile.version} · pressure ${report.pressure.band}, ${moving}`,
    "",
    ...table(WINDOWS, report.horizons, plain),
    "",
    ...table(TOKENS, report.horizons, plain),
    ...(verbose
      ? [
          "",
          ...dimensionDetail(report.horizons, plain),
          "",
          ...modelBreakdown(report.horizons, plain),
        ]
      : []),
    "",
    ...describeCalibration(report.calibration, verbose),
    describeFreshness(report.horizons),
    ...(report.by_client ? ["", ...describeClientComparison(report.by_client)] : []),
  ];
  return `${lines.join("\n")}\n`;
}

/**
 * How current the whole report is, as one line rather than a column.
 *
 * Every horizon carries its own `as_of`, and a column of RFC 3339 timestamps would be the widest
 * thing on the page to say one thing four times. The newest one bounds all of them: no horizon can
 * describe an observation that arrived after the last synchronization.
 *
 * @param {HorizonView[]} horizons
 */
function describeFreshness(horizons) {
  const seen = horizons
    .map((horizon) => horizon.freshness.as_of)
    .filter((/** @type {string | null} */ as_of) => as_of !== null)
    .sort();
  const newest = seen.at(-1);
  return newest === undefined ? "  nothing observed yet" : `  observed up to ${newest}`;
}

/**
 * Every dimension with the sample it was measured from and what was missing.
 *
 * `docs/specification/analysis.md`: every reported statistic carries its unit and its sample size,
 * and is never a bare number whose meaning has to be inferred. The default tables carry the value
 * because that is what the reader came for; this is where the value earns its trust, and it is why
 * moving the sample sizes out of the default reading is a curation rather than a loss.
 *
 * A dimension with nothing measured reports `unknown`, never a zero it did not observe.
 *
 * @param {HorizonView[]} horizons
 * @param {(value: string, style?: Style) => string} paint
 * @returns {string[]}
 */
function dimensionDetail(horizons, paint) {
  const rows = horizons.flatMap((horizon) =>
    Object.entries(horizon.dimensions).map(([dimension, measured]) => ({
      horizon,
      dimension,
      measured,
    })),
  );
  if (rows.length === 0) return ["  no dimension observed yet"];
  return table(
    [
      { header: "WINDOW", align: "left", read: ({ horizon }) => horizonLabel(horizon.horizon) },
      { header: "DIMENSION", align: "left", read: ({ dimension }) => dimension },
      {
        header: "VALUE",
        align: "center",
        read: ({ measured }) => ("value" in measured ? String(measured.value) : "unknown"),
      },
      { header: "UNIT", align: "center", read: ({ measured }) => measured.unit },
      { header: "SAMPLE", align: "center", read: ({ measured }) => String(measured.sample_size) },
      { header: "MISSING", align: "center", read: ({ measured }) => String(measured.missing) },
    ],
    rows,
    paint,
  );
}

/**
 * Every horizon's usage split by the model that served it.
 *
 * One table across all horizons rather than one per horizon, so the window stays a column and the
 * comparison the report is built around survives into the detail. Slices rather than prompts,
 * because one prompt can span several models and counting it once per model would report more
 * prompts than were made.
 *
 * @param {HorizonView[]} horizons
 * @param {(value: string, style?: Style) => string} paint
 * @returns {string[]}
 */
function modelBreakdown(horizons, paint) {
  const rows = horizons.flatMap((horizon) =>
    (horizon.by_model ?? []).map(
      (/** @type {NonNullable<HorizonView["by_model"]>[number]} */ entry) => ({ horizon, entry }),
    ),
  );
  if (rows.length === 0) return ["  no usage attributed to a named model yet"];
  const dimensions = [...new Set(rows.flatMap(({ entry }) => Object.keys(entry.dimensions)))];
  return table(
    [
      {
        header: "WINDOW",
        align: "left",
        read: ({ horizon }) => horizonLabel(horizon.horizon),
      },
      { header: "MODEL", align: "left", read: ({ entry }) => entry.model },
      {
        header: "SLICES",
        align: "center",
        read: ({ entry }) => String(entry.slices.count),
      },
      ...dimensions.map((dimension) => ({
        header: plainly(dimension.replace(/_tokens$/u, "")).toUpperCase(),
        align: /** @type {"center"} */ ("center"),
        read: (/** @type {ModelRow} */ { entry }) => {
          const measured = entry.dimensions[dimension];
          return measured && "value" in measured ? count(measured.value) : "—";
        },
      })),
    ],
    rows,
    paint,
  ).concat(`  counted in ${rows[0]?.entry.slices.unit ?? "usage slices"}`);
}

/**
 * The per-client comparison, as counts against their denominators.
 *
 * Deliberately never a percentage. A refusal share printed as "7% refused" reads as a measurement
 * of the provider's real behaviour, which is exactly the claim this product never makes; "3 of 418
 * counted" says the same thing while showing how much evidence is behind it. Prompts that could not
 * be attributed are reported rather than assigned.
 *
 * @param {ClientComparisonView} comparison
 * @returns {string[]}
 */
function describeClientComparison(comparison) {
  if (comparison.groups.length === 0) {
    return [`  by client: no attributed prompts (policy ${comparison.policy_version})`];
  }
  /** @type {Record<string, string>} */
  const verdicts = {
    higher_than_others: "refused more often than the others",
    lower_than_others: "refused less often than the others",
    not_detected: "difference not detected",
    not_comparable: "not enough counted prompts to compare",
  };
  const lines = comparison.groups.map(
    (/** @type {ClientComparisonView["groups"][number]} */ group) => {
      // With nothing counted the interval is the untouched prior, not a measurement of anything.
      // Printing it beside "0 of 0" would dress a starting assumption up as an observation.
      const interval =
        group.eligible === 0
          ? ""
          : ` [${group.restriction_share.lower.toFixed(3)}-${group.restriction_share.upper.toFixed(3)}]`;
      return `  ${group.client ?? group.installation_id}  ${group.restricted} of ${group.eligible} counted${interval} · ${verdicts[group.difference] ?? group.difference}`;
    },
  );
  if (comparison.unattributed.prompts > 0) {
    lines.push(`  ${comparison.unattributed.prompts} prompts could not be attributed to a client`);
  }
  return lines;
}

/**
 * What the calibration stream is worth, said as a sentence before it is said as a statistic.
 *
 * `live brier 0.002 (sample 131, coverage 0.00)` is four statistics and no sentence, and the reader
 * is a developer deciding whether to trust an estimate rather than a modeller auditing one. The
 * default reports how much has been checked, which is the part that answers that question; every
 * digit survives under `--verbose`, and none of it is ever called accuracy -- `CONTEXT.md` puts
 * that word, along with confidence and certainty, on this term's _Avoid_ list precisely because it
 * promises something a Brier score does not.
 *
 * @param {StatsReportView["calibration"]} calibration
 * @param {boolean} verbose
 * @returns {string[]}
 */
function describeCalibration(calibration, verbose) {
  const snapshots = calibration.snapshots ?? 0;
  const headline =
    snapshots === 0
      ? "  no forecasts checked against an outcome yet"
      : `  ${snapshots} forecasts checked against what happened next`;
  if (!verbose) return [headline];
  return [
    headline,
    `  live      ${describeStream(calibration.live)}`,
    `  backtest  ${describeStream(calibration.backtest)}`,
    `  policy    ${calibration.policy_version}, ${calibration.undelivered_attempts} undelivered`,
  ];
}

/**
 * One calibration stream's figures, or the reason there are none.
 *
 * Reported as not available rather than as zero: a Brier score of zero is a perfect forecaster, and
 * a stream with no outcomes yet is the opposite of that claim.
 *
 * @param {CalibrationStream | null | undefined} stream
 */
function describeStream(stream) {
  if (!stream || stream.brier.value === null) return "not available yet";
  return `brier ${stream.brier.value}, sample ${stream.brier.sample_size}, coverage ${stream.interval.coverage ?? "not available"}`;
}

/**
 * Draw one header and one row per record, every column fitted to what it actually holds.
 *
 * Fitted rather than fixed, unlike the status overview: there the columns hold a closed set of
 * words and a fixed width keeps two runs comparable, while here they hold counts whose magnitude is
 * the reader's own and cannot be guessed from the outside.
 *
 * @template T
 * @param {{header: string, align: "left" | "center", read: (record: T) => string}[]} columns
 * @param {T[]} records
 * @param {(value: string, style?: Style) => string} paint
 * @returns {string[]}
 */
function table(columns, records, paint) {
  const widths = columns.map((column) =>
    Math.max(...[column.header, ...records.map(column.read)].map(measure)),
  );
  const rows = [
    columns.map((column, index) =>
      place(column.header, widths[index] ?? 0, column.align, paint, "dim"),
    ),
    ...records.map((record) =>
      columns.map((column, index) =>
        place(column.read(record), widths[index] ?? 0, column.align, paint),
      ),
    ),
  ];
  return rows.map((cells) => `  ${cells.join("  ")}`.trimEnd());
}

/**
 * An ISO 8601 duration as the word a person uses for that span.
 *
 * `PT1H` and `P7D` are the right keys in configuration and in `--json`, where something parses
 * them. A column header is read, not parsed.
 *
 * @param {string} horizon
 */
function horizonLabel(horizon) {
  const parsed = /^P(?:(\d+)([DW])|T(\d+)([HMS]))$/u.exec(horizon);
  // Anything the pattern does not cover is printed as configured. A horizon nobody anticipated is
  // better read as its own ISO string than as a guess at what it meant.
  if (parsed === null) return horizon;
  const [, span, spanUnit, time, timeUnit] = parsed;
  return `${span ?? time}${(spanUnit ?? timeUnit ?? "").toLowerCase()}`;
}

/**
 * A count at the magnitude it actually reaches, with the unit that names it.
 *
 * `5104351653` is read by counting digits with a fingertip. The scale is decimal -- K, M, G -- and
 * not binary, because these are counts of tokens rather than sizes in memory, and three significant
 * figures is where a token count stops carrying meaning: nobody acts on the difference between
 * 5.10G and 5.104G.
 *
 * @param {number} value
 */
function count(value) {
  const units = ["", "K", "M", "G", "T"];
  let scaled = value;
  let unit = 0;
  while (Math.abs(scaled) >= 1000 && unit < units.length - 1) {
    scaled /= 1000;
    unit += 1;
  }
  if (unit === 0) return String(value);
  const digits = scaled < 10 ? 2 : scaled < 100 ? 1 : 0;
  return `${scaled.toFixed(digits)}${units[unit]}`;
}

/**
 * Milliseconds as the span a person would say out loud.
 *
 * `p90 448230.39999999997ms` is a float that escaped a percentile calculation and a unit nobody
 * converts in their head. Below a minute the seconds keep one decimal, because the difference
 * between 1.2s and 1.8s is the difference the reader came for; above it, tenths of a second are
 * noise against minutes.
 *
 * @param {number} milliseconds
 */
function duration(milliseconds) {
  const seconds = milliseconds / 1000;
  if (seconds < 60) return `${seconds < 10 ? seconds.toFixed(1) : Math.round(seconds)}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m${String(Math.round(seconds % 60)).padStart(2, "0")}s`;
  const hours = Math.floor(minutes / 60);
  return `${hours}h${String(minutes % 60).padStart(2, "0")}m`;
}

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
  // A table of intervals invites reading every row as the same kind of number, and a row that is
  // entirely the plan-profile prior is not a measurement of that source at all. `EVIDENCE very_low`
  // does not say that on its own, and the specification requires the interface to label an initial
  // heuristic rather than let it pass as a calibrated result. Named per source, because which row
  // it applies to is the whole content.
  const heuristic = statuses
    .filter((status) => isInitialHeuristic(status))
    .map(
      (status) =>
        `  ${paint("!", "yellow")} ${status.source.alias} has no history of its own yet; that estimate is the plan profile`,
    );
  // Every source closes with the same standing caveats, so four of them printed twelve identical
  // lines under a five-line table. A warning repeated per row is a warning a reader learns to skip;
  // said once, it is still read. Order is first-seen rather than sorted, so the sentence a source
  // adds for itself stays under the standing ones instead of jumping above them.
  const caveats = [...new Set(statuses.flatMap((status) => status.caveats))];
  return [
    ...dropped,
    ...heuristic,
    ...caveats.map((caveat) => `  ${paint("!", "gray")} ${caveat}`),
  ];
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
 * @param {{color: boolean, verbose?: boolean}} options
 * @returns {string}
 */
export function renderStatus(statuses, options) {
  const paint = painter(options.color);
  return statuses.map((status) => renderSource(status, paint, options.verbose === true)).join("\n");
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
 * @param {boolean} verbose
 */
function renderSource(status, paint, verbose) {
  const band = SCALE[status.pressure.band];
  const lines = [
    status.source.alias,
    row(paint, "next prompt", [
      [
        `${bare(status.viability.lower)}-${percent(status.viability.upper)} chance it goes through · `,
        undefined,
        0,
      ],
      // The label is a word first and a colour second, so a colourblind reader, a NO_COLOR
      // terminal and a captured log all read the same sentence.
      [`risk ${status.risk.label}`, SCALE[status.risk.label], 0],
    ]),
    row(paint, "evidence", [
      [status.evidence.level, undefined, 0],
      [
        ` — ${EVIDENCE_MEANS[status.evidence.level] ?? "how far the local history reaches"}`,
        "dim",
        0,
      ],
    ]),
    row(paint, "pressure", [
      [status.pressure.band, band, 0],
      [
        ` · ${describePercentile(status.pressure.score)} · ${status.expected_prompt_category} prompt`,
        undefined,
        0,
      ],
    ]),
    row(paint, "drivers", [
      [describeContributors(status.pressure.contributors ?? [], verbose), undefined, 0],
    ]),
    // What `--verbose` adds is what identifies and qualifies the estimate rather than states it:
    // which gate is holding the evidence level down, and which method and policy versions produced
    // the number. A reader deciding whether to send a prompt does not ask either question, which is
    // why the default panel does not answer them -- and an estimate that could never answer them on
    // a human surface would leave the invariant met by one route instead of two.
    ...(verbose
      ? [row(paint, "gates", [[describeGates(status.evidence.gates ?? []), undefined, 0]])]
      : []),
    ...methodRows(status, paint, verbose),
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
 * What each rung of the evidence ladder means, said without naming a statistic.
 *
 * The ladder itself is the domain term and stays on the line: `CONTEXT.md` defines `evidence level`
 * with those four values, and replacing them with prose would invent a second vocabulary. What is
 * added is the sentence that tells a reader who has never seen the ladder what the rung buys them.
 * None of these say "confidence", "accuracy" or "certainty" -- the glossary's _Avoid_ list for this
 * term -- because each would promise something a level does not.
 *
 * @type {Record<string, string>}
 */
const EVIDENCE_MEANS = {
  very_low: "barely any history yet — mostly a starting assumption",
  low: "a little history, still thin",
  moderate: "some history, but few refusals seen yet",
  high: "enough of your own history to lean on",
};

/**
 * Whether this estimate is the plan-profile prior and nothing else.
 *
 * `buildForecast` names the method `initial-generic` exactly when it backed off past every local
 * cell to the prior alone, so the identifier is the condition rather than a proxy for it. Read from
 * the method rather than from the evidence level: a `very_low` estimate can still be built from
 * observations, and the two statements are not interchangeable.
 *
 * @param {SourceStatusView} status
 */
function isInitialHeuristic(status) {
  return status.method.id === "initial-generic";
}

/**
 * Say where a percentile sits without using the word.
 *
 * A usage-pressure score already **is** a rank against the user's own history, so "above 90% of
 * your own history" is the literal reading. It is deliberately not "90% used": there is no total
 * here, and a share of an unknown capacity is the one claim this product never makes.
 *
 * @param {number} [score]
 */
function describePercentile(score) {
  if (typeof score !== "number") return "no baseline to compare against yet";
  return `above ${(score * 100).toFixed(0)}% of your own history`;
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
        paint(value, style) + " ".repeat(Math.max(0, width - measure(value))),
    )
    .join("");
  return `  ${paint(label.padEnd(LABEL), "dim")}${body}`.trimEnd();
}

/**
 * The two dimensions that moved the pressure band furthest. Specification 12.3 puts these in the
 * human detail, so a forecast whose drivers are only in `--json` would be two contracts.
 *
 * The default names them and stops there. `input_tokens 90th` asks the reader to know what a
 * percentile is before it tells them anything, and what they came for is which of their own habits
 * moved the reading. `--verbose` adds the rank, said the way this panel says every other rank --
 * "above 90% of your own history", never "90% used", which would be a share of a capacity nobody
 * can see. The number itself stays in every `--json` document, where something parses it.
 *
 * @param {{dimension: string, percentile: number | null, contribution: number | null}[]} contributors
 * @param {boolean} verbose
 */
function describeContributors(contributors, verbose) {
  const ranked = contributors
    .filter((contributor) => contributor.contribution !== null)
    .sort((left, right) => Number(right.contribution) - Number(left.contribution))
    .slice(0, 2);
  if (ranked.length === 0) return "nothing to compare against yet";
  return ranked
    .map((contributor) =>
      verbose
        ? `${plainly(contributor.dimension)} ${describePercentile(contributor.percentile ?? undefined)}`
        : plainly(contributor.dimension),
    )
    .join(", ");
}

/**
 * The method block: a warning when one is owed, an identifier when one was asked for.
 *
 * Two statements about the same estimate, and they are not interchangeable. Specification: the
 * interface explicitly labels the method as an initial heuristic and must not relabel a weak prior
 * as a calibrated probability -- that is the warning, it is owed on the default panel, and it
 * carries no identifier because `initial-generic@1` is a key for something that parses rather than
 * a statement to a reader. The identifier is the other statement, it identifies rather than warns,
 * and it appears only under `--verbose` and in every `--json` document.
 *
 * When both apply they share one label. Two rows both claiming `method` in an aligned label column
 * defeats the column: a label is there so the eye can find the row it names.
 *
 * @param {SourceStatusView} status
 * @param {(value: string, style?: Style) => string} paint
 * @param {boolean} verbose
 */
function methodRows(status, paint, verbose) {
  const identifier = `${status.method.id}@${status.method.version} · model ${status.model_policy_version ?? "unknown"}`;
  if (!isInitialHeuristic(status)) {
    return verbose ? [row(paint, "method", [[identifier, undefined, 0]])] : [];
  }
  return [
    row(paint, "method", [
      ["initial heuristic", "yellow", 0],
      [" — no history of your own is behind this yet", "dim", 0],
    ]),
    ...(verbose ? [row(paint, "", [[identifier, undefined, 0]])] : []),
  ];
}

/**
 * Every evidence gate, with the ones holding the level down marked.
 *
 * The level alone says how much history is behind an estimate; the limiting gate says what to do
 * about it. An estimate capped by `completeness` has a synchronization problem the reader can fix,
 * and one capped by `restrictions` simply has not been refused often enough yet, which no action
 * reaches. More than one gate can tie for weakest, and each of them is marked.
 *
 * @param {{id: string, level: string, limiting: boolean}[]} gates
 */
function describeGates(gates) {
  if (gates.length === 0) return "not assessed";
  return gates
    .map((gate) => `${gate.id} ${gate.level}${gate.limiting ? " (limiting)" : ""}`)
    .join(" · ");
}

/**
 * A stored dimension name, said the way it would be spoken.
 *
 * The stored names are column names -- `cache_write_tokens` -- and they are the right names in the
 * database, the export and the `--json` document, all of which are read by something that wants a
 * stable key. A panel is read by a person, and the underscore is the tell that a row escaped.
 *
 * @param {string} dimension
 */
function plainly(dimension) {
  return dimension === "prompts" ? "prompt count" : dimension.replaceAll("_", " ");
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
