# @snack-ai/cli

## 0.6.1

### Patch Changes

- Republish both packages so npm serves the documentation the MVP deserves.

  npm renders the README inside the published tarball, so rewriting it in the repository changed
  nothing for anyone arriving at the package page: `0.6.0` still introduced itself as the "OpenCode
  tracer preview" that `0.2.0` was. The CLI page now says what SNACK does, what it refuses to claim,
  what each of the eight commands is for, how the forecast is reached, and what upgrading from a
  pre-`0.6` preview means for data written before the migration-preservation baseline.

  The plugin's page explains that nobody installs it directly, what it actually appends to the spool
  field by field, that SNACK works without it by reading OpenCode's database, and the three things
  it will not do: break OpenCode, read what it does not need, or interpret an event it cannot
  validate.

  Setup now registers `@snack-ai/opencode@0.1.2`. Every `0.1.x` emits the same `spool-event-v1`, so
  a registration pinned at an earlier one keeps working and `snack doctor` reports it as outdated
  rather than incompatible.

## 0.6.0

### Minor Changes

- 3923de3: Repair the first-run and live-capture path ahead of the MVP.

  Two defects made a correct installation look or behave wrong:

  - The OpenCode configuration is now located through `XDG_CONFIG_HOME`, the way OpenCode locates
    it. `resolveOpenCodeConfig` read the environment only from its argument, and a real CLI
    invocation passes none, so a custom `XDG_CONFIG_HOME` was ignored: the plugin was registered
    under `~/.config` while OpenCode read it elsewhere. Live capture silently never started, and
    `doctor` still called the registration compatible because it looked in the same wrong place.
  - Plugin registration is inspected by contract rather than by an exact package specifier. Every
    `@snack-ai/opencode@0.1.x` emits the same `spool-event-v1`, so a registration pinned at another
    version of the same package is reported as `outdated` and `doctor` warns; `incompatible` is now
    reserved for an entry whose options are absent or unrecognized, which SNACK genuinely cannot
    use. Setup writes `@snack-ai/opencode@0.1.1`, the published and attested version.

  Setup and configuration also stop working against the user:

  - `snack setup opencode` records `plan_profile` separately from `plan`. `--plan` is the label you
    use for your plan; `--plan-profile` selects the prior SNACK starts from and defaults to
    `generic`. Previously a free-text plan label was resolved as a profile id, so naming a real plan
    produced a `plan_profile_unavailable` warning on every later `status` and `stats`.
  - Configuration keys address array elements, so `snack config set sources.0.plan_profile <id>`
    edits one source instead of requiring the whole `sources` array to be rewritten. An out-of-range
    index fails closed against the schema without replacing the configuration.
  - A missing configuration points at `snack setup opencode`, the command that creates one, rather
    than at `snack config set`.

  Both READMEs gain a quickstart that runs as written. The previous one omitted `--non-interactive`
  and four required flags, so the documented command always failed.

  Pre-0.6 contracts remain experimental; this release changes some of them:

  - `setup opencode` reports `plan_profile` in `data.source`, and accepts `--plan-profile`.
  - `doctor` reports a new `outdated` plugin registration state as a warning rather than a failure.

  `snack export` is the first of the two remaining MVP commands.

  - Both formats carry the same flat tables joined by key — `capacity_periods`, `prompts`,
    `usage_slices`, `restrictions`, `predictions`, `prediction_evaluations` — rather than one
    nesting and the other flattening. Each table declares its columns, so a later migration cannot
    widen an export by adding one, and operational tables are excluded. `pending_spool_observation`
    is excluded in particular: its payload column is the one place an unreviewed field from a future
    capture schema could reach an export, so live events appear only once a synchronization commits
    them.
  - The document streams. A 100,000-prompt export produces roughly 54 MB while growing resident
    memory by about 15 MB, because no table is ever materialized; buffering the same export measured
    around four times its own size.
  - Provenance is recorded at two levels. Row-level versions come from the rows and are never
    re-stamped, while a document-level block names the exporting build and the plan profile each
    source resolved to. `export_schema_version` is independent of the envelope `schema_version`.
  - `--format csv --output -` is refused with exit 2. Six related tables cannot share one stream
    without repeating prompt columns per usage slice or inventing a separator no CSV reader
    understands. CSV writes one file per table into a directory beside a `manifest.json`.
  - `--since` is inclusive and `--until` exclusive, matching the analysis horizons.

  A closed pipe now ends any command quietly. `snack export --output - | head` previously died with
  an unhandled EPIPE and printed a stack trace where the JSON should have been; a streaming command
  makes that the common case rather than a rarity.

  `snack data purge` completes the eight MVP command groups.

  - Deletion runs under the storage operation lock inside one immediate transaction, and the rows
    counted for the preview are compared against the rows actually deleted before it commits. "Purge
    never exceeds its selection" is checked rather than claimed.
  - `--dry-run` reports the same counts, scope, and JSON shape an applied run reports, so a preview
    is verifiably a preview.
  - `--prevent-reimport` records a tombstone enforced during ingestion rather than through the
    ingestion cursor, so it survives `snack sync --full`, which ignores cursors by definition.
    Refused observations are reported as a new `tombstoned` count alongside the existing sync
    counts.
  - Purging a range that contains a source's ingestion watermark resets that cursor in the same
    transaction. The cursor is a single high-watermark and cannot describe a hole, so leaving it
    would make the next incremental synchronization skip the removed records forever, silently.
  - Spool segments are never deleted; segment removal stays with synchronization, which alone knows
    when every source has committed past them.
  - `--include-config` removes the sources after the transaction commits, because the deletion is
    unrecoverable while the configuration is recoverable from its backup. It leaves the OpenCode
    plugin registration alone — that file may hold credentials and belongs to `setup` — and warns
    that capture continues until `setup` changes it.
  - Confirmation is required unless `--dry-run` or `--yes` is given. Without a terminal, or in
    `--json` mode where prompting would break the one-document contract, purge exits 2 and deletes
    nothing.
  - Purge takes no pre-purge backup: leaving a copy of just-deleted records on disk would contradict
    what the command promises. It therefore has no I/O failure of its own, and
    `docs/specification.md` records that exit code 6 is reached by `export` alone.

  Migration 009 adds the tombstone table and recreates the two `BEFORE DELETE` triggers from 007
  with a connection-scoped escape, so purge can remove the prediction snapshots inside its scope
  while those rows stay immutable to every other connection and every other command. The `ON UPDATE`
  triggers are untouched: nothing may ever rewrite a snapshot.

  Two bundled plan profiles join `generic`, named after a billing archetype rather than a provider:
  `subscription-window` for a flat subscription, where restrictions follow requests and generated
  volume concentrating in a window, and `metered-credit` for per-token or credit billing, where risk
  tracks cumulative volume. `--plan-profile` on `snack setup opencode` selects one.

  An archetype changes how usage is weighed, never what SNACK claims capacity is. None of them
  declares `prior_viability`, because a differentiated initial viability would assert a plan's real
  capacity.

  `test/plan-profile.simulation.test.js` is the evidence, and it changed the design. Coverage
  measured at 1500 trials per corner, as rates 0.02 / 0.25 for n = 5 and n = 20:

      strength 0.5 -> 0.944 / 0.684 | 0.963 / 0.848
      strength 1   -> 0.905 / 0.918 | 0.927 / 0.861
      strength 1.5 -> 0.905 / 0.910 | 0.843 / 0.868
      strength 2   -> 0.000 / 0.900 | 0.751 / 0.873

  Only `1` holds the declared floor at both corners: a weaker prior collapses on a restriction-heavy
  source, and a stronger one drags the upper bound below a very high true viability until, at
  strength 2 with five near-certain successes, the interval stops containing the truth entirely.
  Prior strength therefore has no room to vary, and the archetypes differ only in their weights.

  The simulations also assert that each archetype ranks its own failure mode above neutral weighting
  while ranking the other's failure mode below it — a profile that were simply louder everywhere
  would be a sensitivity knob, not a description of a plan — and that all three converge once local
  evidence accumulates, since a profile is a weak initial assumption rather than a standing opinion.

  The unused `supported.providers` and `supported.plans` properties are removed from the
  plan-profile schema. They were never read, and a list of provider brands inside a deliberately
  brand-free artifact contradicts the naming rule; the schema freezes as a public contract at 1.0,
  so this is the last release that can drop them.

  `snack setup opencode` is guided by default. It discovers the OpenCode database, its schema
  fingerprint, the providers present in it, any already-configured source, and the current plugin
  registration, then asks only for what it cannot observe. The local account alias is one of those:
  OpenCode does not expose account identity and SNACK never reads credentials, so it is asked rather
  than guessed.

  An unsupported fingerprint fails closed before the first question, so nobody is walked through a
  questionnaire that cannot lead anywhere. The plan label and the plan profile are asked separately.
  Prospective analysis and plugin registration both default to declining, and a final confirmation
  precedes any change. Interrupting the questions cancels setup, which exits 0 having changed
  nothing — previously that path did not exist at all, since interactive setup threw
  `interactive_setup_unavailable`.

  `--non-interactive` keeps working and now reports which of `--source`, `--provider`, `--profile`,
  and `--plan` are missing instead of failing on the first one. Without a terminal and without
  `--non-interactive`, setup exits 2 naming the flags rather than waiting on input that will never
  arrive. Both entry points resolve the same values and then run the identical journal, backup, and
  rollback path, so idempotency and rollback are covered once for both.

  `snack stats` reports a real usage trend. It was previously hardcoded to `not_available` with the
  reason `no_pressure_history_yet`.

  The trend ranks the five most recent windows against one shared baseline — the windows preceding
  all of them — because ranking each window against its own history would put the scores on
  different scales and make the sequence between them meaningless. Direction comes from a strict
  majority of the steps between consecutive scores. It ships in `stats` only: `status` answers
  whether the next prompt is viable, and a direction across past windows is not part of that answer.

  The window count is measured rather than assumed. As the share of stationary runs reporting
  `steady`, and of rising runs reported as `rising` at 10% / 20% / 50% growth per window:

      windows 3 -> 0.744 | 0.416 / 0.819 / 0.997
      windows 4 -> 0.181 | 0.758 / 0.992 / 1.000
      windows 5 -> 0.689 | 0.652 / 0.986 / 0.994
      windows 6 -> 0.243 | 0.863 / 1.000 / 0.993
      windows 7 -> 0.678 | 0.801 / 0.999 / 0.000

  An even window count leaves an odd number of steps, where no tie is possible and a strict majority
  arises by chance, so those rows report a direction on stationary usage four times out of five.
  Among the odd counts, three under-reports a gentle rise and seven goes blind on a steep one. Five
  is the only count that neither misses a slow climb nor loses a fast one.

  Seven collapses because a percentile cannot exceed 1: once a window clears the entire baseline the
  steps after it are all zero however steeply usage keeps climbing. That same saturation appears on
  real histories, so a trend whose compared windows all sit above the baseline reports
  `not_available (above_baseline)` rather than `steady` — reporting steadiness there would read as
  reassurance about the one situation that deserves it least.

  `TREND_POLICY` is versioned separately as `stage6-trend-v1`. `ANALYTICS_POLICY` is stamped onto
  every stored prediction attempt, so bumping it for something that does not affect a forecast would
  put a false signal into the audit trail permanently.

  `snack stats --verbose` delivers the per-model detail its description promised. The flag
  advertised "per-model detail and extra percentiles" while only repeating the dimensions it had
  already printed.

  Each horizon now carries a `by_model` breakdown, in the human output under `--verbose` and in the
  JSON contract unconditionally. It counts usage slices rather than prompts, because one prompt can
  span several models and counting it once per model would report more prompts than were made. A
  slice whose model the source never named is grouped under an explicit `unknown`, the same way an
  unnamed currency is kept rather than dropped, and the per-model figures reconcile with the horizon
  totals. The breakdown reuses the same summarizers as the horizon, so every figure keeps its unit,
  sample size, and missing count instead of totalling into something that looks complete.

  No new query: the usage slices were already read for the horizon totals.

  The flag description now matches what it does.

  Hardening found and fixed two leaks and one gap where storage was read without being understood.

  - Every error envelope carried option values in its `command` field. `commandName` skipped tokens
    starting with `-` but kept what followed them, so `snack stats --source <value>` reported the
    command as `stats <value>`. Anything pasted into an alias, a time bound, or a configuration
    value travelled into a JSON document users share. Scanning now stops at the first flag.
  - `snack export` and `snack data purge` echoed a rejected source alias back in their error
    message, while the sibling paths in `sync` and `status` already refused to. They now match.
  - `status --no-sync`, `stats`, `export`, and `data purge` read storage without verifying the
    migration history, so a database written by a later SNACK was read, exported, and purged as if
    this build understood it. Only the writing paths checked. All four now refuse, which matters
    most for the two that leave the tool: an export would stamp a misread with this build's
    provenance, and a purge would delete rows it cannot interpret.

  New `test/privacy.test.js` drives all eight command groups in both output modes with canaries
  planted in the source, then asserts no canary reached any output or any byte of any file SNACK
  created — reading files as latin1, so a canary inside a SQLite page or a backup cannot hide behind
  utf8 replacement. New `test/resilience.test.js` covers a corrupted database, a file that is not a
  database, storage that cannot be created, an abandoned lock, an interrupted setup, a failed
  export, a purge that cannot finish, a spool segment cut mid-write, and the future-release refusal
  above.

  The two thinnest test files are filled in. `beta.js` is the numerical kernel behind every credible
  interval and had three tests; `storage.js` had seven, all covering migrations and locking rather
  than the repository itself.

  `beta.test.js` gains the round-trip property — feeding a quantile back through the distribution
  function must return the probability that produced it — plus monotonicity in the shape parameters,
  the distribution-function laws, extreme-but-reachable shapes, and input rejection. It also
  documents two real limits rather than papering over them: shapes are tested from 0.5 up, which is
  the floor the bundled priors can produce, and probabilities stop a thousandth from each end, a
  hundred times wider than the 0.1 and 0.9 a delivered forecast asks for. Further out a Beta turns
  U-shaped, the density becomes singular, and the search's guaranteed relative tolerance in the
  quantile spans progressively more probability, so no fixed bound holds. Ordering and finiteness
  are asserted out there instead.

  `storage.test.js` gains coverage of the invariants that are stated but were untested: an ingestion
  cursor never advances past writes that did not commit, a restored setup backup undoes the
  observations and not only the configuration, and re-storing the same batch converges instead of
  duplicating.

  `snack setup opencode` on a machine without OpenCode reported `internal_error` and exit `10`.
  Every OpenCode read opened the source database itself, and better-sqlite3 raises a bare
  `TypeError` when the parent directory is absent — the shape of the very first run. The four read
  entry points now share one open that classifies any failure as `source_unavailable` with exit `4`
  and names the `OPENCODE_DB` override, so an absent source reads as an unavailable source instead
  of a SNACK bug.

  `npm run pack:smoke` now asserts that `better-sqlite3` resolved a published prebuild instead of
  compiling from source, so a platform without a prebuild fails the gate rather than silently
  requiring a compiler toolchain from every user of that platform.

  The two MVP acceptance criteria that had no test now have one. Criterion 15 — no interface calls
  observed usage a quota percentage or a remaining balance — is checked by driving every command
  group in both output modes and refusing the vocabulary CONTEXT.md rejects, plus the shape of any
  promised prompt count, on stdout, stderr, and inside a CSV export. Criterion 9's argv clause is
  checked by asserting that no option accepts prompt text inline at all: prospective text reaches
  SNACK from a file or from stdin, never from a command line other processes can read.

  An independent tester pass against the installed binary found nine defects the suite could not
  see, and they are fixed here. Three blocked the MVP: a CSV export reported destination failures as
  an internal error instead of export I/O; human mode collected warnings for the JSON envelope and
  never spoke them, so a mistyped `--prompt-file` silently changed the prompt assumption behind a
  forecast; and `stats` was quadratic in the usage slices a window holds, taking 26 s and 928 MB
  where the budget is 150 MB.

  Six more were behaviour a user would meet: a file that is not a database at `OPENCODE_DB` crashed
  `setup` rather than reporting an unavailable source; a never-migrated database reached the query
  layer instead of being refused as storage; `data purge` never asked for confirmation even on a
  terminal; `--horizon all` and `doctor --source` were documented but rejected; human `status`
  omitted the active period and the pressure contributors the specification requires; and a forecast
  built from tens of thousands of prompts still described itself as sparse history dominated by the
  prior.

  Three smaller defects from the same pass are fixed too. A purge that did not reach the ingestion
  watermark still reset it, because the watermark is epoch milliseconds and the scope bounds are ISO
  timestamps, which SQLite compares by type before value. A window whose `--until` is at or before
  its `--since` selects nothing by construction and now exits `2` instead of reporting an empty
  success. And a CSV export stages every artifact before publishing the set together, so an
  interrupted run leaves `.partial` files rather than plausible CSVs missing the manifest that makes
  them interpretable.

  `SNACK_DEBUG` is new: setting it to any value prints the underlying error of an unexpected
  internal failure to stderr, so there is something to attach to a bug report. It never enters the
  JSON document, stdout, or any file.

