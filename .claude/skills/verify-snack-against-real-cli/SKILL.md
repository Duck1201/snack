---
name: verify-snack-against-real-cli
description: >
  Use this skill after changing any SNACK command, and before claiming it works,
  to drive the installed `snack` binary against a seeded database instead of
  trusting the test suite. Use it whenever you touch stdout streaming, interactive
  prompts, wall-clock windows (pressure, trend, horizons, freshness), performance
  budgets, or anything that reads storage. SNACK's command tests inject stdout
  sinks, a fake prompt port and a frozen clock, so an entire class of defects —
  closed pipes, stdin lifecycle, process start-up cost, real-clock data windows —
  is invisible to a green `npm run check`. Includes the exact recipe for seeding a
  throwaway SNACK database anchored to the real clock, which is the enabling step
  and easy to get wrong.
license: MIT
metadata:
  author: Duck
  version: "1.0"
---

# Verify SNACK against the real CLI, not only the test suite

SNACK's command tests drive `run(argv, options)` with injected `stdout`/`stderr`
sinks, an injected `prompt`, and an injected `now`. That is the right seam for
contracts, and it is blind to how the installed command actually behaves.

**Failure pattern:** an injected-port test passes while the shipped command is
broken. The fake sink never closes a pipe, the fake prompt resolves instantly and
never closes stdin, an in-process call pays module-load cost once instead of every
run, and a frozen `now` puts seeded data inside windows that the real clock puts
outside.

**Verified by:** `npm run check` green at 295 tests **while** four defects it did
not catch were found by driving the real binary, then each confirmed fixed by
re-running the real command — plugin registration landing under `$XDG_CONFIG_HOME`,
`export --output - | head` exiting 0 with no stack trace, `Ctrl+D` during setup
exiting 0 having written nothing, and `stats` reporting `above_baseline` instead of
`steady` on a fivefold climb.

## When to use this

- After changing a command's output path, especially anything that streams
  (`export`) or prompts (`setup`).
- After changing anything that reads storage: a new query, a new command, a guard.
- After changing analytics that depend on rolling windows — pressure, trend,
  horizons, freshness — because these are computed against the real clock.
- Before recording a performance budget as met.
- Before telling the user a command works.

## Procedure

- [ ] 1. Run the gate first: `npm run check` from the repo root. Green here is
      necessary, not sufficient.
- [ ] 2. Build a throwaway environment. Every SNACK path is env-driven, so a temp
      root fully isolates the run — never point it at your real config.
- [ ] 3. Seed data **anchored to `new Date()`**, not to a fixed historical date.
      See `references/seeding.md` for the working script; the schema constraints
      there are the part that bites.
- [ ] 4. Drive the actual binary: `node packages/cli/src/cli.js <command>`. Not
      `run()` in-process.
- [ ] 5. Exercise the paths the fakes cannot reach — the checklist below.
- [ ] 6. Re-run `npm run check` to confirm nothing regressed, then delete the temp
      root.

### The isolated environment

```bash
ROOT=$(mktemp -d /home/duck/.tmp_exec/snack-check-XXXX)
CLI=/home/duck/Git/IA/AIQuota/packages/cli
export XDG_CONFIG_HOME=$ROOT/config XDG_DATA_HOME=$ROOT/data \
       XDG_STATE_HOME=$ROOT/state XDG_CACHE_HOME=$ROOT/cache \
       HOME=$ROOT OPENCODE_DB=$ROOT/opencode.db
# ... drive commands ...
rm -rf $ROOT
```

`HOME` must be set too: `resolveOpenCodeConfig` falls back to `$HOME/.config` when
`XDG_CONFIG_HOME` is unset, and a leaked real `HOME` would write into your own
OpenCode configuration.

### What the fakes cannot reach — check each

| Path | How to drive it | What it catches |
| --- | --- | --- |
| Closed pipe | `node $CLI/src/cli.js export --format json --output - \| head -c 200` | unhandled `EPIPE` replacing output with a stack trace |
| Interactive prompt | `script -qec "node $CLI/src/cli.js setup opencode" /dev/null < <(printf 'a\n'; sleep 0.3; printf 'b\n'; ...)` | stdin pausing between questions; a hang |
| Interrupted prompt | same, but feed fewer answers than questions | `Ctrl+D` surfacing as an internal failure |
| Process start-up | spawn the binary N times and take p95 | module-load cost hidden by in-process repetition |
| Real-clock windows | seed relative to `new Date()` | empty horizons, `insufficient_baseline`, saturated percentiles |
| Permissions | `find $ROOT -type f -exec stat -c '%a %n' {} +` | files created outside `0600`/`0700` |

`script -qec` gives a pty, which is what makes `process.stdin.isTTY` true and the
prompt wire up at all. Feed answers with a `sleep` between them: a pty delivers a
whole buffer at once and readline may consume it as one line.

## Gotchas

- **Anchor seeded data to `new Date()`.** The CLI uses the real clock; only tests
  inject `now`. Data seeded at a fixed date falls outside every rolling window and
  every command reports "nothing observed", which reads as a bug in your change.
- **`prompt_execution.completion` is CHECK-constrained** to `provisional` or
  `completed`, and `Observation` requires `source_session_id` (not
  `source_session_fingerprint`, which is a column but not a field of the type).
  Both produce confusing failures when seeding.
- **SNACK normalizes permissions on directories it owns.** `ensurePrivateDirectory`
  chmods to `0700`, so making a directory read-only to simulate a failure gets
  corrected rather than obeyed. To simulate unwritable storage, put a plain *file*
  where the data directory belongs.
- **Percentiles saturate at 1.** Once a window clears the entire baseline, further
  growth is invisible. Seed a *varied* baseline the recent windows can rank inside,
  or you will only ever exercise the saturated branch.
- **Migrations apply before any write** (`initializeDatabase` runs first in `sync`
  and `status`), so temporarily removing a migration file to simulate an older
  build makes commands fail loudly — that is the fixture breaking, not the product.
- No credentials are involved anywhere in this flow. If you ever need OpenCode's
  own configuration, note that it may contain them: render only the `plugin` array,
  never the whole file.

## What didn't work

- **Measuring `status --no-sync` p95 with 20 in-process `run()` calls.** One
  process loads modules once, hiding ~100 ms the installed command pays every time.
  It measured 144 ms against a 250 ms budget and passed, while the real spawn was
  **279 ms and over budget**. Spawn the binary.
- **Measuring peak RSS inside the shared test process.** Absolute RSS belongs to
  the whole process and carried ~200 MB from earlier tests in the same file, so the
  assertion failed at 324 MB with nothing wrong. Assert on *growth* relative to the
  work done instead — an export must cost less memory than the document it
  produces.
- **Opening and closing a `readline` interface per question.** Stdin pauses between
  them and the second question waits forever. One interface must serve the whole
  run, created lazily and closed once.
- **Seeding with a fixed `now` such as `2026-03-01`.** Every prompt landed months
  outside the 31-hour span the pressure calculation reads, so every command
  reported an empty history.
- **Driving the pty with `pty.fork()` and a single `os.write` of all answers.** It
  hung and produced no output; `script -qec` with paced input worked.

## Reference

Load `references/seeding.md` when you need the seeding script itself — the SQL is
long and only needed at step 3.
