---
"@snack-ai/cli": minor
---

Codex CLI is the third supported client: `snack setup codex`.

SNACK reads the rollouts Codex CLI already writes — `sessions/**/rollout-*.jsonl` and
`archived_sessions/rollout-*.jsonl` under `$CODEX_HOME`, or `~/.codex` when it is unset. A relative
`CODEX_HOME` is resolved the way Codex resolves it. Nothing is registered in Codex's configuration
and no plugin is involved. Each line is projected onto an explicit field allowlist and the rest is
dropped unread: messages, reasoning, tool calls and their output, working directories, git metadata,
account identifiers and error messages never leave the parser, and `history.jsonl`, Codex's raw
prompt history, is never opened. Privacy canaries planted in every one of those slots reach no byte
SNACK writes or prints.

Codex `0.145`–`0.147` and `0.159` write two schema families, `cx-rollout-tokencount-v1` and
`cx-rollout-usagerecord-v1`, and both are supported. The family is decided per turn, so a session
started by one version and resumed by the other keeps the usage of every turn it holds. `doctor`
passes while every family present is supported, so upgrading Codex, or deleting old rollouts, does
not fail it while `sync` keeps reading.

A refusal is observed from `codex_error_info` (`usage_limit_exceeded`, `rate_limit_exceeded`) as
well as from `rate_limit_reached_type`, because the one real refusal on record was written only in
the first. A spending cap is an operational failure, not a restriction. A forked subagent from Codex
`0.147` or earlier is not counted, because its copied parent turns cannot be told apart from its
own, and a subagent turn from that family names no prompt to join; `doctor` warns how many of each,
and about compressed rollouts, which are not read yet.

`status` quotes what Codex states about its own capacity windows on a `reported` row beside the
estimate — "Codex states 34% of its 5h window, resets in 2h 30m · 19% of its 7d window, resets Fri
UTC" — and in `--json` as an optional `reported_capacity` field. It is reported capacity usage, the
client's statement: it never enters the viability interval, the risk label, the evidence level or
usage pressure, and a test holds those identical with and without it. Windows are identified by
their length, never by Codex's `primary`/`secondary` slot, which changed meaning at `0.159`. A
figure is attributed only to the capacity source whose provider the stating thread names. One
malformed figure drops only itself, never the history around it.

A Codex source can share a capacity source with OpenCode or Claude Code; nothing Codex-specific is
added to the binding, the prompts or the export. Stated figures are not exported in `1.3`, because a
new table in the export document would be a breaking change. `data purge` deletes them with the rest
of the scope and counts them in the optional `counts.reported_capacity_observations`.

Every other contract is unchanged: the envelope stays at `schema_version` 2, the export at 2,
configuration at 1 and spool events at 1, and a `1.2` document still validates. Two migrations run
on the first command that writes, with the usual backup beforehand. The `source_sync_failed`
warning, for every client, now ends "run `snack doctor` for the cause".
