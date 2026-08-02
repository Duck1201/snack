# SNACK roadmap, 1.0 onward

The per-release detail for the 1.x line, split out of `PLAN.md` the way
[the 0.1-1.0 roadmap](./roadmap-0.1-1.0.md) was: `PLAN.md` keeps the thesis, the product boundaries,
the delivery principles and the policies that outlive any one release, and this file keeps the
schedule they are delivered on. A roadmap is the part of a plan that changes every few weeks, and
mixing it with the part that does not made both harder to trust.

### Phase 1 - End-to-end review (no version) — **complete**

**Purpose:** exercise the published product as a user before building five releases on top of it.

**Subject:** the published `1.0.0`, installed from npm. Not a workspace build and not a staging tarball — the review exists to exercise what a user actually receives, and the artifact that traverses the npm publish path is the one this project has never observed under real use.

**Outcome:** twelve findings, three of them P1, shipped as [`1.0.1`](../release/identity.md). Full record in `.scratch/end-to-end-review/spec.md`.

The phase paid for itself in the first hour, and what it proved is worth stating plainly: **`npm run check` was green the entire time.** Every defect it found was invisible to a suite of 413 tests, and each one names its own blind spot — fixtures with one provider per source where real histories have five; fixtures small enough that reading all of them costs nothing; an injected prompt port that never sees an already-closed stream; a constant naming another package's version with nothing tying the two together; and a host test asserting that an event was written rather than where it landed.

The three P1s were: re-running `setup` erasing a source's history from every forecast, permanently; the CLI installing a plugin three minors old and telling anyone on the current one to downgrade; and live capture emitting a null provider, so no live observation could ever be attributed, on the exact OpenCode version the support matrix listed as supported.

What held: the content-free invariant, swept with 1186 canaries built from the real sources rather than from the fixture file, zero hits across database, backups, spool, state and exports — with a control proving the sweep finds content when content is there. And all four quality budgets, measured rather than assumed.

**The lesson that outlives the phase:** a green gate is evidence that the code does what the tests describe, never that the tests describe what a user does. This is why the review ran against the published artifact and not the tree, and why it is worth repeating whenever a release changes a capture path.

**Exit, met:** the run is recorded, every finding is triaged, and no P0/P1 is outstanding.

### 1.0.2 - the review's remaining defects — **shipped**

**Purpose:** close the P2/P3 findings Phase 1 left open. Compatible defect fixes, which is what a patch is for; nothing here adds a command, a flag, or a field.

- **an OpenCode prompt with no assistant reply is emitted, not dropped** ([finding 01](../../.scratch/end-to-end-review/issues/01-opencode-drops-unanswered-prompts.md)). Eleven of 194 real prompts vanished without reaching any counter, so a source could not be reconciled against its own history. `docs/specification.md` §4.3 already defines the state they are in — completion `unknown`, outcome `excluded` — and the adapter simply never produced it;
- **a provider mapped after the first sync attributes its backlog without `--full`, and `doctor` names the providers it is waiting on** ([02](../../.scratch/end-to-end-review/issues/02-late-provider-mapping-recovers-nothing.md), [03](../../.scratch/end-to-end-review/issues/03-pending-mapping-warning-is-a-dead-end.md)). The pending rows are already retained; nothing replays them, and nothing says which providers they belong to or what to do;
- **the Claude fingerprint check stops re-reading the whole history on every command** ([06](../../.scratch/end-to-end-review/issues/06-fingerprint-check-reads-the-whole-history-every-command.md)). A no-op `sync` reads and parses 222 MB to sample 200 records per file: 238 MB of process RSS, O(total history) where the cursor was designed to make it O(new data).

- **the steady-state memory budget names its unit** ([07](../../.scratch/end-to-end-review/issues/07-steady-state-memory-budget-does-not-name-its-unit.md)). `1.0.0` passed a heap cap while peak process RSS over a real history was 238 MB, so the product's own budget had two answers. Both are now stated, and after the fingerprint fix both pass.

