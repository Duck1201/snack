# OpenCode Support Matrix

SNACK `0.3.x` supports the OpenCode SQLite family `oc-sqlite-msgpart-v1` through read-only
backfill and accepts live `spool-event-v1` metadata from `@snack-ai/opencode@0.1.x`.

| OpenCode version | Schema family | Backfill | Live capture |
| --- | --- | --- | --- |
| `1.17.19` | `oc-sqlite-msgpart-v1` | Supported | Backfill only |
| `1.17.20` | `oc-sqlite-msgpart-v1` | Supported | Backfill only |
| `1.18.1` | `oc-sqlite-msgpart-v1` | Supported | Backfill only |
| `1.18.9` | `oc-sqlite-msgpart-v1` | Supported | Backfill only |
| `1.18.10` | `oc-sqlite-msgpart-v1` | Supported | Supported by `spool-event-v1` |

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

`snack setup opencode --install-plugin --yes` can register `@snack-ai/opencode@0.1.0` in the global
OpenCode configuration. It stores a content-free `spool-event-v1` stream in SNACK's private spool;
the plugin never opens SQLite or throws capture failures into OpenCode. Unknown future spool schema
versions are rejected with sanitized diagnostics.

The current plugin contract uses `chat.message`, `session.error`, and `session.idle`. Its event
fixtures use the documented plugin hook surface and the structured `APIError.data.statusCode` form
already validated by the supported SQLite source family. Unknown event/schema fields are rejected
without retaining the raw payload.

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

## Stage 3 Validation Status

Status: completed on 2026-07-30.

The Stage 3 live-capture implementation passed formatting, lint, type checking, 82 CLI tests, four
default plugin tests, an enabled packed-plugin host test against OpenCode `1.18.10`, independent
CLI/plugin tarball smoke installation, and `npm audit --audit-level=high` on Node.js `24.18.1` with
npm `11.16.0`. Tests cover bounded fail-open writes, writer/reader lock ownership, structured live
429 classification, privacy canaries, strict schema equivalence, transactional cursors, malformed
payload disposal, retained unmapped observations, opt-in feature persistence, crash-safe setup
recovery, optimistic global-config updates, and property-tested hybrid convergence. Independent
release-blocker review found no remaining P0/P1 defects.
