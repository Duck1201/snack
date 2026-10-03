---
name: snack-support-a-client-schema-family
description: >
  Decide whether a client's new on-disk shape — Codex CLI rollouts, Claude Code JSONL, OpenCode's
  SQLite — is a new supported schema family or drift that must fail closed, then support it without
  losing or double counting usage. Use when a client releases a new version, when `doctor` or `sync`
  reports `source_schema_unsupported`, when asked to "support Codex 0.16x", "add a family", "the
  client changed its format", or "why did the numbers move after the client updated", and before
  writing a fixture or a fingerprint rule for any client. Reach for it BEFORE editing the adapter:
  the traps are semantic, and a mechanical field-by-field diff passes straight over them.
license: MIT
metadata:
  author: Duck
  version: "1.0"
---

# Support a client schema family

SNACK reads three clients' own files. Each of them ships faster than SNACK does, and each release
can change the shape SNACK reads. The job is always the same: measure the new shape without reading
content, decide family or drift, find the semantic traps, prove them with fixtures that cannot pass
vacuously, and wire the support matrix.

**Failure pattern: success-shaped silence** — the new shape parses, every field the checklist names
is present, `sync` reports rows inserted, and the numbers are wrong. A slot that changed meaning, a
file that holds two families, a replay of another file's history: none of these is a missing field,
so none of them is caught by asking "which fields were added?".

**Why this skill exists — measured on one machine.** 30 Codex rollouts spanned Codex `0.145` →
`0.159.3` in 9 weeks; `0.147` → `0.159` took 6 weeks, about two minors a week. One release
(`cx-rollout-tokencount-v1` → `cx-rollout-usagerecord-v1`) hid three traps:

1. `rate_limits.primary`/`secondary` **swapped meaning** — `primary` was the 7-day window and became
   the 5-hour one. A stated figure must be keyed by `window_minutes`, never by slot name.
2. `codex resume` **appends the new family to an old file**. Classifying the family per file wiped
   the old turns' stored usage (3 slices / 435 tokens became 1 / 11) — a P1 data-loss defect found
   only in independent review. Choose the slice source per turn; a mixed file is a supported shape.
3. A forked subagent **replays its parent's history** into its own file. Records below
   `subagent_history_start_ordinal` must be dropped — and the first test of that rule passed
   vacuously: `response_id` dedup masked it until a fixture held replica records with no parent
   counterpart.

Also: the documented `rate_limit_reached_type` was null in all 2,408 observed token counts; the one
real refusal came as `task_complete.error.codex_error_info = "usage_limit_exceeded"`. Discovering
this by hand cost about 230k tokens, and the P1 still reached review.

## Which client

Client-specific facts — families, traps already found, allowlist, where files live — are in
`references/codex.md`, `references/claude.md`, `references/opencode.md`. The method below is the
same for all three.

## Procedure

- [ ] 1. **Measure structure, never content** — `references/structure-recipes.md`. Version per file,
      record type × version, path:type frequencies, metadata ranges. Print no value that is not a
      version, a type, a count or a metadata number.
- [ ] 2. **Decide family vs drift** — "The decision" below. Write the decision down with the counts
      that justify it before touching the adapter.
- [ ] 3. **Run every row of the trap checklist** against the measurements. Each row ends in a
      measured answer or a named reason it cannot be measured on this machine.
- [ ] 4. **Write one synthetic fixture per trap** — "Fixtures" below.
- [ ] 5. **Write the failing test, then the rule.** Mutation-check every rule — "Tests that cannot
      pass vacuously".
- [ ] 6. **End-to-end equivalence:** `sync` → append the new-version turn to the old file → `sync` →
      `sync --full`; old prompts keep their slices and the two reads agree.
- [ ] 7. **Wire it** — support row, `Status:` line, contracts pair, `doctor` counts, ADR.
- [ ] 8. `npm run check`, then hand off: `snack-fuzz-a-trust-boundary` for the parser,
      `verify-snack-against-real-cli` (`references/adapter-reconciliation.md`) for the real source.

## The decision: family or drift

- **The fingerprint is structural, never the version string.** A version is evidence for the support
  row, not a rule. Decide by the shape of the records the reader consumes.
- **A new family** is a shape SNACK can read **completely and correctly** with a stated rule — new
  required paths, a new record type that carries usage, a changed boundary. It gets a name:
  `cx-<format>-<what-distinguishes-it>-vN`, `cc-…-vN`, `oc-…-vN`. The `-vN` suffix is required:
  `contracts.test.js` matches `` `<prefix>-[a-z0-9-]+-v\d+` `` in backticks.
- **Drift refuses** with `source_schema_unsupported` (exit `4`) before any canonical write: a read
  field with the wrong type, a missing required path, a boundary record out of place. Never guess a
  meaning to keep a sync green.
