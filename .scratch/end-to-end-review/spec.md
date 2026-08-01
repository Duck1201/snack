# Phase 1 — End-to-end review of the published `1.0.0`

Status: **findings recorded, triage complete, three P1s outstanding.** The exit criterion is not met
until `1.0.1` ships [05](./issues/05-second-setup-discards-the-forecast-evidence.md),
[09](./issues/09-cli-1.0.0-installs-plugin-0.1.2-and-calls-1.0.0-outdated.md) and
[10](./issues/10-live-capture-emits-null-provider-and-can-never-attribute.md).

Date: 2026-08-01. Machine: Linux 6.12.63+deb13-amd64, Node `24.18.1`, npm `11.16.0`, load average
0.51-0.72 across the run.

`PLAN.md` opens the 1.x roadmap with this phase because the seven-day RC soak was dropped at Stage
10, and with it the only rehearsal of the product under real use. `1.0.0` is the first artifact this
project pushed through the npm publish path, and it did so as the final release. Every artifact-level
gate had run. What had never been observed is the product **installed from npm, driven by a person,
against real history** — and that is where all ten findings came from. None of them is reachable from
`npm run check`, which is green.

## The subject, verified before anything was believed

```
snack --version                     1.0.0
snack-ai-cli-1.0.0.tgz              sha256:cc8c5239…37fd6e   matches docs/release/artifacts.md
snack-ai-opencode-1.0.0.tgz         sha256:fd979087…6b8594   matches docs/release/artifacts.md
```

Installed by name and version into a temp prefix (`npm install --prefix $ROOT/npm
@snack-ai/cli@1.0.0`), never from the workspace.

## Environment

SNACK state in a temp `XDG_*` root; the real sources read in place through their own variables:

```
XDG_CONFIG_HOME/XDG_DATA_HOME/XDG_STATE_HOME/XDG_CACHE_HOME → $ROOT/…
OPENCODE_DB        = ~/.local/share/opencode/opencode.db     392 MB, 66 sessions, 2618 messages
CLAUDE_CONFIG_DIR  = ~/.claude                               275 transcripts, 222 MB
```

`HOME` was deliberately **not** redirected: both source variables are set explicitly so nothing falls
back to it, and redirecting it would have hidden the real history the phase exists to read.

## Findings

| # | Severity | Summary | Target |
| --- | --- | --- | --- |
| [05](./issues/05-second-setup-discards-the-forecast-evidence.md) | **P1** | Re-running `setup` on an existing source discards every forecast's evidence, permanently | `1.0.1` |
| [09](./issues/09-cli-1.0.0-installs-plugin-0.1.2-and-calls-1.0.0-outdated.md) | **P1** | The `1.0.0` CLI installs the plugin at `0.1.2`, and tells anyone on `1.0.0` to downgrade | `1.0.1` |
| [10](./issues/10-live-capture-emits-null-provider-and-can-never-attribute.md) | **P1** | Live capture emits `provider: null` on OpenCode `1.18.10`; no live event can ever be attributed | `1.0.1` |
| [01](./issues/01-opencode-drops-unanswered-prompts.md) | P2 | The OpenCode adapter drops a prompt with no assistant reply, and counts it nowhere | `1.1.0` |
| [02](./issues/02-late-provider-mapping-recovers-nothing.md) | P2 | A provider mapping added after the first sync recovers nothing, and nothing says so | `1.1.0` |
| [06](./issues/06-fingerprint-check-reads-the-whole-history-every-command.md) | P2 | The Claude fingerprint check re-reads and re-parses the entire history on every command | `1.1.0` |
| [08](./issues/08-setup-hangs-when-stdin-is-already-closed.md) | P2 | Interactive `setup` hangs forever when stdin is already at EOF | `1.0.1` / `1.1.0` |
| [03](./issues/03-pending-mapping-warning-is-a-dead-end.md) | P3 | `doctor`'s pending-mapping warning names a count and nothing else | `1.1.0` |
| [04](./issues/04-applied-setup-reports-under-a-dry-run-key.md) | P3 | An applied `setup` reports its observation count under a `dry_run` key | `1.1.0` |
| [07](./issues/07-steady-state-memory-budget-does-not-name-its-unit.md) | P3 | The steady-state memory budget does not say which memory it means | `1.1.0` |

