---
"@snack-ai/cli": patch
---

Three ingestion guards, and an error envelope that names its command after a leading `--json`.

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
  refused.
- Instants a client supplies — a prompt's start and end, a restriction's time, a stated figure's
  time and reset — are stored in the canonical UTC spelling (`toISOString`, millisecond precision).
  An offset-bearing or other-precision timestamp from the Claude Code backfill or the spool could
  sort out of time order wherever storage compares instants as text: the stated-band restate, purge
  and export windows, period selection. Migration `020` rewrites instants already stored (a backup
  is taken first) and leaves a canonical database unchanged; an instant that does not parse is now
  refused as `rejected_invalid`.
- An error envelope names its command when `--json` comes before it: `snack --json status` (and
  `stats`, `sync`, `dash`, …) reported `command: "snack"` on failure and now reports `status`, as
  `snack status --json` always did.
- The npm description, the README openings, `snack --help` and `man snack` say what SNACK estimates
  — the chance your next prompt goes through without the provider refusing it for a rate or usage
  limit, from usage metadata alone.

No schema version, export column, exit code or flag changes.
