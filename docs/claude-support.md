# Claude Code Support Matrix

Status: complete.

Cross-platform runtime validation passed on Node.js `24.18.1` in
[CI run 30671328826](https://github.com/Duck1201/snack/actions/runs/30671328826): `npm run check`
and `npm run pack:smoke` green on `ubuntu-latest`, `macos-latest`, and WSL2/Debian 13, with 348 CLI
tests. Budgets measured locally at 100,000 prompts: Claude backfill 12.5 s against a 30 s budget,
`status --no-sync` p95 169 ms against 250 ms over a real history, and the steady-state commands
surviving a 150 MB heap cap.

SNACK `0.7.x` reads Claude Code through the JSONL turn-tree family `cc-jsonl-turntree-v1` by
read-only backfill. There is no live-capture path for Claude Code and no SNACK hook is registered in
Claude Code settings; see [ADR-0006](./adr/0006-claude-jsonl-backfill-without-hooks.md).

| Claude Code version | Schema family | Backfill | Live capture |
| --- | --- | --- | --- |
| `2.1.207` | `cc-jsonl-turntree-v1` | Supported | Not offered |
| `2.1.220` | `cc-jsonl-turntree-v1` | Supported | Not offered |

Support is determined by a structural fingerprint, not by the version string. There is no schema to
inspect as there is for a SQLite source, so the family is decided by the shape of the records the
turn tree is built from: every `user` and `assistant` record must carry `type`, `uuid`,
`parentUuid`, `sessionId`, and `timestamp`, and every `assistant` record must carry
`message.usage.input_tokens`, `output_tokens`, `cache_creation_input_tokens`, and
`cache_read_input_tokens`. Drift in either shape fails closed and produces no canonical writes.

Record types SNACK does not read are skipped rather than refused. Claude Code introduces them
continuously and none of them are the turn tree, so refusing an unread type would fail a client
release that changed nothing SNACK reads.

## What is read, and what is not

A prompt boundary is a `user` record carrying `promptSource` — `typed`, `sdk`, `system`, or
`suggestion_accepted`. A `user` record carrying `toolUseResult` and no `promptSource` is a tool
result inside a turn, not a prompt. `assistant` records carry no `promptId` and are attached to
their prompt through the `parentUuid` chain. Records with `isSidechain: true` are subagent turns:
they contribute their usage to the prompt that started them and never open a prompt of their own.

Two shapes in real histories produce turns with no submission record to walk down from, and both
are read as prompts anyway because they consumed capacity and can carry a refusal. Resuming a
session roots the continued turn at a record that is not a submission — the submission lives in the
history the session was resumed from. And a subagent interrupted before it reported back leaves a
transcript the session never links. Both are identified by the record that roots them. A dangling
record that produced no model call consumed nothing and is not a prompt.

SNACK reads timestamps, client version, model identity, token counts, stop reasons, and the
structured error classification. It does not read `message.content`, `toolUseResult`, `aiTitle`,
`agentName`, `last-prompt` records, `cwd`, `gitBranch`, or `file-history-snapshot` payloads. Claude
Code names each project directory after the working directory it was launched in; the directory name
is treated as an opaque container and session identities are hashed locally before storage.

## Restriction classification

Claude Code records a refused turn as a synthetic assistant record with a structured `error` field.
Classifier `claude-error-v1` maps it as follows. Only the first row is an observed restriction; every
other class is an operational failure, is excluded from the outcome model, and never trains a
forecast — `docs/specification.md` §4.4 already excludes billing and authentication explicitly.

| `error` | Classification |
| --- | --- |
| `rate_limit` | Observed restriction, class `rate_limit`, source code `http_429` |
| `overloaded` | Operational failure |
| `server_overload` | Operational failure |
| `server_error` | Operational failure |
| `authentication_error` | Operational failure |
| `invalid_api_key` | Operational failure |
| `permission_error` | Operational failure |
| `billing` | Operational failure |
| `max_output_tokens` | Operational failure |
| `unknown` | Operational failure |

Claude Code reports session limits and weekly limits through the same `error: "rate_limit"` value at
HTTP 429 and distinguishes them only in the human text of the message, which SNACK does not read.
Both are recorded as class `rate_limit`.

## Setup and synchronization

`snack setup claude` resolves the history directory from `CLAUDE_CONFIG_DIR` when it is an absolute
path, and otherwise from `~/.claude`. It reads the history to prove it is readable before asking
anything, fails closed on an unsupported fingerprint, and exits `4` with `source_unavailable` when
there is no Claude Code installation to read. It registers nothing in Claude Code's own settings and
offers no plugin question, because there is no plugin to register.

Claude Code and OpenCode sources can be configured side by side. A source records where its client
keeps its history — a `database` for OpenCode, a `projects` directory for Claude Code — and the
configuration schema refuses a source that claims the other client's shape.

## Sharing one capacity source

Giving both clients the same `--source` alias, provider, profile, and plan puts them behind one
capacity source. That is the honest description when they talk to the same provider account: they
compete for the same real capacity, so their usage is one usage profile and one capacity period
rather than two halves of a capacity that does not exist. Configuration records one entry per
client, because each has its own installation identity and its own history to find; `status` and
`stats` report the capacity source, not the clients feeding it.

An observed restriction stays attributed to the client that was refused. Getting an answer from the
other client afterwards does not mean the provider did not say no, and combining usage must never
combine away the scarcest evidence a forecast has.

Pointing the same client's alias at a different history is still refused: it would silently
reinterpret every observation already stored under it.

Incremental `sync` skips session files Claude Code has not written to. The cursor is a document the
adapter owns, keyed by a hash of each session file's location: Claude Code names its project
directories after the working directory a session ran in, and SNACK's cursor is stored in its
database, so the name never survives the trip.

## Cost

Claude Code JSONL carries no cost field. Cost and currency are stored as null for Claude
observations rather than derived from a price table, and the field-completeness evidence gate lowers
the evidence level accordingly.

## Client-family Support Policy

The support promise from `0.8.0` — newest validated family plus one previous, per client — is
published as a single matrix for both clients in
[docs/opencode-support.md](./opencode-support.md#client-family-support-policy). Claude Code's newest
validated family is `cc-jsonl-turntree-v1`, and there is no previous one yet.

## Client Attribution

From `0.8.0` each stored prompt records which client installation produced it, so a capacity source
fed by both clients can be asked whether they fare differently against it — `snack stats
--by-client`. The attribution never splits the shared source: it stays one lineage, one capacity
period, and one usage profile.

Prompts stored before `0.8.0` are attributed by the upgrade only where their capacity source has
exactly one binding. Where both clients already shared a source, the answer is genuinely unknown and
is reported as unattributed rather than guessed; the next synchronization that observes such a
prompt fills it in.

Because prompt identifiers are unique per client rather than per capacity source, two clients can in
principle present the same one. That is two prompts, not one, and ingestion refuses the later
observation, keeps what is already stored, and records the collision for `doctor` rather than
overwriting an observation silently.