## 0.5.0

### Minor Changes

- 1da5f3f: Replace the placeholder estimate with the Stage 5 calibratable prediction model.

  `snack status` now forecasts with a weighted Beta-Binomial over source outcomes, seeded by the
  weak plan-profile prior and read through a hierarchical backoff: capacity period plus pressure
  band plus prompt-size category, then period plus band, then the period aggregate, then the prior
  alone. Historical evidence is time-decayed, credible intervals come from tested Beta quantiles,
  and composite gates cap the evidence level at the weakest gate, so a long history without a single
  observed restriction can never look strong.

  `snack status --prompt-file <path|->` analyzes an unsent prompt locally and ephemerally, deriving
  only an allowlisted non-semantic feature vector and a prompt-size category. The text is never
  written, logged, or passed through argv, and a failure warns and assumes a typical prompt instead
  of withholding the forecast.

  Every forecast is stored as an immutable prediction attempt carrying each policy version behind
  it, and is promoted to a prediction snapshot only after its output is confirmed delivered.
  `snack stats` reports live snapshot calibration and rolling-origin backtesting as separate streams
  with Brier score, reliability buckets, interval coverage, and sample sizes, reporting
  `not_available` rather than zero.

  Pre-0.6 contracts remain experimental; this release changes some of them:

  - `status` `evidence` is now an object (`level`, `policy_version`, `gates`) rather than a string.
  - `method.id` is `bayesian-pressure-band` once local evidence exists, and `initial-generic` while
    the weak prior alone produces the estimate; `model_policy_version` is new.
  - The `initial_estimate` warning is replaced by `very_low_evidence`, and the envelope leaves
    `degraded` once the evidence level rises above `very_low`.
  - `status` gains `prospective` and a derived `expected_prompt_category`; `stats` replaces the
    `calibration` placeholder with live and backtest streams.

  Simulating the evidence gates revealed that elapsed-time decay alone cannot pace a real user, so
  the model now also decays evidence by how many prompts followed it. The forecast admits a collapse
  in viability after roughly fifteen to twenty prompts whatever the user's cadence, where before it
  stayed optimistic for eighty. Model policy `stage5-prediction-v2` and evidence policy
  `stage5-evidence-v2` carry the retuned constants.

  `status` reports forecast contributors under `evidence_window` rather than `cell`, with the number
  of prompts considered and the window limit beside the counts, since those counts were always
  relative to the bounded evidence window rather than the whole capacity period.

