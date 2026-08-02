---
name: verify-snack-against-real-cli
description: >
  Drive the real `snack` binary — and for anything about a release, the published npm artifact —
  before claiming a command works or a defect is real. Use after changing any SNACK command,
  anything that reads storage, stdout streaming, interactive prompts, wall-clock windows (pressure,
  trend, horizons, freshness), performance budgets, or a source adapter; when driving the real
  OpenCode host to check live capture; and before recording a defect observed from a shell loop
  rather than a test.
license: MIT
metadata:
  author: Duck
  version: "2.1"
---

# Verify SNACK against the real CLI, not only the test suite

SNACK's command tests drive `run(argv, options)` with injected `stdout`/`stderr` sinks, an injected
`prompt`, and an injected `now`. That is the right seam for contracts, and it is blind to how the
installed command actually behaves.

**Failure pattern: success-shaped silence** — an injected-port test passes while the shipped command
is broken. The fake sink never closes a pipe, the fake prompt resolves instantly and never closes
stdin, an in-process call pays module-load cost once instead of every run, and a frozen `now` puts
seeded data inside windows that the real clock puts outside. Nothing fails; the seam was simply
never crossed.

**Verified by:** `npm run check` green at 295 tests while four defects it did not catch were found
by driving the real binary — plugin registration landing under `$XDG_CONFIG_HOME`,
`export --output - | head` exiting 0 with no stack trace, `Ctrl+D` during setup exiting 0 having
written nothing, and `stats` reporting `above_baseline` instead of `steady` on a fivefold climb.
Verified again, harder, by the Phase 1 review of the published `1.0.0`: twelve findings, three
release-blocking, against a suite green at 413 tests — a `setup` re-run erasing a source's evidence
from every forecast, the CLI installing a plugin three minors old, and live capture emitting a null
provider so no live observation could ever be attributed. Each was reproduced on the artifact
installed from npm.

**And one finding was wrong**, which is why this skill carries "Prove the harness before believing
it".

## Which path this run takes

The procedure below is the common path. Four branches leave it:

- **A source adapter changed** — its fixtures are not evidence about the real source; read
  `references/adapter-reconciliation.md`.
- **The capture plugin changed** — drive the real OpenCode host; read `references/opencode-host.md`.
  The packed-plugin host test is that harness; keep it runnable.
- **You are about to record a defect** seen from a shell loop rather than from a test file — see
  "Prove the harness before believing it".
- **Anything claimed about a release** — go against the published artifact, not the tree; see
  "Verify a released defect against the published artifact".

## Procedure

- [ ] 1. Run the gate first: `npm run check` from the repo root. Green here is necessary, not
      sufficient — a suite that never reaches the seam reports success-shaped silence.
- [ ] 2. Build a throwaway environment. Every SNACK path is env-driven, so a temp root fully
      isolates the run — never point it at your real config.
- [ ] 3. Seed data **anchored to `new Date()`**, not to a fixed historical date.
      `references/seeding.md` has the working script; the schema constraints there are the part that
      bites.
- [ ] 4. Drive the actual binary: `node packages/cli/src/cli.js <command>`. Not `run()` in-process.
- [ ] 5. Exercise the paths the fakes cannot reach — the checklist below.
- [ ] 6. Re-run `npm run check` to confirm nothing regressed, then delete the temp root.

### The isolated environment

```bash
ROOT=$(mktemp -d "${TMPDIR:-/tmp}/snack-check-XXXXXX")
CLI=$(git rev-parse --show-toplevel)/packages/cli   # the package dir; references/seeding.md wants it
SNACK="node $CLI/src/cli.js"                        # the command; everything else wants this
export XDG_CONFIG_HOME=$ROOT/config XDG_DATA_HOME=$ROOT/data \
       XDG_STATE_HOME=$ROOT/state XDG_CACHE_HOME=$ROOT/cache \
       HOME=$ROOT OPENCODE_DB=$ROOT/opencode.db
# ... drive commands ...
rm -rf $ROOT
```

