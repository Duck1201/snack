# Troubleshooting

`snack doctor` diagnoses a local installation without changing it. Every check has a stable id, and
that id — not the message — is what a script should key on. This file is one entry per id: what the
check looks at, what each verdict means, and what to do about it.

`doctor` exits `0` when every check passed or warned, and non-zero when any failed. Warnings are
things worth knowing; failures are things that stop SNACK answering honestly.

A check whose id ends in `:<alias>` is reported once per configured capacity source, and
`source_fingerprint` once per client behind it.

## Reading a failure first

Four situations look alike from the outside and are not, so `doctor` tells them apart:

| What you see | What it means | What to do |
| --- | --- | --- |
| `storage_migrations` fails | The database is at an older schema than this build | Run `snack sync`. A backup is taken first. Read-only commands refuse until then rather than half-reading |
| `storage` fails with `storage_newer_than_application` | A **newer** SNACK already upgraded this database | Install the newer release, or restore the pre-migration backup from the backup directory. No downgrade is offered |
| `sqlite_driver` fails, and `storage` and every OpenCode `source_fingerprint` with it | SNACK's SQLite driver did not load, so nothing was opened. Your data was not read and is not at fault | Reinstall SNACK with the Node.js that runs it: `npm install -g --allow-scripts=better-sqlite3 @snack-ai/cli`. If `which snack` points somewhere other than `npm prefix -g`, a second copy is first on `PATH`; remove it. Commands report this as `storage_driver_unavailable` |
| `source_fingerprint` fails | The client's own history is in a shape this build does not read | Check the support matrix for your client. SNACK refuses rather than guessing at rows it cannot interpret |

The first two were once reported identically, which sent people hunting for corruption that was not
there. The driver failure was reported as "Storage could not be read" until `1.2.1`, which did the
same.

## Installation

| Check | Looks at | Verdicts |
| --- | --- | --- |
| `runtime` | The Node.js version | **fail** — SNACK requires Node.js 24. Install it; there is no fallback |
| `platform` | The operating system | **fail** — not a supported platform. Linux, macOS and WSL2 are supported |
| `sqlite_driver` | Whether the native SQLite driver loads. Reported only when it fails | **fail** — built for another Node.js (the message names both ABIs), or never built: npm 12 skips the build in a global install unless `--allow-scripts=better-sqlite3` is passed. See the table above |

## Configuration

| Check | Looks at | Verdicts |
| --- | --- | --- |
| `config` | The configuration file and its schema | **warn** — not created yet; run `snack setup opencode` or `snack setup claude`. **fail** — invalid or unreadable; the message names the rule that refused it and the location, never the value |
| `config_directory` | Permissions on the configuration directory | **fail** — must be `700` |
| `config_file` | Permissions on the configuration file | **fail** — must be `600` |
| `config_backup` | Permissions on the configuration backup | **fail** — must be `600` |
| `config_lock` | A configuration lock left behind by a killed command | **fail** — a stale lock. It is reclaimed by age automatically; a persistent one means something is holding it |

A permission failure is fixed with `chmod`, and it is worth asking how the mode changed: SNACK
creates every one of these privately and never widens them.

## Storage

| Check | Looks at | Verdicts |
| --- | --- | --- |
| `storage` | Whether the database opens at all | **warn** — not initialized yet; any command that writes creates it. **fail** — invalid, inaccessible, or written by a newer release |
| `storage_integrity` | SQLite's own integrity check | **fail** — the file is damaged. Restore from the backup directory; SNACK will not read through damage |
| `storage_migrations` | Whether every migration this build ships has been applied | **fail** — run `snack sync` |
| `storage_lock` | A storage lock left behind by a killed command | **fail** — as `config_lock` |
| `database_file` | Permissions on the database | **fail** — must be `600` |
| `data_directory`, `backup_directory` | Permissions on the directories SNACK owns | **fail** — must be `700` |
| `backup_files` | Permissions on each database backup | **fail** — must be `600`, or they could not be inspected |
| `setup_recovery` | A setup interrupted partway | **fail** — the recovery state could not be read. A pending recovery is completed automatically by the next command that writes |

## Sources

