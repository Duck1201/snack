# Reconcile an adapter against its real source

Fixtures only contain the shapes you already knew about. A source adapter can be green across every
fixture and still drop whole classes of real records, silently — no error, no warning, just a
smaller number. For SNACK that is worse than a crash: an under-counted **observed restriction**
biases the forecast optimistic, and restrictions are the scarcest evidence it has.

So after writing an adapter, count what the raw source contains and compare it with what the adapter
emitted, per class of evidence. Read-only, and it takes a few lines:

```js
// count the evidence in the raw source, independently of the adapter
let raw = 0;
for (const file of sourceFiles)
  for (const line of readFileSync(file, "utf8").split("\n"))
    try {
      if (JSON.parse(line).error === "rate_limit") raw += 1;
    } catch {}

// count what the adapter attributed, and list what it missed
const captured = new Set();
for (const o of adapter.readAll().observations)
  for (const r of o.restrictions) captured.add(r.observed_at);
console.log(`${captured.size}/${raw}`);
```

Then **chase every gap to a named cause** — do not accept "close enough". Each gap is a shape of
real history the fixtures never had. Trace one missed record by hand: walk its parent chain, check
whether the file it lives in is reachable at all, check whether the record that links it exists.

On the Claude adapter this found three defects a green `npm run check` could not:

| Gap                             | Cause                                                                                  |
| ------------------------------- | -------------------------------------------------------------------------------------- |
| Subagent usage missing entirely | Claude Code writes subagent turns to `<session>/subagents/agent-*.jsonl`, never inline |
| Whole turns missing             | A resumed session roots its continued turn at a record that is not a submission        |
| A restriction missing           | An agent interrupted before reporting back leaves a transcript the session never links |

Restrictions went 13/17 → 17/17 and prompts 374 → 423. Nothing in the fixture suite moved.

Run the same reconciliation once more at the end: the number is the check.

## Gotchas

- **Do not assume the parent record already accounts for a child's usage.** Verify it. On Claude
  Code the parent's `toolUseResult` for a subagent carries
  `{isAsync, status, agentId, description, outputFile}` and no token counts at all, so reading the
  subagent file adds usage rather than double-counting it. Assuming either way without looking gives
  a silently wrong total.

## What didn't work

- **Locating a gap by grepping for an identifier across the source tree.** The subagent identifier
  appears inside the subagent's own transcript, so the grep "found" a link that did not exist in the
  parent and pointed at the wrong cause. Read the specific record and walk its parent chain instead.
