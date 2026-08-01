# Troubleshooting

`snack doctor` diagnoses a local installation without changing it. Every check has a stable id, and
that id — not the message — is what a script should key on. This file is one entry per id: what the
check looks at, what each verdict means, and what to do about it.

`doctor` exits `0` when every check passed or warned, and non-zero when any failed. Warnings are
things worth knowing; failures are things that stop SNACK answering honestly.

A check whose id ends in `:<alias>` is reported once per configured capacity source, and
`source_fingerprint` once per client behind it.

## Reading a failure first

Three situations look alike from the outside and are not, so `doctor` tells them apart:

| What you see | What it means | What to do |
| --- | --- | --- |
| `storage_migrations` fails | The database is at an older schema than this build | Run `snack sync`. A backup is taken first. Read-only commands refuse until then rather than half-reading |
| `storage` fails with `storage_newer_than_application` | A **newer** SNACK already upgraded this database | Install the newer release, or restore the pre-migration backup from the backup directory. No downgrade is offered |
| `source_fingerprint` fails | The client's own history is in a shape this build does not read | Check the support matrix for your client. SNACK refuses rather than guessing at rows it cannot interpret |

The first two were once reported identically, which sent people hunting for corruption that was not
there.

## Installation

| Check | Looks at | Verdicts |
| --- | --- | --- |
| `runtime` | The Node.js version | **fail** — SNACK requires Node.js 24. Install it; there is no fallback |
| `platform` | The operating system | **fail** — not a supported platform. Linux, macOS and WSL2 are supported |

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
| `source_fingerprint:<alias>:<client>` | Whether the client's history is a shape this build reads | **fail** — unsupported or inaccessible. SNACK fails closed here on purpose |
| `plan_profile:<alias>` | The plan profile named in configuration | **warn** — unusable, so the bundled `generic` profile is used instead. Estimates stay honest but lean harder on a weak prior |
| `source_mapping:<alias>` | Observations waiting on a provider mapping | **warn** — pending mappings, or the count is unknown. They are not lost; they are not attributed yet |
| `source_freshness:<alias>` | How old the synchronized usage is | **warn** — nothing synchronized yet, older than 24 hours, or unknown. Run `snack sync` |
| `source_ingestion:<alias>` | Records ingestion refused | **warn** — some were refused, or the count is unknown. Refused records are counted rather than guessed at, and `sync --json` reports `rejected_invalid` |

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

## When `doctor` itself refuses

`snack doctor --source <alias>` exits `4` with `source_not_configured` when no configured source
answers to that alias. It does not report a healthy installation for a source that does not exist.

`doctor` never migrates, never writes, and never repairs. That is deliberate: it is the command you
run to find out what state something is in, and a diagnostic that changed the thing it diagnosed
would be useless for exactly that.
