# 06 — The Claude fingerprint check re-reads and re-parses the entire history on every command

Status: `fixed` in `1.0.2`, commit 09dcefc Severity: **P2** Owner: unassigned Found in: Phase 1
end-to-end review, Wave 4, `@snack-ai/cli@1.0.0` from npm Target: `1.1.0`

## What happens

Against a frozen copy of a real Claude history — 275 session transcripts, 222 MB, **nothing
changed** — a no-op `sync` costs:

```
sync    (true no-op, frozen source)   peak RSS 238 MB   ~1.2 s
doctor                                peak RSS 241 MB
status --no-sync                      peak RSS  93 MB
stats                                 peak RSS 118 MB
```

The same no-op sync against the OpenCode source alone peaks at 96 MB, so the cost is the Claude
path, and it is paid whether or not there is anything to read.

## Mechanism

`claude-adapter.js:132-145`:

```js
function hasSupportedStructure(projectsDirectory) {
  let recognized = 0;
  for (const sessionFile of listReadableFiles(projectsDirectory)) {   // every file, always
    let inspected = 0;
    for (const record of readRecords(sessionFile)) {                  // whole file, read + parsed
      if (inspected >= fingerprintSampleSize) break;                  // caps inspection, not reading
      …
```

`readRecords` (`claude-adapter.js:596`) is eager: `readFileSync(file, "utf8")`, `split("\n")`, then
`JSON.parse` on every line, returning a fully materialized array. The `fingerprintSampleSize = 200`
break limits how many records are _examined_ after the file has already been read and parsed in
full.

`readSince` calls `hasSupportedStructure` before `read`, deliberately and for a good reason recorded
in the code — a client release that moves a usage field must not turn the next sync into a history
of null tokens. But the check runs before the cursor logic in `read()`, so the cursor's file-level
skip — the one optimization the adapter has, documented at `claude-adapter.js:157-163` as "exactly
the work worth avoiding" — never gets to avoid anything. Every command that syncs pays O(total
history bytes), not O(new data).

`doctor` pays it too, through the same fingerprint check.

## Why it matters

The cost grows with the user's whole history and never levels off. This machine is at 222 MB after
about a month; the curve has no ceiling in it. `status` synchronizes by default, so this is the cost
of the product's primary command.

It also collides with `1.2.0`'s `status --watch`, which repeats that command every 30 seconds.

## What it is _not_

Not a breach of the recorded 1.0 gate. `docs/release/performance.md` enforces steady-state memory as
`node --max-old-space-size=150`, and re-run against this real history every command still passes:

```
heap-cap 150MB: sync PASS   doctor PASS   stats PASS   status --no-sync PASS
```

The 238 MB is process RSS, which the gate does not measure. See
[07](./07-steady-state-memory-budget-does-not-name-its-unit.md).

## Suggested fix

Make the fingerprint check read what it inspects. `readRecords` materializes the whole file only
because it returns an array; sampling 200 records needs a line-at-a-time read that stops at 200.
That alone removes the parse cost, and applying the cursor's skip to the fingerprint pass — an
unchanged file cannot have changed its shape — removes the read cost too.

## Test seam

`claude-adapter.js`, with a fixture directory of several session files. Red first: count
`readFileSync` calls (or bytes read) across a `readSince(cursor)` where the cursor already covers
every file, and assert it does not scale with the files that were skipped.
