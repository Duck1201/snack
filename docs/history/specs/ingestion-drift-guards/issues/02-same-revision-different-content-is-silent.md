# 02 — A prompt re-read at the same revision with different content is replaced silently

Status: `fixed` in `1.6.1`, commit `699dcc9` Severity: **P2** Owner: unassigned Found in: `1.3.0`
review — the signature of the Codex P1 Target: `1.6.1`

## What happens

In `storeObservations` (`packages/cli/src/storage.js`), an observation for a prompt already stored
is skipped as `unchanged` when its revision and `observation_hash` both match the stored row. When
the revision matches and the hash does not, it falls through to the update path, which deletes the
prompt's usage slices, source outcome and restrictions and writes the new ones, and counts it as
`updated`.

A source that re-emits a prompt at the **same** revision is claiming nothing changed. Different
content under that claim is either a client that rewrote history without moving its revision, or —
far more likely — SNACK's own reader reading the same bytes differently than it did last time.

## Why it matters

That was exactly the Codex P1: the reader changed its interpretation of unchanged `0.147` turns when
a `0.159` turn was appended, the revision did not move, and the update path replaced 3 slices and
435 tokens with 1 and 11. `sync` reported it as one ordinary `updated` prompt. Nothing a user or a
test looked at distinguished it from a real revision.

The fix for that P1 was in the reader. The storage path that made it silent is unchanged, so the
next reader defect of the same shape — in any adapter — loses data the same way.

## What a fix could be

Treat "same revision, different content" as a counted anomaly rather than an update:

- keep the stored row, as `unchanged` would, so a reader regression cannot destroy history it
  already recorded correctly;
- count it, in a field `sync` and `doctor` can report, so it is visible the first time it happens;
- let a deliberate re-interpretation through: a changed `parser_version` is a legitimate reason for
  the same revision to read differently, and must still update.

## Open questions

- Is there a legitimate same-revision, same-parser-version content change today? OpenCode's live
  spool and its database backfill share a revision domain only under documented rules
  (`docs/architecture/data.md` §9); check whether any of those paths relies on this fall-through.
- Where does the count live — `sync`'s payload (additive, a minor) or an `ingestion_issue` row that
  `doctor` already reads?

## Comments

### Resolution (`1.6.1`, commit `699dcc9`)

**Refused, not applied-and-counted.** "Fail closed on data" and `docs/architecture/data.md` §9 rule
2 ("a duplicate revision is a no-op except for adding provenance") both say the stored row wins: a
regressed reader is the likelier author of the difference, and applying it while counting it would
still have destroyed the 435 tokens. `storeObservations` keeps the stored prompt when the stored row
and the observation share revision domain, revision and `parser_version` but not `observation_hash`,
counts the observation in `rejected_invalid`, and inserts one `same_revision_content_conflict` row
into `ingestion_issue` (reason and path only; no prompt id, no segment, no location). Restrictions
and spool provenance are still unioned first, as for any re-read revision. A changed
`parser_version` is the declared re-interpretation and still updates; a differing revision domain
still goes to the cross-domain merge.

