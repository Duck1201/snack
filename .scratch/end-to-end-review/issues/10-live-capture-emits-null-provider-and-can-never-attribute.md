# 10 — Live capture emits `provider: null` on OpenCode `1.18.10`, so no live event can ever be attributed

Status: `ready-for-agent` Severity: **P1** — blocks release; ships as `1.0.1` Owner: unassigned
Found in: Phase 1 end-to-end review, Wave 2, real OpenCode `1.18.10`

## What happens

Real OpenCode `1.18.10`, the capture plugin registered through
`snack setup opencode --install-plugin`, a real prompt sent with `opencode run`. The plugin loads,
the host exits 0, and the spool receives its events at mode `0600`:

```json
{"event_type":"prompt_started", …,"provider":null,"model":null,"completion":"provisional","outcome":"excluded", …}
{"event_type":"session_idle",   …,"provider":null,"model":null,"completion":"completed","outcome":"success","usage_slices":[],"restrictions":[]}
```

`provider` is null, so the plugin routes the segment to `_pending` rather than to the bound source
directory, and `sync` can do nothing with it:

```
oc-live  spool  read 2  inserted 0  pending_mapping 2
```

Two runs, same result. Every live event ends in `pending_mapping` and stays there. `usage_slices` is
empty, so even attributed the event would carry no token evidence.

## Mechanism

`packages/opencode/src/plugin.js`, `chat.message`:

```js
const model = recordOrNull(input.model);
const provider = stringOrNull(model?.providerID);
const modelId = stringOrNull(model?.modelID);
const targetDirectory = provider
  ? (sourceBindings.get(provider) ?? join(spoolDirectory, "_pending"))
  : join(spoolDirectory, "_pending");
```

OpenCode `1.18.10` does not pass `model` in the `chat.message` hook input, so `provider` and `model`
are always null and the `_pending` branch is the only one that can be taken.

The code is **byte-identical in `@snack-ai/opencode@0.1.2` and `@snack-ai/opencode@1.0.0`**, so this
is not a consequence of [09](./09-cli-1.0.0-installs-plugin-0.1.2-and-calls-1.0.0-outdated.md) and
fixing that one does not fix this one.

## Why P1

`docs/opencode-support.md` publishes the claim this contradicts:

| OpenCode version | Schema family          | Backfill  | Live capture                      |
| ---------------- | ---------------------- | --------- | --------------------------------- |
| `1.18.10`        | `oc-sqlite-msgpart-v1` | Supported | **Supported by `spool-event-v1`** |

`1.18.10` is the version measured here. Live capture is the whole subject of the `0.3.0` release and
one of the two capture paths the product documents. It produces observations that cannot be stored,
on the exact version the matrix names as supported, and there is no user-side workaround — the
`_pending` routing is inside the plugin.

Backfill from OpenCode's SQLite still works and still attributes, which is why nothing looked
broken: `sync` shows sensible numbers on the `backfill` path in the same run.

## What is intact

Worth stating, because it is the invariant this wave existed to test: the plugin **never threw into
the host** (`opencode run` exit 0), the spool file is `0600`, the segment was rotated rather than
removed when it could not be committed, and the events are **content-free** — no prompt text, no
paths, no titles, only bucketed input features. See the Wave 3 sweep in `spec.md`.

## Suggested fix

Read the provider from wherever OpenCode `1.18.x` actually exposes it on this hook — the assistant
message the session writes carries `providerID`, which is how the backfill adapter gets it. Failing
that, the `session.idle` event can resolve the provider before the segment is closed.

Whatever the source, the fix needs the reconciliation check from
`.claude/skills/verify-snack-against-real-cli/SKILL.md` behind it: a plugin test against a real host
that asserts an event lands in the **bound** directory, not merely that an event was written. The
existing packed-plugin host test passes today with every event going to `_pending`.

## Test seam

`packages/opencode` plugin tests for the routing decision, plus the packed-plugin host test
(`SNACK_OPENCODE_HOST_TEST=1`) extended to assert the segment lands under the bound source alias.
Red first: assert a non-`_pending` destination.
