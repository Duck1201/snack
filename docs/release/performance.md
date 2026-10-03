# Performance Evidence

Performance gate: passed

[PLAN.md](../../PLAN.md) states four quality budgets and says outright what they are: figures for a
typical supported developer machine, release gates from the MVP onward, and **not** cross-device
guarantees. This file is where the measurement that satisfies that gate is recorded, per release.

## Why CI reports these and does not assert them

`packages/cli/test/performance.test.js` measures every budget on every run and prints the figure
through `t.diagnostic`. Three of the assertions return early when `CI` is set, and two more step
aside when the load average is above half the core count. The file also runs on its own rather than
beside the rest of the suite, for the reason recorded under `1.2.0`.

That is deliberate, and it is the honest arrangement rather than a convenient one. A shared
two-vCPU hosted runner measured the incremental-synchronisation budget at 2.06 s against a 2 s
budget — three per cent over a budget the runner was never the subject of. Asserting there produces
red that means "the runner was busy", which teaches everyone to ignore the one signal that should
never be ignored. So CI reports the number, this document holds the gate, and a regression shows up
as a figure that moved rather than as a build that flaked.

The measurement below is taken with the **spawned binary**, not with `run()` in-process. One process
loads modules once and hides roughly 100 ms that the installed command pays every time: an
in-process measurement of `status --no-sync` read 144 ms against a 250 ms budget while the real
spawn was 279 ms and over it.

## 1.4.0

- Date: 2026-10-03
- Commit: `release/1.4.0` after `status --sequence N` and migration 016 (`338caa4`); the review fixes that followed touch wording, tests and the release workflow, not a measured path
- Machine: Linux 6.12.111+deb13-rt-amd64, 12 cores
- Toolchain: Node `24.18.1`, npm `11.16.0` for the packaging scripts
- History: 100,000 prompts, per `PROMPTS` in `performance.test.js`; the Codex rows from a synthetic
  history of 1,000 rollouts in the 0.159.3 shape, 100 turns each, one stated rate-limit snapshot per
  turn with two windows (200,000 reported capacity rows)

| Budget | PLAN.md | Measured | `1.3.0` |
| --- | --- | --- | --- |
| `status --no-sync` p95 | under 250 ms | **195 ms** (p50 193 ms, min 189 ms) | 205 ms |
| `status --no-sync --sequence 100` p95 | under 250 ms | **194-196 ms** (p50 191-192 ms, min 184-188 ms), three batches | — |
| `status --no-sync` p95, two clients on one source | under 250 ms | **195 ms** (p50 192 ms, min 187 ms) | 196 ms |
| `status --no-sync` p95, Codex, 200,000 reported capacity rows | under 250 ms | **208-211 ms** plain, **208-216 ms** with `--sequence 100` (p50 204-207 ms both) | 227 ms |
| Incremental synchronisation, 100,000 prompts | under 2 s | **424 ms** (categorize 40 ms + write 384 ms) | 423 ms |
| Initial backfill, 100,000 prompts, OpenCode | under 30 s | **14.4 s** | 14.9 s |
| Initial backfill, 100,000 prompts, Claude Code | under 30 s | **13.6 s** | 13.7 s |
| Initial backfill, 100,000 prompts, Codex CLI, spawned | under 30 s | **16.7 s** | 19.4 s |
| Steady-state memory | under 150 MB | **passes the heap cap for all three clients** | passes |

**`--sequence` costs nothing a wall clock can see.** Three alternating batches of 20 spawned samples
each put the plain and the `--sequence 100` command within 2 ms of each other at p95 and p50 on the
100,000-prompt history: the sequence answer is a closed-form transform of the posterior the
single-prompt forecast already computed, plus one row in `prediction_sequence`. The Codex batches
were taken while another process intermittently took the box down to 47% idle; the batches it
touched read up to 321 ms p95 in either variant alike, and the figures above are the ones taken at
85-99% idle. `performance.test.js` ran at a load average of 5.2-5.9, under the half-the-cores line,
so this time its two `status` assertions did assert, and passed; `vmstat` read 98-99% idle before
and after every measurement, against a real-time kernel's load average of 5-9.

