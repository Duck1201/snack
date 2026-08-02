---
"@snack-ai/cli": patch
---

A capacity period can no longer be recorded as ending before it started.

Every command reads the clock once on entry and only then queues for the storage lock, so two
processes write their periods in lock order and not in clock order — the one that waited can be
holding the earlier reading. Closing the open period with it produced a row whose `ended_at`
preceded its own `started_at`, and a later period whose `started_at` preceded the regime it
replaced. `status` takes the active period's start as the origin of its pressure windows, so the
inversion reached a forecast and not only the stored row.

The boundary is one instant and it belongs to the period being closed, so it is now clamped to never
fall before that period's start. A period closed by a late process reads as zero-length instead of
negative, which is the honest shape — and it is representable at all only because `1.1.1` stopped
requiring distinct start instants.

Found by racing six `setup` runs on one alias against a real installation, which is the only way it
appears: a human cannot produce it, and no single-process test could.