Per `PLAN.md`'s findings policy the three P1s ship as `1.0.1` immediately; a known P1 does not sit on
`latest` for the length of a feature release.

Three of them share one root that only real history exposes: **a real client history is
multi-provider**. This OpenCode database carries five providers — `openai` 136 eligible user
messages, `opencode` 31, `ollama` 19, `anthropic` 5, `haiku` 3 — and `setup` asks for one. The
product's own remedy for the resulting `pending_mapping` state ([02](./issues/02-late-provider-mapping-recovers-nothing.md),
[03](./issues/03-pending-mapping-warning-is-a-dead-end.md)) is a second `setup` run, which is exactly
what triggers [05](./issues/05-second-setup-discards-the-forecast-evidence.md). Every fixture the
suite runs on has one provider per source.

## Wave 1 — the command walk

Every command, human and `--json`, logged with stdout, stderr and exit code.

Clean: `sync` (both paths), `status`, `status --no-sync`, `stats`, `stats --by-client`, `doctor`,
`export` to file and to `-`, `config get|set|path`, `data purge --dry-run` then `--all --yes`.

- `export --format json --output - | head -c 200` — exit 0, no `EPIPE`, no stack trace.
- `export --format csv --output -` — `CSV export requires a directory; use --output <dir>.` Clean
  usage error.
- `setup --non-interactive` with no values — `setup_values_required`, exit 2.
- Interactive `setup` through a pty, answers fed with delays — completes, exit 0. Fewer answers than
  questions — `Setup cancelled; nothing was changed.`, exit 0. **Stdin already at EOF — hangs**
  ([08](./issues/08-setup-hangs-when-stdin-is-already-closed.md)).
- `data purge --all --yes` deleted 735 prompts and 68 snapshots, warned that the source will restore
  them and named `--prevent-reimport`, and a following `status` re-synchronized correctly.

**Permissions, every artifact the run produced:**

```
700  config/snack  data/snack  data/snack/backups  state/snack
600  config.jsonc  config.jsonc.bak  snack.sqlite3  storage-operation
600  export.json          ← including an export written to a user-chosen path
```

Nothing more permissive anywhere. `doctor` agrees.

**Reconciliation against the source** — the check that found
[01](./issues/01-opencode-drops-unanswered-prompts.md). The raw OpenCode database holds 200 user
messages, 194 after the adapter's own compaction and continuation filters. The adapter emits 183. The
11 missing all have zero assistant replies, and they reach no counter at all.

## Wave 2 — live capture through the plugin

The real `~/.config/opencode` copied into the temp root, the plugin registered there, real OpenCode
`1.18.10` driven with `opencode run`.

**Intact, and these are the invariants the wave existed to test:**

- the plugin loaded in the real host and never threw into it — `opencode run` exit 0;
- the spool segment is `0600`;
- the segment was **rotated and retained**, not removed, when it could not be committed — the
  cursor/segment invariant holds;
- the events are content-free. See Wave 3.

**Broken:** every event carries `provider: null`, routes to `_pending`, and `sync` reports
`spool read 2, inserted 0, pending_mapping 2`
([10](./issues/10-live-capture-emits-null-provider-and-can-never-attribute.md)). And the version the
CLI installs is `0.1.2`, not the `1.0.0` it published
([09](./issues/09-cli-1.0.0-installs-plugin-0.1.2-and-calls-1.0.0-outdated.md)).

One environment note that is not a SNACK defect: OpenCode `1.18.10` does not honour `XDG_DATA_HOME`
for its own database, so it kept writing to `~/.local/share/opencode/opencode.db` regardless. That
file is mode `644` — OpenCode's own choice; SNACK only ever opens it read-only.

## Wave 3 — privacy against real artifacts

The fixture canaries in `packages/cli/test/fixtures/privacy-canaries.json` are worth nothing against
real history: those strings do not occur in it. So the corpus was built **from the sources
themselves** — 1186 distinctive strings: prompt and response text from the OpenCode `part` table and
from the Claude transcripts, session titles, slugs, `directory`, `path`, every assistant `cwd`, and
every Claude project directory name.

Swept against every artifact a real run produced — `snack.sqlite3` through `strings`, the backups
directory, the spool NDJSON, everything under `$XDG_STATE_HOME`, and the export document:

