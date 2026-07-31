# @snack-ai/cli

OpenCode tracer preview for SNACK. This version provides read-only OpenCode backfill plus optional
fail-open live capture through `@snack-ai/opencode`, explicit capacity-source mappings, source
diagnostics, and a broad initial next-prompt estimate with very-low evidence. It stores metadata
only and does not claim to know provider capacity.

`snack stats` describes observed usage over rolling analysis horizons: prompt counts by outcome,
restrictions by class, token dimensions kept separate, cost per currency, and duration percentiles.
Anything the source did not report stays `unknown` and never becomes zero.

`snack status` also reports usage pressure, which ranks the current window against your own
preceding windows of the same length. Pressure is relative to your local history. It is not a share
of provider capacity, which remains unknown.

OpenCode backfill supports fingerprint family `oc-sqlite-msgpart-v1`, validated against OpenCode
`1.17.19`, `1.17.20`, `1.18.1`, and `1.18.9`. Compatibility is determined by structural and JSON
fingerprints, not by version strings; unknown shapes fail closed before canonical writes.

Requires Node.js 24.

Use `snack setup opencode --install-plugin --yes` to register the plugin in the global OpenCode
configuration. Add `--enable-prospective-analysis` only when you consent to local ephemeral,
allowlisted prompt-size features.
