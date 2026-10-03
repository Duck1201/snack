# Codex CLI Support Matrix

Status: in progress — the adapter, fixtures, privacy canaries and a first real-client read are in;
the 100,000-prompt backfill budget and the cross-platform CI run are not yet recorded here.
`npm run release:check` refuses to publish until this line says complete.

Real-client read (2026-10-03, the maintainer's `~/.codex`, Codex `0.145.0`–`0.159.3`, counts only):
both families present and supported; 107 prompts, 1,832 usage slices, 1 observed restriction (the
one real `usage_limit_exceeded`), 13 excluded, 760 reported-capacity snapshots, 0 rejected lines;
9 legacy forked subagent rollouts skipped and reported by `doctor`; full read in 0.4 s; `setup codex`,
`sync --full`, `status` and `doctor` all exit `0`.

SNACK `1.3` reads Codex CLI through two JSONL rollout families by read-only backfill. There is no
live-capture path for Codex CLI and nothing is registered in Codex's configuration. The decision to
quote the capacity figures Codex states is [ADR-0007](./adr/0007-quote-codex-reported-capacity.md),
amended for `1.3.0`; the full design is
[the 1.3.0 specification](./history/specs/codex-adapter/spec.md).

| Codex CLI version | Schema family               | Backfill  | Live capture |
| ----------------- | --------------------------- | --------- | ------------ |
| `0.145.0`         | `cx-rollout-tokencount-v1`  | Supported | Not offered  |
| `0.146.0`         | `cx-rollout-tokencount-v1`  | Supported | Not offered  |
| `0.147.0`         | `cx-rollout-tokencount-v1`  | Supported | Not offered  |
| `0.159.2`         | `cx-rollout-usagerecord-v1` | Supported | Not offered  |
| `0.159.3`         | `cx-rollout-usagerecord-v1` | Supported | Not offered  |

The fixtures under `packages/cli/test/fixtures/codex/` are **synthetic**: written from the observed
structure only — key paths, JSON types, record-type counts — with fixed identifiers, `gpt-test`
models and empty strings in every slot SNACK does not read. No value from a real rollout was copied
into them. The non-null values of `rate_limit_reached_type` and `spend_control_reached` were never
observed in a real rollout; their fixtures are taken from the strings in the `0.159.2` binary.

## Where SNACK looks

`$CODEX_HOME` when it is an absolute path, otherwise `~/.codex`. SNACK lists
`<home>/sessions/**/rollout-*.jsonl` and `<home>/archived_sessions/rollout-*.jsonl` — Codex moves
archived threads to the second — and never lists `<home>` itself. `~/.codex/history.jsonl` holds
raw prompt history and is never opened; no file under `packages/cli/src/` names it, and a test
asserts that.

Only a directory or rollout that does not exist is treated as absent — a rollout Codex archived
between listing and reading, or no `archived_sessions` yet. A subdirectory or rollout that exists
and cannot be read (permissions, or a file too large to hold) makes the whole history
`source_unavailable` (exit `4`), as an unreadable Claude Code project directory does: a read that
skipped it would report a smaller history as complete.

Compressed rollouts (`rollout-*.jsonl.zst`) are not read in `1.3`. `doctor` counts them and warns
that their prompts are not observed.

## Families and the fingerprint

The family is decided **per turn**. One sessions tree holds both families at once, because Codex
never rewrites an old rollout — and one rollout can hold both too, because Codex does append to one:
a thread started by `0.147` and resumed by `0.159` keeps its old turns and gains new ones in the
same file. A turn is `cx-rollout-usagerecord-v1` when its `task_started` carries `root_turn_id`
or a `token_usage_record` names it; otherwise it is `cx-rollout-tokencount-v1`. A file reports
every family its turns belong to, and a file holding both is a recognized, supported shape, not
drift. The directory is supported when every file parses. Setup records the family of the most
recently modified file (the usage-record family as soon as that file holds any such turn);
`doctor` passes while every family present is supported — not only while the recorded one is
present — so upgrading Codex, or deleting the old rollouts afterwards, does not fail `doctor` while
`sync` keeps reading.

Every record SNACK reads is held to its shape on every read, not on a sample. A violation refuses the
whole history with `source_schema_unsupported` (exit `4`) and writes nothing: a token field that is
not a non-negative integer, a `used_percent` outside `0..100`, a `window_minutes` that is not a
positive integer, a first line that is not `session_meta`, or a line that does not parse anywhere
but at the end of the file. A half-written last line is a rollout Codex is still writing and is
ignored.

Record types SNACK does not read are skipped rather than refused. Codex adds them every release —
`retained_context` and `token_usage_record` both arrived between `0.147` and `0.159` — so refusing
an unread type would fail a client release that changed nothing SNACK reads.

This differs from the Claude Code reader in one place, on purpose: an unparseable line in the middle
of a Claude transcript is counted as rejected and skipped, while in a Codex rollout it refuses. The
Codex specification treats mid-file damage as drift, because a rollout is the only record of a
thread's usage and skipping a line inside it can drop a response's tokens without a trace.

## What is read, and what is not

Each line is parsed, projected onto an explicit allowlist — `CODEX_FIELD_ALLOWLIST` in
`packages/cli/src/codex-adapter.js` — and the parsed object is dropped. The projection reads through
an accessor that refuses any path not on the list, so the list is the enforcement rather than a
description of it.

| Record | Read |
| --- | --- |
| every line | `type`, `ordinal`, `timestamp`, `payload.type` |
| `session_meta` | `id`, `cli_version`, `model_provider`, `thread_source`, `parent_thread_id`, `forked_from_id` (presence only), `subagent_history_start_ordinal` |
| `turn_context` | `turn_id`, `model` |
| `task_started` | `turn_id`, `root_turn_id` |
| `task_complete` | `turn_id`, `duration_ms`, `error.codex_error_info` (a string, or the single key of an object — never its value) |
| `turn_aborted` | `turn_id`, `reason` |
| `token_count` | `info.last_token_usage` and `info.total_token_usage` token fields; `rate_limits.limit_id`, `plan_type`, `rate_limit_reached_type`, `spend_control_reached` (null-ness only), `primary`/`secondary` `used_percent`, `window_minutes`, `resets_at` |
| `token_usage_record` | `turn_id`, `root_turn_id`, `response_id`, `usage` token fields |

**Never read:** every `response_item` (messages, reasoning, tool calls and their output),
`item_completed`, `thread_settings_applied`, `world_state`, `compacted`, `retained_context`,
`inter_agent_communication_metadata`, the working directory, git metadata, workspace roots,
base instructions, agent names and paths, account and user identifiers, `last_agent_message`, an
error's `message`, `rate_limits.credits` (money, not capacity), `individual_limit`, `limit_name`
and `model_context_window`. A classification code that is not shaped like an identifier is stored
as `unrecognized` rather than verbatim.

The privacy canaries in `packages/cli/test/fixtures/privacy-canaries.json` are planted in every one
of those slots, and in a `history.jsonl` beside `sessions/`, and no byte SNACK writes or prints may
contain one.

## Prompts, subagents and forks

In `cx-rollout-usagerecord-v1` a prompt is a root turn of a user thread: a `task_started` whose
`root_turn_id` equals its `turn_id`. Every other turn — a subagent's, or the continuation a user
resumes after an interrupted turn — contributes its usage and restrictions to the prompt its
`root_turn_id` names. A root that is nowhere in the history (its parent rollout absent, compressed
or deleted) makes those turns a prompt of their own, keyed by that root.

In `cx-rollout-tokencount-v1` each `task_started` **in a user thread** is its own prompt. No field
in that family links a parent turn to the inter-agent message that triggered it, so this family can
split one submission into several prompts. A subagent turn of that family names no root and nothing
says which prompt spawned it, so it opens no prompt: it is skipped, and `doctor` warns how many.

A **forked subagent** begins with a verbatim copy of its parent's history. Records below
`subagent_history_start_ordinal` are skipped, so a fork never re-counts its parent. In
`cx-rollout-tokencount-v1` that boundary was written as the file's own length and the subagent's own
turn cannot be told apart from the copy, so a forked subagent of that family is **skipped whole**
and counted; `doctor` warns how many. Undercounting a superseded family's subagents is the bounded
error; double-counting the parent is not.

## Usage

`cx-rollout-usagerecord-v1` gives one usage slice per `token_usage_record`, keyed by its
`response_id`. `cx-rollout-tokencount-v1` gives one slice per token count whose running total
changed — a repeated total is a rate-limit refresh with no new response — taking that count's
`last_token_usage`. The source is chosen per turn, so in a resumed rollout the turns `0.147` wrote
keep the slices their token counts gave them, and the token counts of a `0.159` turn, which only
repeat its usage records, never add a second slice.

OpenAI reports cached input inside input and reasoning inside output; SNACK stores them apart:
input is `input − cached − cache_write`, output is `output − reasoning`. A negative result is drift
and refuses. Codex records no cost, so cost is null and the completeness gate lowers the evidence
level, as for Claude Code. The provider is the rollout's `model_provider`; a provider other than the
configured one takes the existing pending-mapping path rather than being charged to this source.

## Classification — `codex-error-v1`

| Codex signal | SNACK outcome |
| --- | --- |
| `codex_error_info` `usage_limit_exceeded` or `rate_limit_exceeded` | Observed restriction, class `rate_limit` |
| `rate_limit_reached_type` `rate_limit_reached`, `workspace_owner_usage_limit_reached`, `workspace_member_usage_limit_reached`, on a token count inside the prompt | Observed restriction, class `rate_limit` |
| `rate_limit_reached_type` `*_credits_depleted`, or `spend_control_reached` set | Operational failure — a spending cap, not a usage condition |
| any other `codex_error_info` (`server_overloaded`, `unauthorized`, `context_window_exceeded`, …) | Operational failure |
| `turn_aborted` | Excluded, class `cancelled` |

At most one restriction is recorded per prompt. `rate_limit_reached_type` alone is not trusted to be
complete: the one real refusal observed was recorded only as `codex_error_info:
"usage_limit_exceeded"`, with every surrounding `rate_limit_reached_type` null.

## Reported capacity usage

From every token count that carries `rate_limits`, SNACK keeps `limit_id`, `plan_type`, and each
stated window as `{window_minutes, used_percent, resets_at}`. Windows are identified by their length,
never by their slot: from `0.159` Codex's `primary` is a 5-hour window and the 7-day window moved to
`secondary`, where before `primary` was the 7-day (or 30-day, free) window. A figure is always kept
with the `limit_id` it was stated for.

`status` quotes the latest figure per Codex installation and limit on its own `reported` row, and in
`--json` as the optional `reported_capacity` array. It is never an input to the viability interval,
the risk label, the evidence level or usage pressure. `plan_type` is shown and never rotates the
capacity period, which stays keyed on the plan label the user configured.

**Reported figures stay local in `1.3`: `export` does not include them.** Adding a table to the
export document would be a breaking export change, which from `1.0` takes a major release.
`data purge` deletes them with the prompts in scope.

## Setup and sharing a capacity source

```sh
snack setup codex --non-interactive --source work --provider openai --profile default --plan plus
```

Setup checks the fingerprint before asking anything, reads the history once as a dry run, and
exits `4` with `source_unavailable` when there is no sessions directory. A Codex source can share a
capacity source with OpenCode or Claude Code on the same lineage; nothing Codex-specific is added to
the binding, the prompts or the export.

One Codex installation can also feed two capacity sources told apart by provider (`--provider
azure` on one alias, `--provider openai` on another). Each thread's `model_provider` decides
where its prompts go, and the figures that thread stated follow the same rule: they are stored only
for the source whose provider matches, and not at all while that provider maps to more than one
source of the installation.