**Answer to the first open question: yes, one legitimate case exists.** OpenCode's backfill revision
is the newest `time_updated`, a millisecond clock over rows OpenCode updates in place, and
`readSince` re-reads rows at the cursor's own timestamp precisely to catch a write in the
millisecond already read (`main.test.js`, "incremental sync detects allowlisted metadata changes at
the cursor timestamp", since Stage 2). Each adapter therefore declares `revisionIdentifiesContent`:
Claude and Codex (append-only) `true`, OpenCode `false`; the spool path keeps the storage default,
`true`. Where it is `false`, only the Codex signature is refused — a reading that would drop a usage
slice already stored. Such a write never deletes rows, and a deletion that lowers the revision was
already kept as `unchanged`.

**Answer to the second: the existing `ingestion_issue` table.** `doctor` already sums it into the
`source_ingestion:<alias>` warn ("N observation(s) were refused on ingestion."), and `sync`'s
existing `rejected_invalid` carries the count — the same treatment the
`cross_client_prompt_id_collision` guard and the 0.9 Claude timestamp refusal received. No field is
added, so a `sync --json` with no anomaly is byte-identical and nothing waits for `1.7.0`.

**Residual risk.** A future reader change that alters content without bumping `parser_version` will
now be refused and surface as a growing `source_ingestion` warning instead of silently rewriting
history; bump `parser_version` when an interpretation changes on purpose. On OpenCode, a regression
that changes values inside slices it keeps is still applied.

Tests: `storage.test.js` (same revision refused; later revision applies; parser bump applies; clock
revisions accept a later write but refuse a lossy one; any different reading refused where the
revision names content; another domain is not the same revision) and `main.test.js` (a Claude turn
whose subagent transcript disappears keeps its 3 slices through `sync --full`, and `doctor` warns).
Seven guard mutations were each killed by at least one test.

### Review of the fix (`1.6.1`, before release)

Two defects in the fix, both fixed before `1.6.1` shipped.

**A refused reading still applied its restrictions.** The guard ran after the union of
restrictions and spool provenance, so an observation it refused could add a `rate_limit`
restriction and flip the stored outcome to `restricted` — the heaviest signal the forecast reads,
from a reading SNACK had just declined to trust. The guard is now decided before anything of the
observation is applied. A refused reading contributes provenance only: the installation that
reported it, filled only where none was recorded, and the spool's `seen_spool` flag (0 → 1) with
SNACK's own clock. None of that is something the observation says about the prompt, and none moves
a count, a slice or an outcome. The equal-hash path still unions: nothing in that reading differs
from what is stored, so the union re-inserts rows already there (`INSERT OR IGNORE`) and sets an
outcome that is already `restricted`. Tests: `storage.test.js` ("a refused same-revision reading
applies none of its restrictions", "an identical reading at the stored revision still unions its
restrictions").

**A Claude Code turn written in one millisecond could be refused for good.** The Claude revision is
`<ms>:<uuid>` of the turn's newest record, a tie inside one millisecond broken by uuid
`localeCompare`. A record appended later in that millisecond under a uuid that sorts lower — a usage
slice, or the terminal — added content without moving the revision, so the next `sync` refused the
turn as `same_revision_content_conflict` and kept the stale row until another record arrived. The
real history holds 42 same-millisecond pairs written in that order. The tie is now broken by append
order: the revision still names the highest uuid of the newest millisecond and appends `+NNNNNN`,
the number of that millisecond's records written after it in the same file (a record in a subagent
transcript, which has no order against the session file, counts as after). A higher uuid in the
millisecond renames the revision and sorts later; a lower one grows the suffix. Storage compares the
tail with `localeCompare`, under which `<uuid>+000001` sorts after `<uuid>`, so every append moves
the revision forward.

*No `parser_version` bump.* Where nothing was appended after the named record — every turn without
a tie, and every tie written in uuid order — the revision is byte for byte what `1.6.0` wrote, so
the stored hash still matches and the turn is `unchanged`. A bump would have sent every stored
Claude prompt through the update path once. Proof on a real history (1,079 turns, 1,066 prompts):
a database written by the pre-fix tree, then synced by the fixed one, reads `updated 0` on an
incremental `sync` (no file moved), `updated 18, unchanged 1,061, rejected_invalid 0` on the next
`sync --full` — the 18 turns whose revision gains a suffix, with slice count (76,053), token total,
restrictions (7) and outcomes identical before and after — and `unchanged 1,079` on the one after.

*A session copied whole into another file under a new `sessionId`* keeps its uuids and times, and
so its revision, while its observation hash differs. It is one prompt: stored once, from the file
listed first, its usage counted once; the copy is refused as `same_revision_content_conflict` on
each read that reaches it and moves nothing. Claude Code's own copies on a real history (7 prompt ids
read from more than one file) all carry different revisions, so none is refused there.

Tests: `claude-adapter.test.js` ("a Claude revision is the one earlier releases wrote unless a record
was appended after it in its millisecond", "a subagent record written in the turn's newest
millisecond moves the revision") and `main.test.js` ("the terminal / a usage slice written in the
same millisecond under a smaller uuid advances a Claude turn", "a Claude session copied into another
file under a new session id is stored once"). Mutation-checked: restoring the uuid-only tie, naming
the last-appended record without a suffix, an unpadded or unconditional suffix, ignoring line order
or cross-file records, applying the union before the guard, and skipping the union on the equal-hash
path are each killed.
