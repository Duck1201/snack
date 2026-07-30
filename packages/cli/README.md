# @snack-ai/cli

OpenCode tracer preview for SNACK. This version provides read-only OpenCode setup and backfill,
explicit capacity-source mappings, source diagnostics, and a broad initial next-prompt estimate with
very-low evidence. It stores metadata only and does not claim to know provider capacity.

OpenCode backfill supports fingerprint family `oc-sqlite-msgpart-v1`, validated against OpenCode
`1.17.19`, `1.17.20`, `1.18.1`, and `1.18.9`. Compatibility is determined by structural and JSON
fingerprints, not by version strings; unknown shapes fail closed before canonical writes.

Requires Node.js 24.
