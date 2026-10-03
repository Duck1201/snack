# 01 — `started_at` ordered and filtered as text

Status: `needs-triage` Severity: **P3** Owner: unassigned Found in: `1.5.0` review of migration
`018` — beside the frontier normalization Target: unscheduled

## What happens

`readStatedBandRows` (`packages/cli/src/storage.js`) selects the active period's prompts with
`prompt_execution.started_at >= ?` (the restate's lookback) and
`ORDER BY prompt_execution.started_at, prompt_execution.id`. Both are text comparisons. `started_at`
is stored as the source wrote it: the Codex adapter writes UTC `Z` instants, but the Claude Code
backfill keeps the client's own spelling, and the spool accepts an offset and any fraction.

On a capacity source that Codex shares with Claude Code or with the OpenCode spool, a prompt stored
as `2026-10-03T12:30:00-03:00` (15:30 UTC) sorts as text before `2026-10-03T13:00:00.000Z`. The
restate then hands `walkStatedHistory` (`packages/cli/src/reported-capacity.js`) prompts out of
chronological order. The walk advances one cursor over the stated timeline and never moves it back,
so after a later prompt has pulled statements in, the next prompt — earlier in time, later in the
list — is resolved with statements made **after its own start**. Its stored `stated_band` can then
be wrong, and with it the shadow's cells and `backtestReported`'s as-of discipline. The same text
comparison can also put a prompt on the wrong side of the lookback filter.

## Why it matters

Low today: the band only feeds the `reported-capacity@1` shadow, which never answers, and only on a
source where Codex is mixed with a client that stores offset-bearing timestamps. It still breaks a
stated invariant — a band is resolved from statements strictly earlier than the prompt's start (spec
§9.3) — silently, and the shadow's calibration record is what a later release reads to decide
whether to promote it.

It is pre-existing in kind, not introduced by `1.5.0`'s fix: the purge windows and the selection of
a prompt's capacity period compare `started_at` as text too.

## What a fix could be

Normalize instants at ingestion: store every `started_at` (and every other instant column storage
compares) in the canonical `toISOString()` spelling, so text order is chronological order everywhere
at once, rather than parsing at each read.

- the adapters or `storeObservations` normalize before the row is written; a value that does not
  parse is refused as invalid rather than stored;
- already-stored rows need a migration that rewrites them, append-only, with the usual backup — or a
  rebuildable pass at the next `sync`, if a rewrite of `started_at` can be shown not to move a
  revision or an `observation_hash`;
- a property test that feeds offset-bearing and fractional spellings through every source and
  asserts the stored band equals the one resolved by instant.

## Open questions

- Does any hash, revision or dedup key include `started_at` as written? Rewriting it would then make
  the next backfill read every Claude Code prompt as changed.
- Is a migration that rewrites `prompt_execution.started_at` within the `1.x` compatibility promise,
  given `export` publishes the column?
