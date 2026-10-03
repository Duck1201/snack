# 02 — A prompt re-read at the same revision with different content is replaced silently

Status: `needs-triage` Severity: **P2** Owner: unassigned Found in: `1.3.0` review — the signature
of the Codex P1 Target: unscheduled

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
