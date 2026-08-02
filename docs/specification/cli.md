# The command-line contract

Part of the [specification](../specification.md), which indexes every section and keeps §1-3.

## 12. CLI Contract

### 12.1 Global Behavior

All commands support:

- `--help`;
- `--version`;
- `--json` when the command emits structured results;
- `NO_COLOR` and non-TTY output without semantic reliance on colour. Colour is drawn with `util.styleText` from the standard library and never carries meaning alone: a risk label is a printed word that happens to be coloured, so a colourblind reader, a `NO_COLOR` terminal and a captured log read the same sentence. Whether to colour is asked of the output stream through `hasColors()`, with `FORCE_COLOR` and `NO_COLOR` honoured in Node's own precedence — `hasColors()` exists only on a TTY, so leaving the question to the stream alone would drop `FORCE_COLOR` exactly where it is meant to work. There is no `--color` flag. `--json` output is never coloured;
- stable, English command names and JSON fields.

Human warnings go to stderr. Primary human output goes to stdout. JSON mode writes one valid document to stdout and structured diagnostics inside that document; incidental logs never corrupt stdout.

### 12.2 `snack setup`

```text
snack setup <opencode|claude> [--dry-run] [--non-interactive] [--json]
                              [--source <alias>] [--provider <id>]
                              [--profile <name>] [--plan <label>]
                              [--plan-profile <name>]
                              [--enable-prospective-analysis]
snack setup opencode          [--install-plugin] [--yes]
```

Responsibilities:

- discover local source locations;
- create/edit validated capacity-source mappings;
- select bundled/custom plan profiles;
- obtain explicit prospective-analysis consent;
- show and optionally apply client-specific plugin/hook configuration changes;
- back up modified configuration;
- initialize/migrate SNACK storage;
- test source/spool permissions and report next steps.

The MVP accepts `opencode`; `claude` is accepted from 0.7. Setup is idempotent. Re-running it shows current state and proposed changes rather than duplicating plugin/hook entries or sources.

Setup is guided by default and asks only for what it cannot observe. The source database, its schema fingerprint, the providers present in it, any already-configured sources, and the current plugin registration are all discovered. An unsupported fingerprint fails closed before the first question, so nobody is walked through a questionnaire that cannot lead anywhere. The local account or profile alias is deliberately asked rather than discovered: OpenCode does not expose account identity, and SNACK never reads credentials.

The plan label and the plan profile are asked as two separate questions, because the plan a user names and the archetype SNACK holds a prior for are different things. Prospective analysis and plugin registration both default to declining, and a final confirmation precedes any change. Interrupting the questions — `Ctrl+D`, or stdin closing — cancels setup, which exits `0` having changed nothing.

`--non-interactive` requires `--source`, `--provider`, `--profile`, and `--plan`, and reports which are missing. Without a terminal and without `--non-interactive`, setup exits `2` naming the flags rather than waiting on input that will never arrive. Both entry points resolve the same values and then run the identical journal, backup, and rollback path.

### 12.3 `snack status`

```text
snack status [--source <alias>] [--no-sync]
             [--prompt-file <path|->] [--verbose] [--json]
```

Human output has two shapes, chosen by whether a source is named, because they answer two different
questions. There is no box drawing in either: a box survives neither a narrow terminal nor a pipe,
and this output is read through both.

**Without a selection, an overview:** one row per capacity source under one header, carrying the
alias, the viability interval, the risk label, the evidence level, the pressure band, the data age,
and the synchronization status. The question without a selection is which source to reach for, and
that is a comparison across sources rather than a reading of one. The alias column is left-aligned
and fitted to the aliases; the measurements are centred under fixed-width headers, so a column does
not move when a neighbouring source is renamed.

Column widths are counted in screen columns, not code units: an alias may hold characters that
occupy two columns, and one counted as one slides every measurement in that row.

The overview drops columns to fit a narrow terminal, in a declared order of what the reader can most
afford to lose rather than by position — the alias and the interval are never dropped. A dropped
column may cost detail and never a warning: a synchronization that failed is restated as a footer
line when its column is gone.

The uncertainty statements every source repeats are stated once beneath the table rather than once
per row.

