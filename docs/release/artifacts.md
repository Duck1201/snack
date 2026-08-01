# Release artifact evidence

Artifact evidence gate: passed

Written by `npm run release:evidence` from measurement, never by hand. PLAN.md delivery principle
9 is that a release advances on reproducible technical evidence rather than on an assertion, and a
checksum somebody typed is an assertion.

CLI `0.9.0`, OpenCode plugin `0.1.3`.

## Tarball checksums

Compare these against what the registry serves before moving a dist-tag. A mismatch means the
published artifact is not the one that passed the gates, and the release restarts through a new
`rc.N` rather than being patched.

| Package | Tarball | sha256 |
| --- | --- | --- |
| `@snack-ai/cli` | `snack-ai-cli-0.9.0.tgz` | `sha256:f3f686c450957ce1de2180925a5efbac4a3d3979591f26b8da26fe260ca9aa7c` |
| `@snack-ai/opencode` | `snack-ai-opencode-0.1.3.tgz` | `sha256:0f3b20143e884a842f69bd03377b98065c9d46bdcdfc98ea76ee6e4dd2e85976` |

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
| `@snack-ai/cli` | 50 | `sha256:d024d33130a61bd1864420a511e56ac1d0226d58b58a1c0bb55463ea8f4e4988` |
| `@snack-ai/opencode` | 1 | `sha256:c54155a657ccd4c454a6435240bd3ac3639d33e2da971580d835e44fe102ea2d` |
