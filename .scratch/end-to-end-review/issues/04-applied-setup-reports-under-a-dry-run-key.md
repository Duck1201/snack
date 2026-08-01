# 04 — An applied `setup` reports its observation count under a `dry_run` key

Status: `ready-for-agent` Severity: **P3** Owner: unassigned Found in: Phase 1 end-to-end review,
Wave 1, `@snack-ai/cli@1.0.0` from npm Target: `1.1.0`

## What happens

`setup opencode --dry-run --json` returns, correctly:

```json
"dry_run": { "observations": 183, "applied": false }
```

`setup opencode --json` **without** `--dry-run` — a run that mutates configuration — returns:

```json
"dry_run": { "observations": 183 }
```

The key says the run was a dry run. It was not. `applied` simply disappears rather than becoming
`true`, so a consumer cannot even use its absence to tell the two apart from the payload alone.

## Why it matters

The `--json` payload is a frozen public contract under `docs/compatibility.md`. A field named for
the opposite of what happened is the kind of thing a consumer writes a guard against and then
depends on.

## Constraint on the fix

Renaming `dry_run` is a **breaking change to a frozen payload** and needs a major version. What can
land in a minor is additive: always emit `applied`, `true` or `false`, so the payload is at least
self-describing. Note the rename in `docs/compatibility.md` as a candidate for whenever a major is
cut, rather than leaving it as an unrecorded wart.

## Test seam

`packages/cli/test/contracts.test.js` — assert `applied` is present and `true` on an applied setup.
