# 05 — A Claude record's timestamp was stored verbatim, whatever it held

Status: done Severity: P1

## Report

The Claude adapter copied `record.timestamp` into `started_at` and `completed_at` with `String()`
and no check that the value is a time. A record whose `timestamp` read `PRIVATE_LEAK_CANARY` came
out of `sync` as:

```
read 1 | inserted 1 | rejected_invalid 0
prompt_execution.started_at = "PRIVATE_LEAK_CANARY"
```

Reported as a clean insertion. Every window, freshness figure, horizon and pressure score computed
over that row was then arithmetic over a string, and nothing said so.

The second half is worse than the arithmetic: whatever the field held travelled out of the source
file and into the database unread. That is the shape a content leak takes — not a field SNACK
decided to store, but a field it never looked at.

Found by the Claude JSONL property test written for Stage 9 Wave 2, on the 72nd generated case. No
hand-written fixture had it, which is the point of the fuzz.

## Cause

`readRecords` in `packages/cli/src/claude-adapter.js` treated "parses as JSON" as "is a record this
reader can use". `requiredTurnFields` names `timestamp` as required, but only presence was ever
checked — never that the value is a time.

## Fix

`readRecords` now rejects a line whose `timestamp` is present and does not parse as a date, through
the same `rejected` channel an unparseable line already used. `sync` reports it as
`rejected_invalid`, so the history is visibly incomplete instead of quietly wrong.

Absence is deliberately not a failure: Claude Code keeps adding record types, and the ones this
reader never looks at need not carry a time. Refusing them would break SNACK on a client release
that changed nothing SNACK reads.

After the fix, the same input reports `rejected_invalid: 1` and the stored row carries a real time.

## Comments

Fixed in Stage 9 Wave 2. Covered by
`no Claude history, however broken, makes the adapter throw or invent an observation` in
`packages/cli/test/claude-adapter.property.test.js`, and confirmed through `sync` against the real
read path.

An earlier version of that property also asserted no generated value reaches the observation. It was
wrong at that seam: source identifiers leave the adapter raw by design and are hashed on the way
into storage. The leak question belongs to `privacy.test.js`, which asks it of the bytes on disk.
