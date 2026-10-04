# 02 — A prompt re-read at the same revision with different content is replaced silently

Status: `fixed` in `1.6.1`, commit e368ea3 Severity: **P2** Owner: unassigned Found in: `1.3.0`
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

### Resolution (`1.6.1`, commit e368ea3)

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
