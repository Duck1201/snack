# 12 — Two `setup` runs in the same millisecond raise `internal_error`

Status: `ready-for-agent` Severity: **P3** Owner: unassigned Found in: while writing the failing
test for [05](./05-second-setup-discards-the-forecast-evidence.md) Target: `1.1.0`

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
