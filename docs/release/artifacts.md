# Release artifact evidence

Artifact evidence gate: passed

Written by `npm run release:evidence` from measurement, never by hand. PLAN.md delivery principle
9 is that a release advances on reproducible technical evidence rather than on an assertion, and a
checksum somebody typed is an assertion.

CLI `1.6.1`, OpenCode plugin `1.0.5`.

## Tarball checksums

Compare these against what the registry serves before moving a dist-tag. A mismatch means the
published artifact is not the one that passed the gates, and the release restarts through a new
`rc.N` rather than being patched.

| Package | Tarball | sha256 |
| --- | --- | --- |
| `@snack-ai/cli` | `snack-ai-cli-1.6.1.tgz` | `sha256:0631056fcd1428c9fbda0fa40f4d93d5718d272a282362b1c364f74a287b709d` |
| `@snack-ai/opencode` | `snack-ai-opencode-1.0.5.tgz` | `sha256:f1cddb915da3703da8d38b19d86109e92e3890dbf237468d761820717e7c0aed` |

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
| `@snack-ai/cli` | 50 | `sha256:7bdd0816d0cd4c2068f5c575c12dc403422912ecfc93b6a6ae47ddf3c0ee4fa2` |
| `@snack-ai/opencode` | 1 | `sha256:650ea14bc4d4058f54ce51d7b7f857ee300fa5f67ebf3a9ff3d222d5d79e80aa` |
