# @snack-ai/cli

## 1.2.0

### Minor Changes

- ec71281: `snack status --verbose`, and a generated `man snack`.

  `1.1.3` moved the method identifier, the model policy version, the evidence gates and the
  percentile behind each pressure driver off the default panel, because they identify and qualify an
  estimate rather than state it, and the reader of a panel is a developer deciding whether to send a
  prompt. That left them reachable only through `--json`, so the requirement that an estimate always
  names its method was met by one route instead of two. `status --verbose` is the second route.

  The verbose panel lists every evidence gate with the limiting one marked, which is the actionable
  half of the ladder: an estimate capped by completeness has a synchronization problem you can fix,
  and one capped by restrictions has simply not been refused often enough yet. Each pressure driver
  gains its rank, stated the way the panel states every rank — "above 90% of your own history",
  never a share of a capacity nobody can see. `--verbose` renders panels even without a source
  selection, because the overview exists to compare sources and four more rows per source is not a
  comparison.

  `--json` is byte-identical with and without `--verbose`. Nothing was added to any document.

  `man snack` ships in the package, generated from the CLI's own help text and the command reference
  in the repository, and checked by the build. Three gates run in `npm run check`: the committed
  page must equal what the generator produces, every flag the CLI declares must appear in a synopsis
  in the specification, and the published tarball must carry the page. The frozen flag-surface test
  and the man page now read the same help through the same parser, so they cannot describe different
  CLIs.

  Writing that gate found fifteen flags that already existed and that no synopsis declared — every
  `setup` value flag, `--install-plugin`, `--yes`, `--enable-prospective-analysis`, and
  `export --json`. The documentation is corrected; those flags are unchanged and always worked.

## 1.1.3

### Patch Changes

- 7c77021: Write `status` and `stats` for a person.

  `snack status` without a selection is now an overview: one row per capacity source under one
  header, because the question without a selection is which source to reach for, and that is a
  comparison. Four configured sources printed four panels and twelve identical caveat lines; the
  caveats every source repeats are stated once. Naming a source still gives the panel, and the panel
  is written in words — the interval says what it is the chance of, each evidence rung carries the
  sentence that says what it buys, and a pressure percentile reads as "above 90% of your own
  history".

  `snack stats` is two tables with the analysis horizons as rows, rather than one
  semicolon-separated line per horizon. Tokens keep a table of their own so no column folds two
  dimensions into one subtotal. `2423712.9000000013ms` reads as `40m` and `5104351653` reads as
  `5.10G`. The default reports how many forecasts have been checked; the Brier scores, coverage,
  per-dimension sample sizes, per-model breakdown and policy versions moved under the `--verbose`
  `stats` already had.

  An estimate produced by the plan-profile prior alone — a source just configured, or one whose plan
  was just changed — is now labelled an initial heuristic in the panel and warned about per source
  beneath the overview. The specification puts that on the interface rather than on the JSON
  document, and no surface was saying it.

  Fixes an alignment defect that has been present since `1.1.0`: widths were counted in UTF-16 code
  units, so a capacity source whose alias is written in CJK or holds an emoji had every measurement
  in its row shifted left of its own heading.

  No `--json` document changes, and no flag is added or removed.

## 1.1.2

### Patch Changes

- 9a093e7: A capacity period can no longer be recorded as ending before it started.

  Every command reads the clock once on entry and only then queues for the storage lock, so two
  processes write their periods in lock order and not in clock order — the one that waited can be
  holding the earlier reading. Closing the open period with it produced a row whose `ended_at`
  preceded its own `started_at`, and a later period whose `started_at` preceded the regime it
  replaced. `status` takes the active period's start as the origin of its pressure windows, so the
  inversion reached a forecast and not only the stored row.

  The boundary is one instant and it belongs to the period being closed, so it is now clamped to
  never fall before that period's start. A period closed by a late process reads as zero-length
  instead of negative, which is the honest shape — and it is representable at all only because
  `1.1.1` stopped requiring distinct start instants.

  Found by racing six `setup` runs on one alias against a real installation, which is the only way
  it appears: a human cannot produce it, and no single-process test could.

## 1.1.1

### Patch Changes

- 75950c9: `setup --json` now always says whether it applied anything.

  An applied run answered `"dry_run": { "observations": 183 }` — a key naming the opposite of what
  happened, with `applied` disappearing rather than becoming `true`, so a consumer could not tell a
  preview from a mutation by reading the payload. `applied` is now emitted on both paths.

  Renaming `dry_run` would be the honest fix and it is a breaking change to a frozen payload, so it
  stays recorded in `docs/compatibility.md` as a candidate for whenever a major is cut.

