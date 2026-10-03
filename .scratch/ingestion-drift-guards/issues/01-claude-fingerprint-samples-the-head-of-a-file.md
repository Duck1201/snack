# 01 — The Claude fingerprint samples the head of each file, so a family appended later is unseen

Status: `needs-triage` Severity: **P2** (P1 the day Claude Code ships a second family) Owner:
unassigned Found in: `1.3.0` review, by analogy with the Codex P1 Target: unscheduled

## What happens

`hasSupportedStructure` in `packages/cli/src/claude-adapter.js` decides whether a Claude projects
directory is a shape SNACK reads by inspecting at most `fingerprintSampleSize` (200) records per
session file, read with `readSampleRecords`. The read path itself (`read()`) does not apply
`isSupportedTurnRecord` to the records it consumes; the fingerprint is the only shape check.

Nothing past record 200 of a file is ever held to the turn-tree shape. A resumed session that Claude
Code appends to — if a later Claude Code appends records of a new shape to an old transcript — puts
the new family exactly where the sample does not look: the head of the file is old-family, the
fingerprint passes, and the appended records are read under `cc-jsonl-turntree-v1`'s rules without
ever having been recognized as that family.

## Why it matters

This is the Codex P1's mechanism, minus the per-file reclassification. Codex appended a new family
to old rollouts on resume, and the defect was reading those turns under the wrong family's rules.
`docs/codex-support.md` answers it by holding every record the Codex reader consumes to its shape,
not a sample. The Claude reader still samples, for a good reason recorded in the code (issue 06 of
the end-to-end review: reading every file whole on every command cost O(total history) memory).

Claude Code has produced one family so far (`docs/claude-support.md`), so there is no instance yet.
`PLAN.md` rates "unsupported/incompatible data accepted without a safe fail-closed result" P1; this
becomes that the first time Claude Code changes the shape of a record SNACK reads.

## What a fix has to keep

- The O(new data) cost the sample bought. Validating the records `read()` already parses costs no
  extra I/O, because `read()` re-reads only files whose mtime moved; validating the whole history in
  the fingerprint does not.
- The refusal happening before any canonical write, as for every other drift.

## Open questions

- Does Claude Code append to an existing transcript on resume, or start a new file? If it always
  starts a new file, a new family arrives at the head of a file and the sample sees it; the gap is
  then only a mid-file change within one session.
- Should the check move to `read()` (every consumed record) and the fingerprint keep sampling for
  `doctor`, as the Codex reader splits it?