[Finding 08](../../.scratch/end-to-end-review/issues/08-setup-hangs-when-stdin-is-already-closed.md) was scoped into this release and then **retracted**: `setup` cancels cleanly on `Ctrl+D` and refuses without a terminal, and the reported hang was the review's own harness tearing down a pty while the command was still working. The fix was written and reverted rather than shipped, because a refactor justified by a defect that does not exist is not what a patch is for. The finding is kept, marked invalid, with the analysis — a red result from a harness is not evidence until the harness is shown able to tell a wait from an exit, which is the same rule this project already applies to a failing test.

**Exit, met:** each fix carries a test that fails against `1.0.1`; a source reconciles against its raw history exactly; and a no-op `sync` over a real history does not scale with what the cursor already covers.

### 1.1.0 - Interface, `snack update`, and the documentation restructure — **shipped**

**Purpose:** the terminal output is the product's only surface, and it is currently unreadable. And keeping the product current is currently a manual reconstruction of flags.

- `snack update`: bring the CLI and the capture plugin to the versions that belong together. Phase 1 made the case — upgrading by hand meant reading the local configuration to rebuild the exact `setup` invocation, because any field typed differently starts a new capacity period and retires the evidence. The command already knows every one of those values;
- **this is the one command allowed to reach the network**, and it needs [ADR-0010](../adr/0010-snack-update-may-reach-the-network.md) before it needs code. "Local only" is a product boundary and `setup` "performs no package fetch itself" is a stated one; an update command that installs packages changes both. The ADR records the scope of the exception rather than letting it become a precedent;
- colour through `util.styleText` from the standard library — it honours `NO_COLOR`, `FORCE_COLOR`, and TTY detection on its own, so no dependency and no `--color` flag are added;
- colour never carries meaning alone: the risk label is printed as a word and coloured, so a colourblind reader, a `NO_COLOR` terminal, and a captured log all read the same thing;
- column-aligned layout, one panel per **capacity source**;
- a usage-pressure sparkline over the analysis horizon, drawn with Unicode block characters and no dependency;
- `--json` output is never coloured and never reflows;
- the documentation restructure and the new roadmap ship in this release rather than as a docs-only patch, which would spend a version and a full npm publish without changing behavior.

**Exit:** rendering is covered by tests with colour forced on and off; no new dependency for colour; no interface work reaches the `--json` document except the one field named below; and `snack update` never rotates a capacity period it was not asked to.

**Amended while planning: `status --json` gains `pressure.trend`.** This entry originally required
`--json` bytes to be unchanged from `1.0.x` for the same input. The sparkline is drawn from the
window scores `computeUsageTrend` already produces, and asking `status` for them puts `trend` inside
the `pressure` payload — so the criterion as written forbade emitting a value the human panel shows.

The criterion is amended rather than satisfied by deleting the field before the envelope, for three
reasons. `status.schema.json` **already declares** `pressure.trend` as `object | null`: the slot was
reserved at the `0.9` freeze, so filling it is the additive change the schema was written permissive
to allow, not a contract change. A sparkline the human sees and `--json` cannot reproduce is the
asymmetry this product's own boundary — "expose human-readable and versioned JSON output" — exists
to prevent, and the suite already asserts the two modes agree. And computing a value in order to
throw it away saves nothing on the human path, which is the default one.

What the criterion was protecting is kept and stated more precisely: colour, layout, alignment and
the sparkline's rendering are human formatting and reach no JSON document. `pressure.trend` is the
single exception, it is named here, and it is additive under the strict SemVer `1.0` confirmed.

**Shipped** as `@snack-ai/cli@1.1.0` and `@snack-ai/opencode@1.0.2` on 2026-08-01, from commit
`ba57aaa`, tagged `v1.1.0`. Four pull requests and a release cut; the published artifacts match
the recorded evidence exactly. Full record in [docs/release/identity.md](../release/identity.md).

