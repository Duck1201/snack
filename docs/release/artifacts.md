# Release artifact evidence

Artifact evidence gate: passed

Written by `npm run release:evidence` from measurement, never by hand. PLAN.md delivery principle
9 is that a release advances on reproducible technical evidence rather than on an assertion, and a
checksum somebody typed is an assertion.

CLI `1.0.2`, OpenCode plugin `1.0.1`.

## Tarball checksums

Compare these against what the registry serves before moving a dist-tag. A mismatch means the
published artifact is not the one that passed the gates, and the release restarts through a new
`rc.N` rather than being patched.

| Package | Tarball | sha256 |
| --- | --- | --- |
| `@snack-ai/cli` | `snack-ai-cli-1.0.2.tgz` | `sha256:be4c0dd88c4fb0926c13a1bee93d650b1eb1b11e38d02e51febc331c9ce48cf1` |
| `@snack-ai/opencode` | `snack-ai-opencode-1.0.1.tgz` | `sha256:96fbaa4299ad7381d60937b4f878c19af81914720a9d7b0e1d3aa0501fe61546` |

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
| `@snack-ai/cli` | 50 | `sha256:467e75082c326d9b07ee602a55dd6d45896ea31706b1ee3ac3d5253894c2b5fa` |
| `@snack-ai/opencode` | 1 | `sha256:6923815727c1fecc6c1198e6d4480dcc8c2cc1268f3ac01cc62ddd44e736498b` |
