# `snack update`

Status: **built and verified against the real binary.** Target `1.1.0`. Decisions below were taken
before any code; the implementation is a separate session.

Governed by [ADR-0010](../../docs/adr/0010-snack-update-may-reach-the-network.md), which is the
prerequisite and is already accepted: this is the only command in the product permitted to make a
network request.

## What it is for

Bringing a `0.8.2` installation to `1.0.1` during Phase 1 is the whole case, and it is worth stating
as a sequence because every step is a place to get it wrong:

1. read `~/.config/snack/config.jsonc` to recover the alias, provider, profile, plan and plan
   profile of each source;
2. rebuild a `setup` invocation repeating all five **exactly** — any field typed differently starts
   a new capacity period and retires that source's accumulated evidence from every forecast;
3. remember that `--enable-prospective-analysis` is not implied by the existing configuration and
   must be passed again;
4. `npm i -g` for the CLI, then a separate `setup --install-plugin` for the plugin.

Every value in steps 1–3 is already known to the program. The risk in step 2 is silent and
permanent, and it lands on the person least equipped to see it coming.

## The decision that makes this simple

**The plugin re-registration must not go through `setup`.**

`setup` calls `ensureCapacityPeriod`, which rotates the period whenever provider, profile, plan or
plan profile differs from the open one. That is correct for `setup` and catastrophic for `update`:
an upgrade is not a change of capacity regime, and rotating on one would retire the user's evidence
for doing the thing the product told them to do.

Re-registering the plugin needs none of it. It is: read the SNACK config → build the bindings →
write the OpenCode registration. The helpers already exist and none of them touches a capacity
period:

- `preparePluginRegistration(configFile, {installation_id, spool_directory, prospective_analysis, source_bindings})`
  — `packages/cli/src/opencode-config.js:85`
- `writePluginRegistration(configFile, content, expectedContent)` — same file, line 155
- `pluginBindings(sources, installationId, paths)` — `packages/cli/src/main.js:1214`, already
  handles the ambiguous case by emitting no binding when two sources share a provider on one
  installation

So the roadmap's exit criterion — "`snack update` never rotates a capacity period it was not asked
to" — is satisfied **structurally**, by not calling the code that could. That is worth preferring
over satisfying it by care, and the test should assert the period is untouched rather than assert
the call was not made.

## Shape

```
snack update [--yes] [--json] [--dry-run]
snack update --finish            # internal; see "The two-process problem"
```

### The two-process problem

After the CLI is installed, the process that is still running is the **old** version, and it only
knows the old `pluginPackageSpec`. Registering the plugin from it would write the version being
replaced — the exact defect
[finding 09](../end-to-end-review/issues/09-cli-1.0.0-installs-plugin-0.1.2-and-calls-1.0.0-outdated.md)
was, arriving by a new road.

**Decision: install, then re-exec the newly installed binary with `--finish`.**

The install overwrites the package in place, so the bin path the process was launched from now
resolves to the new code. `--finish` does only the plugin re-registration, using the new build's own
pin.

Rejected alternatives, and why:

- **Two explicit steps** (`update`, then `update --plugin`): impossible to use the wrong pin and no
  path resolution at all, but it leaves the user running two commands — which is half the problem
  that motivated the command.
- **Register before installing**: one step, but if the install then fails, the configuration names a
  plugin that is not on disk and live capture stops. A failure must never leave the pair worse than
  it found it.

`--finish` is documented as internal. It is not in the README's command table and does not appear in
`snack --help` output for a user; it exists because a process cannot become a different version of
itself.

### Detecting how the CLI was installed

Getting this wrong installs into the wrong place silently, so it is **detected and then confirmed**,
never assumed.

Detection is a pure function of the running module's path, the working directory, and the
environment — which makes it a unit-testable seam with no filesystem in it:

```js
resolveUpdatePlan({ modulePath, cwd, env }) -> {
  manager: "npm" | "pnpm" | "bun" | "yarn",
  scope: "global" | "local",
  command: string,          // exactly what will run, for display
  args: string[],
}
```

Signals, from the nearest `node_modules` ancestor of `modulePath`:

| Layout                                    | Manager                              | Scope  |
| ----------------------------------------- | ------------------------------------ | ------ |
| `<prefix>/lib/node_modules/@snack-ai/cli` | npm                                  | global |
| `.../pnpm/global/<n>/node_modules/…`      | pnpm                                 | global |
| `~/.bun/install/global/node_modules/…`    | bun                                  | global |
| a `node_modules` inside `cwd`             | detected from the lockfile beside it | local  |

