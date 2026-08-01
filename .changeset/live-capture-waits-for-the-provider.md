---
"@snack-ai/opencode": patch
---

Live capture now resolves the provider from `chat.params` when the host does not send `model` on
`chat.message`, and holds the prompt's first event until it can be routed.

OpenCode declares `model` optional on `chat.message` and does not send it on `1.18.10`. Every live
event therefore carried `provider: null`, went to the `_pending` directory, and `sync` reported
`read 2, inserted 0, pending_mapping 2` — no live observation could ever be attributed, on the exact
version `docs/opencode-support.md` lists as supported. `chat.params` carries the provider on the
same turn and is not optional; a prompt whose provider never arrives is still released to `_pending`
at its terminal event, which is where it would have gone anyway.

Note for `changeset version`: `pluginPackageSpec` in `packages/cli/src/opencode-config.js` names
this package's version. A test asserts the two match, so bumping this package turns `npm run check`
red until the constant moves with it. That is the gate working.