- 75950c9: Two `setup` runs on the same source in the same millisecond no longer fail with
  `internal_error`.

  A capacity-period boundary is one instant, written as `ended_at` on the period being closed and
  `started_at` on the one being opened, and `capacity_period` was
  `UNIQUE (source_alias, started_at)`. Whenever the clock did not move between the two writes they
  collided, and the collision surfaced as exit `10`. A human cannot type two commands a millisecond
  apart; a script can, and so can anything that retries.

  Migration 013 rebuilds `capacity_period` without that constraint. The invariant that matters — one
  open period per capacity source — was never the constraint's job and is still enforced by
  `capacity_period_active_idx`.

  **This is the expensive migration in this project.** With foreign keys enforced, the parent cannot
  be dropped while a child holds rows, so `prompt_execution` and the seven tables that cascade from
  it are copied out and back. On a 100,000-prompt history: 1.8 s, 104 MB peak RSS, every row
  preserved, and a database file that grows about 1.7x and reuses the freed pages rather than
  returning them. The runner takes its usual backup first. Figures in `docs/release/performance.md`.

## 1.1.0

### Minor Changes

- `snack update`, a readable `status`, and the documentation restructure.

  **`snack update`** brings the CLI and the capture plugin to versions that belong together. It
  works out how the CLI was installed — npm, pnpm, bun or yarn, global or local — shows the exact
  command before running it, installs, and then re-registers the capture plugin at the pin the newly
  installed build carries. Doing that by hand meant reading your own configuration back and retyping
  five values into `setup` exactly, and any one of them typed differently starts a new capacity
  period and retires everything SNACK has learned about that source. `snack update` never rotates a
  capacity period.

  It is the only command in the product that reaches the network, scoped by ADR-0010, and it carries
  a package name and a version and nothing else. An installation layout SNACK cannot recognize
  refuses and prints the command to run by hand rather than installing somewhere unexpected. Every
  other command now runs in the test suite with network access denied.

  **`status` prints one panel per capacity source** instead of one unwrapped line: an aligned label
  column, no box drawing, and a usage-pressure sparkline. Colour is drawn with the standard library
  and never carries meaning alone — a risk label is a printed word that happens to be coloured, so a
  colourblind reader, a `NO_COLOR` terminal and a captured log read the same sentence. `--json` is
  never coloured, and gains one field: `pressure.trend`, the window scores the sparkline is drawn
  from, filling a slot the status schema has declared since the 0.9 freeze.

  **The documentation is restructured.** Each language gets its own README and both ship in the
  tarball; the specification and the architecture are split by topic behind an index that preserves
  their section numbers; the 1.x roadmap moves out of `PLAN.md`.

  The plugin's behaviour is unchanged. It republishes because its README was split by language and
  both files now ship.

## 1.0.2

### Patch Changes

- 1a80acc: `doctor` now says which providers a source is waiting on, how many observations each
  holds, and what to run:

  ```
  61 schema-valid observation(s) need an explicit mapping. Waiting on: opencode 34, ollama 19,
  anthropic 5, haiku 3. Configure each with `snack setup` and its --provider, then run
  `snack sync --full` to attribute what is already stored.
  ```

  A real client history is multi-provider and `setup` asks for one, so this is the state a new user
  lands in. The count alone did not say how to leave it.

- 1a80acc: Every command that synchronizes stops reading the whole Claude Code history to check its
  shape.

  The fingerprint check samples 200 records per transcript and then stops, but it stopped inside an
  array built by reading and parsing each file in full. Over a real 222 MB history a `sync` with
  nothing to read cost 238 MB of process memory and 1.2 s; it now costs 138 MB and 0.74 s, and
  `doctor` drops from 241 MB to 148 MB. What the check can conclude is unchanged — it never looked
  past 200 records — only what it reads to conclude it.

- 1a80acc: An OpenCode prompt whose assistant reply never arrived is now recorded instead of
  disappearing.

  Eleven of 194 prompts on a real history vanished this way, every one with no assistant message
  naming it as a parent — and they reached no counter either, so `sync` reported fewer observations
  than the source held and a source could not be reconciled against its own history. They are stored
  with the provider the user's own message names, and `excluded`, which keeps them out of the
  outcome model while their descriptive dimensions still count.

## 1.0.1

### Patch Changes