**With `--source <alias>`, a panel:** an aligned label column carrying the viability interval and
what it is the probability of, the risk label, the evidence level with a plain statement of what
that level supports, the pressure band with the reading behind it, the top pressure contributors,
the expected prompt category, the active period, the data age, the synchronization status, and the
uncertainty statement.

The method identifier and its version, the model policy version, the evidence gates, and the
percentile each pressure contributor ranks at are **not** in the default human output. They identify
and qualify the estimate rather than state it, and the reader of a panel is a developer deciding
whether to send a prompt.

**With `--verbose`, a panel carrying all of them.** The evidence gates are listed with the limiting
one marked, because which gate holds the level down is the actionable half of the ladder: an
estimate capped by completeness has a synchronization problem the reader can fix, and one capped by
restrictions has simply not been refused often enough yet. Each pressure driver gains its rank,
stated the way this panel states every rank — "above 90% of your own history", never a share of a
capacity nobody can see. The method row names the method, its version and the model policy version,
and is separate from the initial-heuristic label below, which is a warning and carries no
identifier; both may appear at once.

`--verbose` renders panels even without a source selection, rather than a wider overview. The
overview exists to compare sources, and four more rows per source is a stack of panels wearing a
table's header. Asking for the detail is asking for the shape with room for it.

The uncertainty statements every source repeats are stated once beneath all the panels, the same
rule the overview follows: a warning printed once per panel is a warning a reader learns to skip. A
caveat only some sources carry stays in their panels, because moved to the foot it would claim every
source. With one panel nothing is shared, so `--source <alias>` is unchanged.

The requirement that an estimate always names its method is therefore met by two routes, the
`--verbose` panel and the `--json` document, rather than by one.

**One method is named on the human surface, and named rather than identified.** An estimate the
plan-profile prior alone produced — the backoff that reports `initial-generic` — is labelled an
initial heuristic in the panel and warned about per source beneath the overview. That is a separate
requirement from naming the method: an interval built from no observation of this source is not a
measurement of it, and an interface that let it pass beside a calibrated one would be relabelling a
weak prior as a calibrated probability. The label carries no identifier and no version, because it
exists to be read rather than parsed.

`status` draws no chart. The window scores remain in `pressure.trend` in `--json`; the drawing of
them belongs to a surface with room for a series worth drawing.

Prospective text requires an unambiguous source.

### 12.4 `snack stats`

```text
snack stats [--source <alias>] [--horizon <duration|all>]
            [--verbose] [--by-client] [--json]
```

Defaults to configured standard horizons and all sources when concise output remains readable. A source selection produces detail.

Human output is two tables per source, with the analysis horizons as rows in both: comparing the
horizons is the question the report exists to answer, and a shape that puts one horizon's
measurements on one line makes that comparison a matter of holding eight numbers in the head.

The first table carries the prompt counts, the restrictions named by class, the excluded count, the
observed cost per currency, and the duration percentiles. The second carries the token dimensions,
one column each. They are two tables rather than one because a row cannot hold both and stay inside
a terminal, and the token columns are never folded into a subtotal that crosses dimensions.

Durations and counts are rendered at the magnitude a reader uses — minutes rather than milliseconds,
`5.10G` rather than ten digits — while `--json` keeps the stored precision.

The default closes with how many forecasts have been checked against an outcome and how current the
observations are. `--verbose` adds every statistic: each dimension with its unit, sample size and
missing count; the per-model breakdown, counted in usage slices; both calibration streams with their
Brier scores, sample sizes and interval coverage; and the policy versions. A statistic is never
reported as a bare number without its unit and sample size, and those travel with it under
`--verbose` rather than being dropped.

`--by-client` compares the clients feeding each capacity source. It answers the one question a
shared source invites: whether one client is refused more often than the others against the same
real capacity. Each client's refusal share among eligible prompts is reported with a credible
interval, and a difference is named only when that interval and the interval over the other clients
do not overlap. Overlapping intervals are reported as no difference detected, which is not the same
statement as no difference; too few eligible prompts is reported as not comparable, which is not the
same statement as either. Prompts that cannot be attributed to a client are counted and reported
rather than assigned.

