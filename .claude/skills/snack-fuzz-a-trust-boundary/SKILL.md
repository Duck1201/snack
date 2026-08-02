---
name: snack-fuzz-a-trust-boundary
description: >
  Write a property test that actually finds defects at one of SNACK's trust boundaries — a client
  adapter (Claude JSONL, OpenCode message/part blobs), the spool NDJSON reader, or argv. Use when
  asked to fuzz, property-test, or harden ingestion or the CLI surface, and before trusting a green
  fixture suite as evidence that a parser fails closed.
license: MIT
metadata:
  author: Duck
  version: "1.2"
---

# Fuzz a SNACK trust boundary

SNACK's fail-closed-on-data invariant lives at four seams: two client adapters, the spool reader,
and argv. Each one is a place where input SNACK does not control becomes an observation, a stored
row, or a published document. This is how to write a property test there that finds something.

**Failure pattern: success-shaped silence** — a parser that neither refuses nor understands, and
stores what it read verbatim. The row looks fine, `sync` reports it inserted, and every window,
freshness figure and horizon computed over it is arithmetic on a string. The fixture suite stays
green because fixtures only hold shapes someone already thought of. The test you write here fails
the same way if you let it: a property that refuses everything is silence too.

**Verified by:** four property tests written in one wave found three defects the suite had never
seen — a Claude `timestamp` that was not a time reaching `prompt_execution.started_at` (found on the
72nd generated case), a record with no time rooting a turn (137th case, _after_ the first fix), and
a rejected argv token published in the error envelope's `command` field. `npm run check` was green
before and after each.

When a **new client adapter** is what changed, read "Compare the two adapters" below before writing
anything — the highest-value finding of this kind was a difference between two readers, not a bug
inside one.

## The property, stated once

Every one of these tests asserts the same sentence, and it is worth writing at the top of the file:

> For any generated input, the reader either produces observations it can stand behind or refuses.
> Anything else — a crash, or a plausible-looking observation assembled from something it did not
> understand — is worse than reading nothing, because an under-counted or mis-timed history biases
> the forecast without saying so.

## Procedure

- [ ] 1. **Start from real data and degrade it.** Read a committed fixture, then apply generated
      mutations to it. Generating a record from nothing produces shapes nobody has ever seen, the
      reader refuses them all, and the test proves only that the refusal path works.

- [ ] 2. **Name mutations after how clients really break.** `drop-field`, `wrong-type`,
      `null-field`, `unknown-type` (a record type from a later release), `orphan-parent`,
      `self-parent`, a truncated last line. These are client-release drift, not random bytes.

- [ ] 3. **Test at the documented seam**, never at internals — the table under "Seams" below.
      `createSourceAdapter` takes `{adapter, database}`; passing a whole configured source is a
      typecheck error.

- [ ] 4. **Allow exactly one refusal and assert its shape.** Catch, then
      `assert.ok(error instanceof SnackError)` and
      `assert.equal(error.reason,     "source_schema_unsupported")`. Every other throw is the reader
      falling over rather than deciding.

- [ ] 5. **Count how many inputs were read through, and fail if none were** — the snippet under "The
      anti-vacuity counter" below. It is the assertion that breaks success-shaped silence in your
      own test: without it a fingerprint that later grows stricter turns a real property into a
      green one that reads nothing.

- [ ] 6. **Assert only what the seam owns.** See "Assert at the right seam" below — this is where
      both false positives came from.

- [ ] 7. **Run it several times before believing it.** `fast-check` seeds randomly, so one green run
      is one sample of the space — the loop under "Running it" below.

- [ ] 8. **Every defect gets a failing test first, then the fix, then an issue file** under
      `.scratch/<feature>/issues/NN-<slug>.md` with the severity and — if the surface is frozen —
      why the fix does not reset the freeze.

## Seams

| Boundary       | Seam                                                             |
| -------------- | ---------------------------------------------------------------- |
| Claude JSONL   | `createClaudeAdapter({projectsDirectory}).readAll()`             |
| OpenCode blobs | `createSourceAdapter({adapter: "opencode", database}).readAll()` |
| Spool NDJSON   | `readSpoolEvents({spoolDirectory, installationId, cursors})`     |
| argv           | `run(argv, options)` through `makeRunFixture()`                  |