### What migration 016 costs the person upgrading

A 100,000-prompt Codex CLI history with 200,000 reported capacity rows, backfilled by the published
`@snack-ai/cli@1.3.0` (schema 015), then opened by this tree:

| | Measured |
| --- | --- |
| First `sync` after the upgrade, spawned, backup included | **1.17 s** (0.99 s once migrated) |
| Database file, before | 156.0 MB |
| Database file, after | 156.0 MB (+4 KB) |
| Rows in every pre-existing table, before and after | identical |
| `integrity_check` / `foreign_key_check` | ok / no violations |

016 only creates `prediction_sequence` and its two immutability triggers, empty; the cost is the
pre-migration backup, a copy of the database taken once. `upgrade:smoke` now includes `1.3.0` as a
floor and applies 016 over a database that release wrote.

## 1.3.0

- Date: 2026-10-03
- Commit: `release/1.3.0` after the Codex CLI adapter, migrations 014 and 015 and
  `reported_capacity_latest` (`9449a86`); the two `status` rows re-taken at `a2f0533`
- Machine: Linux 6.12.111+deb13-rt-amd64, 12 cores
- Toolchain: Node `24.18.1`, npm `11.16.0` for the packaging scripts, `12.0.2` locally
- History: 100,000 prompts, per `PROMPTS` in `performance.test.js`; the Codex rows from a synthetic
  history of 1,000 rollouts in the 0.159.3 shape, 100 turns each, one stated rate-limit snapshot per
  turn with two windows (200,000 reported capacity rows)

| Budget | PLAN.md | Measured | `1.2.1` |
| --- | --- | --- | --- |
| `status --no-sync` p95 | under 250 ms | **205 ms** (p50 192 ms, min 186 ms) | 199 ms |
| `status --no-sync` p95, two clients on one source | under 250 ms | **196 ms** (p50 194 ms, min 189 ms) | 210 ms |
| `status --no-sync` p95, Codex, 200,000 reported capacity rows | under 250 ms | **227 ms** (p50 218 ms, min 213 ms) | — |
| Incremental synchronisation, 100,000 prompts | under 2 s | **423 ms** (categorize 47 ms + write 376 ms) | 667 ms |
| Incremental synchronisation, Codex, one turn appended to one rollout, spawned | under 2 s | **969 ms** p50, 1,089 ms max of 10 | — |
| Initial backfill, 100,000 prompts, OpenCode | under 30 s | **14.9 s** | 15.4 s |
| Initial backfill, 100,000 prompts, Claude Code | under 30 s | **13.7 s** | 15.2 s |
| Initial backfill, 100,000 prompts, Codex CLI | under 30 s | **19.4 s** | — |
| Steady-state memory | under 150 MB | **passes the heap cap for all three clients** | passes both readings |

**Every figure is inside its budget, and the two `status` assertions still stepped aside.** The
first full runs were taken while a JVM held three of the twelve cores, at load averages of 10-17;
there `status --no-sync` read up to 290 ms, over budget, and no assertion was entitled to an opinion.
The rows above are the re-run with that process gone: `vmstat` read 95-96% idle with no runnable
queue, yet this real-time kernel's load average sat at 7.7-8.2, above the half-the-cores rule, so the
assertions stepped aside again. The figures are therefore ones this run reports from an idle CPU
rather than ones it asserted. The Codex rows are not in `performance.test.js`; they were measured
with the spawned binary by the same method, 20 samples a batch, under the earlier load.

**The Codex `status` figure is the one this release had to earn.** Before `9449a86`,
`readReportedCapacity` ranked every statement a source had stored to keep one per limit, and read
476 ms p95 over 200,000 rows. Keeping the latest stated figure per group in
`reported_capacity_latest`, upserted in the transaction that stores it and recomputed by `data
purge`, makes the read 0.53 ms in process, and the spawned command lands within 10-20 ms of a
prompt-only history. A wall clock would not guard that, so `storage.test.js` asserts the query plan
instead: the history table is reached only through its unique key, never scanned.

### What migrations 014 and 015 cost the person upgrading

