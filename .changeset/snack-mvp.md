---
"@snack-ai/cli": minor
---

Repair the first-run and live-capture path ahead of the MVP.

Two defects made a correct installation look or behave wrong:

- The OpenCode configuration is now located through `XDG_CONFIG_HOME`, the way OpenCode locates it.
  `resolveOpenCodeConfig` read the environment only from its argument, and a real CLI invocation
  passes none, so a custom `XDG_CONFIG_HOME` was ignored: the plugin was registered under
  `~/.config` while OpenCode read it elsewhere. Live capture silently never started, and `doctor`
  still called the registration compatible because it looked in the same wrong place.
- Plugin registration is inspected by contract rather than by an exact package specifier. Every
  `@snack-ai/opencode@0.1.x` emits the same `spool-event-v1`, so a registration pinned at another
  version of the same package is reported as `outdated` and `doctor` warns; `incompatible` is now
  reserved for an entry whose options are absent or unrecognized, which SNACK genuinely cannot use.
  Setup writes `@snack-ai/opencode@0.1.1`, the published and attested version.

Setup and configuration also stop working against the user:

- `snack setup opencode` records `plan_profile` separately from `plan`. `--plan` is the label you
  use for your plan; `--plan-profile` selects the prior SNACK starts from and defaults to `generic`.
  Previously a free-text plan label was resolved as a profile id, so naming a real plan produced a
  `plan_profile_unavailable` warning on every later `status` and `stats`.
- Configuration keys address array elements, so `snack config set sources.0.plan_profile <id>` edits
  one source instead of requiring the whole `sources` array to be rewritten. An out-of-range index
  fails closed against the schema without replacing the configuration.
- A missing configuration points at `snack setup opencode`, the command that creates one, rather
  than at `snack config set`.

Both READMEs gain a quickstart that runs as written. The previous one omitted `--non-interactive`
and four required flags, so the documented command always failed.

Pre-0.6 contracts remain experimental; this release changes some of them:

- `setup opencode` reports `plan_profile` in `data.source`, and accepts `--plan-profile`.
- `doctor` reports a new `outdated` plugin registration state as a warning rather than a failure.

`snack export` is the first of the two remaining MVP commands.

- Both formats carry the same flat tables joined by key — `capacity_periods`, `prompts`,
  `usage_slices`, `restrictions`, `predictions`, `prediction_evaluations` — rather than one nesting
  and the other flattening. Each table declares its columns, so a later migration cannot widen an
  export by adding one, and operational tables are excluded. `pending_spool_observation` is excluded
  in particular: its payload column is the one place an unreviewed field from a future capture
  schema could reach an export, so live events appear only once a synchronization commits them.
- The document streams. A 100,000-prompt export produces roughly 54 MB while growing resident memory
  by about 15 MB, because no table is ever materialized; buffering the same export measured around
  four times its own size.
- Provenance is recorded at two levels. Row-level versions come from the rows and are never
  re-stamped, while a document-level block names the exporting build and the plan profile each
  source resolved to. `export_schema_version` is independent of the envelope `schema_version`.
- `--format csv --output -` is refused with exit 2. Six related tables cannot share one stream
  without repeating prompt columns per usage slice or inventing a separator no CSV reader
  understands. CSV writes one file per table into a directory beside a `manifest.json`.
- `--since` is inclusive and `--until` exclusive, matching the analysis horizons.

A closed pipe now ends any command quietly. `snack export --output - | head` previously died with an
unhandled EPIPE and printed a stack trace where the JSON should have been; a streaming command makes
that the common case rather than a rarity.

`snack data purge` completes the eight MVP command groups.

- Deletion runs under the storage operation lock inside one immediate transaction, and the rows
  counted for the preview are compared against the rows actually deleted before it commits. "Purge
  never exceeds its selection" is checked rather than claimed.
- `--dry-run` reports the same counts, scope, and JSON shape an applied run reports, so a preview is
  verifiably a preview.
- `--prevent-reimport` records a tombstone enforced during ingestion rather than through the
  ingestion cursor, so it survives `snack sync --full`, which ignores cursors by definition. Refused
  observations are reported as a new `tombstoned` count alongside the existing sync counts.
- Purging a range that contains a source's ingestion watermark resets that cursor in the same
  transaction. The cursor is a single high-watermark and cannot describe a hole, so leaving it would
  make the next incremental synchronization skip the removed records forever, silently.
- Spool segments are never deleted; segment removal stays with synchronization, which alone knows
  when every source has committed past them.
- `--include-config` removes the sources after the transaction commits, because the deletion is
  unrecoverable while the configuration is recoverable from its backup. It leaves the OpenCode
  plugin registration alone — that file may hold credentials and belongs to `setup` — and warns that
  capture continues until `setup` changes it.
- Confirmation is required unless `--dry-run` or `--yes` is given. Without a terminal, or in
  `--json` mode where prompting would break the one-document contract, purge exits 2 and deletes
  nothing.
- Purge takes no pre-purge backup: leaving a copy of just-deleted records on disk would contradict
  what the command promises. It therefore has no I/O failure of its own, and `docs/specification.md`
  records that exit code 6 is reached by `export` alone.

Migration 009 adds the tombstone table and recreates the two `BEFORE DELETE` triggers from 007 with
a connection-scoped escape, so purge can remove the prediction snapshots inside its scope while
those rows stay immutable to every other connection and every other command. The `ON UPDATE`
triggers are untouched: nothing may ever rewrite a snapshot.

Two bundled plan profiles join `generic`, named after a billing archetype rather than a provider:
`subscription-window` for a flat subscription, where restrictions follow requests and generated
volume concentrating in a window, and `metered-credit` for per-token or credit billing, where risk
tracks cumulative volume. `--plan-profile` on `snack setup opencode` selects one.

An archetype changes how usage is weighed, never what SNACK claims capacity is. None of them
declares `prior_viability`, because a differentiated initial viability would assert a plan's real
capacity.

`test/plan-profile.simulation.test.js` is the evidence, and it changed the design. Coverage measured
at 1500 trials per corner, as rates 0.02 / 0.25 for n = 5 and n = 20:

    strength 0.5 -> 0.944 / 0.684 | 0.963 / 0.848
    strength 1   -> 0.905 / 0.918 | 0.927 / 0.861
    strength 1.5 -> 0.905 / 0.910 | 0.843 / 0.868
    strength 2   -> 0.000 / 0.900 | 0.751 / 0.873

Only `1` holds the declared floor at both corners: a weaker prior collapses on a restriction-heavy
source, and a stronger one drags the upper bound below a very high true viability until, at strength
2 with five near-certain successes, the interval stops containing the truth entirely. Prior strength
therefore has no room to vary, and the archetypes differ only in their weights.

The simulations also assert that each archetype ranks its own failure mode above neutral weighting
while ranking the other's failure mode below it — a profile that were simply louder everywhere would
be a sensitivity knob, not a description of a plan — and that all three converge once local evidence
accumulates, since a profile is a weak initial assumption rather than a standing opinion.

The unused `supported.providers` and `supported.plans` properties are removed from the plan-profile
schema. They were never read, and a list of provider brands inside a deliberately brand-free
artifact contradicts the naming rule; the schema freezes as a public contract at 1.0, so this is the
last release that can drop them.
