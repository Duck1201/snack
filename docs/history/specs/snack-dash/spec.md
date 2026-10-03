# 1.6.0 — `snack dash`

Status: **investigated; awaiting the user's decisions in §11.** Ships in the minor `1.6.0` beside the
alternative recency half-lives (`../half-life-shadows/spec.md`). Every `file:line` anchor below is
against commit `5ef53c8` (the head of `release/1.6.0` when this was written); the half-life builder
is editing `status.js`, `prediction.js` and `storage.js` in parallel, so anchors in those three files
move — the function names are the stable reference.

Evidence read: `PLAN.md` (Commands, Quality Budgets, "Outside the 1.x Line" item 4 and its
amendment), `docs/history/roadmap-1.x.md` (the `1.2.0` entry's paragraph on why `dash` moved, the
`1.6.0` entry), ADR-0008, `docs/specification/cli.md`, `docs/compatibility.md`, `CONTEXT.md`,
`packages/cli/src/{cli,main,render,status,analytics,output,storage,file-lock,errors,prediction}.js`,
`packages/cli/test/{vocabulary,contracts}.test.js`, `scripts/man-surface.mjs`,
`scripts/generate-man.mjs`, `docs/architecture/integrations.md` §12, migrations `007` and `013`, the
skills `snack-public-contract-schemas` and `verify-snack-against-real-cli`, the 2026-10-03 offline
decay analysis, and a read-only copy of the author's real database (journal mode, row counts).

Contents: 1 command surface · 2 architecture · 3 two clocks and the storage lock · 4 the snapshot
rule · 5 widgets and wording · 6 performance · 7 the sequence answer's ceiling · 8 tests · 9 builder
slices and the frozen interface · 10 documentation and contract changes · 11 decisions for the user.

---

## 0. Findings that shape everything below

1. **`status --no-sync` is not lock-free today.** The whole `status` action, `--no-sync` included,
   runs inside `withStorageOperationLock` (`main.js:740`), because it writes: every run records a
   `prediction_attempt` (`main.js:895-910`, `storage.js:2640`) inside the lock and confirms delivery
   after it (`main.js:959`, `storage.js:2717`). A dash that "reads storage with no lock" every second
   would therefore be a *new* access pattern, not a repetition of an existing one.
2. **SNACK's database is in rollback-journal mode, not WAL.** No migration or open sets
   `journal_mode`; the real database reads `journal_mode = delete`. `docs/architecture/integrations.md`
   §12 says "WAL mode may be used for SNACK's own DB after platform tests" — it never was. In
   rollback mode a reader can be refused while a writer commits (or spills its cache mid-transaction,
   which a 2.3 s ingestion will), and `better-sqlite3` opens every connection with a 5 000 ms busy
   timeout that **blocks the event loop synchronously** — the screen and the keys freeze for up to
   five seconds per read.
3. **Every storage read opens its own connection** (`readSourceSummary` `storage.js:1563`,
   `readOutcomeRows` `:1734`, `readUsageWindowRows` `:2077`, …). A forecast assembled while a sync
   commits can read its summary before the commit and its outcomes after it. `status` is protected
   from that torn read by the operation lock in finding 1.
4. **The full per-source computation is ~100-150 ms in process on a 100 000-prompt history** (the
   `docs/release/performance.md` note: 144 ms in process against ~200 ms spawned) and synchronous.
   Once a second that is 10-15% of a core and a key latency of up to 150 ms, to recompute an
   estimate whose evidence has not changed.
5. **The forecast moves with the clock alone.** Outcome weights decay with age
   (`2^(-age/7d)`, `prediction.js` `decayWeight`), and the pressure windows slide with `now`
   (`computeSourcePressure`, `main.js:2799`). With no new observation the unrounded interval drifts;
   the rounded one rarely does.
6. **Commander accepts `snack dash --json`.** `--json` is a program-level option
   (`main.js:189`), so `dash --json` and `--json dash` both parse with `optsWithGlobals().json ===
   true` (checked against the installed Commander). The refusal has to be explicit.
7. **`prediction_delivery.format` is free text** (`migrations/013:178`, no `CHECK`), exported as
   `predictions.delivery_format` (`export.js:191,224`) and unconstrained in `export.schema.json`
   (`delivery_format: {}`).
8. **`cli.js` rethrows every stream error but `EPIPE`** (`cli.js:11-15`). A TTY whose terminal
   closes raises `EIO`, which would become an uncaught exception mid-screen.

Findings 1-4 decide §3: **the dash never touches SQLite outside the storage operation lock, and it
takes that lock only once per synchronization**, right after its own sync child has exited, for one
recompute. Between syncs it holds no lock and opens no connection; the 1 s redraw is a pure function
of the cached reading and the clock. (Corrected after review of `3978a85`: two writes also take it
between syncs — the retry of a recompute the lock was busy for, on the next tick, and the delivery
of a snapshot recorded while the terminal was too small, by the first frame that draws it.)

---

## 1. Command surface

### 1.1 Synopsis and flags

```text
snack dash
```

**No flags in `1.6.0` beyond `--help`** (D1). Every flag is additive later and breaking to remove, and
none is needed to answer the roadmap's exit criterion:

- `--source <alias>` would only pre-select a row; the list already shows every source and the
  selection is the interaction. A filter would also make the screen answer a different question than
  "which source to reach for".
- A refresh interval: the redraw clock is not user-visible in any way that matters, and the sync
  cadence is a fixed constant (§3.3, D2).
- **No `--json`**, by ADR-0008: a live screen plus a document is a usage error.

The contracts map (`contracts.test.js:608-692`) gains one literal row, in Commander's registration
order (register `dash` immediately after `status`):

```js
    dash: ["--help"],
```

### 1.2 Preconditions, in order, all before the alternate buffer is entered

Each is checked before anything is written to storage or to the screen, the way `status` validates
`--sequence` before taking the lock (`main.js:728-733`).

| # | Condition | Exit | `errors[].code` | Message |
|---|---|---|---|---|
| 1 | `optsWithGlobals().json === true` (`dash --json`, `--json dash`) | `2` | `dash_json_unsupported` | ``snack dash draws a screen and has no JSON form; `snack status --json` gives the same reading as a document.`` |
| 2 | `stdout.isTTY !== true` (`dash \| cat`, `dash > file`) | `2` | `dash_requires_terminal` | ``snack dash needs an interactive terminal; `snack status` gives the same reading through a pipe.`` |
| 3 | `stdin.isTTY !== true` (`dash < /dev/null`): raw-mode keys are impossible | `2` | `dash_requires_terminal` | same |
| 4 | `TERM` unset, empty or `dumb` (in the injected `env`): no cursor addressing, no alternate buffer | `2` | `dash_requires_terminal` | same |
| 5 | configuration unreadable or invalid | `3` | existing reasons | existing messages (`readConfig`) |
| 6 | no configured capacity source | `4` | `source_unavailable` | the `status` message (`main.js:755-758`) |
| 7 | storage newer than this build, unreadable, or never initialized-but-present | `5` | `storage_newer_than_application`, `storage_read_error`, `storage_not_initialized` | existing (`assertReadableStorage`, `storage.js:3272`) |

`storage_migrations_pending` and a missing database are **not** errors for `dash`: the first sync
child applies the migrations (with the pre-migration backup) exactly as `snack sync` does, and the
screen says so while it runs (§5.6).

