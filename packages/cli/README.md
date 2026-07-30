# @snack-ai/cli

OpenCode tracer preview for SNACK. This version provides read-only OpenCode backfill plus optional
fail-open live capture through `@snack-ai/opencode`, explicit capacity-source mappings, source
diagnostics, and a broad initial next-prompt estimate with very-low evidence. It stores metadata
only and does not claim to know provider capacity.

OpenCode backfill supports fingerprint family `oc-sqlite-msgpart-v1`, validated against OpenCode
`1.17.19`, `1.17.20`, `1.18.1`, and `1.18.9`. Compatibility is determined by structural and JSON
fingerprints, not by version strings; unknown shapes fail closed before canonical writes.

Requires Node.js 24.

Use `snack setup opencode --install-plugin --yes` to register the plugin in the global OpenCode
configuration. Add `--enable-prospective-analysis` only when you consent to local ephemeral,
allowlisted prompt-size features.