| Check | Looks at | Verdicts |
| --- | --- | --- |
| `source_fingerprint:<alias>:<client>` | Whether the client's history is a shape this build reads | **fail** — unsupported or inaccessible. SNACK fails closed here on purpose. For Codex CLI it passes while every family present is one SNACK reads, whether or not the family recorded at setup is still present, because one Codex history holds several supported families at once and the old rollouts may since have been deleted. **warn** — a Codex history with no rollout yet: nothing to read until Codex writes one |
| `source_coverage:<alias>:codex:<what>` | Codex CLI history SNACK deliberately does not read | **warn** — `forked_subagents`: forked subagent rollouts from Codex 0.147 or earlier, whose copied parent turns cannot be told apart, so only turns a later Codex added on resuming them are read; `subagent_turns`: subagent turns from Codex 0.147 or earlier, which name no prompt to join; `stated_figures`: figures Codex stated that could not be quoted (a percentage outside 0-100, or a label that is not an identifier); `compressed_rollouts`: `rollout-*.jsonl.zst` files, not read in 1.3. `sync` keeps working; the prompts in them are not observed. See [the Codex support matrix](./codex-support.md) |
| `plan_profile:<alias>` | The plan profile named in configuration | **warn** — unusable, so the bundled `generic` profile is used instead. Estimates stay honest but lean harder on a weak prior |
| `source_mapping:<alias>` | Observations waiting on a provider mapping | **warn** — pending mappings, or the count is unknown. They are not lost; they are not attributed yet |
| `source_freshness:<alias>` | How old the synchronized usage is | **warn** — nothing synchronized yet, older than 24 hours, or unknown. Run `snack sync` |
| `source_ingestion:<alias>` | Records ingestion refused | **warn** — some were refused, or the count is unknown. Refused records are counted rather than guessed at, and `sync --json` reports `rejected_invalid`. Since 1.6.1 this includes a prompt that read differently at the revision already stored, by the same parser version: the stored prompt is kept, because a reader disagreeing with itself is the likelier cause. A warning that grows on every `sync` names a reader defect worth reporting |

## The OpenCode live-capture plugin

Reported only when an OpenCode source is configured.

| Check | Looks at | Verdicts |
| --- | --- | --- |
| `opencode_plugin` | The SNACK entry in OpenCode's own configuration | **warn** — not registered, so only backfill runs; or registered at another version, so re-run `snack setup opencode`. **fail** — an entry SNACK cannot work with |
| `spool_directory` | Permissions on the spool directory | **fail** — must be `700` |
| `spool_permissions:<alias>` | Permissions on the per-source spool directory | **fail** — must be `700` |
| `spool_files:<alias>` | Permissions on each spool segment | **fail** — must be `600` |
| `spool_writable:<alias>` | Whether the plugin can write | **warn** — no live events received yet. **fail** — inaccessible or not writable |
| `spool_truncation:<alias>` | Segments cut mid-write | **warn** — a truncated tail. A segment the plugin is still writing is normal; a persistent one is not |
| `spool_rotation:<alias>` | Segment rotation | **warn** — rotation is not keeping up |
| `spool_cursor:<alias>` | Whether closed segments were fully consumed | **warn** — a closed segment is not yet acknowledged. Segments are removed only after every configured source has committed past them |

## `snack dash`

`dash` is not a `doctor` check, but it refuses and reports in ways worth reading in one place. The
full contract is [cli.md §12.12](./specification/cli.md#1212-snack-dash).

| What you see | What it means | What to do |
| --- | --- | --- |
| exit `2`, `dash_requires_terminal` | Standard output or input is not a terminal (`snack dash \| cat`, a redirect, a script), or `TERM` is unset, empty or `dumb` | Run it in an interactive terminal, or use `snack status`, which gives the same reading through a pipe |
| exit `2`, `dash_json_unsupported` | `--json` was passed; the dash draws a screen and has no document | `snack status --json` |
| exit `3`, `4` or `5` before anything is drawn | Configuration, a missing capacity source, or storage newer, unreadable or never initialized — refused exactly as `status` refuses them | As for `status`; storage that does not exist yet or is a migration behind is **not** refused: the first synchronization prepares it, with its backup |
| "snack dash needs at least 64 columns and … rows" | The terminal is too small for the sources configured; nothing is drawn as a forecast or recorded as delivered | Enlarge it; the screen repaints. `q` still quits |
| `sync skipped — another snack command is using storage` | Another `snack` command held the storage lock; the reading on screen is kept and marked old | Nothing; the next synchronization or the next second's retry takes it back |
| `sync failed — run snack doctor` | The synchronization child failed | `snack doctor`, then `snack sync` to see the error itself |
| `A newer snack upgraded storage; quit and restart snack dash.` | A newer `snack` (after `snack update`, say) migrated the database past what this session's code reads; synchronization stops | Quit and start `snack dash` again |
| `Storage keeps answering busy; quit and run snack doctor.` | SQLite answered busy to five reads or writes in a row under the dash's own lock — something outside `snack` is holding the database | Quit, find what has the database open, and run `snack doctor` |
| `Warning: …` on standard error after quitting | A reading carried a warning — a plan profile that could not be read and fell back to `generic`, say — which has no room on the screen, so it is written once on exit, after the terminal is restored | As the warning says; `snack doctor` reports the same condition as `plan_profile:<alias>` |

Quitting never kills a synchronization in flight: it finishes and releases the storage lock on its
own, and a command typed right after waits for it through the lock's usual retry.

## When `doctor` itself refuses

`snack doctor --source <alias>` exits `4` with `source_not_configured` when no configured source
answers to that alias. It does not report a healthy installation for a source that does not exist.

`doctor` never migrates, never writes, and never repairs. That is deliberate: it is the command you
run to find out what state something is in, and a diagnostic that changed the thing it diagnosed
would be useless for exactly that.
