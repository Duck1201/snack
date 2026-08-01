# 03 — `doctor`'s pending-mapping warning names a count and nothing else

Status: `ready-for-agent`
Severity: **P3**
Owner: unassigned
Found in: Phase 1 end-to-end review, Wave 1, `@snack-ai/cli@1.0.0` from npm
Target: `1.1.0`

## What happens

```
[warn] source_mapping:oc-main: 183 schema-valid observation(s) need an explicit mapping.
```

That is the whole message (`doctor.js:191`). It does not say which providers were seen, how many of
each, or what the user is supposed to do. SNACK holds all of it: the `pending_mapping` table stores
`provider` and `model` per row, and the remedy is a `setup` run naming the provider.

The compatibility policy requires unknown fingerprints to "fail closed and produce actionable
`doctor` output". This fails closed correctly and the output is not actionable.

## What it should say

```
[warn] source_mapping:oc-main: 183 observation(s) need an explicit mapping:
       openai 133, opencode 31, ollama 19.
       Run: snack setup opencode --source oc-main --provider openai …
```

The counts already exist in the table this check queries. Related to
[02](./02-late-provider-mapping-recovers-nothing.md), which is the other half of why a user gets
stuck here: knowing the remedy is not enough if applying it recovers nothing.

## Test seam

`run(argv, options)` — seed pending mappings across two providers, assert `doctor`'s warning names
both providers and their counts.