**An unrecognized layout refuses rather than guessing** — the same fail-closed rule the ingestion
side already follows. A refusal names the resolved path and tells the user the command to run by
hand, which is strictly better than installing somewhere they did not expect.

The resolved command is printed and confirmed before anything runs. `--yes` skips the prompt for
automation; `--dry-run` prints and exits.

### Failure

An install that fails leaves the installation exactly as it was. The plugin registration is written
only after the install reports success, and `--finish` runs in the new process — so a failed install
means nothing was rewritten, and the user still has a working, older, matched pair.

ADR-0010 requires the failure to read as what it is: offline, proxy, registry outage, private
mirror. It must not surface as an internal error, and it must not surface as a SNACK defect.

## Test plan, and the seams

Agreed before writing tests, per the project's rule.

| Seam                                         | What it covers                                                                                                                   |
| -------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| `resolveUpdatePlan(...)` — pure              | every layout in the table, plus an unrecognized one that refuses. No filesystem, no network                                      |
| `run(argv, options)` with `makeRunFixture()` | `--dry-run` prints the command and changes nothing; `--yes` skips the prompt; a refused confirmation writes nothing              |
| `run(...)` with an injected installer        | `--finish` rewrites the plugin registration to the current pin, and **the capacity periods are byte-identical before and after** |
| the real binary                              | driven; see below                                                                                                                |

The installer is injected the way `writeConfig` and `prompt` already are, so no test runs a package
manager.

### The real binary, run

Packed the CLI, `npm install -g` into a temp prefix, and drove the installed `snack` through the bin
symlink with an isolated `XDG_*` and `HOME`. The suite cannot reach any of this: it injects
`modulePath`, and the question here is whether the _real_ one lands where the layout table says.

| Checked                                         | Result                                                                                                     |
| ----------------------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| Where a global install actually puts the module | `<prefix>/lib/node_modules/@snack-ai/cli/src/update.js` — the npm row                                      |
| Whether the bin symlink hides it                | It does not. Node resolves the symlink, so `import.meta.url` is the real path and the layout still matches |
| `update --dry-run`                              | `Would run: npm install --global @snack-ai/cli@latest`, exit 0, nothing installed                          |
| `update` with no TTY and no `--yes`             | Refuses, exit 2, and names the command it would have run                                                   |
| `--finish` in `--help`                          | Absent                                                                                                     |
| `--finish` with nothing registered              | Writes nothing; no `opencode.json` is created                                                              |
| `--finish` over a registration stood on `0.8.2` | Rewritten to `@snack-ai/opencode@1.0.1`; `doctor` then reports `[pass] opencode_plugin`                    |
| Capacity periods across that `--finish`         | Byte-identical                                                                                             |
| Permissions on everything written               | All `0600`                                                                                                 |

The one path deliberately not driven is a real `update --yes`, which would install the published
`1.0.2` over the candidate from the public registry. The install itself is one `spawn` behind an
injected port; what could only be learned here was the layout, and it was.

## The boundary gate ADR-0010 asks for

The ADR states it plainly: until now "no command opens a socket" was true structurally, and this
release makes it a property that has to be proven.

**Every command other than `update` must run with network access denied**, and the test should fail
loudly if a future change reaches for a socket from `sync`, `status`, `doctor`, `export` or anything
else. This is the one piece of the release that protects a product boundary rather than adding a
feature, and it should land in the same PR as the command.

**Correction, from planning.** This document originally said Node 24 could enforce the denial
in-process. It cannot: the permission model covers `fs`, `child_process`, `worker`, `wasi` and
`addons`, and there is no `--allow-net`. Verified against the runtime this project pins:

```console
$ node --help | grep -c allow-net
0
```

The gate is therefore a **test-level denial**: a `denyNetwork()` helper in `run-fixture.js` replaces
`net.connect`, `net.Socket.prototype.connect`, `tls.connect`, `dns.lookup`, `dns.promises.*`,
`http.request`, `https.request` and `globalThis.fetch` with throwing stubs, and a
`network-boundary.test.js` drives every command under it.

Its limit belongs in a comment beside it rather than in a release note: this proves the paths the
test exercises, not the paths it does not. The upgrade, when it is worth the cost, is a static walk
of the import graph from `cli.js` that fails when any module outside `update.js` imports a
networking builtin — which catches unexecuted code but not a dependency that opens a socket. Neither
is complete alone, and the runtime one is the one that would have caught the defect this gate exists
for.