`HOME` must be set too: `resolveOpenCodeConfig` falls back to `$HOME/.config` when `XDG_CONFIG_HOME`
is unset, and a leaked real `HOME` would write into your own OpenCode configuration.

### What the fakes cannot reach — check each

| Path               | How to drive it                                                                                 | What it catches                                                |
| ------------------ | ----------------------------------------------------------------------------------------------- | -------------------------------------------------------------- |
| Closed pipe        | `$SNACK export --format json --output - \| head -c 200`                                         | unhandled `EPIPE` replacing output with a stack trace          |
| Interactive prompt | `script -qec "$SNACK setup opencode" /dev/null < <(printf 'a\n'; sleep 0.3; printf 'b\n'; ...)` | stdin pausing between questions; a hang                        |
| Interrupted prompt | same, but feed fewer answers than questions                                                     | `Ctrl+D` surfacing as an internal failure                      |
| Process start-up   | spawn the binary N times and take p95                                                           | module-load cost hidden by in-process repetition               |
| Real-clock windows | seed relative to `new Date()`                                                                   | empty horizons, `insufficient_baseline`, saturated percentiles |
| Permissions        | `find $ROOT -type f -exec stat -c '%a %n' {} +`                                                 | files created outside `0600`/`0700`                            |

`script -qec` gives a pty, which is what makes `process.stdin.isTTY` true and the prompt wire up at
all. Feed answers with a `sleep` between them: a pty delivers a whole buffer at once and readline
may consume it as one line.

**Keep the feeder open after the last answer, or you will invent a hang that is not there.**

```bash
# WRONG — reports a hang for a command that cancels cleanly
script -qec "$SNACK setup claude" /dev/null < /dev/null

# RIGHT — the pty stays up long enough for the command to print and exit
script -qec "$SNACK setup claude" /dev/null < <(sleep 2; printf '\004'; sleep 30)
```

When `script`'s own stdin reaches EOF, `script` starts tearing the pty down while the child is still
working, and a `timeout` around it measures that teardown.

## Prove the harness before believing it

This skill exists because a green test suite is not evidence about what a user experiences. The
symmetric claim is the one that is easy to skip: **a red result from a shell harness is not evidence
either, until the harness is shown able to tell the two answers apart.**

Before recording a defect observed from a shell loop rather than from a test file, run the
**control** that distinguishes the outcome you are claiming from the one you are not:

| Claiming              | The control that proves the harness                                                                        |
| --------------------- | ---------------------------------------------------------------------------------------------------------- |
| "it hangs"            | the same harness around a command that is **known to wait and then finish** — not one that exits instantly |
| "it exits non-zero"   | the same harness around a command known to exit zero                                                       |
| "nothing was written" | write a file through the same harness and see it                                                           |

The finding-08 control was `script -qec 'read -r x; echo' /dev/null < /dev/null`, which exits in
microseconds. It proved the harness could observe an **exit**. It never proved the harness could
observe a **wait**, which was the thing being measured — so it licensed a defect that did not exist:
a two-minute "hang" recorded as P2, scoped into a release, and fixed, before the same command was
driven with the feeder held open and answered `Setup cancelled; nothing was changed.`, exit 0, on
the unmodified published build. The fix was reverted. Cost: a fix, a revert and a retraction.

This is the same rule the project already applies to tests — confirm the check disagrees with the
unfixed code before trusting that it agrees with the fixed one. It applies to a shell loop too.

## Verify a released defect against the published artifact

Driving `node packages/cli/src/cli.js` proves the tree. For anything claimed about a **release** — a
defect found in it, or a fix shipped in it — install by name and version instead:

```bash
npm install --prefix "$ROOT/npm" @snack-ai/cli@1.0.1
S="$ROOT/npm/node_modules/.bin/snack"
"$S" --version                       # believe nothing until this prints what you expect
```

Two things only this reaches:

