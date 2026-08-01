# 07 — The steady-state memory budget does not say which memory it means

Status: `ready-for-agent` Severity: **P3** Owner: unassigned Found in: Phase 1 end-to-end review,
Wave 4 Target: `1.1.0` — documentation, no product change

## What happens

`PLAN.md` states the budget as "steady-state CLI memory: under 150 MB".

`docs/release/performance.md` enforces it as `node --max-old-space-size=150` — a cap on the V8
old-space **heap** — and records the result as a pass/fail rather than a figure, deliberately, "so
the budget is enforced by the runtime rather than compared against a number that would drift with
the collector."

Both readings are defensible and they do not agree. Measured against a real 222 MB Claude history:

| Command            | V8 heap cap 150 MB | Peak process RSS |
| ------------------ | ------------------ | ---------------- |
| `sync` (no-op)     | PASS               | 238 MB           |
| `doctor`           | PASS               | 241 MB           |
| `stats`            | PASS               | 118 MB           |
| `status --no-sync` | PASS               | 93 MB            |

A user who reads "under 150 MB" and looks at `top` sees 238. Nothing is broken; the sentence is just
not saying which number it is about.

## Suggested fix

Say it in `PLAN.md`: "steady-state V8 heap under 150 MB, enforced as `--max-old-space-size=150`",
and note what that excludes — native allocations, the SQLite page cache, and external buffers. If
process RSS is what the budget was always meant to describe, that is a different sentence and a
different gate, and [06](./06-fingerprint-check-reads-the-whole-history-every-command.md) becomes a
breach of it rather than an inefficiency.

Delivery principle 9 is the reason this is worth a file rather than a shrug: a gate that reports
pass/fail against an unnamed unit is an assertion, not a measurement.
