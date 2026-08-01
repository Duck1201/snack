# Release artifact evidence

Artifact evidence gate: passed

Written by `npm run release:evidence` from measurement, never by hand. PLAN.md delivery principle
9 is that a release advances on reproducible technical evidence rather than on an assertion, and a
checksum somebody typed is an assertion.

CLI `1.0.0`, OpenCode plugin `1.0.0`.

## Tarball checksums

Compare these against what the registry serves before moving a dist-tag. A mismatch means the
published artifact is not the one that passed the gates, and the release restarts through a new
`rc.N` rather than being patched.

| Package | Tarball | sha256 |
| --- | --- | --- |
| `@snack-ai/cli` | `snack-ai-cli-1.0.0.tgz` | `sha256:cc8c52392302d5c9ba044eab2914202a00fe7bed5caaeda22e87c17f3337fd6e` |
| `@snack-ai/opencode` | `snack-ai-opencode-1.0.0.tgz` | `sha256:fd9790874869f15a132e1c140933e1641e80fb8dd0f413dbdd8ac2d78a16a594` |

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
| `@snack-ai/cli` | 50 | `sha256:7a0638d37eb6d263efa901b27969c7eb82917544ebd4908b781d73b116c4bc04` |
| `@snack-ai/opencode` | 1 | `sha256:4c97fb6000831c04adb28f2742796097a8dbe5ad06c491d28bc9da996b879277` |
