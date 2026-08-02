# @snack-ai/opencode

## 1.0.3

### Patch Changes

- The capture plugin validates only what the host can get wrong.

  The spool had three descriptions of a valid event: the schema both packages ship, this plugin's
  hand-written check on the way in, and the reader's on the way out. The schema is the contract and
  the other two were implementations of it, so all three could disagree — and a reader stricter than
  the contract reports a conforming plugin's events as corruption rather than as disagreement.

  The plugin now checks only the identifiers, provider and model OpenCode supplies and does not
  bound. Every other field of an event is a literal written a few lines above, so re-deriving it
  from the assembled object only restated the constructor. An identifier the host makes longer than
  the schema allows is refused rather than written, because `spool.js` validates that same schema on
  the way back in and would otherwise read the line as a corrupt segment instead of as a prompt this
  plugin could not represent.

  No event that was valid before is refused now, and the spool event schema is unchanged at
  version 1.

## 1.0.2

### Patch Changes

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

## 1.0.1

### Patch Changes

- 813b78e: Live capture now resolves the provider from `chat.params` when the host does not send
  `model` on `chat.message`, and holds the prompt's first event until it can be routed.

  OpenCode declares `model` optional on `chat.message` and does not send it on `1.18.10`. Every live
  event therefore carried `provider: null`, went to the `_pending` directory, and `sync` reported
  `read 2, inserted 0, pending_mapping 2` — no live observation could ever be attributed, on the
  exact version `docs/opencode-support.md` lists as supported. `chat.params` carries the provider on
  the same turn and is not optional; a prompt whose provider never arrives is still released to
  `_pending` at its terminal event, which is where it would have gone anyway.

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

## 0.1.3

### Patch Changes

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

## 0.1.2

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

## 0.1.1

### Patch Changes

- b8d7d9f: Republish the OpenCode capture plugin from the protected release workflow so the version
  served on `next` carries an npm provenance attestation.

  The plugin's first publication had to be performed manually, because npm cannot bind a trusted
  publisher to a package that does not exist yet, and a local publish cannot generate provenance.
  This release contains no behavior change: it exists so that the installable version is the one
  built and attested by CI.
