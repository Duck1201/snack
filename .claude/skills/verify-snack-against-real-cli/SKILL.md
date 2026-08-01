---
name: verify-snack-against-real-cli
description: >
  Drive the installed `snack` binary against a seeded database before claiming a command works — the
  fakes a green `npm run check` runs on cannot reach these paths. Use after changing any SNACK
  command, anything that reads storage, stdout streaming, interactive prompts, wall-clock windows
  (pressure, trend, horizons, freshness), performance budgets, or a source adapter.
license: MIT
metadata:
  author: Duck
  version: "1.0"
---

# Verify SNACK against the real CLI, not only the test suite

SNACK's command tests drive `run(argv, options)` with injected `stdout`/`stderr` sinks, an injected
`prompt`, and an injected `now`. That is the right seam for contracts, and it is blind to how the
installed command actually behaves.

**Failure pattern:** an injected-port test passes while the shipped command is broken. The fake sink
never closes a pipe, the fake prompt resolves instantly and never closes stdin, an in-process call
pays module-load cost once instead of every run, and a frozen `now` puts seeded data inside windows
that the real clock puts outside.

**Verified by:** `npm run check` green at 295 tests **while** four defects it did not catch were
found by driving the real binary, then each confirmed fixed by re-running the real command — plugin
registration landing under `$XDG_CONFIG_HOME`, `export --output - | head` exiting 0 with no stack
trace, `Ctrl+D` during setup exiting 0 having written nothing, and `stats` reporting
`above_baseline` instead of `steady` on a fivefold climb.

## When to use this

- After changing a command's output path, especially anything that streams (`export`) or prompts
  (`setup`).
- After changing anything that reads storage: a new query, a new command, a guard.
- After changing analytics that depend on rolling windows — pressure, trend, horizons, freshness —
  because these are computed against the real clock.
- Before recording a performance budget as met.
- Before telling the user a command works.
- After writing or changing a **source adapter**, before believing its fixtures — see "Reconcile an
  adapter against its real source" below.

## Procedure

- [ ] 1. Run the gate first: `npm run check` from the repo root. Green here is necessary, not
      sufficient.
- [ ] 2. Build a throwaway environment. Every SNACK path is env-driven, so a temp root fully
      isolates the run — never point it at your real config.
- [ ] 3. Seed data **anchored to `new Date()`**, not to a fixed historical date. See
      `references/seeding.md` for the working script; the schema constraints there are the part that
      bites.
- [ ] 4. Drive the actual binary: `node packages/cli/src/cli.js <command>`. Not `run()` in-process.
- [ ] 5. Exercise the paths the fakes cannot reach — the checklist below.
- [ ] 6. Re-run `npm run check` to confirm nothing regressed, then delete the temp root.

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

`HOME` must be set too: `resolveOpenCodeConfig` falls back to `$HOME/.config` when `XDG_CONFIG_HOME`
is unset, and a leaked real `HOME` would write into your own OpenCode configuration.

### What the fakes cannot reach — check each

| Path               | How to drive it                                                                                               | What it catches                                                |
| ------------------ | ------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------- |
| Closed pipe        | `node $CLI/src/cli.js export --format json --output - \| head -c 200`                                         | unhandled `EPIPE` replacing output with a stack trace          |
| Interactive prompt | `script -qec "node $CLI/src/cli.js setup opencode" /dev/null < <(printf 'a\n'; sleep 0.3; printf 'b\n'; ...)` | stdin pausing between questions; a hang                        |
| Interrupted prompt | same, but feed fewer answers than questions                                                                   | `Ctrl+D` surfacing as an internal failure                      |
| Process start-up   | spawn the binary N times and take p95                                                                         | module-load cost hidden by in-process repetition               |
| Real-clock windows | seed relative to `new Date()`                                                                                 | empty horizons, `insufficient_baseline`, saturated percentiles |
| Permissions        | `find $ROOT -type f -exec stat -c '%a %n' {} +`                                                               | files created outside `0600`/`0700`                            |