A 100,000-prompt Claude Code history, backfilled by the published `@snack-ai/cli@1.2.1` (schema
013), then opened by this tree:

| | Measured |
| --- | --- |
| Wall clock for both migrations, in process, three runs | **0.83-1.01 s** |
| Peak process RSS during it | **85 MB** |
| First `sync` after the upgrade, spawned | **2.2 s** (1.5-1.6 s once migrated) |
| Database file, before | 73.9 MB |
| Database file, after | 78.4 MB |
| Rows in every pre-existing table, before and after | identical |
| `prompt_execution.installation_id` mismatches | 0 of 100,000 |
| `integrity_check` / `foreign_key_check` | ok / no violations |

014 rebuilds `client_installation` and its three dependents through a keyed stash of
`prompt_execution.installation_id`, rather than copying `prompt_execution` out and back. That is why
it costs half of 013's 1.8 s on a database half again as large, and grows the file by 6% rather than
1.7x. 015 creates `reported_capacity_observation`, its index and `reported_capacity_latest` empty.
The pre-migration backup is still taken first, so the peak disk is roughly twice the database, once.
`upgrade:smoke` now includes `1.2.1` as a floor and applies both over a database that release wrote.

## 1.2.1

- Date: 2026-10-03
- Commit: the `1.2.1` cut, after the SQLite driver diagnosis and the `update` prefix fix
- Machine: Linux 6.12.111+deb13-rt-amd64, 12 cores, load average 5.96 at the start of the run
- Toolchain: Node `24.18.1`, npm `12.0.2`
- History: 100,000 prompts, per `PROMPTS` in `performance.test.js`

| Budget | PLAN.md | Measured | `1.2.0` |
| --- | --- | --- | --- |
| `status --no-sync` p95 | under 250 ms | **199 ms** (p50 194 ms, min 186 ms) | 194 ms |
| `status --no-sync` p95, two clients on one source | under 250 ms | **210 ms** (p50 200 ms, min 195 ms) | 204 ms |
| Incremental synchronisation, 100,000 prompts | under 2 s | **667 ms** (categorize 43 ms + write 624 ms) | 448 ms |
| Initial backfill, 100,000 prompts, OpenCode | under 30 s | **15.4 s** | 14.8 s |
| Initial backfill, 100,000 prompts, Claude Code | under 30 s | **15.2 s** | 14.2 s |
| Steady-state memory | under 150 MB | **passes both readings** | passes both readings |

**Not every assertion ran.** The machine was busy: the two `status --no-sync` assertions stepped
aside at load averages of 7.0 and 11.2 over 12 cores, by the rule above, so those two rows are
figures this run reports rather than ones it asserted. Every figure is inside its budget anyway, and
each was taken under more contention than `1.2.0`'s; the incremental-synchronisation write is the
one that moved, by the 50% a loaded disk-bound step tends to.

The release adds one module to every command's import graph, `sqlite-driver.js`, which imports
`better-sqlite3` — already loaded through `storage.js` — so it adds no module load. Its in-memory
probe runs only on an error path and once per `doctor`.

## 1.2.0

- Date: 2026-08-02
- Commit: the `1.2.0` cut, after `status --verbose` and the generated `man snack`
- Machine: Linux 6.12.63+deb13-amd64, 12 cores, load average 2.48 at the start of the run
- Toolchain: Node `24.18.1`, npm `11.16.0`
- History: 100,000 prompts, per `PROMPTS` in `performance.test.js`

| Budget | PLAN.md | Measured | `1.1.1` |
| --- | --- | --- | --- |
| `status --no-sync` p95 | under 250 ms | **194 ms** (p50 187 ms, min 181 ms) | 198 ms |
| `status --no-sync` p95, two clients on one source | under 250 ms | **204 ms** (p50 195 ms, min 187 ms) | 198 ms |
| Incremental synchronisation, 100,000 prompts | under 2 s | **448 ms** (categorize 44 ms + write 404 ms) | 446 ms |
| Initial backfill, 100,000 prompts, OpenCode | under 30 s | **14.8 s** | 15.1 s |
| Initial backfill, 100,000 prompts, Claude Code | under 30 s | **14.2 s** | 13.5 s |
| Steady-state memory | under 150 MB | **passes both readings** | passes both readings |

