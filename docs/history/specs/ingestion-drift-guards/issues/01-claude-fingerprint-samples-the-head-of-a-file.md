# 01 — The Claude fingerprint samples the head of each file, so a family appended later is unseen

Status: `fixed` in `1.6.1` (commit `f0a4230`,
`fix(claude): hold every consumed record to the turn-tree shape`) Severity: **P2** (P1 the day
Claude Code ships a second family) Owner: unassigned Found in: `1.3.0` review, by analogy with the
Codex P1 Target: `1.6.1`

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

## Resolution — 1.6.1

**Decision: a turn record of another shape anywhere in a file refuses the history.** `readRecords`
holds every `user`/`assistant` record it consumes to `isSupportedTurnRecord` and throws
`source_schema_unsupported` (exit `4`) on a mismatch, before any canonical write. It is not counted
as rejected and stepped over, because:

- It is drift, not damage. A record that parses but has the wrong shape is a client writing another
  family; skipping it drops a prompt's tokens without a trace, or keeps the prompt with fewer usage
  slices — the Codex P1's silent loss. `docs/codex-support.md` refuses the same case.
- It is the rule drift at the head of a file already followed (the sampled fingerprint returned
  `false`). Refusing at record 201 but not at record 199 would make the outcome depend on where in
  the file the new family landed.
- The deliberate Claude/Codex difference survives where it was argued: an unparseable mid-file line
  and a turn record whose `timestamp` is not a time are still damage, counted as rejected and
  skipped.

**What it keeps.** The per-sync check in `readSince` still samples 200 records per file, so a sync
with nothing new stays O(files); the per-record check costs no extra I/O, because it runs on the
records `read()` already parses for files whose mtime moved. `fingerprint()` — setup and `doctor` —
now streams every record (one 64 KiB chunk in memory), so `doctor` fails what `sync --full` refuses.
Claude backfill of 100k prompts (`performance.test.js`): 14.1 / 16.0 / 15.5 s before, 15.1 / 15.3 s
after, against a 30 s budget.

**Open questions, answered.** Whether Claude Code appends to a transcript on resume or starts a new
file no longer matters: either way the record is checked when read. The check moved to `read()` and
the per-sync fingerprint keeps sampling, as the issue proposed; the Codex reader's `doctor` likewise
parses every file.

**Not covered.** A file read before `1.6.1` and not written to since is not re-read by an
incremental `sync`; `sync --full` or `doctor` re-checks it.

Tests: `claude-adapter.test.js` ("a family appended past the fingerprint sample refuses the read",
the incremental, subagent and `doctor` variants) and `doctor.test.js` (sync → resume → sync is
degraded, writes nothing, leaks no canary; `doctor` fails), on the synthetic fixture
`packages/cli/test/fixtures/claude/resumed-2-1-220-by-drifted-usage.jsonl` (202 supported records,
then a drifted turn at record 203–204). Mutation-checked: removing the per-record check fails the
read tests; sampling again in `fingerprint()` fails the `doctor` test.