The comparison reads the widest configured horizon, because separating two refusal rates needs every
observation available. It is reported as counts against their denominators and never as a
percentage: a share printed as a percentage reads as a claim about the provider's real capacity.

The block is present only when the flag is given. A capacity source fed by one client has nothing to
compare, and the report says so rather than implying a finding.

### 12.5 `snack sync`

```text
snack sync [--source <alias>] [--full] [--json]
```

Incremental mode imports spool records and source changes after stored cursors. `--full` re-reads supported source history and reconciles it idempotently; it does not duplicate records or bypass schema checks.

Results are reported per source/path, including read, inserted, updated, unchanged, excluded, pending-mapping, rejected-invalid, and failed counts.

### 12.6 `snack doctor`

```text
snack doctor [--source <alias>] [--json]
```

Checks:

- runtime and supported platform;
- configuration/schema validity;
- private directory/file permissions;
- SNACK database integrity and migration state;
- OpenCode database and Claude JSONL locations, accessibility, schema fingerprints, and versions when configured;
- OpenCode plugin or Claude hook registration/version/compatibility;
- spool writability, rotation, cursor, malformed/rejected counts, and pending schema-valid mappings;
- source mappings and active periods;
- plan-profile age/provenance;
- data freshness, gaps, and completeness;
- clock/time-zone anomalies.

Doctor never prints credentials, prompt text, response text, or raw sensitive source rows.

### 12.7 `snack export`

```text
snack export --format json --output <path|->
snack export --format csv  --output <directory>
             [--source <alias>] [--since <time>] [--until <time>] [--json]
```

Export is the only intentional path for data to leave SNACK storage. JSON includes schema version and sufficient plan/model provenance to interpret predictions. CSV is a flattened usage/prediction representation and may require separate files when one-to-many relationships cannot be represented safely.

Both formats carry the same flat tables joined by key — `capacity_periods`, `prompts`, `usage_slices`, `restrictions`, `predictions`, `prediction_evaluations` — rather than one nesting and the other flattening. Each table declares its columns, so a later migration cannot widen an export by adding one. Operational tables are excluded, including `pending_spool_observation`, whose payload column is the one place an unreviewed field from a future capture schema could reach an export; live events that have not yet been reconciled therefore do not appear until a synchronization commits them.

`--since` is inclusive and `--until` exclusive, the same half-open convention the analysis horizons use.

An export carries two levels of provenance. Row-level versions come from the rows and are never re-stamped with the exporting build's values. A document-level block names the exporting build — CLI version, export schema version, envelope schema version — and the plan profile each source resolved to. The export schema version is independent of the envelope `schema_version` because it freezes as a public contract at 1.0 on its own timeline.

`--format csv --output -` is refused with exit `2`. Six related tables cannot share one stream without either repeating prompt columns per usage slice or introducing a separator no CSV reader understands, and both invite a silent miscount; CSV writes one file per table in a directory, beside a `manifest.json` carrying the provenance and per-table row counts.

No export contains credentials or text content. Opaque identifiers remain opaque.

### 12.8 `snack data purge`

```text
snack data purge (--source <alias> | --all)
                 [--since <time>] [--until <time>]
                 [--include-config] [--prevent-reimport]
                 [--dry-run] [--yes] [--json]
```

`--prevent-reimport` records a local tombstone/cursor policy for the selected source range; without it, a later full synchronization may restore records still present in the source. The tombstone is enforced during ingestion rather than through the ingestion cursor, so it survives `--full`, which ignores cursors by definition.

Purge deletes exactly the selected scope inside one transaction, and verifies that: the rows counted for the preview and the rows actually deleted must agree, or the transaction rolls back. `--dry-run` reports the same counts, the same resolved half-open window, and the same JSON shape as an applied run, so a preview is verifiably a preview of what will happen.

The ingestion cursor is a single high-watermark and cannot express a purged middle range. When the purged range contains the current watermark, the cursor is reset in the same transaction; otherwise an incremental synchronization would silently never re-import the removed records. A purge whose range does not reach the watermark — including one that selects no records at all — leaves the cursor alone, since forcing a full re-scan would change nothing. Spool segments are never deleted by purge — segment removal remains synchronization's responsibility under the rule that a segment is removed only after every configured source has committed past it.

