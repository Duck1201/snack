# Release artifact evidence

Artifact evidence gate: passed

Written by `npm run release:evidence` from measurement, never by hand. PLAN.md delivery principle
9 is that a release advances on reproducible technical evidence rather than on an assertion, and a
checksum somebody typed is an assertion.

CLI `1.1.3`, OpenCode plugin `1.0.2`.

## Tarball checksums

Compare these against what the registry serves before moving a dist-tag. A mismatch means the
published artifact is not the one that passed the gates, and the release restarts through a new
`rc.N` rather than being patched.

| Package | Tarball | sha256 |
| --- | --- | --- |
| `@snack-ai/cli` | `snack-ai-cli-1.1.3.tgz` | `sha256:79f5d4ca9e80cb7fd978ed4679d7be96b64d5a0ce3dc7e72555e78788f64cb47` |
| `@snack-ai/opencode` | `snack-ai-opencode-1.0.2.tgz` | `sha256:90b8740c9a43e5782f0e22632c5634bcbf62a50af01cc76dae12d25534103375` |

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
| `@snack-ai/cli` | 50 | `sha256:fa890805f208aba5f5f9bec644960d8753077e1cf6748d27013861f5f725c282` |
| `@snack-ai/opencode` | 1 | `sha256:f863cff7fec8d87ad78168fab65be42e07c54ac5c934c0812f1b18ab87b7827b` |
