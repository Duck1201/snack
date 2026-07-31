# Native SQLite Distribution

SNACK's only native dependency is `better-sqlite3`, pinned to the exact version `12.6.2` in
`packages/cli/package.json`. This file records what a user's `npm install` actually resolves on the
supported matrix, because a native addon that silently compiles from source is a supported-platform
failure even when the resulting binary works.

Status as of 2026-07-31, for `better-sqlite3@12.6.2` on Node.js 24 (`NODE_MODULE_VERSION` 137).

## How the binding is obtained

The dependency's install script is `prebuild-install || node-gyp rebuild --release`. The intended
path downloads a published binary; the fallback compiles locally and requires a C++ toolchain and
Python on the user's machine. Both paths end at
`node_modules/better-sqlite3/build/Release/better_sqlite3.node`, so the two are distinguished by
what else the build directory holds: a compile also leaves `Makefile`, `config.gypi`, and
`Release/obj.target`.

`npm run pack:smoke` asserts that the build directory of a clean install from the packed tarball
contains exactly `Release/better_sqlite3.node` and nothing else. On any platform whose prebuild is
missing, the smoke run fails instead of quietly shipping a source build.

## Published prebuilds for Node ABI 137

Assets attached to
[`WiseLibs/better-sqlite3` release `v12.6.2`](https://github.com/WiseLibs/better-sqlite3/releases/tag/v12.6.2)
(published 2026-01-16), filtered to `node-v137`:

| Asset | Size | SHA-256 |
| --- | --- | --- |
| `node-v137-darwin-arm64` | 961686 | `664a814a90450eb472f7297d1992b7dc2b512c37cabbd9a1029b3e858e7a981c` |
| `node-v137-darwin-x64` | 1006861 | `fe062db9af00cd6d49e64777bc1bb0933644ae1a10bba6d9162e83191068227a` |
| `node-v137-linux-arm` | 927658 | `d9f471881d8fdffe03f23e16f72c2ab74e35785c0fcabb2b6ff75d12b9ae8191` |
| `node-v137-linux-arm64` | 1050772 | `4e66c2c0cbe200206008a35fbcfb8a893aa475df223a1100ccc50d6dd2dce844` |
| `node-v137-linux-x64` | 1076008 | `3138ba6a9268b70a194b212809c12967b77ac286d65645f8fb01472464b9865b` |
| `node-v137-linuxmusl-arm` | 1013977 | `e497165b8ef89e3b94e7cd832dd1085faa6ceada6d496a51446ac1eb0c42a7f6` |
| `node-v137-linuxmusl-arm64` | 1208369 | `5b95080fe2dd7c6b293e6b06ab883745a621191c84f2596a24428e32f456edda` |
| `node-v137-linuxmusl-x64` | 1188418 | `99823652951e0a0b41a8915fdff4b987343168bb9b6449af0e0c1baaf1b1b2d6` |
| `node-v137-win32-arm64` | 895047 | `438a54b43b1fd33a2bff584f9ae18cce9b588018dd25618b06d0b86e4f072106` |
| `node-v137-win32-x64` | 1028351 | `697a0e0cf5068742b6ef01c6c91b6dd7e3a838822ab037e6d6f5cd7508f3ac3e` |

Every platform SNACK supports is covered: Linux x64/arm64 on glibc and musl, macOS x64/arm64, and
WSL2, which resolves the Linux asset for its architecture. Windows assets exist but SNACK does not
support running natively on Windows; the supported Windows path is WSL2.

## glibc floor on Linux

The `linux-x64` prebuild links `libstdc++.so.6`, `libm.so.6`, `libpthread.so.0`, and `libc.so.6`,
and its highest versioned symbol requirement is `GLIBC_2.29`. Distributions older than that — for
example Debian 9 or Ubuntu 18.04 — cannot load the prebuild and fall back to a source compile.
Debian 11+, Ubuntu 20.04+, and the WSL2 Debian 13 image used in CI are all above the floor. Alpine
and other musl systems use the separate `linuxmusl` assets and are unaffected by this number.

## Verified installs

| Platform | Node / npm | Evidence |
| --- | --- | --- |
| Debian 13, x64 | `24.18.1` / `11.16.0` | Local clean install from the packed tarball on 2026-07-31 downloaded the prebuild; the build directory held only `Release/better_sqlite3.node` |
| ubuntu-latest, x64 | `24.18.1` / `11.16.0` | CI `quality` job runs `npm run pack:smoke` |
| macos-latest, arm64 | `24.18.1` / `11.16.0` | CI `quality` job runs `npm run pack:smoke` |
| Debian 13 on WSL2, x64 | `24.18.1` / `11.16.0` | CI `wsl-smoke` job; results recorded in [platform-smoke.md](./platform-smoke.md) |

## Known limitations

- `prebuild-install` downloads over HTTPS from GitHub and does not verify the asset against a
  checksum recorded in this repository. The table above exists so a suspicious download can be
  compared by hand; automating that comparison would mean owning the download step.
- `prebuild-install@7.1.3` is marked deprecated by its author. It remains functional and is a
  transitive dependency of `better-sqlite3`; replacing it is upstream's decision, not SNACK's.
- Installing the CLI with `--ignore-scripts` produces a package with no binding at all. That is the
  documented cost of a native dependency. Verified on 2026-07-31 by removing the binding from an
  installed prefix: `snack doctor` reports `[fail] storage: Storage is invalid or inaccessible.`
  and exits `5`, and `snack status` reports `Storage initialization failed.` — neither leaks a
  native stack trace.