`--include-config` removes the selected sources from the configuration after the database transaction has committed, because the deletion is unrecoverable while the configuration file is recoverable from its backup. It does not touch the OpenCode plugin registration, which may contain credentials and belongs to `setup`; purge warns that capture continues until `setup` changes it.

Confirmation is required unless `--dry-run` or `--yes` is given, and the confirmation is the source alias typed back rather than a single keystroke. Without a terminal, or in `--json` mode where prompting would break the one-document contract, purge exits `2`.

**Purge takes no pre-purge backup.** Leaving a copy of just-deleted records on disk would contradict what the command promises, and §3.5.7 already states that purged records are not restorable. Consequently purge has no I/O failure of its own: storage failures exit `5`, configuration write failures exit `3`, and misuse exits `2`. Exit code `6` in §12.11 is reached by `export` alone.

### 12.9 `snack config`

```text
snack config get [<key>] [--json]
snack config set <key> <value> [--json]
snack config path
```

Values are parsed and validated against the configuration schema before atomic replacement. Sensitive values are not supported because SNACK configuration must not contain provider credentials.

### 12.10 `snack update`

```text
snack update [--yes] [--dry-run] [--json]
```

Brings the CLI and the capture plugin to versions that belong together, and is the only command permitted to reach the network ([ADR-0010](../adr/0010-snack-update-may-reach-the-network.md)).

It resolves how the CLI was installed from the running module's path, the working directory and the lockfile beside the project root, covering npm, pnpm, bun and yarn across global and local layouts. **An unrecognized layout refuses** with exit `4`, naming the resolved path and the command to run by hand: installing into a place the user did not expect, silently, is worse than not installing.

The resolved command is printed and confirmed before anything runs. `--dry-run` prints and exits; `--yes` skips the confirmation for automation; without either, and with no terminal or in JSON mode, it refuses rather than installing unasked.

Only `@snack-ai/cli` is installed. SNACK never installs the capture plugin — it writes a package specifier that OpenCode resolves — so the matched pair arrives through the registration rather than through a second install.

After a successful install the command re-execs the newly installed binary, which re-registers the plugin at the pin that build carries. The running process only knows the pin it shipped with, and registering from it would write the version being replaced. This step **never rotates a capacity period**: it does not go through `setup`, and therefore never reaches the code that could. A registration is rewritten only if one already exists; nothing registered means live capture was never asked for, and `update` does not start it.

A failed install exits `4` and changes nothing. Offline, a proxy, a registry outage or a private mirror are failures of the environment and are reported as such, never as an internal error.

### 12.11 Exit Codes

Initial stable categories:

- `0`: command completed, including high risk or very low evidence;
- `2`: invalid CLI usage;
- `3`: invalid or unsafe configuration;
- `4`: requested source unavailable or incompatible with no usable result;
- `5`: storage, migration, or integrity failure;
- `6`: export I/O failure; purge reaches no case of its own, because it takes no backup and writes no file (see §12.8);
- `10`: unexpected internal failure.

If synchronization partially fails but a valid, explicitly stale forecast can still be returned, status exits `0` and exposes degraded health prominently. If no valid result exists for the requested source, it exits `4`.

A time window is half-open, so `--until` at or before `--since` selects nothing by construction and exits `2` rather than reporting an empty success that hides a mistyped bound.

An unexpected internal failure reports no detail, because SNACK cannot know what is safe to print about a failure it did not anticipate. Setting `SNACK_DEBUG` to any value prints the underlying error to stderr for a bug report; it never enters the JSON document, stdout, or any file, and it is off unless asked for, because a stack trace carries absolute paths.

## 13. JSON Output

Every JSON document includes:

- `schema_version`;
- `command`;
- `generated_at`;
- `status` (`ok|degraded|error`);
- command-specific `data`;
- structured `warnings` and `errors` arrays.

Forecast JSON additionally includes source/period identity, viability interval, coverage target, risk, evidence, method/model versions, prompt assumption, pressure explanation, freshness, completeness, and caveats.

Breaking field changes require a schema-version and SemVer decision. Human formatting changes do not alter the JSON contract.
