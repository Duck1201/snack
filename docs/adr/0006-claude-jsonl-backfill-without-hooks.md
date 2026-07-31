---
status: accepted
---

# Ingest Claude Code from its JSONL histories alone, without registering hooks

SNACK will read Claude Code through its local JSONL session histories only, and will not register
`UserPromptSubmit`, `Stop`, or `StopFailure` hooks in the user's Claude Code settings. This
supersedes the hook path described for `0.7` in `PLAN.md` Stage 7 Wave 3, `docs/specification.md`
§3.6 items 3 and 5, and `docs/architecture.md` §10.6.

The OpenCode split exists because OpenCode's database is a poor source for restrictions: the plugin
was added to obtain live error fidelity that backfill could not reach. Claude Code is not in that
position. Its JSONL is appended as the session runs, and a refused turn is written to it as a
structured record — `error: "rate_limit"`, `isApiErrorMessage: true`, `apiErrorStatus: 429`,
`model: "<synthetic>"` — carrying the same classification the `StopFailure` hook would deliver.
Registering hooks would therefore write into a user-owned settings file, add a merge/rollback
surface, and create a second delivery path for a signal already present in the first, in exchange
for a latency improvement measured in the polling interval of a command the user runs by hand.

Two consequences are accepted deliberately. Restriction observations are seen when `sync` runs
rather than at the instant of refusal, which is the same freshness the OpenCode backfill path
already has and which `status` already reports through `as_of` and age. And the moment capacity
returns is not recorded: Claude Code carries it only inside the human text of the synthetic message
(`"resets 2:40am"`), and deriving a timestamp from response text is a privacy boundary SNACK does
not cross for a field no forecast currently consumes.

Unrecognized record types are skipped rather than treated as schema drift. Claude Code adds record
types on its own schedule — session titles, agent names, queue operations, file-history snapshots —
and none of them are the turn tree. Failing closed on them would take SNACK down on a client release
that changed nothing SNACK reads. The fingerprint is decided by the shape of the `user` and
`assistant` records the turn tree is built from, and drift there still fails closed.

Claude Code JSONL carries no cost field of any kind. Cost stays null for Claude observations rather
than being derived from a price table, and the existing field-completeness evidence gate
(`docs/specification.md` §9.5) lowers the evidence level on its own.

This decision is reopened if any of the following is observed: JSONL stops being written
incrementally during a session, refusals stop carrying a structured `error` field, or a measured
gap appears between what the JSONL records and what a session actually consumed. Live capture then
returns as its own release with the dry-run, diff, backup, consent, and rollback requirements that
`docs/architecture.md` §10.6 already specifies.
