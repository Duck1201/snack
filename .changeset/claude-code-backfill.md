---
"@snack-ai/cli": minor
---

Read Claude Code histories as a second capacity source.

`snack setup claude` configures a Claude Code source and every command that already worked for
OpenCode works for it: sync, status, stats, doctor, export, purge, and config. Claude Code is read
through its own JSONL session histories, read-only, and SNACK registers no hook and writes nothing
into Claude Code's settings — see ADR-0006.

A turn's usage is attributed to the prompt that started it, including subagent transcripts Claude
Code keeps in files of their own and records no token count for in the session that spawned them.
Turns continued from a resumed session, and subagent transcripts a session never linked, are read
too: both consumed capacity and can carry a refusal, and refusals are the scarcest evidence a
forecast has. Refusals are classified from the structured error Claude Code records, never from the
sentence it shows the user. Claude Code reports no cost of any kind, so cost stays null rather than
being derived from a price table.

Databases upgrade from `0.6` in place. The two constraints that named OpenCode, and the ingestion
cursor columns that spelled out OpenCode's own concepts, are replaced by ones that name a set of
clients and an adapter-owned cursor; an existing OpenCode cursor keeps its place rather than forcing
a full re-read.

Two clients can share one capacity source. Giving OpenCode and Claude Code the same alias, provider,
profile, and plan puts them behind one lineage, because that is what they are when they talk to the
same provider account: one usage profile and one capacity period rather than two halves of a
capacity that does not exist. A restriction stays attributed to the client that was refused even
when the other client succeeds afterwards.