Every assertion ran; none stepped aside.

### A regression this release introduced, and the flake that turned out not to be one

Validating spool events against the published schema — the change that took the plugin to `1.0.3` —
loaded Ajv and compiled that schema **at module load**. `spool.js` is reachable from every command
through `main.js`, so every command paid roughly 65 ms for a validator most of them never call, and
`status` has a 250 ms budget in total. Measured against the tree before the change: p95 went from
197-201 ms to 216-229 ms, and back to 192-198 ms once the validator was compiled on first use.

`performance.test.js` was failing about one run in six while that was true. It was read as a flaky
budget and it was not: it was this regression, sitting close enough to the ceiling to cross it only
sometimes. The guard against that reading is now structural rather than timed — a test asserts Ajv
is absent from the module cache after importing `spool.js`, which fails deterministically.

### Why this file now runs on its own

`node --test` runs test files in parallel, one per core, and this file's `status` measurement was
competing with thirty-six others. Eight full-suite runs on twelve cores read p95 **208-249 ms**
against the 250 ms budget — passing every time, the worst by one millisecond — while the same
assertion alone read **195-207 ms**.

`machineIsBusy()` caught none of those eight. `loadavg` is a one-minute exponentially damped
average, so it has barely moved by the time a seventy-second suite reaches this file; the guard
works for a developer machine busy with something else, which is what it was written for, and not
for the suite it lives in. `packages/cli/package.json` therefore runs every other file first and
this one alone. It costs about fifteen seconds, and it makes PLAN.md's "otherwise idle developer
machine" true of the machine the assertion actually runs on.

## 1.1.1

- Date: 2026-08-01
- Commit: `fix/1.1.1-remaining-findings`, after migration 013 rebuilt `capacity_period`
- Machine: Linux 6.12.63+deb13-amd64, 12 cores, load average 1.38 at the start of the run
- Toolchain: Node `24.18.1`, npm `11.16.0`
- History: 100,000 prompts, per `PROMPTS` in `performance.test.js`

| Budget | PLAN.md | Measured | `1.1.0` |
| --- | --- | --- | --- |
| `status --no-sync` p95 | under 250 ms | **198 ms** (p50 187 ms, min 182 ms) | 212 ms |
| `status --no-sync` p95, two clients on one source | under 250 ms | **198 ms** (p50 192 ms, min 188 ms) | 192 ms |
| Incremental synchronisation, 100,000 prompts | under 2 s | **446 ms** (categorize 45 ms + write 401 ms) | 414 ms |
| Initial backfill, 100,000 prompts, OpenCode | under 30 s | **15.1 s** | 14.5 s |
| Initial backfill, 100,000 prompts, Claude Code | under 30 s | **13.5 s** | 13.6 s |
| Steady-state memory | under 150 MB | **passes both readings** | passes both readings |

Every assertion ran; none stepped aside. Nothing here is expected to move: migration 013 changes the
schema `1.1.0` already had by exactly one dropped unique index, and every read path is unchanged.

### What migration 013 costs the person upgrading

This is the expensive migration in this project and the only one whose price scales with how much
someone has used SNACK. Dropping `UNIQUE (source_alias, started_at)` from `capacity_period` needs a
table rebuild, and with foreign keys enforced the parent cannot be dropped while a child holds rows,
so `prompt_execution` and everything that cascades from it are copied out and back — eight tables in
total. The roadmap asked for this to be priced against a real history before the approach was
chosen, so it was, on the same machine and the same 100,000-prompt scale as the budgets above:

| | Measured |
| --- | --- |
| Wall clock for the whole upgrade | **1.8 s** |
| Peak process RSS during it | **104 MB** |
| Database file, before | 47.6 MB |
| Database file, after | 79.4 MB |
| Rows in every rebuilt table, before and after | identical |

Two things are worth naming rather than leaving to be discovered. The **file grows by about 1.7x**
and does not shrink back: the pages the dropped tables used are freed inside the file, not returned
to the filesystem, and SQLite reuses them for what the user records next. No `VACUUM` is run, because
it cannot run inside the transaction the migration runner holds and reclaiming space is not worth a
second full-file rewrite on an upgrade. And the runner takes a **pre-migration backup** first, so the
peak disk needed is roughly three times the database, once, during the upgrade.

