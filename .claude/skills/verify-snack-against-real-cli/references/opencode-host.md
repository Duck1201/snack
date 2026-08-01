# Drive the real OpenCode host

Live capture cannot be verified any other way: the plugin only routes when a real host dispatches
real hooks. `opencode run "…"` is the non-interactive entry point.

**The plugin must be registered by npm specifier.** A local path or a `plugin/` directory entry makes
OpenCode hang at `init` with no output and no log line — several variants were tried and every one
hung. Either point at a published version, or install a packed tarball into the config directory and
reference the **installed directory**, which is what
`packages/opencode/test/host.integration.test.js` does.

```bash
# publish-free route: pack, install into the config dir, reference the installed directory
npm pack --workspace @snack-ai/opencode --pack-destination "$V"
npm install --prefix "$V/config/opencode" --ignore-scripts --engine-strict=false "$V"/*.tgz
# opencode.json plugin entry: [ "<V>/config/opencode/node_modules/@snack-ai/opencode", { … } ]

env XDG_CONFIG_HOME=$V/config XDG_DATA_HOME=$V/data XDG_CACHE_HOME=$V/cache \
    OPENCODE_DISABLE_MODELS_FETCH=true OPENCODE_DISABLE_AUTOUPDATE=true \
  opencode run "reply with the single word ok"
```

Those two `OPENCODE_DISABLE_*` variables are not optional in a throwaway root — without them the run
stalls fetching models or checking for an update, which looks exactly like the plugin hanging the
host.

Then assert **where** the segment landed, never just that one exists:

```bash
find "$SPOOL" -type f -printf '%m %p\n'     # expect 600, and the bound alias directory
```

`_pending/` is where an unattributable event goes, so a test that reads it passes whether routing
works or not. That is precisely how a null-provider defect survived a stable release.

**OpenCode does not honour `XDG_DATA_HOME` for its own database** — it keeps writing to
`~/.local/share/opencode/opencode.db` whatever you set. Redirecting it is not isolation; treat the
real database as read-only input and isolate only SNACK's own state.

**OpenCode's own configuration may hold credentials.** When you need to look at it, render only the
`plugin` array.

## What didn't work

- **Registering the plugin by local path, by tarball path, or via a `plugin/` directory.** All three
  hung OpenCode at `init` with no output. Only an npm specifier or an installed `node_modules`
  directory works.
- **Redirecting `XDG_DATA_HOME` to isolate OpenCode's database.** OpenCode ignores it and keeps
  writing to the real one. What that actually isolates is nothing, while making you believe the run
  was contained.
