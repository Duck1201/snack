# @snack-ai/opencode

Fail-open OpenCode capture plugin for SNACK. It writes only versioned, content-free metadata to the
private spool configured by `snack setup opencode --install-plugin --yes`.

The plugin never opens SQLite, imports the SNACK CLI, stores prompt/response text, or throws a
capture failure back to OpenCode. It requires a compatible `@snack-ai/cli` that accepts
`spool-event-v1`.

You do not install this package yourself. `snack setup opencode --install-plugin --yes` registers it
in OpenCode's own configuration after showing you the exact change, and `snack doctor` reports
whether the registration is compatible.

Install the CLI instead:

```bash
npm install -g @snack-ai/cli
```

`0.1.1` is the version the `@snack-ai/cli@0.6.0` MVP is compatible with. Apache-2.0.