Both figures are one-time, on the first command that opens storage for write after the upgrade.

## 1.1.0

- Date: 2026-08-01
- Commit: `release/1.1.0`, after `snack update`, the status panel and the documentation restructure
- Machine: Linux 6.12.63+deb13-amd64, 12 cores, load average 1.68 at the start of the run
- Toolchain: Node `24.18.1`, npm `11.16.0`
- History: 100,000 prompts, per `PROMPTS` in `performance.test.js`

| Budget | PLAN.md | Measured | `1.0.2` |
| --- | --- | --- | --- |
| `status --no-sync` p95 | under 250 ms | **212 ms** (p50 193 ms, min 182 ms) | 196 ms |
| `status --no-sync` p95, two clients on one source | under 250 ms | **192 ms** (p50 186 ms, min 184 ms) | 202 ms |
| Incremental synchronisation, 100,000 prompts | under 2 s | **414 ms** (categorize 40 ms + write 374 ms) | 420 ms |
| Initial backfill, 100,000 prompts, OpenCode | under 30 s | **14.5 s** | 14.6 s |
| Initial backfill, 100,000 prompts, Claude Code | under 30 s | **13.6 s** | 13.3 s |
| Steady-state memory | under 150 MB | **passes both readings** | passes both readings |

Every assertion ran; none stepped aside.

### The status panel and the trend cost nothing measurable

`status` now asks `computeSourcePressure` for the window scores the usage-pressure sparkline is
drawn from, which adds one `computeUsagePressure` call per window — five — per source. That looked
like a real risk against a 250 ms p95 and was measured before it was believed, by flipping
`includeTrend` off and on over the same 100,000-prompt history, spawning the binary each time:

| `status --no-sync` | p95 | p50 |
| --- | --- | --- |
| without the trend | 197 ms | 186 ms |
| with the trend | 188 ms | 184 ms |

The difference is noise, and the reason is structural rather than lucky: `computeSourcePressure`
already reads and buckets all thirty-one windows in one query, so the trend only re-ranks rows that
are already in memory. The scan was paid before the sparkline asked for anything.

### The backfill budget stops being asserted on a hosted runner

Merging `1.1.0` turned `main` red on macOS: `backfill took 30.2s` against a 30 s budget, from a
commit whose diff touches no ingestion file at all — no adapter, no `storage.js`, no `spool.js` —
and which had passed macOS minutes earlier on its own pull request. The same history backfills in
**14.5 s** on the machine whose measurement is the gate.

So the assertion was measuring the runner. `status --no-sync` p95 already carried an exemption for
exactly this, with the reasoning written beside it; the two backfill assertions did not, which was
an inconsistency rather than a decision. They now carry the same one, and it was proven in both
directions before being trusted: with the budget tampered down to 1 ms the assertion still fails
locally, and with `CI` set the same tampered budget is skipped.

The memory assertions stay unconditional. A heap ceiling is a property the process either survives
or dies on, which is portable in a way that a wall clock on borrowed hardware is not.

The `212 ms` single-source figure above is 16 ms above `1.0.2` and 24 ms above the paired
measurement in this same run, which is run-to-run variation on a shared machine rather than a
regression: the two-client figure moved the other way, by 10 ms, on the same commit.

## 1.0.2

- Date: 2026-08-01
- Commit: the `chore/verify-pendencies` branch, after the Phase 1 follow-up fixes
- Machine: Linux 6.12.63+deb13-amd64, 12 cores, load average 1.43 at the start of the run
- Toolchain: Node `24.18.1`, npm `11.16.0`
- History: 100,000 prompts, per `PROMPTS` in `performance.test.js`

