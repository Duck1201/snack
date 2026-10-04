# OpenCode Support Matrix

SNACK `1.0` supports the OpenCode SQLite family `oc-sqlite-msgpart-v1` through read-only backfill
and accepts live `spool-event-v1` metadata from `@snack-ai/opencode@1.0.x`. The plugin's version
moved to `1.0.0` with the CLI's; the spool event contract it speaks is still `schema_version` 1,
and a `0.1.x` plugin still writes a spool this CLI reads.

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

The tables OpenCode creates are not `STRICT`, so SQLite reports `notnull = 0` for their
`TEXT PRIMARY KEY` columns. The fingerprint asserts a key through `pk` and requires `NOT NULL` only
of the columns that carry one; the fixtures under `packages/cli/test/fixtures/opencode/` reproduce
OpenCode's own DDL rather than a tidied equivalent, because a fingerprint is a claim about the
database OpenCode writes.

The adapter opens the OpenCode database with SQLite read-only and query-only modes. It does not
select prompt text, response text, tool payloads, paths, credentials, raw errors, or arbitrary
metadata. OpenCode WAL files remain owned by OpenCode; SNACK does not checkpoint or modify them.

Mappings are unique per OpenCode installation, provider, and local profile alias. The supported
SQLite family exposes a provider identifier but no profile identifier; if more than one profile is
configured for that provider, SNACK holds those observations as pending and excludes them from
forecasts. After resolving the configuration, run `snack sync --full` to re-evaluate history.

OpenCode `OPENCODE_DB` is honored when it is an absolute path. Otherwise SNACK checks
`${XDG_DATA_HOME:-~/.local/share}/opencode/opencode.db`.

`snack setup opencode --install-plugin --yes` can register `@snack-ai/opencode@1.0.4` in the global
OpenCode configuration — the version this CLI publishes alongside itself, asserted by a test so the
two cannot drift apart again. SNACK writes that exact specifier but does not require it when
reading: because every published plugin emits the same `spool-event-v1`, a registration pinned at
another version of the same package is reported as outdated rather than incompatible, and `doctor`
warns instead of failing. It stores a content-free `spool-event-v1` stream in SNACK's private spool;
the plugin never opens SQLite or throws capture failures into OpenCode. Unknown future spool schema
versions are rejected with sanitized diagnostics.

The current plugin contract uses `chat.message`, `chat.params`, `session.error`, `session.idle`, and
-- from `1.6.1`, for its `type` alone -- `session.status`.
Its event fixtures use the documented plugin hook surface and the structured `APIError.data.statusCode`
form already validated by the supported SQLite source family. Unknown event/schema fields are
rejected without retaining the raw payload.

`chat.params` is read for one reason: OpenCode declares `model` **optional** on `chat.message` and
does not send it on `1.18.10`. Routing a spool segment needs the provider, and a segment written to
`_pending` is never attributed and never revisited — so a prompt whose provider is not yet known is
held until `chat.params`, which carries it on the same turn and is not optional. A prompt whose
provider never arrives is released to `_pending` at its terminal event.

### What OpenCode `1.18.15` changed under live capture

Observed by driving a real `opencode serve` `1.18.15` against a local OpenAI-compatible stub, and
fixed in the plugin shipped with SNACK `1.6.1`:

- **`chat.message` still omits `model`, but its output names it.** The input carries `agent` and
  `model` keys whose values are undefined; the user message on the hook's output carries `agent`
  and `model: {providerID, modelID}`. The plugin routes from there first.
- **The title call comes first.** On the first prompt of every session OpenCode names the session
  with `small_model`, and that `chat.params` (agent `title`) arrives before the `build` one. Until
  `1.6.1` the plugin routed on the first `chat.params` it saw, so a `small_model` on another
  provider filed every session's first prompt under that provider, as a success. `chat.params`
  now routes a prompt only when its agent is the prompt's and its `message.id` is the prompt's;
  `title`, `compaction` and `summary` never route one.
- **`chat.params` names the model `id`, not `modelID`.** The `model` there is the provider's model
  record, so `model` was `null` on every live event before `1.6.1`.
- **A 429 is retried by OpenCode and never reaches `session.error`.** OpenCode reports each retry
  only as `session.status {type: "retry", attempt, message, next}`; `message` is the provider's
  free text and there is no status code. The turn ends in `session.idle` whether a retry then
  succeeded or the user cancelled it. `spool-event-v1` lets `session_idle` say only `success`, and
  a restriction needs structured evidence the retry status does not carry, so a turn that saw a
  retry writes no terminal event: it stays provisional in the spool and backfill, which reads how
  the turn ended, finalizes it. The retry message is never stored or read beyond its `type`.
- **A cancelled prompt emits `session.error` (`MessageAbortedError`) and then `session.idle` twice**,
  and `/shell` and `/summarize` emit further idles after a prompt has finished. The plugin now
  writes one terminal event per prompt -- `session_error`, `excluded`, for the cancellation -- and
  ignores later ones. Spools written by earlier plugins carry a `success` after the cancellation;
  `sync` keeps the exclusion the database records and no longer reports an
  `incomparable_outcome_conflict` for it.

`snack setup opencode` is guided from `0.6.0`. It discovers the database path, its schema
fingerprint, and the provider identifiers already present in it, then asks only for what OpenCode
does not expose — the profile alias, the plan label, and the plan-profile archetype. An unsupported
fingerprint fails closed before the first question. Nothing is written until the final
confirmation, and cancelling leaves no SNACK state behind. `--non-interactive` with `--source`,
`--provider`, `--profile`, and `--plan` remains the scriptable path, and `--dry-run` validates the
proposal either way.

The profile alias is the one mapping input that cannot be discovered: the supported SQLite family
records a provider identifier but no account identity, and SNACK never reads OpenCode credentials.

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

## Client-family Support Policy

From `0.8.0` the published support promise is the newest validated schema family plus one previous
validated family, per client, and it is stated per release rather than implied by the version table
above.

| Client | Newest validated family | Previous validated family |
| --- | --- | --- |
| OpenCode | `oc-sqlite-msgpart-v1` | none yet |
| Claude Code | `cc-jsonl-turntree-v1` | none yet |
| Codex CLI (from `1.3.0`) | `cx-rollout-usagerecord-v1` | `cx-rollout-tokencount-v1` |

Codex is the first client to have produced a second family: `0.159` replaced the per-turn token
counts of `0.145`–`0.147` with usage records, and a session resumed across that change carries both
in one file. OpenCode and Claude Code have not, so "plus one previous" has nothing to name for them.
Those rows are published anyway, because the shape of the promise is what a user needs to know
before a client updates underneath them, and an empty column is an honest answer where an absent
table would leave the question open.

A fingerprint outside this matrix fails closed with actionable `doctor` output and writes nothing.
SNACK never promises every historical client version.