## 0.4.0

### Minor Changes

- 2d04e1a: Add explainable analytics: rolling analysis horizons, observed usage profiles, plan
  profiles, and usage pressure.

  `snack stats` is new. It reports every configured analysis horizon, or one chosen with
  `--horizon`, in concise, `--verbose`, and `--json` form: prompt counts by outcome, restrictions by
  class, token dimensions kept separate, cost totalled per currency in exact decimal arithmetic,
  duration percentiles, freshness, and a time-decayed effective sample size. Absent source fields
  are reported as unknown and never as zero, and calibration metrics say not available until a
  prediction model exists.

  `snack status` now reports real usage pressure instead of a placeholder, and `snack doctor`
  reports the plan profile a source uses and warns when it is more than a year past its `as_of`
  date.

  Plan profiles ship as validated data. A source selects one through `sources[].plan_profile`,
  naming a bundled profile or a local file. A profile that fails validation is rejected, the generic
  profile is used instead, and the command warns rather than substituting silently. Migration 005
  stamps the capacity period with the profile identity and version; changing which profile a source
  uses opens a new period, while a new version of the same profile does not.

  Usage pressure compares the current window with preceding windows of the same length. It is
  relative to local history and is never a share of real provider capacity, which SNACK treats as
  unknown.

## 0.3.0

### Minor Changes

- Add fail-open OpenCode live capture through the versioned `spool-event-v1` contract.
- Reconcile live restrictions with read-only backfill without duplicate prompt outcomes.
- Add opt-in global plugin registration, durable private spool cursors, and live spool diagnostics.

## 0.2.0

### Minor Changes

- Add read-only OpenCode setup, backfill synchronization, diagnostics, and an explicitly
  uncalibrated next-prompt status estimate.
- Complete Stage 2 validation: provider/profile ambiguity remains pending without entering
  forecasts, setup transitions capacity periods immediately, and risk labels use the versioned
  lower-bound policy.