**Where the plan above was wrong.**

`snack update` landed with the layout detection, the confirmation, the failure path and the
re-exec, plus the network gate ADR-0010 asked for. Two things in this entry turned out to be wrong
and are corrected in the record rather than quietly: Node 24 cannot deny network access in-process —
its permission model covers `fs`, `child_process`, `worker`, `wasi` and `addons`, and there is no
`--allow-net` — so the gate is a test-level denial with a control proving it can fail. And ADR-0010
said `update` installs both packages; it installs only the CLI, because SNACK never installs the
plugin and a second install would land in a `node_modules` nothing reads.

The interface entry says `util.styleText` "honours `NO_COLOR`, `FORCE_COLOR`, and TTY detection on
its own". It honours them **for a TTY**. `hasColors()` exists only on `tty.WriteStream`, so a piped
stdout has no such method and `FORCE_COLOR` was dropped exactly where it is meant to work —
`snack status | less -R`. The two variables are read directly now, in Node's own precedence, and
everything else is still left to the stream. Driving the real binary is what showed it.

The sparkline is over five windows rather than "the analysis horizon": it reuses the scores
`computeUsageTrend` already produces, which are capped at five. Scoring all thirty-one buckets
`computeSourcePressure` fetches was considered and declined. The five-window version was then
measured against the 250 ms p95 and costs nothing — 197 ms without it, 188 ms with it — because the
query was already paid and the trend only re-ranks rows already in memory.

The panel also gained a `drivers` row the design did not have: specification §12.3 puts the top
pressure contributors in the default human detail, and a forecast whose drivers are only in `--json`
is two contracts.

[Finding 12](../../.scratch/end-to-end-review/issues/12-two-setups-in-the-same-millisecond-are-an-internal-error.md)
was scoped here and deferred to `1.1.1` once the rebuild was priced: `capacity_period` has the
observations table as a child, so dropping its redundant constraint copies the user's whole history
out and back, and no pragma that would avoid it survives the migration runner's transaction.

### 1.1.1 - the two findings 1.1.0 did not carry — **shipped**

**Purpose:** close the last two open findings from the Phase 1 review. Both are P3 with a documented
workaround, both were scoped into `1.1.0` and neither shipped there — one by choice, one after being
priced. Compatible defect fixes, which is what a patch is for; nothing here adds a command or a flag.

**[Finding 04](../../.scratch/end-to-end-review/issues/04-applied-setup-reports-under-a-dry-run-key.md) — an applied `setup` reports under a `dry_run` key.**
`setup opencode --json` without `--dry-run` answers `"dry_run": { "observations": 183 }`. The key
names the opposite of what happened, and `applied` disappears rather than becoming `true`, so a
consumer cannot tell the two apart from the payload alone.

The constraint is what makes this a patch rather than a rename: `dry_run` is a frozen public payload
and renaming it needs a major. What lands in a minor or a patch is additive — always emit `applied`,
`true` or `false`, so the payload is at least self-describing. The rename belongs in
`docs/compatibility.md` as a candidate for whenever a major is cut, rather than staying an
unrecorded wart. Test seam: `packages/cli/test/contracts.test.js`, asserting `applied` is present
and `true` on an applied setup.

**[Finding 12](../../.scratch/end-to-end-review/issues/12-two-setups-in-the-same-millisecond-are-an-internal-error.md) — two `setup` runs in the same millisecond raise `internal_error`.**
`capacity_period` is `UNIQUE (source_alias, started_at)` and a rotation inserts the new period at the
same instant it just wrote as the old one's `ended_at`, so the two collide whenever the clock does
not move. It surfaces as exit `10`. A human cannot type two commands a millisecond apart; a script
can, and so can any caller that retries.