- ad9f6b0: Re-running `setup` on an existing source no longer makes its stored history disappear,
  and now says what the change costs before it happens.

  `setup` opens a new capacity period whenever provider, profile, plan or plan profile changes —
  correct, a new plan is a new capacity regime. But `status`, `doctor` and the source summary read
  the open period only, so a source with 603 synchronized prompts reported `observed 0` and
  `as_of unknown`, `doctor` said "No synchronized usage is available", and `stats` printed the same
  rows with their timestamps. `sync --full` could not bring them back: an observation keeps the
  period it belongs to by timestamp.

  Describing a source and training its forecast are separate questions, and only the second one is
  about the regime. `observed`, `as_of` and the freshness check now report everything the source
  holds; the forecast still trains on the open period alone, so it falls back to the plan profile
  with `evidence very_low` and says so. `setup` emits a `capacity_period_rotated` warning naming how
  many prompts stop informing the estimate, on stderr and in the `--json` envelope.

- a614474: `snack setup opencode --install-plugin` now registers `@snack-ai/opencode@1.0.1`, the
  version published alongside this CLI. `1.0.0` still wrote `0.1.2`: every setup installed a plugin
  three minors old, and `doctor` told anyone already pinned at `1.0.0` that their registration was
  "another version" and to re-run setup — advice that would have downgraded them. A test now asserts
  the pin equals what the plugin workspace publishes, so the two cannot drift apart again.

## 1.0.0

### Major Changes

- 333cac9: First stable release.

  Six surfaces are public contracts under strict SemVer from here: the documented commands and
  flags, the exit-code categories, the `--json` envelope and its per-command payload schemas, the
  configuration schema, the export document, and the spool event contract. They are the surfaces
  frozen at `0.9` and confirmed rather than redefined by this release — a change to any of them
  during the stable gate audit would have reset the freeze and required a new `0.9.x`.

  No product behavior changes. What this release adds is the evidence that the contracts hold: the
  documents `0.9.0` emits are captured and still validate unchanged, every published release from
  the `0.6.0` migration floor forward upgrades under the candidate with integrity intact, and the
  artifacts are staged on an isolated registry and checksum-verified before npm sees them.

  The OpenCode plugin reaches `1.0.0` alongside the CLI. Its behavior and its `spool-event-v1`
  contract are unchanged; the version moves because the packages are released together and its
  documentation did.

### Patch Changes

- 0826e50: Rewrite the package documentation in English and Portuguese.

  Each README now opens with a non-technical section that says what SNACK is for and reads its
  example output in plain words, then a technical section covering the Beta-Binomial model, the
  Jeffreys prior, hierarchical backoff, the evidence gates, usage-pressure percentiles and the
  calibration metrics — with references, so the reasoning can be checked rather than trusted.

  Both packages ship their README inside the tarball, and both were describing a version nobody was
  running: the CLI's said the `0.6` line was the MVP and Claude Code was still to come, and the
  plugin's described its compatibility in terms of `0.1.x`. The published support matrices were two
  releases stale as well.

  Every example is captured from a real run rather than written by hand.

## 0.9.0

### Minor Changes

- Stage 9: feature freeze and public beta.

  The 1.0 public surface is frozen and recorded in `docs/compatibility.md` — commands, flags, exit
  codes, the `--json` envelope and every command payload, the configuration document, the `export`
  document, and the spool event schema. `release:check` gates on that document.

  Four corrections landed on the surface before it was locked. The `--json` envelope moved to
  `schema_version` 2, because `config set` was publishing the storage layer's own JavaScript names
  and its three `data.storage` keys are now snake_case; no other payload changed shape. Each payload
  now has a published schema under `schemas/commands/`, routed from the envelope by command name.
  `export --json` is documented. `doctor --source <unknown-alias>` refuses with exit 4 like every
  other command instead of reporting a clean bill of health, `data purge --include-config` no longer
  warns about a plugin that was never registered, and a rejected configuration names the rule that
  refused it with a reason code per rule, never echoing the rejected value.

  Beta hardening then found four defects on those frozen surfaces, each a fix or a correction to the
  form of a contract rather than to what it says. Read-only commands refuse a database at an older
  schema with `storage_migrations_pending` under exit 5, where they used to fail as an internal
  error. The Claude reader refuses a record whose `timestamp` is not a time rather than storing it,
  and will not root a turn at one. The error envelope's `command` no longer carries a rejected
  positional argument. `schemas/spool-event.schema.json` declares `type` on each conditional branch
  so it compiles under the Ajv configuration the product itself uses — the plugin's patch release
  exists to republish that file; the set of accepted documents is unchanged.

  Upgrading from `0.6+` is an install and a `snack sync`; the full path is in
  `docs/compatibility.md`. The migration floor stays `0.6.0` and is now proven against the published
  `0.6.1` artifact. Four trust boundaries gained property tests, the budgets have a recorded
  developer-machine measurement that `release:check` gates on, and `doctor` has a documented account
  of every check it can report.

