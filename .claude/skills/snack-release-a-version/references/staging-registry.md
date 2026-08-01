# Staging the tarballs on an isolated registry

Load this when a release has to prove its artifacts install from a registry before npm sees them —
`npm run release:staging`, or when writing something like it. `scripts/staging-registry.mjs` is the
working implementation; this is why it looks the way it does.

## Why a registry at all

`pack:smoke` installs a tarball **by file path**. That proves the package's contents. It cannot
prove the part only a registry has: that the manifest resolves, that declared dependencies are
fetched rather than assumed present, and that `npm install <name>@<version>` reaches the artifact at
all.

Verdaccio is fetched by `npx` for the run. Nothing is added to the repository's dependencies — a
staging registry runs twice a year, and pinning a server into the lockfile buys reproducibility of
the thing least likely to be the problem.

Uplinks are disabled, which is what "isolated" means: a package the registry cannot serve fails here
instead of being fetched from npmjs.org and quietly passing.

## The four traps, each of which cost one run

**1. `npm publish` demands a token even when the registry allows anonymous publish.**

```
npm error code ENEEDAUTH
npm error need auth This command requires you to be logged in to http://localhost:4873/
```

The check is client-side, raised before any request. Verdaccio configured with `publish: $all` never
looks at the token. So write a throwaway userconfig with a dummy one and pass `--userconfig`:

```
//localhost:<port>/:_authToken=staging
```

No account, no interactive `npm adduser`.

**2. `publishConfig.provenance: true` breaks a local publish.**

```
npm error code EUSAGE
npm error Automatic provenance generation not supported for provider: null
```

Both packages set it, correctly, for npmjs.org. Provenance is a signed statement about a CI run and
there is no provider to sign it here. Pass `--provenance=false` for the staging publish only. The
tarball is byte-identical either way — the attestation is generated at publish time and never enters
the archive.

**3. Killing the `npx` handle leaves verdaccio running.**

`spawn("npx", ["--yes", "verdaccio@6", ...])` makes npx the child and verdaccio its *grand*child.
`child.kill()` reaps npx and orphans the server, which keeps holding its port and serving a storage
directory the `finally` block has already deleted. The next run then fails with a message that
describes nothing that is true:

```
npm error 400 Bad Request - PUT http://localhost:4873/@snack-ai%2fcli
  - Cannot find module '../encodings'
```

That is iconv-lite inside a deleted `node_modules`, reached through a stale process. Spawn with
`detached: true` and signal the group: `process.kill(-child.pid, "SIGTERM")`.

**4. A hardcoded port lets trap 3 poison the next run.**

Verdaccio's default 4873 means a leftover server answers the readiness probe and the run proceeds
against the wrong process. Bind an OS-assigned port (`server.listen(0)`, read `address().port`,
close) and use that. With a fresh port each run, a stale server is invisible instead of
authoritative.

## Readiness

Poll `npm ping --registry <url>` rather than a raw HTTP request. It is the same client the publish
and the install use, so a registry that answers a socket but not npm is correctly still "not ready".
Poll rather than sleep: `npx` may spend a minute fetching verdaccio the first time and no time at
all afterwards.

## What the gate actually asserts

1. Both tarballs publish into the isolated registry.
2. The CLI installs **by name and version** from it, over a database a real floor release created.
3. `doctor` reports no failing check.
4. `npm pack <name>@<version> --registry <url>` returns a tarball whose sha256 equals the staged
   one.

Step 4 is the point. If the registry serves different bytes than were staged, the artifact that
passed the gates is not the artifact a consumer downloads, and there is nothing left to reason
about.

## Cleanup

Tear down in a `finally`, always: signal the process group, then remove the temp directory. Verify
after a run that nothing survived — `pgrep -c verdaccio` should answer 0 and no `snack-staging-*`
directory should remain. Trap 3 is invisible until the _next_ run, so checking at the end of this
one is the only cheap way to catch it.