## Documentation this must carry

Delivery principle 11, and ADR-0010 names the specific problem: a blanket "SNACK makes no network
calls" is currently true and becomes false as written.

Each becomes the stronger, checkable claim rather than a blanket one:

> No command that touches your data touches the network. `snack update` installs packages and
> carries nothing about your usage.

**Correction, from planning.** ADR-0010 says the sentence is in three READMEs. It is in two, and the
exact lines are worth naming so nobody rewrites a sentence that is still true:

- `README.md:60` — "It makes no network calls, sends no telemetry, and reads no credentials"; PT at
  `:197`;
- `packages/cli/README.md:21` — "It never sends anything anywhere"; PT at `:321`;
- `packages/opencode/README.md` makes **no** network claim, and the plugin still makes no network
  call. Leave it alone.

Also `docs/specification.md:165` ("never update over the network at runtime") and `:640` (the
runtime-network paragraph). Not `:244` — "uses no model or network call" is about the prediction
method and stays true.

Plus the command table in each README and `docs/compatibility.md`, in English and Portuguese.

`PLAN.md`'s boundary lists were already qualified when ADR-0010 was accepted.

## Order within `1.1.0`

Three PRs, one release, in this order:

1. **`snack update`** — this document, plus the network gate;
2. **Interface** — colour through `util.styleText`, one panel per capacity source, the
   usage-pressure sparkline. `--json` bytes unchanged from `1.0.x` for the same input;
3. **Documentation restructure** and the roadmap.

The two remaining Phase 1 P3s ride along:
[04](../end-to-end-review/issues/04-applied-setup-reports-under-a-dry-run-key.md) — emit `applied`
on an applied setup, since the rename it really wants breaks a frozen payload and needs a major —
and
[12](../end-to-end-review/issues/12-two-setups-in-the-same-millisecond-are-an-internal-error.md),
which needs a table rebuild and should use the `sqlite-constraint-migrations` skill.

## What is decided, and what is not

Decided: re-exec over two steps; detect-and-confirm over assume; three PRs and one release; the
plugin path avoids `setup` entirely.

### Decided in the planning session that followed

- **The full manager table ships.** npm, pnpm, bun and yarn × global and local, as written above.
  Only npm-global is exercisable on the machine this was planned on; the rest are covered by path
  fixtures against the pure seam, which is the whole reason `resolveUpdatePlan` has no filesystem in
  it. An unrecognized layout still refuses.
- **A refusal exits `unavailable` (4)**, not `config` (3). An install layout nobody recognizes is a
  property of the environment, not of something the user wrote in `config.jsonc`, and a failed
  install — offline, proxy, registry outage — lands on the same code for the same reason.
- **`--finish` is hidden from `--help`**, which means the frozen command-surface contract test
  (`packages/cli/test/contracts.test.js:450`) cannot see it, because that test reads the help text
  rather than Commander's object graph. That is the right behaviour and it leaves the flag ungated,
  so a test asserting `--finish` is absent from the help output has to be written on purpose.
- **Finding 12 rides along;
  [finding 04](../end-to-end-review/issues/04-applied-setup-reports-under-a-dry-run-key.md) does
  not.** 1.1.0 already carries three fronts.

### The interface, no longer undecided

The direction was "one panel per capacity source". The layout chosen is an aligned label column and
**no box drawing** — it survives a narrow terminal, a pipe, and a captured log, none of which a box
does:

```
work
  viability  95-100%  risk low        evidence moderate
  pressure   high ▁▂▃▅▆▇█▇▆           category typical
  method     bayesian-pressure-band@1
  as of      40s ago · sync ok · period since 2026-01-02
  ! Real provider capacity is unknown.
```

The sparkline reuses `pressure.trend.scores[]`, which `computeUsageTrend` already produces
(`packages/cli/src/analytics.js:240-296`) and caps at five windows. The longer series — the ~31
buckets `computeSourcePressure` already fetches in one query and then discards — was considered and
declined: it costs a `computeUsagePressure` call per bucket against a 250 ms budget, to draw a wider
picture of a number the product deliberately refuses to make look precise.

**Open, and to settle before writing the renderer:** the roadmap's exit criterion says "`--json`
bytes unchanged from `1.0.x` for the same input", and asking `status` for the trend puts a `trend`
key inside the `pressure` payload. The plan's assumption is that the trend is computed for rendering
and dropped before the envelope. Accepting it as an additive field instead is legitimate under
SemVer and would need the criterion amended rather than quietly missed.