| Budget | PLAN.md | Measured | `1.0.1` |
| --- | --- | --- | --- |
| `status --no-sync` p95 | under 250 ms | **196 ms** (p50 187 ms, min 180 ms) | 187 ms |
| `status --no-sync` p95, two clients on one source | under 250 ms | **202 ms** (p50 193 ms, min 183 ms) | 189 ms |
| Incremental synchronisation, 100,000 prompts | under 2 s | **420 ms** (categorize 40 ms + write 380 ms) | 408 ms |
| Initial backfill, 100,000 prompts, OpenCode | under 30 s | **14.6 s** | 14.3 s |
| Initial backfill, 100,000 prompts, Claude Code | under 30 s | **13.3 s** | 13.4 s |
| Steady-state memory | under 150 MB | **passes both readings** — see below | passes as heap |

Every assertion ran; none stepped aside. An earlier attempt at these figures was taken while the
machine sat at load 5-7 and produced `status --no-sync` p95 245 ms with one assertion skipping
itself. Those numbers were discarded rather than recorded, because a budget measured under
contention is a measurement of the contention.

### The memory budget stops depending on which memory you mean

`1.0.1` passed the gate as written — a `--max-old-space-size=150` heap cap — while peak process RSS
over a real 222 MB Claude history was 238 MB. The two readings disagreed about whether the product
met its own stated budget, which is what
[finding 07](../history/specs/end-to-end-review/issues/07-steady-state-memory-budget-does-not-name-its-unit.md)
was about.

They no longer disagree. Measured over the same real history, with nothing to synchronise:

| Command | heap cap 150 MB | peak process RSS |
| --- | --- | --- |
| `sync` (no-op) | PASS | **142 MB** (was 238 MB) |
| `doctor` | PASS | **141 MB** (was 241 MB) |
| `stats` | PASS | **117 MB** |
| `status --no-sync` | PASS | **93 MB** |

The change is the fingerprint sampling fix: commands stopped reading the whole history to check its
shape. `PLAN.md` now names the unit, so the budget is a claim someone can check rather than one that
depends on which tool they reach for — but for the first time both tools agree, which is the
stronger result.

## 1.0.1

- Date: 2026-08-01
- Commit: the `release-1.0.1` branch, after the Phase 1 P1 fixes
- Machine: Linux 6.12.63+deb13-amd64, 12 cores, load average 0.49 at the start of the run
- Toolchain: Node `24.18.1`, npm `11.16.0`
- History: 100,000 prompts, per `PROMPTS` in `performance.test.js`

Measured because `1.0.1` widens a query on the `status` path: `readSourceSummary` no longer filters
on the open capacity period, so it aggregates every period a source has. A budget that is a release
gate is not assumed to have survived a change to the query behind it.

| Budget | PLAN.md | Measured | Against `1.0.0` |
| --- | --- | --- | --- |
| `status --no-sync` p95 | under 250 ms | **187 ms** (p50 184 ms, min 178 ms) | 193 ms |
| `status --no-sync` p95, two clients on one source | under 250 ms | **189 ms** (p50 184 ms, min 179 ms) | 197 ms |
| Incremental synchronisation, 100,000 prompts | under 2 s | **408 ms** (categorize 39 ms + write 369 ms) | 410 ms |
| Initial backfill, 100,000 prompts, OpenCode | under 30 s | **14.3 s** | 16.5 s |
| Initial backfill, 100,000 prompts, Claude Code | under 30 s | **13.4 s** | 13.7 s |
| Steady-state memory | under 150 MB | passes under `--max-old-space-size=150` | passes |

Nothing regressed, and the OpenCode backfill came back down from `1.0.0`'s 16.5 s to 14.3 s —
`0.9.0` read 14.1 s on a quieter machine, so this is the load average moving, not the product.
Stage 10 recorded the same effect in the other direction.

Also measured against the real history Phase 1 used, driving the installed binary rather than the
fixture: `status --no-sync` p95 190 ms over 603 real prompts across two capacity periods, which is
the shape the widened query was the reason to check.

Phase 1's own measurements against the **published `1.0.0`** and a real 222 MB Claude history are
recorded separately in `docs/history/specs/end-to-end-review/spec.md`, along with two findings this file
should eventually answer: the steady-state budget does not name its unit, and a no-op `sync` costs
238 MB of process RSS because the Claude fingerprint check re-reads the whole history.