Errors go through the existing `renderError` (`main.js:3142`): stderr in human mode, one error
envelope on stdout when `--json` was passed or `presentation.json` is configured. So
`snack dash --json` emits a valid envelope with `command: "dash"`, `status: "error"`, `data: null` —
the one JSON document `dash` can ever produce. The envelope schema constrains `data` per command only
in its `allOf` routing, and an error document's `data` is always `null`, so no schema changes.

**`presentation.json` does not refuse the screen.** It is a default for the commands that produce a
document; `dash` produces none. A configured preference is not "combined with `--json`", which is what
ADR-0008 forbids.

Both new reasons are new values of the open `errors[].code` field under an existing exit code — the
shape `sequence_length_invalid` (1.4) and `storage_migrations_pending` took. No exit code moves.

### 1.3 Exit codes during and after the session

| How the session ends | Exit |
|---|---|
| `q`, or `Ctrl+C` (raw mode delivers `\x03` as a key, not `SIGINT`) | `0` |
| `SIGINT`/`SIGTERM` sent from outside | terminal restored, then the process re-raises the same signal with the default handler, so the shell sees death by that signal, like any Unix tool |
| `SIGHUP`, or `EIO` on the TTY (the terminal went away) | nothing to restore; exits quietly by the signal / `0` |
| an unexpected exception anywhere in the loop | terminal restored **first**, then the existing `internal_error` path: exit `10`, "Unexpected internal failure.", `SNACK_DEBUG` stack to stderr |

A failed synchronization, a busy lock, a migration in progress, a source that cannot be read — none
of these ends the session. They are stated on the screen (§5.6), because ADR-0008 says a tick that
cannot synchronize "is skipped rather than queued, and the screen says the data is stale".

### 1.4 `NO_COLOR`, `FORCE_COLOR`, `COLUMNS`

- Colour is decided once at start with the existing `supportsColor(stdout, env)` (`main.js:1586`):
  `FORCE_COLOR` beats `NO_COLOR` beats `hasColors()`. With colour off, a frame contains **no SGR
  sequence at all** — only cursor addressing — and reads identically (the risk label is a word).
- The size is read from `stdout.columns`/`stdout.rows` and refreshed on `resize`. **`COLUMNS` is not
  consulted**: `terminalColumns` (`main.js:1607`) reads it first because a pipe has no width, and
  `dash` never draws into a pipe. Honouring a stale `COLUMNS` on a real TTY would draw past the edge.

---

## 2. Architecture

Stdlib only: `node:tty` (via `process.stdin`/`stdout`), `node:readline` (`emitKeypressEvents`),
`node:child_process` (`spawn`), `node:util` (`styleText`, already used). **No new dependency**; the
package keeps publishing `src/` verbatim. The dash modules are **imported lazily** from the `dash`
action (`await import("./dash.js")`), so no other command pays their module-load cost — the 65 ms
regression `1.2.0` found came from exactly that.

### 2.1 Modules (flat in `packages/cli/src/`, per the existing convention)

| Module | Kind | Responsibility |
|---|---|---|
| `source-report.js` (new, extracted from `main.js`) | storage-reading, no I/O to terminal | `buildSourceReports`, `computeSourcePressure` (moved from `main.js:2799`), `summarizeWindow` (`:2884`), `toPredictionAttempt` (`:2548`), `toPredictionSequence` (`:2591`), `confirmPredictionDelivery` (`:2639`), and the new `pressureSeries` (§5.3). `status` and `dash` both call it. |
| `screen.js` (new) | pure + one `write` port | screen buffer: enter/leave the alternate buffer, per-line frame diff, invalidate, idempotent restore |
| `dash-view.js` (new) | **pure** `DashState → {lines, drawn}` | every widget: header, list, detail, scale, plot, key bar, help, too-small, banners |
| `dash.js` (new) | controller | the state machine: clocks, keys, sync scheduling, recompute, the snapshot ledger; talks only to ports |
| `dash-terminal.js` (new) | real I/O boundary | the production ports: raw mode, keypress decoding, signals, `resize`, `EIO`, the sync child. The one dash file tests reach only through a pty |
| `render.js` (changed) | pure | exports `shownInterval` and `shownForecast` (§4.2) and the overview's row builder (§5.2); `status` output byte-identical |
| `main.js` (changed) | wiring | registers `dash`, runs §1.2, builds ports from `RunOptions` or `dash-terminal.js`, hands off to `runDash` |
| `cli.js` (changed) | executable | treats `EIO` like `EPIPE` on stdout/stderr (finding 8) |

`cli.js` cannot host the terminal ports: it runs the CLI on import, so nothing in it is testable. The
ports live in `dash-terminal.js`, which `main.js` imports only when `RunOptions` injected none — the
same pattern as `prompt` (`cli.js:35-48`), moved one file inward.

### 2.2 Screen buffer and frame diff (`screen.js`)

```js
/** @param {{write(chunk: string): void}} out */
export function createScreen(out) → {
  enter(): void,          // "\x1b[?1049h" alt buffer, "\x1b[?25l" hide cursor, "\x1b[2J\x1b[H"
  frame(lines: string[]): void,
  invalidate(): void,     // forget the previous frame: next frame() repaints every row
  leave(): void,          // idempotent: "\x1b[0m\x1b[?25h\x1b[?1049l"
}
```

- `frame` compares each line with the previous frame's line at the same row; for each changed row it
  writes `\x1b[{row};1H` + line + `\x1b[K`, and, when the new frame is shorter, `\x1b[{n+1};1H\x1b[J`
  once. A frame identical to the last writes **zero bytes** (tested).
- All of one frame's bytes go out in **one `write`**, so a terminal never shows half a frame.
- Lines arrive already fitted to the width by the view; `screen.js` never measures or wraps.
- `leave()` is also exposed as a synchronous `restoreSync(fd)` using `fs.writeSync`, registered on
  `process.on("exit")` as the last resort when everything else failed.

### 2.3 Widgets are pure

`renderDash(state: DashState, size: {columns, rows}, options: {color: boolean}) →
{lines: string[], drawn: string[]}` (`dash-view.js`). `drawn` is the list of capacity-source aliases
whose forecast — interval, risk, evidence — appears in this frame; it is how the controller knows
what the reader actually saw (§4.3). No widget reads a clock, an env var, a file or a stream; the
frame time is `state.now`. Every widget is tested from a written-out `DashState` (§8.1).

### 2.4 Keys (raw mode, `readline.emitKeypressEvents(stdin)`)

| Key | Action |
|---|---|
| `↑` `↓`, `k` `j` | move the selection (clamped, no wrap) |
| `r` | synchronize now — ignored while a sync child is running (single-flight), the header already says "synchronizing" |
| `?` | toggle the help pane (it replaces the detail pane; the list stays, §4.3) |
| `Esc` | close the help pane if open; otherwise nothing |
| `q`, `Ctrl+C` (`\x03`) | quit, exit `0` |
| `Ctrl+Z` (`\x1a`) | suspend (§2.5) |
| `Ctrl+L` | `invalidate()` and repaint |

Any other key does nothing. Keys never write to storage.

### 2.5 Signals and terminal restoration

The controller holds one `restore()`: raw mode off, `stdin.pause()`, `screen.leave()`. It is
idempotent and is run, in order of preference, by: the normal quit path; a `finally` around the
session promise; the guard every callback runs inside (§2.6); `process.on("exit")` with
`restoreSync`.

