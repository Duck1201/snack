# 02 — A provider mapping added after the first sync recovers nothing, and nothing says so

Status: `fixed` in `1.0.2`, commit faaee15 — see below Severity: **P2** Owner: unassigned Found in:
Phase 1 end-to-end review, Wave 1, `@snack-ai/cli@1.0.0` from npm Target: `1.1.0`

## What happens

A real OpenCode history is multi-provider. This one carries five: `openai` (136 eligible user
messages), `opencode` (31), `ollama` (19), `anthropic` (5), `haiku` (3). `snack setup opencode` asks
for **one** provider, so the first sync stores nothing at all:

```
oc-main  read 183  inserted 0  pending_mapping 183
```

`doctor` warns, correctly. The user then does the right thing — configures the second provider on
the same alias, which reuses the same `installation_id`:

```
snack setup opencode --source oc-main --provider openai …
```

and re-syncs. **The next sync reads one record.**

```
oc-main  read 1  inserted 0  pending_mapping 1
```

The ingestion cursor advanced past all 183 rows on the first sync, so the mapping that would now
attribute them is never applied to them. `sync --full` recovers them —

```
oc-main  read 183  inserted 133  excluded 29  pending_mapping 50
```

— and 50 is exactly `opencode` 31 + `ollama` 19, so the recovery is complete and correct.

## Why it is a defect

Nothing tells the user any of this. `sync` reports `read 1` as a success. `doctor` keeps warning
about pending mappings without connecting the warning to the remedy. A user who fixed the
configuration and re-synced has every reason to believe the fix took effect, and the only signal
that it did not is a number they have no baseline for.

The cursor invariant itself is intact — `CLAUDE.md` requires the cursor to advance inside the
committing transaction, and it did. What is missing is that a _pending_ observation is not a
committed one, and advancing past it makes the pending row unrecoverable by the incremental path.

P2 rather than P1 because `sync --full` is a complete workaround. It is undocumented, which is the
other half of the defect.

## Reproduction

1. `setup opencode --source X --provider <a provider your history barely uses>`
2. `sync` — everything lands in `pending_mapping`
3. `setup opencode --source X --provider <the provider you actually use>`
4. `sync` — reads only what is new since step 2; the backlog stays pending
5. `sync --full` — the backlog is attributed

## Suggested fix

The lazy version, in preference order:

1. when a sync sees a newly-mapped provider that has pending rows for this installation, replay the
   pending rows rather than requiring `--full`. The rows are already retained in `pending_mapping`;
2. failing that, have `sync` and `doctor` say
   `run snack sync --full to attribute N pending observation(s)` — a message, not a mechanism.

## Test seam

`run(argv, options)` with `makeRunFixture()`: setup with provider A, sync, setup with provider B,
sync, assert the previously pending observations are attributed without `--full`.

## What actually shipped, and what did not

**Partly fixed in `1.0.2`.** The suggested fix listed two options in preference order; the first one
is not available.

Option 1, replaying the pending rows, **cannot be done from storage.** `pending_mapping` is
`(source_alias, source_prompt_id, provider, model, first_seen_at)` — identifiers, no payload. The
full observation is retained only for the spool path, in `pending_spool_observation`. So for a
backfill there is nothing to replay from: the source has to be read again, which is exactly what
`sync --full` does. Holding the payload for every pending backfill observation is a schema change
and belongs to a release that can carry a migration.

Option 2 shipped: `doctor` now names the providers, their counts, and the command
([03](./03-pending-mapping-warning-is-a-dead-end.md)). A user who lands in this state is told how to
leave it, which was the half of the defect that could be closed without moving the schema.

**Separate aliases avoid the trap entirely**, which is worth recording because it is what a real
multi-provider history wants anyway: a new capacity source has no ingestion cursor, so its first
sync reads the whole source and attributes immediately. Confirmed on a real installation — adding
`opencode-zen` and `ollama-local` alongside an existing `openai` source attributed 34 and 19
observations on a plain `sync`, with no `--full` and no capacity period rotated.