**This was investigated during `1.1.0` and deferred with the price measured, so the next session
starts from the measurement rather than the estimate.** The issue file carries the detail; the short
version is that the obvious fix is not small. Dropping the constraint means a table rebuild, and
`capacity_period` has two children — `prompt_execution`, the observations table with four indexes,
and `prediction_attempt`, which carries two immutability triggers. With `foreign_keys = ON` there is
no way to drop the parent without dropping both, so every existing database copies its entire
history out and back. `PRAGMA legacy_alter_table = ON` would have avoided touching the children and
does not survive the migration runner's transaction, exactly as `foreign_keys` does not — probed,
with the output recorded.

So the choice is open and belongs to whoever picks this up:

- **rebuild the table.** Its one real benefit is that dropping the constraint makes rotation
  reachable under a frozen clock, which is what hid
  [finding 05](../../.scratch/end-to-end-review/issues/05-second-setup-discards-the-forecast-evidence.md)
  — every command test injects a frozen `now`, so no test could reach the rotation path without
  knowing to advance it, and none did;
- **classify the collision** as a config-level error with an actionable message instead of
  `internal_error`. A few lines, fixes the reported symptom, leaves the testing trap in place.

Price the rebuild against a real history before choosing. Use the `sqlite-constraint-migrations`
skill either way.

**Also available, and optional:** the network boundary gate `1.1.0` shipped proves the paths its
tests exercise and not the paths they do not. The complement is a static walk of the import graph
from `cli.js` that fails when any module outside `update.js` imports a networking builtin — it
catches unexecuted code but not a dependency that opens a socket, so neither is complete alone. The
note lives beside `denyNetwork()` in `packages/cli/test/fixtures/run-fixture.js`. Worth adding when
a dependency, rather than this code, becomes the thing to doubt.

**Exit:** each fix carries a test that fails against `1.1.0`; `setup --json` is self-describing
without renaming a frozen field; and two `setup` runs in the same millisecond do not report an
internal failure.

**Exit, met.** Both fixes landed with a test that fails against `1.1.0` — `applied` missing from an
applied setup's payload, and `SQLITE_CONSTRAINT_UNIQUE` from a rotation under a frozen clock. The
optional gate was taken as well.

**Shipped** as `@snack-ai/cli@1.1.1` on 2026-08-02, from commit `b9b1635`, tagged `v1.1.1`. The
plugin stays at `1.0.2` and did not republish; the digest the registry already served for it was
compared against this tree before the dispatch rather than reasoned about. One pull request and a
release cut; the published artifact matches the recorded evidence exactly. Full record in
[docs/release/identity.md](../release/identity.md).

**With this the Phase 1 ledger closes.** Twelve findings, eleven real and one retracted, across four
releases — `1.0.1`, `1.0.2`, `1.1.0` and `1.1.1`. Nothing from that review is outstanding.

**Where the plan above was wrong.**

**The rebuild was chosen, and the cascade is bigger than this entry said.** The entry named two
children, `prompt_execution` and `prediction_attempt`. There are eight tables in the drop: those two
plus `prompt_usage_slice`, `prompt_source_outcome`, `restriction_observation`, `prediction_delivery`
and `prediction_evaluation`, which cascade from them and cannot survive their parent being dropped
with foreign keys on. Five triggers come back too, and in the form
[migration 009](../../packages/cli/migrations/009_purge_tombstone.sql) left them, not the form
`007` created them in — `DROP TABLE` takes a table's triggers with it, and recreating the original
pair would have made `data purge` unable to delete the snapshots it previewed.

**The price is far lower than "copies the user's whole history out and back" suggested.** Measured
before the approach was committed to, as this entry required, on a seeded 100,000-prompt history:
**1.8 s, 104 MB peak RSS, every row preserved**. The cost that is worth naming is not time but
space — the file grows about 1.7x and keeps the freed pages for reuse instead of returning them, and
the runner's own pre-migration backup means the peak disk needed is roughly three times the database,
once. Figures in [docs/release/performance.md](../release/performance.md).

