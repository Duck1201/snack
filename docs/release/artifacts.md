# Release artifact evidence

Artifact evidence gate: passed

Written by `npm run release:evidence` from measurement, never by hand. PLAN.md delivery principle
9 is that a release advances on reproducible technical evidence rather than on an assertion, and a
checksum somebody typed is an assertion.

CLI `1.2.1`, OpenCode plugin `1.0.4`.

## Tarball checksums

Compare these against what the registry serves before moving a dist-tag. A mismatch means the
published artifact is not the one that passed the gates, and the release restarts through a new
`rc.N` rather than being patched.

| Package | Tarball | sha256 |
| --- | --- | --- |
| `@snack-ai/cli` | `snack-ai-cli-1.2.1.tgz` | `sha256:0a117af102caab13a42592deb1e2ef31b6a83c410ea452402db65c13a76146e1` |
| `@snack-ai/opencode` | `snack-ai-opencode-1.0.4.tgz` | `sha256:f5262a87ca9372334436549a10228e4dd6c7b3ec8a0b98deba1f965722348d8f` |

## Reproducible build

Each package is packed twice, from the same source, into separate directories, and every entry
inside the two tarballs is compared by content digest. A difference names the entry rather than
reporting only that the tarballs disagree.

Result: every entry identical for both packages.

## SBOM

CycloneDX, generated with `npm sbom --package-lock-only` so the bill describes what the lockfile
declares rather than what one machine happens to have installed. The documents are under
[sbom/](./sbom/).

The digest covers the `components` array alone. A CycloneDX document carries a fresh
`serialNumber` and `timestamp` on every run, so a digest of the whole file would never reproduce
and would prove nothing about the dependencies it exists to pin.

| Package | Components | sha256 of components |
| --- | --- | --- |
| `@snack-ai/cli` | 50 | `sha256:7431686993b17e86ff8d5cf257c198a8397c1c472affa52b82e28413889b31df` |
| `@snack-ai/opencode` | 1 | `sha256:401f816bb64d04d18c1a8566eab2e0daa506bbc76190f14903c7043c9689acd0` |
