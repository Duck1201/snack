# 01 — `started_at` ordered and filtered as text

Status: `fixed` in `1.6.1`, commit 072809e Severity: **P3** Owner: unassigned Found in: `1.5.0`
review of migration `018` — beside the frontier normalization Target: `1.6.1`

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

## Comments

Fixed in `1.6.1` (commit 072809e) by normalizing at ingestion and rewriting what was already stored.

- **Ingestion.** `storeObservations` stores `started_at`, `completed_at` and every restriction's
  `observed_at` in the `Date#toISOString` spelling (UTC, milliseconds; a finer fraction truncated as
  `Date.parse` reads it) and refuses an observation whose instant does not parse as
  `rejected_invalid`. A stated figure's `observed_at` and `resets_at` are stored with their
  millisecond fraction too: the reported pattern accepted `12:00:00Z`, which sorts after
  `12:00:00.500Z`. Text order is now time order in every read that compares instants, with no read
  changed.
- **The open question on hashes.** `observation_hash` is `sha256(JSON.stringify(observation))`, so
  it does include `started_at` as written. It is now taken over the observation **as delivered**,
  before normalization: a prompt re-read in the spelling it was first read in hashes as it did in
  `1.6.0` and is `unchanged`. Hashing the normalized observation would have moved the hash of every
  non-canonical row stored before `1.6.1`, sent each through the update path on its next read, and
  tripped the same-revision guard of `ingestion-drift-guards` 02 as a false anomaly. For a canonical
  spelling the two hashes are identical anyway.
- **Stored rows.** Migration `020_canonical_instants.sql` rewrites them with the ingestion's own
  function, registered on the migrating connection (`snack_canonical_instant`), so an upgraded row
  and the same instant read again agree to the millisecond; a value that does not parse is left as
  it is. A restriction stated twice in two spellings of one instant becomes one row. Every source
  whose rows moved has its stated-band frontier set to `''`, recomputing the whole active period.
  Each `WHERE` matches only a row whose spelling moves, so a canonical database is left byte for
  byte as it was; it costs the pre-migration backup. 100,000 canonical prompts: 425 ms including the
  backup; 100,000 offset-bearing ones: 1,067 ms.
- **The open question on export.** `export` publishes `started_at`, `completed_at` and a
  restriction's `observed_at`. The export schema leaves those values unconstrained and every frozen
  corpus is canonical, so no document changes for canonical data; for a history that held another
  spelling, the exported value is the same instant in the canonical spelling. That is a spelling,
  not a contract change.
- **Real data.** On a copy of a real Claude Code history (1,065 prompts, 1,031 completions, 7
  restrictions stored; 178,279 `timestamp` fields in the JSONL) not one instant was non-`Z` or
  without millisecond precision. Codex and OpenCode adapters and the OpenCode plugin already wrote
  `toISOString()`. The defect needed a spool line or a client writing another spelling, which is why
  it stayed latent.

Covered by `packages/cli/test/instants.test.js`, written first and red before the fix, and
mutation-checked: 16 mutants of the ingestion and the migration, all killed.
