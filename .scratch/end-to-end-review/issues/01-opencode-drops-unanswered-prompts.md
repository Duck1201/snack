# 01 — The OpenCode adapter drops a prompt with no assistant reply, and counts it nowhere

Status: `ready-for-agent`
Severity: **P2**
Owner: unassigned
Found in: Phase 1 end-to-end review, Wave 1, `@snack-ai/cli@1.0.0` from npm
Target: `1.1.0` unless a later wave raises the severity

## What happens

Against the real OpenCode database (392 MB, 66 sessions, 2618 messages), the adapter emits **183**
observations. The source holds **200** user messages, **194** of them eligible once the adapter's own
compaction and continuation filters are applied.

The 11 that disappear all share one property: **no assistant message names them as a parent**.

```
msg_faaa79693001ncQGniEJDGKo0g provider=anthropic model=claude-opus-4-8  assistantReplies=0
msg_faabb6473001JizV4I5pzRaK38 provider=haiku     model=                assistantReplies=0
msg_fab06c689001CMitTk2prSl3Cj provider=openai    model=gpt-5.6-sol     assistantReplies=0
… 11 rows, every one of them assistantReplies=0
```

They are not merely unstored. They never reach a counter: `sync` reports
`read 183, inserted 133, excluded 29, pending_mapping 50, rejected_invalid 0, failed 0`, and 183 is
already the post-drop number. Nothing in `sync`, `doctor` or `stats` lets a user reconcile 200
against 183.

## Why it is a defect rather than a policy

`docs/specification.md` §4.3 already defines the state these prompts are in:

- prompt-level completion `unknown` — "available metadata cannot determine a terminal state";
- source-level outcome `excluded` — "cancellation, operational error, or ambiguity prevents a valid
  success/restriction label", and "excluded observations still contribute valid descriptive usage
  dimensions".

A user prompt with no assistant reply is the textbook `unknown`/`excluded` observation. The adapter
never produces that shape; it produces nothing at all. Two consequences:

1. the descriptive usage dimensions the spec says an excluded observation still contributes are lost;
2. a source can never be reconciled against its own history, which is the check that finds an
   under-counting adapter in the first place — see
   `.claude/skills/verify-snack-against-real-cli/SKILL.md`, "Reconcile an adapter against its real
   source".

Forecast correctness is **not** affected, which is what keeps this at P2: only `success` and
`restricted` update the Bayesian outcome model, and an unanswered prompt carries neither. A
restriction lives in the assistant message, so no restriction evidence is being lost here.

## Reproduction

```bash
node -e '
import("@snack-ai/cli/src/opencode-adapter.js").then(async ({createOpenCodeAdapter}) => {
  const a = createOpenCodeAdapter({ databaseFile: process.env.HOME + "/.local/share/opencode/opencode.db" });
  console.log(a.readSince(null).observations.length);   // 183
});'
```

against

```sql
SELECT COUNT(*) FROM message JOIN session ON session.id = message.session_id
WHERE json_extract(message.data,'$.role') = 'user';   -- 200
```

## Suggested fix

Emit the observation with `completion: "unknown"` and outcome `excluded` rather than skipping the
row. If the project decides the drop is correct, it still needs its own counter in the sync result
so the number is reconcilable.

## Test seam

`opencode-adapter.js`, driven by a fixture under `packages/cli/test/fixtures/opencode/` that carries
a user message with no assistant child. Red first: assert the adapter emits an observation for it.