| Signal / event | Handling |
|---|---|
| stdout `resize` (Node's `SIGWINCH`) | read new `columns`/`rows`, `invalidate()`, repaint immediately |
| `SIGINT`, `SIGTERM` | `restore()`, remove our listener, `process.kill(process.pid, signal)` |
| `SIGHUP`, `EIO` on stdout/stdin | the terminal is gone: skip writing, release listeners, exit |
| `Ctrl+Z` key or an external `SIGTSTP` | `restore()`, then `process.kill(process.pid, "SIGSTOP")` (a listener on `SIGTSTP` suppresses the default stop, so the stop is sent as `SIGSTOP`) — after the work in flight settles, so the process never stops holding the storage lock; no recompute starts while suspended (review of `3978a85`) |
| `SIGCONT` | re-enter raw mode and the alternate buffer, `invalidate()`, repaint; if the next sync was due while stopped, start it now |

The sync child is spawned **`detached: true`** (its own process group), so `SIGHUP`/`SIGINT` aimed at
the terminal's foreground group never kill it mid-transaction. Killing a sync mid-transaction leaves
SQLite to roll the journal back (safe) but leaves `proper-lockfile`'s directory to go stale for 120 s
(`file-lock.js:20-29`), during which every other `snack` command answers `storage_locked`. For the
same reason **quitting never kills an in-flight child**: the dash restores the terminal and exits;
the child, `unref()`'d, finishes its transaction, writes its envelope into a closed pipe (`cli.js`
swallows the `EPIPE`) and releases the lock on its own. A `snack status` typed right after quitting
waits for it through the lock's existing retry (~5 s).

### 2.6 Crash containment

Every callback the controller registers (keypress, timer, child exit, resize, signal) runs inside
`guard(fn)`, which catches synchronously and on rejection and routes the error to the session's
`fail(error)`: the session promise rejects, `finally` runs `restore()`, and only then does `run()`'s
existing `catch` (`main.js:1373-1431`) render "Unexpected internal failure." to the restored
terminal. A stack trace is never printed into the alternate buffer, where it would vanish on leave.

---

## 3. Two clocks and the storage lock

### 3.1 The redraw clock: ~1 s, no storage

Every second (and on every key, resize and state change), the controller builds a frame from the
**cached reading** and `clock()`, and hands it to `screen.frame`. It reads nothing from SQLite and
holds no lock. What legitimately changes per second is computed in the view from `state.now`: each
row's `LAST SEEN` (`now − freshness.as_of`, not the cached `age_seconds`), "synced 12s ago", "next
sync in 48s". The frame diff turns that into a handful of bytes.

### 3.2 The sync clock: a child process, single-flight, fixed delay

- **Command:** `process.execPath` with `[fileURLToPath(new URL("./cli.js", import.meta.url)), "sync",
  "--json"]`, environment inherited (XDG paths, `CODEX_HOME`, `OPENCODE_DB`, …), `stdio: ["ignore",
  "pipe", "pipe"]`, `detached: true`. The tested `sync` path — ingestion, recategorize, restate,
  `linkPrimaryEvaluations`, segment removal (`main.js:532-641`) — runs unchanged, and the storage
  lock lives and dies inside the child.
- **Cadence:** one sync at start, then **60 s after the previous one ended** (fixed delay, never fixed
  rate), so two syncs can never overlap and a slow one never queues a backlog. `r` starts one now if
  none is running. (D2.)
- **No timeout, no kill.** A sync that runs long is shown as "synchronizing for 2m"; the next is not
  started until it ends.
- **stdout** is collected and parsed as one envelope; **stderr is drained and discarded**, never shown
  and never stored: with `SNACK_DEBUG` it can carry a stack with absolute paths.
- **Outcome mapping** (`SyncOutcome`):

| Child result | Dash state | Per-source `synchronization.status` shown |
|---|---|---|
| exit `0`, `status: "ok"` | `ok`, recompute | `ok` |
| exit `0`, `status: "degraded"` | `ok`, recompute | `failed` for each alias with `failed > 0` in `data.sources`, `ok` for the rest |
| exit `5`, `errors[0].code === "storage_locked"` | `storage_busy`: skipped, not queued; no recompute; reading marked stale | unchanged |
| exit `5`, `storage_newer_than_application` | `storage_newer`: stop scheduling syncs; banner (§5.6) | unchanged |
| exit `3`, `4`, other `5`, `10`, or unparseable stdout, or spawn failure | `failed`; no recompute | unchanged |

  The child resolving `cli.js` from the dash's own module URL matters after `snack update`: the files
  on disk are now the new version, so the child is newer than the running dash, and may migrate the
  database past what the dash's in-memory code reads. That is the `storage_newer` row: the dash says
  so and stops synchronizing rather than reading a schema it does not know.

### 3.3 The recompute: once per sync, under the lock

After every sync child that ends in `ok` (and once at start), the controller runs **one recompute**:

```text
withStorageOperationLock(paths, async () => {
  assertReadableStorage(databaseFile)            // pending → "preparing storage"; newer → banner
  reports = buildSourceReports({ ..., synchronization: fromLastSync, recordAttempts: false })
  for each source whose snapshot key changed: recordPredictionAttempt(...)   // §4
  draw the frame now; drawn = view.drawn
  confirmPredictionDelivery(for attempts whose source ∈ drawn, format "dash")
})
```

- **Reads are consistent**: nothing writes while the dash holds the operation lock (every writer —
  `sync`, `status`, `purge`, `config set`, setup — takes it), so finding 3's torn read cannot happen.
- **No busy wait on the event loop**: the dash's own child has exited and released the lock; no other
  writer can hold SQLite while the dash holds the operation lock, so the 5 s `better-sqlite3` busy
  timeout is never reached.
- **The lock is held for one recompute** (~100-150 ms on 100 000 prompts, §6) **once per sync**, and
  never between syncs. That is the exit criterion's "no storage lock is held between syncs", stated
  precisely: between the end of one recompute and the start of the next sync child, the
  `storage-operation` lock is free, and a test takes it at every tick (§8.4).
- **If the lock cannot be taken** (another `snack` command holds it past `proper-lockfile`'s ~5 s of
  retries — async, so the keys keep working), the recompute is skipped, the cached reading stays on
  screen marked stale, and the controller retries on the next tick; at most one recompute is in
  flight.
- **Delivery under the lock too.** `status` confirms delivery after releasing the lock
  (`main.js:959`); the dash cannot, because a write outside the lock is exactly where a concurrent
  writer turns into a 5 s synchronous freeze. Rendering inside the lock costs a few milliseconds.

**WAL is not needed and not proposed.** The design never reads concurrently with a writer, so
switching SNACK's database to WAL (`integrations.md` §12) would buy the dash nothing, and it would
add `-wal`/`-shm` files to the permission (`0o600`) and backup surfaces. Recorded here, not offered as
a decision.

### 3.4 Storage that is locked or migrating

