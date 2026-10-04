---
"@snack-ai/cli": patch
---

Three ingestion guards, an error envelope that names its command after a leading `--json`, and the
CLI's half of live capture on OpenCode `1.18.15`.

- Claude Code: every `user`/`assistant` record SNACK reads is now held to the `cc-jsonl-turntree-v1`
  shape, not only the first 200 records of each file. A session resumed by a later Claude Code that
  appends records of another shape now refuses the history with `source_schema_unsupported` before
  anything is written, instead of being read under the old family's rules. `snack setup claude` and
  `snack doctor` check every record too, so `doctor` fails a history `sync --full` would refuse;
  both now take time in proportion to the size of the history. Unparseable mid-file lines are still
  counted as rejected and skipped.
- A prompt that reads differently at the revision already stored no longer replaces what was stored.
  A source re-emitting a prompt at the same revision claims nothing changed; different content under
  that claim used to fall through to the update path, which deleted the prompt's usage slices,
  outcome and restrictions, rewrote them, and reported an ordinary `updated` — how the 1.3.0 Codex
  defect turned 3 slices and 435 tokens into 1 and 11 without a word. SNACK now keeps the stored
  prompt, counts the observation in `sync`'s `rejected_invalid`, and `doctor` reports it under
  `source_ingestion:<alias>`. A new parser version still re-reads deliberately. OpenCode's database
  revision is a millisecond clock over rows updated in place, so there a write landing in the
  millisecond already read is still stored; only a reading that would drop usage already stored is
  refused. A refused reading applies nothing of itself: it adds no restriction and cannot turn the
  stored outcome into `restricted`.
- Claude Code: a record written in the same millisecond as a turn's newest one, under a uuid that
  sorts lower — a usage slice, or the turn's end — now moves the turn's revision. It used to leave
  the revision where it was, so the guard above refused the turn and kept the stale reading until a
  later record arrived. A turn without such a record keeps the revision earlier releases stored, so
  upgrading re-reads nothing; on a real history 18 of 1,079 turns are counted `updated` once, with
  their content unchanged.
- Instants a client supplies — a prompt's start and end, a restriction's time, a stated figure's
  time and reset — are stored in the canonical UTC spelling (`toISOString`, millisecond precision).
  An offset-bearing or other-precision timestamp from the Claude Code backfill or the spool could
  sort out of time order wherever storage compares instants as text: the stated-band restate, purge
  and export windows, period selection. Migration `020` rewrites instants already stored (a backup
  is taken first) and leaves a canonical database unchanged; an instant that does not parse, or that
  names no time zone (`2026-01-02T04:00:00`, which was read in the machine's local zone), is now
  refused as `rejected_invalid`. Every timestamp the supported clients write names its zone.
- An error envelope names its command when `--json` comes before it: `snack --json status` (and
  `stats`, `sync`, `dash`, …) reported `command: "snack"` on failure and now reports `status`, as
  `snack status --json` always did.
- `sync` no longer records an `incomparable_outcome_conflict` (and `doctor` no longer warns) for
  every prompt cancelled in OpenCode when the live plugin reported it as a success; the exclusion
  OpenCode's database records is kept.
- `sync` takes over a spool writer lock abandoned for more than two minutes, whatever process id it
  names, instead of skipping the live segment indefinitely. The takeover is atomic, so two writers
  judging the same lock abandoned at once can no longer both end up holding it. A clock jump of more
  than two minutes, or a laptop resumed mid-append, can still take over a held lock; locks are held
  for milliseconds.
- `doctor` reports `spool_lock:<alias>` (warn) while such an abandoned lock is present, and
  `spool_lock:_pending` for the directory of events bound to no source (check ids are an open set).
- The npm description, the README openings, `snack --help` and `man snack` say what SNACK estimates
  — the chance your next prompt goes through without the provider refusing it for a rate or usage
  limit, from usage metadata alone.

No schema version, export column, exit code or flag changes; `doctor` gains one check id family,
`spool_lock:<alias>` and `spool_lock:_pending`, in its open set.
