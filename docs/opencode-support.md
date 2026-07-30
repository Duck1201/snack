# OpenCode Support Matrix

SNACK `0.2.x` supports the OpenCode SQLite family `oc-sqlite-msgpart-v1` through read-only
backfill.

| OpenCode version | Schema family | Backfill |
| --- | --- | --- |
| `1.17.19` | `oc-sqlite-msgpart-v1` | Supported |
| `1.17.20` | `oc-sqlite-msgpart-v1` | Supported |
| `1.18.1` | `oc-sqlite-msgpart-v1` | Supported |
| `1.18.9` | `oc-sqlite-msgpart-v1` | Supported |

Support is determined by a structural fingerprint, not by the version string. The fingerprint
checks the required `session`, `message`, and `part` tables, columns, foreign keys, read indexes,
and critical JSON shapes used for prompt boundaries, finality, errors, and usage. Unknown or
incompatible fingerprints produce no canonical writes.

The adapter opens the OpenCode database with SQLite read-only and query-only modes. It does not
select prompt text, response text, tool payloads, paths, credentials, raw errors, or arbitrary
metadata. OpenCode WAL files remain owned by OpenCode; SNACK does not checkpoint or modify them.

Mappings are unique per OpenCode installation, provider, and local profile alias. The supported
SQLite family exposes a provider identifier but no profile identifier; if more than one profile is
configured for that provider, SNACK holds those observations as pending and excludes them from
forecasts. After resolving the configuration, run `snack sync --full` to re-evaluate history.

OpenCode `OPENCODE_DB` is honored when it is an absolute path. Otherwise SNACK checks
`${XDG_DATA_HOME:-~/.local/share}/opencode/opencode.db`.

Live plugin capture is not part of `0.2.x`; it begins in Stage 3.

`0.2.x` setup is non-interactive: `--source`, `--provider`, `--profile`, and `--plan` are
explicitly required, and `--dry-run` validates the proposal without creating SNACK state. Guided
interactive prompts are deferred.

The Stage 2 status estimate is not retained as a prediction snapshot. Immutable prediction
attempts, delivery confirmations, and calibration links remain part of Stage 5.

## Stage 2 Completion

Status: completed on 2026-07-30.

The Stage 2 OpenCode tracer passed formatting, lint, type checking, the complete test suite,
package-content inspection, package installation smoke, and release-readiness validation on Node.js
`24.18.1` with npm `11.16.0`.