**The alternative was not taken, and the reason it existed is now covered.** Classifying the
collision as a config-level error would have fixed the exit code and left the testing trap: a frozen
clock could still not reach the rotation path, which is what hid
[finding 05](../../.scratch/end-to-end-review/issues/05-second-setup-discards-the-forecast-evidence.md).
The rebuild removes the trap, and the regression test is precisely the one nothing could write
before — a rotation with the clock held still.

**The optional network gate has an empty exception list.** The note asking for it assumed the walk
would need to exempt `update.js`. It does not: `update` reaches the network by spawning the package
manager and imports no networking builtin itself, so the rule the test asserts is the simpler one —
nothing in the shipped source opens a socket. The two gates are complementary and neither is complete
alone: the runtime denial covers dependencies but only executed paths, the static walk covers
unexecuted first-party code but no dependency.

### 1.2.0 - `status --watch` and `man snack`

- `snack status --watch[=SECONDS]`, default 30 s, floor 5 s, not a config key — an AI prompt takes minutes, so 30 s already outpaces the reality it observes;
- each tick synchronizes; a tick that finds the lock held is skipped and the screen is marked stale rather than queued;
- a snapshot is written only when the evidence changed ([ADR-0008](../adr/0008-watch-writes-a-snapshot-only-on-new-evidence.md));
- `--watch --json` and `--watch` without a TTY are usage errors, exit code 2;
- `snack.1`, generated by script from Commander's own definitions plus the command-reference prose, checked in, and verified by `npm run check` so an undocumented flag fails the gate.

**Exit:** an eight-hour watch session writes the same number of snapshots as the equivalent number of manual `status` runs; the generated man page matches the live flag surface.

### 1.3.0 - Codex CLI adapter

- read `~/.codex/sessions/**/rollout-*.jsonl` by **field allowlist**, never by exclusion: the same files carry `user_message`, `agent_message`, `cwd`, `workspace_roots`, and `git`. `~/.codex/history.jsonl` is never opened;
- ingest token usage per turn, and `rate_limit_reached_type` as an observed restriction stated by the source itself;
- ingest and display **reported capacity usage** — `used_percent`, `window_minutes`, `resets_at`, `plan_type` — labelled as reported and shown beside the estimate, never inside it and never in usage pressure ([ADR-0007](../adr/0007-quote-codex-reported-capacity.md));
- fingerprinted schema families, fail closed on drift, `snack setup codex`, and a support matrix page alongside the OpenCode and Claude ones;
- the prediction method is deliberately unchanged in this release.

**Exit:** privacy canaries pass against Codex fixtures; an unknown fingerprint refuses with actionable `doctor` output; a Codex source shares a capacity source with any other client on the same lineage without leaking client-specific fields.

### 1.4.0 - `status --sequence N`

- the probability that N consecutive prompts all complete without an observed restriction, reported as an interval with an evidence level, a risk label, and a named method — the same shape as the single-prompt answer;
- N is always supplied by the user. SNACK never inverts the relation, because a count derived from a probability is a claim about remaining capacity;
- an additive field in the existing envelope; no new command, no new envelope.

**Exit:** the JSON envelope validates against a version-bumped schema that the `1.0` corpus still validates against; no output path can produce a count of prompts.

### 1.5.0 - `reported_capacity_v1` prediction method

- a second versioned prediction method, named in the envelope beside the baseline, used only for capacity sources that report a figure;
- calibration is reported per method: mixing a method informed by a stated figure with one estimating from history would make a single Brier score meaningless;
- separated from `1.3.0` on purpose — shipping a new adapter and a new prediction method together leaves two candidate causes for any divergence and no way to separate them.

**Exit:** both methods carry independent calibration figures with their own sample sizes; the baseline's numbers are unchanged for sources that report nothing.
