---
"@snack-ai/cli": patch
---

Two `setup` runs on the same source in the same millisecond no longer fail with `internal_error`.

A capacity-period boundary is one instant, written as `ended_at` on the period being closed and
`started_at` on the one being opened, and `capacity_period` was `UNIQUE (source_alias, started_at)`.
Whenever the clock did not move between the two writes they collided, and the collision surfaced as
exit `10`. A human cannot type two commands a millisecond apart; a script can, and so can anything
that retries.

Migration 013 rebuilds `capacity_period` without that constraint. The invariant that matters — one
open period per capacity source — was never the constraint's job and is still enforced by
`capacity_period_active_idx`.

**This is the expensive migration in this project.** With foreign keys enforced, the parent cannot
be dropped while a child holds rows, so `prompt_execution` and the seven tables that cascade from it
are copied out and back. On a 100,000-prompt history: 1.8 s, 104 MB peak RSS, every row preserved,
and a database file that grows about 1.7x and reuses the freed pages rather than returning them. The
runner takes its usual backup first. Figures in `docs/release/performance.md`.