- **Skipped, not refused:** record types SNACK does not read. Clients add them every release
  (ADR-0006's rule). Refusing an unread type fails a release that changed nothing SNACK reads.
- **Dropped, not refused:** a value that is only quoted and never an input (a stated figure out of
  range). It drops itself and is counted; the prompts around it are still read.
- **Validate on every read, not on a sample.** A new record type can first appear thousands of lines
  into a file — or, after a resume, at its tail.
- **One directory may hold several families at once**, and so may one file. Supported means every
  file parses; `families` is the union.

## The semantic-trap checklist — run on every new client version

| Trap                         | Ask                                                                      | How to measure                                                                    |
| ---------------------------- | ------------------------------------------------------------------------ | --------------------------------------------------------------------------------- |
| Slot or name changed meaning | Does a field keep its name and change what it measures?                  | metadata ranges per slot × version (recipe 4)                                     |
| New family appended to old   | Can the new client write into a file an old client started?              | per-file family mix (recipe 6); `resume` in the client's own help                 |
| Replay or fork duplication   | Does a file copy another file's records?                                 | ids in more than one file (recipe 7); boundary field vs file length               |
| Silently null field          | Does the documented signal ever fire? What fires instead?                | type frequency of every candidate field (recipe 5)                                |
| Client rewrites old files    | Does the client migrate, compact or move old files?                      | `rollout-migrations/`-like directories; mtime vs last record time; archive moves  |
| Compressed files             | Are some files no longer plain text?                                     | count by extension (recipe 8); count them, never read them silently               |
| Units and normalization      | Is cached input inside input? Reasoning inside output? Totals or deltas? | sum the parts against `total_tokens`; a repeated running total is no new response |
| Turn and prompt boundaries   | What opens a prompt, what attaches to it, what links a child to it?      | record type × version; which records carry the linking id                         |

An answer of "not seen on this machine" is not "no": the resume trap was zero files at measurement
time and real anyway. Read the client's own source or `--help` when the sample cannot answer.

## Fixtures

- **Synthesize from structure only.** Fixed identifiers (`00000000-0000-7000-8000-…`), `gpt-test`
  models, empty strings in every slot SNACK does not read. Never copy a value from a real file. A
  value never observed (a non-null `rate_limit_reached_type`) comes from the client binary's strings
  or source, and the support doc says so.
- **One fixture per trap, named after what it is:** `version-0-159-3.jsonl` for the plain family,
  `resumed-0-147-0-by-0-159-3.jsonl`, `subagent-0-159-3.jsonl`, `fork-0-146-0.jsonl`,
  `stated-percent-out-of-range.jsonl`.
- **Privacy canaries in every content-bearing slot** of the new shape — the strings in
  `packages/cli/test/fixtures/privacy-canaries.json`, planted by a canary-history builder in
  `run-fixture.js` (`createCodexCanaryHistory` is the worked example). `privacy.test.js` scans every
  byte SNACK writes; the adapter test scans everything the adapter returns. Both must first assert
  the canary history was read at all.

## Tests that cannot pass vacuously

- **Mutation-check every rule.** Remove the rule (comment out the ordinal filter, key windows by
  slot again, classify per file again), run the test, watch it fail, restore. A test that stays
  green was proving something else.
- **Remove the masking rule's help.** If two rules can both produce the right answer (ordinal
  boundary and `response_id` dedup), build a fixture only one of them can handle — replica records
  with no counterpart. `codex-adapter.test.js` "a fork's replay region is not read even where the
  parent holds no counterpart" is the pattern.
- **Assert the read happened:** a count of observations or slices before any "nothing leaked" or
  "nothing double counted" assertion.
- **End-to-end equivalence**, through `run()` with `makeRunFixture()`: `codex-sync.test.js` "a 0.147
  rollout resumed by 0.159 keeps its old turns' slices across syncs" — old prompts keep exactly
  their slices, totals only grow, and `sync --full` equals the incremental result.

## Wiring

- **Support doc row** in `docs/<client>-support.md`: version, backticked family, backfill, live
  capture. Update the newest/previous policy table in `docs/opencode-support.md`.
- **`Status:` line**, exactly `Status: complete.` or `Status: completed on YYYY-MM-DD.` on a line of
  its own — `scripts/support-matrix-gate.mjs`. "Not yet complete" blocks, by design.
- **Contracts pair:** every backticked family in the support docs and `compatibility.md` must occur
  in the adapter source (`contracts.test.js`, the `[prefix, adapter]` loop). The reverse is not
  checked — keep the family constant and the docs in step by hand.
- **`doctor`:** every skip or drop the new rules introduce is a `health()` count and a warn id
  `source_coverage:<alias>:<client>:<what>`. Counts only — no path, no thread id, no value.
- **ADR:** when the meaning of a stated figure changes, amend the ADR that decided to quote it
  (ADR-0007's "Amendment — 1.3.0" is the model). Surface a conflict; never override silently.

## Things that bite

- **Traps compound.** A legacy fork that `0.159` resumed held a usage-record turn, so it escaped the
  whole-file legacy-fork skip and lost its old turns with no warning — found after the resume and
  fork rules were each green. Test the cross product of the traps, not each one alone.
- **Never open files outside the allowlisted tree** to "just check": `~/.codex/history.jsonl` is raw
  prompt history. Measure only `sessions/` and `archived_sessions/`.
- **jq prints values by default.** Every recipe ends in `type`, `length`, a path, or a count; a
  recipe that prints `.payload` is the leak.
- **A version table per file lies for a mixed file.** `session_meta` names the version that started
  the file, not every version that wrote it.
- **A forked `0.159` rollout carries a second `session_meta`** inside its replay region; "the first
  line" and "the `session_meta`" are not the same question.
- **A client upgrade can change old files' mtimes** without changing their content — the cursor
  re-reads them, which must be idempotent.
