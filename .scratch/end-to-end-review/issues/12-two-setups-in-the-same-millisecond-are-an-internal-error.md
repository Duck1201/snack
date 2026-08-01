# 12 — Two `setup` runs in the same millisecond raise `internal_error`

Status: `ready-for-agent` Severity: **P3** Owner: unassigned Found in: while writing the failing
test for [05](./05-second-setup-discards-the-forecast-evidence.md) Target: `1.1.1`

## What happens

`capacity_period` is `UNIQUE (source_alias, started_at)` (`002_open_code_tracer.sql:22`), and a
rotation closes the open period and inserts a new one at the **same** timestamp it just wrote as
`ended_at`. Two `setup` runs on one alias within the same millisecond therefore collide on the
unique constraint, and the failure surfaces as the worst exit code SNACK has:

```json
{
  "status": "error",
  "errors": [{ "code": "internal_error", "message": "Unexpected internal failure." }]
}
```

exit `10`.

A human cannot type two `setup` commands a millisecond apart, so this is P3 in the field. A script
can, and so can any caller that retries.

## Why it is worth a file anyway

It is why the whole suite never reached the rotation path. Command tests inject a frozen `now`
(`makeRunFixture`), so **every** re-`setup` in a test hits this constraint instead of rotating. The
first failing test written for [05](./05-second-setup-discards-the-forecast-evidence.md) passed
against the defect for exactly that reason, and only advancing the injected clock reached the real
behaviour:

```js
// A frozen clock cannot rotate at all …
fixture.options.now = new Date("2026-01-02T04:00:00.000Z");
```

A frozen clock is the right default for command tests and is not the defect. What the defect cost is
that no test could reach the rotation without knowing to advance it, and none did.

## Suggested fix

The period boundary is one instant; recording it as `ended_at` on one row and `started_at` on the
next is what makes the two collide only when the clock does not move. Either allow the insert to
carry the same instant (the unique constraint is doing less work than it looks — `ended_at IS NULL`
already has its own partial unique index for "one open period per source"), or classify the
collision as a config-level error with an actionable message rather than `internal_error`.

Dropping a constraint means a table rebuild — see the `sqlite-constraint-migrations` skill.

## Test seam

`storage.js` directly: call `ensureCapacityPeriod` twice with the same `now` and a changed plan, and
assert the outcome is not `internal_error`.

## What the `1.1.0` session found, and why this moved to `1.1.1`

Scoped into `1.1.0`, investigated, and deferred once the rebuild was priced. Recorded here so the
next session starts from the measurement rather than from the estimate.

**The rebuild is not small.** `capacity_period` has two children — `prompt_execution`, which is the
observations table and carries four indexes, and `prediction_attempt`, which carries two
immutability triggers including a `BEFORE DELETE` that aborts. With `foreign_keys = ON`, dropping
the parent means dropping and recreating both children, so every existing database copies its entire
history out and back to remove a constraint that only bites when two `setup` runs land in the same
millisecond.

**There is no cheaper route through a pragma.** `PRAGMA legacy_alter_table = ON` would make
`ALTER TABLE ... RENAME` leave the children's `REFERENCES` clauses alone, which would rebuild the
parent without touching the observations table at all. It does not survive the migration runner's
transaction, exactly as `foreign_keys` does not. Probed directly:

```
child DDL after rename: ... REFERENCES "parent_old"(id) ...
SqliteError: FOREIGN KEY constraint failed
```

The pragma was silently ignored, the child was rewritten to point at the renamed table, and the
insert that followed failed. This is the same trap the `sqlite-constraint-migrations` skill
documents for `foreign_keys`, and it is worth adding there: **no pragma the runner's transaction
does not already hold can be set from inside a migration.**

So the choice for `1.1.1` is between the full rebuild — whose one real benefit is that dropping the
constraint makes rotation reachable under a frozen clock, which is what hid
[finding 05](./05-second-setup-discards-the-forecast-evidence.md) — and classifying the collision as
a config-level error, which is a few lines, fixes the reported symptom, and leaves the testing trap
in place. Price the rebuild against a real history before choosing.