| State at start or during a session | What the dash does |
|---|---|
| database missing (never synchronized) | no reading; "Preparing storage — the first synchronization creates it." The first child does. |
| `storage_migrations_pending` | no reading; "Preparing storage — 2 pending migrations, after a backup." (count from the error) The child migrates under its own lock. |
| child fails while preparing | "Storage could not be prepared; run `snack sync` to see why." Keeps trying at the cadence. |
| lock busy (child exit `5 storage_locked`, or the recompute's own acquire) | "sync skipped — another snack command is using storage" · reading kept, marked stale |
| `storage_newer_than_application` mid-session | "A newer snack upgraded storage; quit and restart snack dash." Syncs stop; the last reading stays, marked stale. |

---

## 4. The snapshot rule (ADR-0008, stated for a screen)

### 4.1 What is recorded

One **prediction snapshot** per *rendered* forecast: a `prediction_attempt` row (with the sequence,
reported-capacity and half-life shadow rows its transaction already carries — none for the sequence,
§7.4) plus its `prediction_delivery` row. It uses the existing path unchanged:
`toPredictionAttempt` → `recordPredictionAttempt` (`storage.js:2640`) → frame written →
`confirmPredictionDelivery` (`main.js:2639` → `storage.js:2717`), with
`{channel: "stdout", format: "dash", invocation_id: <one UUID per dash session>}` (D5).

### 4.2 The key, and the one rounding function behind it

`render.js` gains two exports, and the private `interval()` (`render.js:1319`) becomes a formatter of
the first:

```js
/** The shown ends of a viability interval, rounded outward, as whole percents. */
export function shownInterval(viability: {lower: number, upper: number}): {lower: number, upper: number}
//   = today's interval() arithmetic: snap, floor/ceil, clamp, the 49/51 guard (render.js:1319-1337)

/** Everything a human surface states about one source's answer, already rounded. */
export function shownForecast(report): {
  interval: {lower: number, upper: number},   // shownInterval(report.viability)
  risk: string,                               // report.risk.label
  evidence: string,                           // report.evidence.level
}

function interval(viability) {                // unchanged output, now derived
  const { lower, upper } = shownInterval(viability);
  return `${lower}-${upper}%`;
}
```

Every interval a panel, the overview, the dash list or the dash detail prints goes through
`interval()` → `shownInterval()`. The key is built in `dash.js` from the same call:

```js
export function snapshotKey(report, capacityPeriodId) {
  const shown = shownForecast(report);
  return JSON.stringify([
    report.source.alias,
    capacityPeriodId,
    shown.interval.lower, shown.interval.upper, shown.risk, shown.evidence,
    report.method.id, report.method.version,
    report.model_policy_version,
    report.risk.policy_version, report.evidence.policy_version,
    report.pressure.policy_version,                         // analytics / weight policy
    report.source.plan_profile.id, report.source.plan_profile.version,
  ]);
}
```

- **The capacity period is in the key**: `linkPrimaryEvaluations` (`storage.js:2834`) pairs an
  outcome only with an attempt of the same period, so a new period needs a new attempt even when the
  numbers did not move.
- **Not in the key:** the unrounded interval, the point, `freshness`, `synchronization`, pressure
  band and percentile, drivers, the reported row, the shadows. They are not the estimate the reader
  is shown as the answer, or they change with the clock alone.
- `expected_prompt_category` is constant (`typical`) in `dash`, which takes no prompt file.

### 4.3 What "rendered" means, and the ledger

The controller keeps, per source: `deliveredKey` (the key of the last snapshot delivered in this
session, initially none) and `pending` (`{key, attemptId}` recorded but not yet drawn).

1. After a recompute, for each source: `key = snapshotKey(...)`. If `key === deliveredKey` → write
   nothing (an identical frame writes nothing). Else record the attempt, set `pending`.
2. When a frame is written, for each alias in `view.drawn` with a `pending`: confirm the delivery
   (under the lock, §3.3) and set `deliveredKey = pending.key`.
3. A `pending` that is superseded before it was ever drawn stays an attempt without delivery — the
   operational diagnostic `CONTEXT.md` defines, never counted as a forecast the user received.
4. **Added after review of `06340e7`.** A `pending` also carries the `next N` row it was recorded
   with (`N`, or off). A frame whose row differs — the person stepped `N`, or showed or hid the row,
   while the terminal was too small — confirms nothing for it: the `pending` is dropped and stays an
   attempt without delivery, as in 3, and the next recompute records the reading again with the row
   then on screen. Delivering it would claim a sequence the screen never showed.

**Every source's list row is always drawn** in a normal frame: the list does not scroll (§5.7 sets a
minimum height that fits every source), and the help pane replaces only the detail pane. So a forecast
is undrawn only while the terminal is too small or the process is suspended — and then nothing is
delivered, which is the truth.

Consequences, stated so a reviewer can check them against ADR-0008:

- an eight-hour session with no new observation writes **one snapshot per source**, at start;
- a session restarted writes one again, exactly as running `status` again would;
- new observations that do not move the rounded interval, the risk or the evidence write nothing:
  subsequent outcomes are linked to the delivered snapshot the reader was still looking at, which is
  what `linkPrimaryEvaluations` does for a manual `status` read once before ten prompts;
- **time alone can move the key** (finding 5) — a sync with no new prompt whose recompute crosses a
  rounding edge writes a snapshot. That is the rendered-estimate rule the roadmap and ADR-0008's
  preamble adopted ("keys its snapshots on the rendered estimate"), and it is narrower than the ADR
  body's "only when the set of observations changed". The difference is real but small and
  harmless: a manual `status` at that instant would have shown, and recorded, the same new numbers.
  The ADR gets a one-paragraph note saying so in the release PR (§10).

### 4.4 The exit criterion, made testable

"An eight-hour dash session writes the same number of snapshots as the equivalent manual `status`
runs." The *equivalent manual runs* are: one `status --no-sync` at each instant the dash recomputed,
**counted only when what it would print differs from what the previous one printed** — a person who
re-ran `status` and saw the same line did not receive a new forecast, which is ADR-0008's whole point.
The test in §8.5 computes both sides from the same storage at the same injected instants.

---

## 5. Widgets and wording

### 5.1 Layout (80 × 24, colour off, one Codex-fed source selected)

```text
 snack dash · 3 capacity sources                  synced 12s ago · next in 48s
   SOURCE  NEXT PROMPT   RISK   EVIDENCE  PRESSURE  LAST SEEN   SYNC
 ▸ work     95-100%      low      high    moderate   2m ago      ok
   codex    61-99%    elevated    low       high     4m ago      ok
   home      2-98%      high    very_low  unknown     never    failed
 ──────────────────────────────────────────────────────────────────────────────
 work
   next prompt  95-100% chance it goes through · risk low
   evidence     high — enough of your own history to lean on
   pressure     moderate · above 62% of your own history · typical prompt
                lightest ├───────────────●─────────┤ heaviest
   by hour      ▁▂▁·▃▅▆▄▂▁··▁▂▃▅▇█▆▅▃▂▁▂  each hour against your own history
                24h ago                 now
   drivers      prompts, output tokens
   as of        2m ago · period since 2026-09-30
   ! Real provider capacity is unknown.
   ! Usage pressure compares this window with local history; it is not a share of capacity.

 ↑↓ select   r sync now   ? help   q quit
```

### 5.2 The list

`render.js` exports the overview's row builder as `overviewLines(statuses, {color, columns})` →
`string[]` (header + one line per source, no footer) — `renderStatusTable` (`render.js:661`) becomes
`overviewLines` plus its existing `warnings` footer, byte-identical. The dash prefixes the selected
row with `▸` in the two-space indent every overview line already starts with, so no column moves.
The same `OVERVIEW` columns (`render.js:174`), the same `fit()` sacrifice order (`render.js:738`),
the same `measure()` for wide characters (`render.js:795`). `SYNC` reads `ok`, `failed`, `busy`
(skipped because another command held storage) or `waiting` (before the first sync ends).

### 5.3 The plot: ~24 windows, a display series of its own

