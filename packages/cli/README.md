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
`1.17.19`, `1.17.20`, `1.18.1`, and `1.18.9`; `1.18.10` additionally supports live capture.
Compatibility is determined by structural and JSON fingerprints, not by version strings; unknown
shapes fail closed before canonical writes.

## Getting started

Requires Node.js 24. Pre-MVP releases publish to the `next` tag:

```bash
npm install -g @snack-ai/cli@next
```

Setup is non-interactive in this release, so every value is an explicit flag:

```bash
snack setup opencode --non-interactive \
  --source work --provider anthropic --profile default --plan pro \
  --install-plugin --yes
```

- `--source` names the capacity source in SNACK; `--provider` and `--profile` say which provider
  account it maps to. Run without `--install-plugin` to configure backfill only.
- `--plan` records what you call your plan. It is a label, not a lookup key.
- `--plan-profile` selects the prior SNACK starts from, and defaults to `generic`.
- `--install-plugin` registers `@snack-ai/opencode` in the global OpenCode configuration and needs
  `--yes` to confirm; `--dry-run` shows the proposal and changes nothing.
- `--enable-prospective-analysis` is opt-in, and only enables local ephemeral, allowlisted
  prompt-size features.

Then `snack doctor` to check the installation, `snack sync` to import history, and `snack status` to
assess the next prompt.
