# 11 — The packed-plugin host test named a tarball that stopped existing at `0.1.1`

Status: `fixed` Severity: **P2** Owner: unassigned Found in: Phase 1 end-to-end review, while
verifying [10](./10-live-capture-emits-null-provider-and-can-never-attribute.md) against the real
host Fixed in: the same change as 10

## What happened

`packages/opencode/test/host.integration.test.js` packed the plugin and then opened the tarball by a
name written out by hand:

```js
await execute("npm", ["pack", packageDirectory, "--pack-destination", root, "--json"], …);
const tarball = join(root, "snack-ai-opencode-0.1.0.tgz");
```

The filename carries the version. The plugin left `0.1.0` at Stage 4 and is now `1.0.0`, so the test
had been unable to run for six releases — it would fail on `npm install` with a missing file.

Nothing said so, because the test is `{ skip: !enabled }` behind `SNACK_OPENCODE_HOST_TEST=1` and
nobody had set it since. `npm run check` was green throughout, and `docs/opencode-support.md` cites
"an enabled packed-plugin host test against OpenCode `1.18.10`" as evidence for the live-capture
support claim.

This is the same shape as [09](./09-cli-1.0.0-installs-plugin-0.1.2-and-calls-1.0.0-outdated.md):
one place naming another package's version, with nothing tying the two together.

## Why it matters beyond itself

It is the reason [10](./10-live-capture-emits-null-provider-and-can-never-attribute.md) survived to
a stable release. The only gate that runs the plugin inside a real host could not run, and the
assertion it would have made was too weak anyway — it read `_pending/current.open` and checked that
_an_ event was written, never _where_. With no `source_bindings` configured, `_pending` is where
every event goes even when routing works.

## Fixed

`npm pack --json` reports the filename it wrote; the test takes it from there and cannot go stale.
The test now also configures a `source_bindings` entry for the provider the request names, and
asserts the segment lands under that alias with `"provider":"openai"` — so a regression to
`_pending` fails instead of passing.

Verified by running it against real OpenCode `1.18.10`:

```
SNACK_OPENCODE_HOST_TEST=1 node --test packages/opencode/test/host.integration.test.js
✔ OpenCode loads the packed plugin and dispatches chat.message
```

## Left open

The host test drives a message that carries `model` explicitly, so it exercises routing but not the
`chat.params` fallback that [10](./10-live-capture-emits-null-provider-and-can-never-attribute.md)
adds — reaching that needs a turn that actually calls a provider, which does not belong in a gate.
That path is covered at the plugin's own seam by
`a host that omits the model on chat.message still routes to the bound source`, and by the real
`opencode run` observation recorded in [`spec.md`](../spec.md).