- **Series:** `pressureSeries` in `source-report.js`, computed from the **same rows and buckets**
  `computeSourcePressure` already reads (`main.js:2799-2882`: one read spanning the current window
  plus `ANALYTICS_POLICY.pressure_baseline_windows` = 30 baseline windows, `analytics.js:21-28`), so
  it costs no extra query. For the newest `PLOT_POLICY.windows` = **24** windows, oldest first: a
  window with no prompt is `null` (absence of observation, never zero — the rule
  `computeSourcePressure` applies to baselines); otherwise its `computeUsagePressure` score against
  **the one baseline the current window is ranked against** (offsets 1-30 with prompts). One shared
  baseline keeps the 24 scores on one scale, which is the reason `computeUsageTrend` gives
  (`analytics.js:226-239`). A past window is inside the baseline it is ranked against; for a drawing
  that is acceptable and the help says "each hour against your own history".
- **Policy:** `PLOT_POLICY = Object.freeze({ version: "dash-plot-v1", windows: 24 })` in
  `analytics.js`, beside and separate from `TREND_POLICY`, whose `windows: 5` (`analytics.js:220`)
  **does not move**: the trend direction is versioned, published in `--json` and stamped nowhere it
  could be confused with a drawing. `pressureSeries` is never added to the `pressure` object — that
  object is what `status --json` serializes — and is returned beside the reports.
- **Unit:** windows of the primary horizon (`config.analysis.horizons[0]`, default `PT1H`,
  `config.js:71`). Label `by hour` when it is `PT1H`, otherwise `by window` and the axis says
  `24 × 5h ago`.
- **Drawing:** the existing `sparkline()` (`render.js:1366`, eight blocks on a fixed [0, 1] scale,
  never rescaled to the series), with `·` (dim) for a `null` window, so "no prompts that hour" never
  looks like "the lightest hour". Below 5 baseline windows the row reads "no baseline to compare
  against yet" (`describePercentile`'s wording, `render.js:1137`) and no blocks are drawn.
- **Narrow:** the plot shows the newest `min(24, columns − 17)` windows; the axis keeps "now" on the
  right.

### 5.4 The scale: a marker, never a filled bar

```text
                lightest ├───────────────●─────────┤ heaviest
```

- One marker `●` at `round(score × (width − 1))` on a track of **one repeated glyph on both sides**
  (`─`), between `├` and `┤`. Left of the marker and right of it are drawn identically: there is no
  "consumed" side. Width `min(25, columns − 34)`, at least 11; below that, the scale is omitted and
  the `pressure` row's words stay.
