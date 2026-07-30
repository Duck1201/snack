# @snack-ai/opencode

Fail-open OpenCode capture plugin for SNACK. It writes only versioned, content-free metadata to the
private spool configured by `snack setup opencode --install-plugin --yes`.

The plugin never opens SQLite, imports the SNACK CLI, stores prompt/response text, or throws a
capture failure back to OpenCode. It requires a compatible `@snack-ai/cli` that accepts
`spool-event-v1`.
