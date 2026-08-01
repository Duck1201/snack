# Release artifact evidence

Artifact evidence gate: passed

Written by `npm run release:evidence` from measurement, never by hand. PLAN.md delivery principle
9 is that a release advances on reproducible technical evidence rather than on an assertion, and a
checksum somebody typed is an assertion.

CLI `1.0.0-rc.0`, OpenCode plugin `1.0.0-rc.0`.

## Tarball checksums

Compare these against what the registry serves before moving a dist-tag. A mismatch means the
published artifact is not the one that passed the gates, and the release restarts through a new
`rc.N` rather than being patched.

| Package | Tarball | sha256 |
| --- | --- | --- |
| `@snack-ai/cli` | `snack-ai-cli-1.0.0-rc.0.tgz` | `sha256:b751ec5aa2362dd66efdb96570313c11b7a57cb3f2d82099624a403ddf0af3c3` |
| `@snack-ai/opencode` | `snack-ai-opencode-1.0.0-rc.0.tgz` | `sha256:789ef7ee78e0bb67143d492a5b9a00eaccec861c9ab7da2baeb7259bc010f0fe` |

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
| `@snack-ai/cli` | 50 | `sha256:707634435c79ebcc255ae0ded9600c5a8411dbbd5ed5d835e4c7f2be0da912fb` |
| `@snack-ai/opencode` | 1 | `sha256:f3db3dcfaba1d23560ec5c8312ed394a268f846e800895d9db14879d0f20f876` |