- The ends are named for the reader's own history — `lightest`, `heaviest` — the same two ends
  `describePercentile` already states in words ("lower/higher than every window in your own
  history"). No `0%`/`100%`, no `empty`/`full`, no `used`/`left`.
- Colour (when on) paints **only the marker**, in the band's `SCALE` colour (`render.js:152`). The
  band word on the row above carries the meaning.
- `score === null` → no scale line at all.

### 5.5 Detail pane rows, in order

`next prompt`, `evidence`, `pressure` (+ scale), `by hour` (+ axis), `drivers`, `reported` (only for
a Codex-fed source, `describeReported` unchanged), `as of`, then the source's caveats. Each row is
`renderSource`'s row (`render.js:897-970`) without `--verbose`, `--sequence` or the `shadow` row;
`renderSource` is split so the dash reuses the row builders rather than copying them. `as of` drops
`sync …` (the list shows it). The `initial-generic` warning (`isInitialHeuristic`, `render.js:1124`)
is kept, as on the default panel.

### 5.6 Header, banners and key bar — exact strings

Header right side, one of:

- `synced 12s ago · next in 48s`
- `synchronizing… 3s`
- `sync skipped — another snack command is using storage · next in 48s`
- `sync failed — run snack doctor · next in 48s`
- `preparing storage…`

When the reading on screen is older than the last attempted sync, the `as of` row gains
`· showing the reading from 4m ago`.

Banners (one line under the header, replacing nothing else; each fits the 64-column minimum with its
margin, so none is cut — the build first worded the pending-migrations and newer-storage banners at 101
and 73 columns, and both were reworded to the lines below):

- `Preparing storage — 2 pending migrations, after a backup.`
- `Preparing storage — the first synchronization creates it.`
- `Storage could not be prepared; run snack sync to see why.`
- `A newer snack upgraded storage; quit and restart snack dash.`

Key bar: ` ↑↓ select   r sync now   ? help   q quit`.

Help pane (replaces the detail pane; the list stays drawn):

```text
 keys
   ↑ ↓  j k     select a capacity source
   r            synchronize now (otherwise every 60 seconds)
   ? Esc        close this help
   q Ctrl+C     quit
 reading this screen
   NEXT PROMPT  the chance the next prompt goes through, as an interval
   EVIDENCE     how much of your own history supports that interval
   PRESSURE     where this hour sits against your own history, not a share of capacity
   Real provider capacity is unknown.
   The method and policy versions behind each estimate: snack status --json
   Shadow estimates, recorded to compare and never the answer: snack status --verbose
```

Too small: one line, centred: `snack dash needs at least 64 columns and 15 rows for 3 sources; this
terminal has 58×20. q quits.`

### 5.7 Size policy

- **Designed for 80 × 24.** Minimum **64 columns** — the longest `next prompt` row
  (`100-100% chance it goes through · risk elevated`, 47 columns) after the 15-column label indent
  fits with a margin — and **`sources + 12` rows** (header, list header, the rows, rule, five
  detail rows, one caveat, key bar). Nine sources fit 24 rows. With the `next N` row on, four more,
  whether or not it informs (after review of `3978a85`: the informative row's assumption qualifier
  now has the row's priority and is reserved, where the build trimmed it first at 64 columns). A
  short terminal gives up, in order, the other caveats, the drivers, the scale and the plot, then
  the prior-tail line, then `as of`, and "Real provider capacity is unknown." last of all.
- **64-79 columns:** the list drops columns by `fit()`'s sacrifice order; detail rows truncate their
  explanatory tail with `…` (the interval, the risk word, the evidence word and the band word are
  never truncated); the plot narrows (§5.3).
- **Below the minimum:** the too-small line, keys still work, **nothing is drawn as a forecast and so
  nothing is delivered** (§4.3). Growing the terminal repaints.
- No line is ever wider than `columns` in screen columns (property-tested, §8.1).

### 5.8 Shadows and the sequence answer on the dash

- **Shadows: nothing on screen, one line in help** (D4). The dash shows the answer. A shadow, even as
  a count, invites "which one is better", and the place that answers it with the caveat attached is
  `status --verbose`. The shadows are still **computed and recorded** with every dash snapshot,
  because `buildSourceReports` is the code `status` runs and the attempt transaction carries them —
  the dash adds paired calibration samples at exactly the rate it adds answers.
- **No sequence answer, no `--sequence`** (D3). Reasons: (a) the length is the user's number for one
  question; a standing `next 10` on a screen left open becomes a gauge someone watches fall, which is
  the shape of "prompts remaining" the product refuses; (b) §7 shows the answer is too wide to
  inform beyond roughly 23 at best, so a live row would read "too wide" almost always; (c) it would
  add a flag to a command that otherwise has none.

---

## 6. Performance

| Measured | Budget | How |
|---|---|---|
| Recompute (lock + read + forecast + shadows + record) for every source, in process, 100 000 prompts | p95 **< 250 ms** — the `status --no-sync` budget, per PLAN's "a `snack dash` redraw is held to the same budgets as the command it repeats" | `performance.test.js`, the existing 100 000-prompt fixture, 20 recomputes |
| One frame (`renderDash` + diff), 9 sources, 200 × 60 | p95 **< 5 ms** | same file |
| Idle CPU between syncs (1 s ticks, no key) | **< 1 %** of a core | real binary, 10 min, `ps` |
| Peak RSS over an 8 h session; V8 old-space | **< 150 MB**, `--max-old-space-size=150` | the real 8 h run (§8.7) |
| Heap after 1 000 recompute cycles (forced GC) | grows **< 5 MB** | `performance.test.js`, injected clock |

**What is cached and when it is invalidated.** The cache is the last `buildSourceReports` result plus
the `pressureSeries`. It is invalidated **only** by: a sync child ending `ok`; `r` (which starts a
sync, so the same thing); startup; `SIGCONT` if a sync came due. Nothing else recomputes — not a key,
not a resize, not a tick. Per-second freshness is derived in the view (§3.1). A full computation per
second (finding 4) would be 10-15 % of a core and up to 150 ms of key latency every second for an
answer whose evidence changes, at most, once a sync.

---

## 7. The sequence answer's ceiling, documented

Not a `dash` surface (§5.8); it ships in the same release because the roadmap's `1.6.0` entry asks
for it, as documentation plus one optional `status --sequence` caveat.

### 7.1 Where

`docs/specification/analysis.md` §9.8 gains a subsection "How far the answer reaches", and
`docs/specification/cli.md` §12.3's `--sequence` paragraph gains one sentence pointing at it.

### 7.2 The forward table (evidence level and a fixed N in, the typical interval out)

Computed with the repo's `assembleForecast`/`assessSequence` and `render.js`'s rounding on
representative posteriors under the bundled `Beta(0.5, 0.5)` prior; `*` marks an interval
`sequence-width-v1` calls too wide to inform. The level is the one the real gates give that history
(decay analysis, `regimes.out`).

| History behind the answer (level) | next 1 | next 5 | next 10 | next 20 | next 50 | next 100 |
|---|---|---|---|---|---|---|
| none — the starting assumption alone (very_low) | 2-98%* | 0-89%* | 0-79%* | 0-61%* | 0-29% | 0-9% |
| 3 prompts, no restriction (very_low) | 65-100% | 11-99%* | 1-98%* | 0-96%* | 0-89%* | 0-79%* |
| 8 prompts, no restriction (low) | 83-100% | 40-100%* | 16-99%* | 2-98%* | 0-95%* | 0-91%* |
| 8 prompts, 1 restriction (low) | 65-97% | 12-84%* | 1-71%* | 0-50% | 0-18% | 0-3% |
| 30 prompts, no restriction (moderate) | 93-100% | 72-100% | 52-100% | 27-100%* | 4-99%* | 0-97%* |
| saturated, no restriction (moderate) | 96-100% | 83-100% | 69-100% | 48-100%* | 16-99%* | 2-98%* |
| saturated, ~1% restricted (high) | 95-100% | 77-100% | 59-99% | 35-98%* | 7-94%* | 0-88%* |
| saturated, ~5% restricted (high) | 88-99% | 54-91% | 29-82%* | 8-68%* | 0-38% | 0-14% |
| saturated, ~10% restricted (high) | 82-95% | 37-77% | 13-59% | 1-34% | 0-7% | 0-1% |

The one line that goes with it, verbatim: "The answer weights recent prompts more, halving a prompt's
weight every 30 later prompts in the same conditions, so the history behind it saturates near an
effective 44 prompts: beyond that, a longer history does not narrow the interval any further."

**The table is read left to right only.** It is never restated as "the largest N each level can
answer": reading it backwards is the probability-to-N inversion `1.4.0` refuses, done by hand. The
section says that in one sentence, and `vocabulary.test.js`'s count-before-prompts rule already
covers the man page that quotes cli.md.

### 7.3 The optional diagnostic (D6)

When `sequence.width.too_wide` **and** the evidence window's `weighted_restrictions` is below
`SEQUENCE_PRIOR_TAIL_POLICY.max_weighted_restrictions = 0.05` (`prediction.js`, new frozen constant,
`version: "sequence-prior-tail-v1"`), `status --sequence` appends one caveat after the width caveat:

> "Your recent history has no restriction to learn from, so the low end of this interval comes from
> SNACK's starting assumption rather than from your history."

A caveat, so it reaches `--json` through the existing open `caveats` array and moves no schema; no
new member, no storage. The real Codex copy trips it (one restriction weighted 0.00027); a history
with any restriction in the last few dozen prompts in that cell does not. Without `--sequence`, or at
an interval that is not too wide, nothing changes — the `1.5` corpus replay holds.

### 7.4 What the dash records for sequences

**Revised after review (user decision D3).** The build first recorded nothing for the `next N` row,
which left a shown method absent from the record and contradicted D3, whose chosen alternative
records `prediction_sequence` with each snapshot. As built now: while the row is on, each attempt the dash
records carries the sequence for the `N` on screen — `assessSequence` of the very answer recorded —
as a `prediction_sequence` row in the attempt's transaction, through `recordAttempt`, the path
`status --sequence` takes. No write per key press: stepping `N` changes no snapshot key, so it
records nothing until the reading itself changes. With the row off, no sequence is recorded.

---

## 8. Tests

### 8.1 Widgets, no terminal (`test/dash-view.test.js`)

- Golden frames (colour off) for: one source, nine sources, Codex-fed with `reported`, initial
  heuristic, no baseline, help pane, too-small, each banner, each header state — at 80 × 24, 64 × 15,
  200 × 60.
- **Property** (`fast-check`): for arbitrary `DashState` and sizes, every line's `measure()` ≤
  `columns`, `lines.length ≤ rows`, and `drawn` = every alias iff the frame is not too-small.
- **Scale**: for any score in [0, 1], the stripped scale line matches
  `/^lightest ├(─*)●(─*)┤ heaviest$/u`, has exactly one `●`, and contains none of `█▓▒░■▮`.
- **Plot**: `null` windows draw `·`; 24 windows at ≥ 80 columns; the axis keeps `now` rightmost.
- **Colour off**: no `\x1b[` in any line. **Colour on**: removing SGR yields the colour-off frame.
- **Rounding**: for arbitrary viability, the interval substring in the list row and in the
  `next prompt` row equals `shownInterval()`'s, and `snapshotKey` carries the same two integers.

### 8.2 Screen buffer (`test/screen.test.js`)

Identical frame → zero bytes written; one changed row → exactly one cursor move + that row + `\x1b[K`;
shorter frame → one `\x1b[J`; `invalidate()` → full repaint; `leave()` twice → restore bytes once;
every frame is one `write`.

### 8.3 Fake-TTY harness (`test/fixtures/fake-tty.js`)

```js
makeFakeTerminal({columns, rows, env}) → {
  stdout: {isTTY: true, columns, rows, write(chunk), on("resize"), hasColors()},
  stdin:  {isTTY: true, setRawMode(flag), on/emit("keypress"), pause(), resume()},
  press(name | sequence), resize(columns, rows), signal(name),
  frames(): string[][],      // the virtual screen after each write, ANSI applied, SGR stripped
  rawMode: boolean, inAltBuffer: boolean, cursorVisible: boolean,
}
makeFakeClock(start) → { now(): Date, advance(ms): Promise<void> }   // drives every timer
makeFakeSync(fn) → SyncPort    // fn runs in process: run(["node","snack","sync","--json"], …)
```

The harness applies the cursor-addressing subset `screen.js` emits to a `rows × columns` grid, so
assertions are about what a reader would see, not about bytes. Injected through `RunOptions`
(`terminal`, `clock`, `scheduler`, `sync`, `signals`), alongside `stdout`/`now` (`main.js:125-140`).

### 8.4 Loop, lock and signals (`test/dash.test.js`)

- Start → alt buffer on, raw mode on, cursor hidden; `q` → all three restored, exit `0`.
- `Ctrl+C` key → exit `0`, restored. Injected `SIGTERM` → restored, then the signal port receives
  the re-raise. `SIGHUP` → no write after it. `Ctrl+Z` → restored, `SIGSTOP` requested; `SIGCONT` →
  alt buffer and raw mode back, full repaint.
- A throwing keypress handler (injected fault) → restored **before** stderr receives "Unexpected
  internal failure.", exit `10`.
- **Lock freedom:** at every 1 s tick of a simulated 30 min, except while a recompute is in flight,
  the test acquires and releases `storage-operation` with `acquirePrivateLock` with **no retry**.
- Single-flight: `r` pressed three times during a running sync starts no second child; a sync that
  takes 3 virtual minutes delays the next by 60 s from its end.
- Child outcomes: each row of §3.2's table, from a fake sync port, leads to the stated header and
  `SYNC` values and recomputes only on `ok`.
- Storage states: missing DB, pending migration (database built at the `1.5.0` schema), newer schema,
  and a lock held by the test for 10 s — each shows §3.4's text and never exits.

### 8.5 The snapshot count (`test/dash-snapshots.test.js`)

On an OpenCode fixture (`createOpenCodeDatabase`) with a fake clock, a fake sync port that runs the
real `sync` in process, and a script of evidence:

1. **Eight hours, no new observation:** advance 8 h in 1 s ticks (28 800 frames, 480 syncs). Assert
   `SELECT count(*) FROM prediction_delivery WHERE format = 'dash'` = number of sources, and attempts
   = deliveries.
2. **Eight hours, 40 prompts appended at scripted instants** (some restricted, some moving the band):
   at every instant the dash recomputes, the test also computes the reference on the same storage —
   `buildSourceReports` with recording off, the code `status --no-sync` runs — and keys it with
   `snapshotKey`. Assert, per source: dash snapshots = the number of times the reference key differs
   from the previous reference key (counting the first). Assert no two consecutive dash snapshots of
   a source share a key.
3. **Identical frame writes nothing:** force a recompute whose unrounded lower end moves
   `0.9512 → 0.9518`; attempt and delivery counts unchanged.
4. **Rendered means drawn:** shrink below the minimum, let a key change, grow back — the attempt is
   recorded at the recompute and delivered at the first normal frame; a key superseded while too
   small leaves one attempt with no delivery.
5. **Cross-check with the real command:** at three instants, the `next prompt` interval printed by
   `run(["status","--no-sync","--source",alias])` equals the dash row's.

Runs in seconds: the clock is virtual and the fixture is small.

### 8.6 Pipes, privacy, vocabulary

- **Real binary** (spawned, as `performance.test.js` does): `snack dash | cat` → exit `2`, the
  `dash_requires_terminal` message on stderr, nothing on stdout; `snack dash < /dev/null` under a
  pty → `2`; `snack dash --json` → `2` with one valid error envelope.
- In process: `TERM=dumb`, `TERM` unset → `2`; `NO_COLOR=1` → frames without SGR.
- **Pty smoke** (Linux and macOS CI; skipped where `script` is absent): `script -qec "node cli.js
  dash" /dev/null`, feeder held open (per the verify skill), send `q` → exit `0`, output ends with
  `\x1b[?25h` and `\x1b[?1049l`; send `SIGTERM` to the child → same restore bytes.
- **Privacy:** the canary fixture (`fixtures/privacy-canaries.json`) through the OpenCode fixture,
  a dash session with every pane opened: no canary in any frame, any database row the dash wrote, or
  any file created; the only files the session touches are the database and the lock directory,
  `0o600`/`0o700`.
- **Vocabulary** (`vocabulary.test.js`): `["dash"]` joins `invocations` (it covers both refusals,
  human and `--json`); a new test runs a fake-TTY session through every pane, banner and size
  above and adds each final virtual screen, SGR stripped, to `outputs`, so `forbidden`
  (`vocabulary.test.js:25-41`) and the count-before-prompts rule police the screen. One dash-only
  pattern on the scale and plot lines: `/\b(?:full|empty|used|left|remaining)\b/iu`.

### 8.7 The eight-hour measurement on a real database (release evidence)

Per `verify-snack-against-real-cli`: the candidate binary, a **copy** of a real database with live
clients writing, under `script`, for 8 h, with a loop running `snack status --no-sync --json` every
5 min beside it. Record in `docs/release/performance.md`: dash snapshots per source; syncs run;
consecutive duplicate keys (must be 0); `storage_locked` answers to the loop (must be 0); peak RSS;
recompute p95. It cannot recompute the reference after the fact — §8.5 is the proof of equality; this
is the proof that nothing in the real environment breaks it.

---

## 9. Builder slices and the frozen interface

### 9.1 Ordering against the half-life work

S1 extracts the `status` action's per-source loop (`main.js:765-908`) into `source-report.js`. The
half-life builder is wiring `createWeightingShadows`/`attachShadows` into that same loop. **S1 starts
after that wiring lands on `release/1.6.0`**, and extracts it as it is; S2 needs only the frozen
types below and can start now.

### 9.2 Frozen interface (written first, in S1's first commit, as JSDoc typedefs)

```js
// source-report.js
/** @typedef {ReturnType<typeof createSourceStatus> & {reported_capacity?: …, shadow?: …, shadows?: …}} SourceReport */
/** @typedef {{alias: string, capacityPeriodId: number | null, report: SourceReport,
 *   series: (number | null)[], seriesHorizon: string, attempt: object, extras: {sequence?: object, shadow?: object, shadows?: object[]}}} BuiltSource */
export async function buildSourceReports(input: {
  paths, config, selected, inScope, now: Date,
  synchronization: (alias: string) => {performed: boolean, status: string},
  sequenceLength?: number, prospective?: …, includeSeries?: boolean,
}): Promise<{sources: BuiltSource[], warnings: {code: string, message: string}[]}>
export function recordAttempt(databaseFile, built: BuiltSource): number      // recordPredictionAttempt
export function confirmPredictionDelivery(databaseFile, ids, {now, format, invocationId})

// render.js
export function shownInterval(viability): {lower: number, upper: number}
export function shownForecast(report): {interval: {lower, upper}, risk: string, evidence: string}
export function overviewLines(statuses, {color, columns}): string[]
export function sparkline(scores)                                           // already exported

// dash-view.js
/** @typedef {object} DashState
 * @property {string} now                          ISO instant of this frame
 * @property {{alias: string, report: SourceReport, series: (number|null)[], seriesHorizon: string,
 *             sync: "ok" | "failed" | "busy" | "waiting"}[]} sources   config order
 * @property {number} selected
 * @property {"detail" | "help"} pane
 * @property {{phase: "idle" | "running", startedAt: string | null, endedAt: string | null,
 *             outcome: "ok" | "failed" | "storage_busy" | "storage_newer" | null,
 *             nextAt: string | null}} sync
 * @property {{computedAt: string | null, stale: boolean,
 *             storage: "ready" | "missing" | "pending" | "unprepared" | "newer",
 *             pendingMigrations: number}} reading
 */
export function renderDash(state: DashState, size: {columns: number, rows: number},
                           options: {color: boolean}): {lines: string[], drawn: string[]}

// dash.js
/** @typedef {{start(): Promise<SyncOutcome>}} SyncPort
 *  @typedef {{exitCode: number, envelope: object | null}} SyncOutcome */
export async function runDash(ports: {terminal, clock: () => Date, scheduler, sync: SyncPort,
  signals, storage: {paths, config, selected, inScope}, color: boolean, invocationId: string}): Promise<number>
export function snapshotKey(report, capacityPeriodId): string
```

### 9.3 Slices

- **S1 — extraction and the key (builder A).** `source-report.js`; `status` calls it; `render.js`
  exports §9.2 with `status` byte-identical (the `1.5` corpus replay and `render.test.js` hold it);
  `pressureSeries` + `PLOT_POLICY`. Gate: `npm run check` green with no test changed but
  additions.
- **S2 — screen and widgets (builder B, now).** `screen.js`, `dash-view.js`, §8.1, §8.2, against
  hand-written `DashState`s. No storage, no clock.
- **S3 — controller, command, ports (builder A, after S1).** `dash.js`, `dash-terminal.js`, the
  `dash` command and §1.2 in `main.js`, `RunOptions` additions, `cli.js` `EIO`; §8.3-§8.5.
- **S4 — surface and evidence (either, last).** `contracts.test.js` row, `vocabulary.test.js`,
  privacy, pipe and pty tests (§8.6), `performance.test.js` (§6), docs and the man page (§10), the
  8 h run (§8.7).
- **S5 — the sequence ceiling (either, independent).** §7: `analysis.md`, `cli.md`, and — if D6 —
  `SEQUENCE_PRIOR_TAIL_POLICY`, the caveat in `status.js`'s `sequenceCaveats`, its tests in
  `status-sequence.test.js`, the vocabulary line.

Reviewer focus: no SQLite access outside the operation lock in `dash.js`; `snapshotKey` and every
printed interval going through `shownInterval`; `status` bytes unchanged; restore on every exit path;
the child never killed.

---

## 10. Documentation and contract changes

- **`docs/specification/cli.md`**: a new `### 12.12 \`snack dash\`` after `12.11 Exit Codes` (no
  renumbering — `cli.md:370` cites §12.11), with the synopsis `snack dash` in a fence (the man
  generator reads fenced lines as synopsis, `man-surface.mjs:212-265`), §1.2's refusals, the keys,
  the two clocks, the snapshot rule in one paragraph, and "the dash draws no sequence answer and no
  shadow". §12.3's `--sequence` paragraph gains the pointer to §7. §12.11 gains the two reasons.
- **`packages/cli/man/snack.1`**: regenerated with `node scripts/generate-man.mjs`; the gate fails
  until it is.
- **`docs/compatibility.md`**, "What 1.6.0 adds": a new command, additive to the flag surface
  (`dash: ["--help"]`); two new reasons on exit `2`; `predictions.delivery_format` may now hold
  `dash` (D5) — a new value of a column the export schema never constrained; no envelope, export,
  configuration or spool version moves; no migration from `dash`.
- **ADR-0008**: a dated note under the preamble — the dash keys on the rendered estimate, which can
  move with time alone (§4.3), and the sync cadence is 60 s, not the `--watch` 30 s.
- **`docs/architecture/stack-and-layout.md`**: the five new modules in the module paragraph
  (`:87-96`). **`PLAN.md`** already carries the amendment; nothing to add. **README** (both
  languages): one line under the commands.
- **`CONTEXT.md`**: no new term. "dash" is a command, not a domain concept.

---

## 11. Decisions for the user

**D1. Flags on `dash` in `1.6.0`.** **Recommendation: none but `--help`.** `--source` only
pre-selects a row, an interval flag exposes a constant nobody has asked to change, and both are
additive in any later minor while neither can ever be removed. Alternative: `--source <alias>` as an
initial selection.

**D2. The sync cadence.** **Recommendation: fixed 60 s after the previous sync ends, plus `r`, not
configurable.** A sync measured at 2.3 s on a real database every 60 s is ~4 % duty on the lock; 30 s
(the old `--watch` default) doubles that for evidence that arrives a prompt at a time; a
configuration key would widen `config.schema.json` (`additionalProperties: false`), which a `1.5`
binary would then refuse. Alternative: 30 s, or a `dash.sync_interval` key.

**D3. The sequence answer on the dash.** **Recommendation: not shown, no `--sequence`** (§5.8): a
standing `next N` on a screen left open reads as a countdown, and it is too wide to inform past ~23
at best. Alternative: `--sequence <n>` adding a `next <n>` row to the detail pane and recording
`prediction_sequence` with each snapshot.

**D4. Shadows on the dash.** **Recommendation: nothing on screen, one help line pointing at
`status --verbose`** (§5.6). Alternative: a count ("2 shadow estimates recorded") in the detail
pane.

**D5. The delivery `format` for a dash snapshot.** **Recommendation: `"dash"`**, so the stream ADR-0008
might one day need to evaluate separately is identifiable without a filter that changes today's
calibration (nothing reads `format`). It is a new value in the exported, unconstrained
`delivery_format` column, stated in `compatibility.md`. Alternative: `"human"`, which changes no
exported value and makes dash snapshots indistinguishable from `status` ones forever.

**D6. The prior-tail diagnostic on `status --sequence`.** **Recommendation: ship it**, as one caveat
under `sequence-prior-tail-v1` with no JSON member (§7.3) — the analysis showed the width on a
restriction-free history is the prior's tail, and saying so is the one explanation that is true for
the reader's own data. Alternative: document only (§7.2) and leave the panel as `1.5` prints it.

## Decisions (user, 2026-10-03)

- D1 flags: none beyond `--help`.
- D2 sync cadence: fixed 60 s after the previous sync finishes, plus the `r` key; no configuration.
- D3 sequence in the dash: YES, "and show only what is reliable". The dash gains one sequence row whose
  length N the person chooses with a key (e.g. `+`/`-` or `s` to set; default off or a documented
  default). When the sequence interval is too wide (`sequence-width-v1`), the row shows NO numbers —
  only the honest statement (the same caveat wording as `status --sequence`, plus the prior-tail
  diagnostic when it applies). The key never skips, hides or clamps lengths by informativeness: the
  boundary between "shown" and "withheld" must not be discoverable by stepping, because that would
  reveal a per-user maximum N (the p→N inversion). The person's N stays the person's; the dash only
  declines to print numbers that carry no information. No `--sequence` flag on `dash`. Recorded
  (confirmed after review of `3978a85`): while the row is on, each snapshot carries the sequence for
  the N on screen as a `prediction_sequence` row in its transaction; a key press records nothing
  (§7.4).
- D4 shadows in the dash: nothing on screen ("only what is reliable"); help points at `status --verbose`.
- D5 delivery format: `format: "dash"` in `prediction_delivery` (spec recommendation).
- D6 prior-tail diagnostic: ship in 1.6.0 as a caveat in `status --sequence` (and the dash sequence
  row), under versioned `sequence-prior-tail-v1`, no new JSON member.