- **the artifact a user receives**, which traversed the publish path the tree never does. Phase 1
  found the CLI installing a plugin three minors old this way, and `doctor` telling anyone on the
  current one to downgrade;
- **whether a defect was ever real.** Reproducing it on the published build _before_ fixing it is
  what separates a product defect from a harness artifact, and it costs one `npm install`.

Re-verify the fix the same way after publishing. Comparing the published tarball's digest against
`docs/release/artifacts.md` belongs to `.claude/skills/snack-release-a-version/SKILL.md`, step 7.

## Gotchas

- **Anchor seeded data to `new Date()`.** The CLI uses the real clock; only tests inject `now`. Data
  seeded at a fixed date falls outside every rolling window and every command reports "nothing
  observed", which reads as a bug in your change.
- **Re-stamping an OpenCode fixture means rewriting the JSON, not just the columns.** The adapter
  takes `started_at` from `time.created` inside `message.data`, not from the `time_created` /
  `time_updated` columns. Updating only the columns produces the most misleading state there is:
  `sync` reports `1 read, 1 inserted` and every horizon then reports `0 prompts`, so the ingestion
  path looks healthy while nothing is in range. Rewrite the timestamps inside the `data` blob too,
  or pass a wide `--horizon` (for example `P365D`) when the point is to exercise a command rather
  than the windows themselves.
- **`prompt_execution.completion` is CHECK-constrained** to `provisional` or `completed`, and
  `Observation` requires `source_session_id` (not `source_session_fingerprint`, which is a column
  but not a field of the type). Both produce confusing failures when seeding.
- **SNACK normalizes permissions on directories it owns.** `ensurePrivateDirectory` chmods to
  `0700`, so making a directory read-only to simulate a failure gets corrected rather than obeyed.
  To simulate unwritable storage, put a plain _file_ where the data directory belongs.
- **Percentiles saturate at 1.** Once a window clears the entire baseline, further growth is
  invisible. Seed a _varied_ baseline the recent windows can rank inside, or you will only ever
  exercise the saturated branch.
- **Migrations apply before any write** (`initializeDatabase` runs first in `sync` and `status`), so
  temporarily removing a migration file to simulate an older build makes commands fail loudly — that
  is the fixture breaking, not the product.

## What didn't work

- **Measuring `status --no-sync` p95 with 20 in-process `run()` calls.** One process loads modules
  once, hiding ~100 ms the installed command pays every time. It measured 144 ms against a 250 ms
  budget and passed, while the real spawn was **279 ms and over budget**. Spawn the binary.
- **Measuring peak RSS inside the shared test process.** Absolute RSS belongs to the whole process
  and carried ~200 MB from earlier tests in the same file, so the assertion failed at 324 MB with
  nothing wrong. Assert on _growth_ relative to the work done instead — an export must cost less
  memory than the document it produces.
- **Measuring a quality budget while the machine is busy.** At load 5–7 on 12 cores,
  `status --no-sync` p95 read 245 ms against a 250 ms budget and one assertion stepped aside; idle,
  the same tree read 196 ms. A budget measured under contention measures the contention — wait for
  the load average, and record it beside the figure.
- **Opening and closing a `readline` interface per question.** Stdin pauses between them and the
  second question waits forever. One interface must serve the whole run, created lazily and closed
  once.
- **Driving the pty with `pty.fork()` and a single `os.write` of all answers.** It hung and produced
  no output; `script -qec` with paced input worked.
- **Trusting a green fixture suite for a new source adapter.** Seventeen fixture assertions passed
  while the adapter dropped 4 of 17 real restrictions and 47 whole prompts. Fixtures encode the
  shapes you already thought of; only the real source has the ones you did not.

## Reference

- `references/seeding.md` — the seeding script itself, needed at step 3.
- `references/adapter-reconciliation.md` — counting a real source against what an adapter emitted,
  and chasing every gap to a named cause.
- `references/opencode-host.md` — driving the real OpenCode host for live capture.