## The anti-vacuity counter

```js
let readThrough = 0;
// ...inside the property, after the catch block
readThrough += 1;
// ...after fc.assert
assert.ok(readThrough > 0, "every generated input was refused; the read path went untested");
```

## Running it

```bash
for i in $(seq 1 12); do
  node --test packages/cli/test/<name>.property.test.js 2>&1 | grep -cE "^✖"
done
```

Run from the repo root. From `packages/cli` the runner reports `Could not find`.

## Assert at the right seam

The two false positives that cost the most time were both assertions placed where the claim does not
apply. The generated value shows up somewhere legitimate and the test reads like a real finding.

| Claim                          | Right seam                                         | Wrong seam                                                                                                               |
| ------------------------------ | -------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| No source content reaches disk | `privacy.test.js`, scanning every byte SNACK wrote | The adapter's observation — source identifiers leave an adapter **raw by design** and are hashed on the way into storage |
| A stored value is well-formed  | The observation (`started_at`, `completed_at`)     | —                                                                                                                        |
| A rejected value is not echoed | Refusals only                                      | Successes — `config set` echoing what it stored is the command working                                                   |

For privacy canaries specifically: plant them only in fields that must **not** survive. A spool
event's `source_code` is a provider error code and is stored on purpose; a canary there fails the
test for a reason that is not a leak. Testing a policy where it does not apply is how a privacy test
starts getting edited until it passes.

## Compare the two adapters

The most valuable finding of this kind was not a bug in one reader but a difference between two.

The OpenCode adapter passes this fuzz cleanly because its fingerprint queries assert
`json_type(data, '$.time.created') = 'integer'`, so a blob whose time is missing or is not a number
never reaches the read. The Claude adapter had no equivalent check, which is why it — and only it —
stored a timestamp that was not a time.

**When two adapters exist, run the same property against both and explain any difference.** A
boundary that passes for a reason you cannot name has not been tested; it has been visited.

## Gotchas

- **`structuredClone` is not a known global** to this repo's ESLint config. Round-trip through
  `JSON.parse(JSON.stringify(...))` — the fixtures came from JSON a moment ago.
- **`Object.values(ExitCode)` needs an explicit `Set<number>` annotation**, or `tsc` rejects
  `published.has(exitCode)` against the frozen literal union.
- **A SQLite-backed property is slow.** Each case builds a database on disk: 100 runs takes about 6
  s, 200 takes 12 s for no extra coverage when the mutation space is small.
- **Guard destructive generated argv.** Generating `--yes` is deliberate — a destructive command
  that skipped confirmation on a malformed scope is the worst thing argv could produce — but every
  invocation must run against a throwaway `makeRunFixture()` root.
- **Reusing one fixture across runs is fine and more realistic.** Reset `stdout.value` and
  `stderr.value` between invocations; state accumulating across cases is closer to a real
  installation than a clean root each time.

## What didn't work

- **Refusing only a `timestamp` that is present and invalid.** The reasoning was right — Claude Code
  writes `ai-title` and `queue-operation` records with no timestamp and the reader ignores them —
  but the conclusion was wrong: _any_ record can root a turn. The guard belongs in `turnRoots`,
  which is the function that decides what a submission is.
- **`/dev/full` as an ENOSPC fixture.** Wrong in both directions: as root the export creates
  `/dev/full.partial` and renames it over the device, exiting 0; as anyone else it fails because
  `/dev` is not writable, which is a permission error dressed as a full disk. It passed locally and
  failed only on the WSL2 job, which runs as root. A real full filesystem needs a loopback mount.

## Reference

`packages/cli/test/{claude-adapter,opencode-adapter,spool,main}.property.test.js` are the four
worked examples. `spool.property.test.js` additionally shows the arbiter pattern: when two
hand-written validators disagree about the same contract, compile the **published schema** with the
product's own Ajv configuration (`{allErrors: true, strict: true}`) and make it the referee. That is
what caught the spool schema failing to compile at all.