## 0.8.2

### Patch Changes

- e7c46cb: Keep the identifier rule off the guided-setup questions. `0.8.1` put the pattern on every
  question so the shape was known before the answer was typed, which spent a line of regex on
  everyone who was going to type something ordinary anyway. The rule now appears only on a refusal,
  where it answers something that just happened. A refusal still costs one answer rather than the
  whole questionnaire.

## 0.8.1

### Patch Changes

- a90b64f: Ask each guided-setup question before offering its choices. The numbered list was printed
  first, so every question with choices read back to front. The rendering is now a pure function
  with its own tests, leaving the executable only the readline handle.
- a90b64f: Accept the OpenCode databases OpenCode actually writes. The structural fingerprint
  required every key column to report `NOT NULL`, which only holds inside a `STRICT` table;
  OpenCode's own DDL is not `STRICT`, so `snack setup opencode` refused every real installation with
  `source_schema_unsupported` while the test fixture — hand-written as `STRICT` — kept passing. A
  primary key is now asserted through `pk` alone, and the fixture is OpenCode's real DDL. The
  fingerprint family stays `oc-sqlite-msgpart-v1`: nothing that was accepted before is refused now.
- a90b64f: Check setup's identifiers where they are given rather than after the questionnaire. A
  profile named with a space passed every question and then failed with
  `Configuration schema rejected /sources/0/profile.`, losing every other answer and naming neither
  the value nor the rule. Setup now states the rule on the question, refuses an unusable answer on
  the spot and asks again, and rejects a malformed `--source`, `--provider`, `--profile` or `--plan`
  up front with `setup_values_invalid`. The rules are read from the configuration schema, so the two
  checks cannot drift apart.

## 0.8.0

### Minor Changes

- a139095: Stage 8, multi-client convergence.

  Each stored prompt now records which client installation produced it, so a capacity source fed by
  both OpenCode and Claude Code can be asked whether they fare differently against it. The new
  `snack stats --by-client` answers that with a refusal share and a credible interval per client,
  and names a difference only when the intervals do not overlap. The attribution never splits the
  shared source: it stays one lineage, one capacity period, one usage profile.

  Prompts stored before this release are attributed only where their capacity source has one
  binding. Where two clients already shared a source the answer is unknown and is reported as
  unattributed rather than guessed; the next synchronization that observes such a prompt fills it
  in.

  Three defects are fixed. Two clients sharing an alias could present the same prompt id, and when
  both had succeeded the second read silently overwrote the first; ingestion now refuses the
  collision and reports it. Refused observations were only reported for sources that have a live
  capture path, so a Claude-only source could refuse silently. And a database written by a newer
  release was reported as a corrupted migration history; it now says which release to install.

  The `doctor` check that counts refused observations is renamed from `source_spool:<alias>` to
  `source_ingestion:<alias>`, because it counts every refusal and not only the spool's. Anything
  matching on the old id needs updating.

  The JSON envelope and the export document gain published JSON Schemas, shipped in the package. The
  export moves to schema version 2 for the new client columns; the envelope stays at version 1 and
  still accepts every document 0.7 produced.

## 0.7.0

### Minor Changes

- c5eb92b: Read Claude Code histories as a second capacity source.

  `snack setup claude` configures a Claude Code source and every command that already worked for
  OpenCode works for it: sync, status, stats, doctor, export, purge, and config. Claude Code is read
  through its own JSONL session histories, read-only, and SNACK registers no hook and writes nothing
  into Claude Code's settings — see ADR-0006.

  A turn's usage is attributed to the prompt that started it, including subagent transcripts Claude
  Code keeps in files of their own and records no token count for in the session that spawned them.
  Turns continued from a resumed session, and subagent transcripts a session never linked, are read
  too: both consumed capacity and can carry a refusal, and refusals are the scarcest evidence a
  forecast has. Refusals are classified from the structured error Claude Code records, never from
  the sentence it shows the user. Claude Code reports no cost of any kind, so cost stays null rather
  than being derived from a price table.

  Databases upgrade from `0.6` in place. The two constraints that named OpenCode, and the ingestion
  cursor columns that spelled out OpenCode's own concepts, are replaced by ones that name a set of
  clients and an adapter-owned cursor; an existing OpenCode cursor keeps its place rather than
  forcing a full re-read.

  Two clients can share one capacity source. Giving OpenCode and Claude Code the same alias,
  provider, profile, and plan puts them behind one lineage, because that is what they are when they
  talk to the same provider account: one usage profile and one capacity period rather than two
  halves of a capacity that does not exist. A restriction stays attributed to the client that was
  refused even when the other client succeeds afterwards.

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