`script -qec` gives a pty, which is what makes `process.stdin.isTTY` true and the prompt wire up at
all. Feed answers with a `sleep` between them: a pty delivers a whole buffer at once and readline
may consume it as one line.

## Reconcile an adapter against its real source

Fixtures only contain the shapes you already knew about. A source adapter can be green across every
fixture and still drop whole classes of real records, silently — no error, no warning, just a
smaller number. For SNACK that is worse than a crash: an under-counted **observed restriction**
biases the forecast optimistic, and restrictions are the scarcest evidence it has.

So after writing an adapter, count what the raw source contains and compare it with what the adapter
emitted, per class of evidence. Read-only, and it takes a few lines:

```js
// count the evidence in the raw source, independently of the adapter
let raw = 0;
for (const file of sourceFiles)
  for (const line of readFileSync(file, "utf8").split("\n"))
    try {
      if (JSON.parse(line).error === "rate_limit") raw += 1;
    } catch {}

// count what the adapter attributed, and list what it missed
const captured = new Set();
for (const o of adapter.readAll().observations)
  for (const r of o.restrictions) captured.add(r.observed_at);
console.log(`${captured.size}/${raw}`);
```

Then **chase every gap to a named cause** — do not accept "close enough". Each gap is a shape of
real history the fixtures never had. Trace one missed record by hand: walk its parent chain, check
whether the file it lives in is reachable at all, check whether the record that links it exists.

On the Claude adapter this found three defects a green `npm run check` could not:

| Gap                             | Cause                                                                                  |
| ------------------------------- | -------------------------------------------------------------------------------------- |
| Subagent usage missing entirely | Claude Code writes subagent turns to `<session>/subagents/agent-*.jsonl`, never inline |
| Whole turns missing             | A resumed session roots its continued turn at a record that is not a submission        |
| A restriction missing           | An agent interrupted before reporting back leaves a transcript the session never links |

Restrictions went 13/17 → 17/17 and prompts 374 → 423. Nothing in the fixture suite moved.

Run the same reconciliation once more at the end: the number is the check.

## Gotchas

- **Do not assume the parent record already accounts for a child's usage.** Verify it. On Claude
  Code the parent's `toolUseResult` for a subagent carries
  `{isAsync, status, agentId, description, outputFile}` and no token counts at all, so reading the
  subagent file adds usage rather than double-counting it. Assuming either way without looking gives
  a silently wrong total.
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
- **OpenCode's own configuration may hold credentials.** When you need to look at it, render only
  the `plugin` array.

## What didn't work

- **Measuring `status --no-sync` p95 with 20 in-process `run()` calls.** One process loads modules
  once, hiding ~100 ms the installed command pays every time. It measured 144 ms against a 250 ms
  budget and passed, while the real spawn was **279 ms and over budget**. Spawn the binary.
- **Measuring peak RSS inside the shared test process.** Absolute RSS belongs to the whole process
  and carried ~200 MB from earlier tests in the same file, so the assertion failed at 324 MB with
  nothing wrong. Assert on _growth_ relative to the work done instead — an export must cost less
  memory than the document it produces.
- **Opening and closing a `readline` interface per question.** Stdin pauses between them and the
  second question waits forever. One interface must serve the whole run, created lazily and closed
  once.
- **Driving the pty with `pty.fork()` and a single `os.write` of all answers.** It hung and produced
  no output; `script -qec` with paced input worked.
- **Trusting a green fixture suite for a new source adapter.** Seventeen fixture assertions passed
  while the adapter dropped 4 of 17 real restrictions and 47 whole prompts. Fixtures encode the
  shapes you already thought of; only the real source has the ones you did not.
- **Locating a gap by grepping for an identifier across the source tree.** The subagent identifier
  appears inside the subagent's own transcript, so the grep "found" a link that did not exist in the
  parent and pointed at the wrong cause. Read the specific record and walk its parent chain instead.

## Reference

Load `references/seeding.md` when you need the seeding script itself — the SQL is long and only
needed at step 3.