## 1.0 stable gate audit

- Date: 2026-08-01
- Commit: `9a7ba12` (Stage 10 Wave 1, before the version bump)
- Machine: Linux 6.12.63+deb13-amd64, 12 cores, load average 1.23 at the start of the run
- Toolchain: Node `24.18.1`, npm `11.16.0`
- History: 100,000 prompts, per `PROMPTS` in `performance.test.js`

| Budget | PLAN.md | Measured | Headroom |
| --- | --- | --- | --- |
| `status --no-sync` p95 | under 250 ms | **193 ms** (p50 186 ms, min 181 ms) | 23% |
| `status --no-sync` p95, two clients on one source | under 250 ms | **197 ms** (p50 191 ms, min 183 ms) | 21% |
| Incremental synchronisation, 100,000 prompts | under 2 s | **410 ms** (categorize 40 ms + write 370 ms) | 80% |
| Initial backfill, 100,000 prompts, OpenCode | under 30 s | **16.5 s** | 45% |
| Initial backfill, 100,000 prompts, Claude Code | under 30 s | **13.7 s** | 54% |
| Steady-state memory | under 150 MB | passes under `--max-old-space-size=150` | — |

No budget regressed against `0.9.0`, which is the claim the stable gate needs: Stage 10 changes no
product code, so a figure that moved materially here would mean something changed that nobody
intended. The OpenCode backfill reads 16.5 s against 14.1 s at `0.9.0` — a 17% move on the budget
with the most headroom, on a machine at load 1.23 rather than 0.81, and the Claude backfill over the
same code path is unchanged at 13.7 s. That is the machine, not the product.

## 0.9.0

- Date: 2026-08-01
- Commit: `4c56de6`
- Machine: Linux 6.12.63+deb13-amd64, 12 cores, load average 0.81 at the start of the run
- Toolchain: Node `24.18.1`, npm `11.16.0`
- History: 100,000 prompts, per `PROMPTS` in `performance.test.js`

| Budget | PLAN.md | Measured | Headroom |
| --- | --- | --- | --- |
| `status --no-sync` p95 | under 250 ms | **202 ms** (p50 187 ms, min 181 ms) | 19% |
| `status --no-sync` p95, two clients on one source | under 250 ms | **190 ms** (p50 185 ms, min 182 ms) | 24% |
| Incremental synchronisation, 100,000 prompts | under 2 s | **435 ms** (categorize 40 ms + write 395 ms) | 78% |
| Initial backfill, 100,000 prompts, OpenCode | under 30 s | **14.1 s** | 53% |
| Initial backfill, 100,000 prompts, Claude Code | under 30 s | **13.7 s** | 54% |
| Steady-state memory | under 150 MB | passes under `--max-old-space-size=150` | — |

The steady-state row is a pass/fail rather than a figure by design: the commands are run under a
hard heap cap, so the budget is enforced by the runtime rather than compared against a number that
would drift with the collector.

The initial backfill is excluded from the memory budget, as PLAN.md says: reading a whole source
materializes every observation before storage sees it and needs roughly 300 MB of heap at 100,000
prompts. Bounding that means committing the backfill in batches, which changes when the ingestion
cursor advances and belongs to a release that can measure the trade.

### Movement since 0.8

`status --no-sync` p95 was **227 ms against 250 ms at Stage 8** — nine per cent of headroom, the
tightest figure in the set and the one that had been flaking. It measures 202 ms here, so the margin
roughly doubled. Nothing in Wave 2 was aimed at that path; the earlier figure was measured on a
busier machine, which is the whole reason the assertion now steps aside above half load.

No budget regressed. The two Wave 2 changes that touch a read path — refusing an unmigrated
database in `assertReadableStorage`, and the timestamp guard in the Claude reader — add one
comparison per open and one per record, and neither is visible at this resolution.

## How to reproduce

```bash
cd packages/cli
CI= node --test --test-name-pattern "p95 budget|backfill and memory budgets|inside the sync budget|inside the status budget" test/performance.test.js
```

Run it on an idle machine. The suite prints every figure whether or not it asserts, so a busy run
still produces numbers — they just are not the gate.
