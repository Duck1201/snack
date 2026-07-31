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