```
snack.sqlite3      0 hits
export document    0 hits
backups + state    0 hits
spool NDJSON       0 hits
```

**The sweep is not tautological.** A control file built from five of the canaries returns 5 hits, and
the raw Claude transcripts return 2457. The method finds content when content is there.

Bare project paths were swept separately because they fall under the 16-character floor the corpus
uses: `/home/duck/Git/IA/AIQuota`, `-home-duck-Git-IA-AIQuota`, `Downloads/IMC` — zero hits in every
artifact.

The live spool event was read by hand as well. It carries bucketed features only:
`estimated_input_tokens`, `line_count_bucket: "1-10"`, `code_block_count_bucket: "0"`,
`attachment_count`. The prompt text does not appear.

**The content-free invariant holds on real data.** This is the strongest result of the phase.

## Wave 4 — the budgets, measured

Spawned binary, per `docs/release/performance.md`. History: 735 prompts stored from 222 MB of Claude
transcripts and a 392 MB OpenCode database — not the synthetic 100,000-prompt corpus the recorded
figures use, so these numbers are reported with their subject rather than compared to it.

| Budget | `PLAN.md` | Measured |
| --- | --- | --- |
| `status --no-sync` p95 | under 250 ms | **222 ms** (p50 206, max 427, n=30) |
| Incremental sync p95 | under 2 s | **1220 ms** (p50 1189, n=10) |
| Initial backfill | under 30 s | **2.56 s** (614 Claude + 183 OpenCode read) |
| Steady-state memory | under 150 MB | **passes** as heap; **238 MB** as process RSS |

The last row is two findings, not one. Re-running the recorded 1.0 gate —
`node --max-old-space-size=150` — against this real history passes on every command, so the gate as
written holds ([07](./issues/07-steady-state-memory-budget-does-not-name-its-unit.md) is about the
gate not naming its unit). Peak process RSS tells a different story and led to a real cause:

```
sync (true no-op, frozen source)   238 MB      doctor   241 MB
status --no-sync                    93 MB      stats    118 MB
OpenCode source alone (sync)        96 MB
```

A sync with **nothing to read** costs 238 MB and ~1.2 s because
`hasSupportedStructure` reads and parses all 275 transcripts on every command
([06](./issues/06-fingerprint-check-reads-the-whole-history-every-command.md)). The cost is O(total
history), not O(new data), and `1.2.0`'s `status --watch` would repeat it every 30 seconds.

## Wave 5 — the real `0.8.2` upgrade

Backed up first: `~/.local/share/snack` (4.9 MB), `~/.config/snack`, `~/.local/state/snack` to
`$SCRATCH/backup-0.8.2/`.

`1.0.0` opened the real `0.8.2` database — 714 prompts, migrations 1-12 all applied at `0.8.2` —
and:

- **no migration was pending.** `1.0.0` ships exactly those twelve, so the chain applied nothing and
  correctly took no backup. This is the conditional Stage 10 already learned to assert;
- checksums verified — the database opened without `migration_history_mismatch`;
- `PRAGMA integrity_check` → `ok`, 714 prompts intact;
- `status --no-sync`, `doctor`, `stats` and `export` all ran clean;
- the export from the upgraded database **validates against both frozen schemas**:

```
envelope.schema.json  VALID
export.schema.json    VALID
```

`doctor` on this state produced the message that
[05](./issues/05-second-setup-discards-the-forecast-evidence.md) cannot reach —
`Synchronized usage is older than 24 hours` — which confirms that branch works when the capacity
period is open, and that the "No synchronized usage is available" in the clean room was the defect
and not the normal path.

The real state was left as found apart from the prediction snapshots the review's own `status` runs
wrote, which are ordinary SNACK data. The schema is unchanged, so the user's installed `0.8.2` still
opens it.

## What the phase says about the test suite

Every finding here is invisible to `npm run check`, and each one names the reason:

- fixtures are single-provider; real histories are not (01, 02, 03, 05);
- fixtures are small; the cost of reading them all is invisible at fixture size (06, 07);
- the injected `prompt` port never has an already-closed stream (08);
- a version constant naming *another package* has nothing in the gate tied to it (09);
- the packed-plugin host test asserts an event was written, not where it landed (10).

That last one is the sharpest: the host test passes today with every single event going to
`_pending`.
