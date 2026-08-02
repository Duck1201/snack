# Release artifact evidence

Artifact evidence gate: passed

Written by `npm run release:evidence` from measurement, never by hand. PLAN.md delivery principle
9 is that a release advances on reproducible technical evidence rather than on an assertion, and a
checksum somebody typed is an assertion.

CLI `1.2.0`, OpenCode plugin `1.0.3`.

## Tarball checksums

Compare these against what the registry serves before moving a dist-tag. A mismatch means the
published artifact is not the one that passed the gates, and the release restarts through a new
`rc.N` rather than being patched.

| Package | Tarball | sha256 |
| --- | --- | --- |
| `@snack-ai/cli` | `snack-ai-cli-1.2.0.tgz` | `sha256:e65fcdc0f7497998009fa9ee219a44a18ef9f08f03cd048e30dcc189e10b7c95` |
| `@snack-ai/opencode` | `snack-ai-opencode-1.0.3.tgz` | `sha256:167f4f84162d4c4da6842b760e0d376ba71124626d45e14656a7ce881e583a2a` |

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
| `@snack-ai/cli` | 50 | `sha256:8bb93dab9a16fe4a4c7a0f131151e29f05019dd4d01cad871aeb2a64213b9d1f` |
| `@snack-ai/opencode` | 1 | `sha256:5b4cf899a92575962c3b4a1c1f4b733a9cddf6848177c785cb6d35516fb4b939` |
