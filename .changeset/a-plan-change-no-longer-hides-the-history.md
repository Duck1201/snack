---
"@snack-ai/cli": patch
---

Re-running `setup` on an existing source no longer makes its stored history disappear, and now says
what the change costs before it happens.

`setup` opens a new capacity period whenever provider, profile, plan or plan profile changes —
correct, a new plan is a new capacity regime. But `status`, `doctor` and the source summary read the
open period only, so a source with 603 synchronized prompts reported `observed 0` and
`as_of unknown`, `doctor` said "No synchronized usage is available", and `stats` printed the same
rows with their timestamps. `sync --full` could not bring them back: an observation keeps the period
it belongs to by timestamp.

Describing a source and training its forecast are separate questions, and only the second one is
about the regime. `observed`, `as_of` and the freshness check now report everything the source
holds; the forecast still trains on the open period alone, so it falls back to the plan profile with
`evidence very_low` and says so. `setup` emits a `capacity_period_rotated` warning naming how many
prompts stop informing the estimate, on stderr and in the `--json` envelope.
