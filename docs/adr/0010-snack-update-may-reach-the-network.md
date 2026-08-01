---
status: accepted
---

# `snack update` may reach the network; nothing else may

`snack update` installs `@snack-ai/cli` and `@snack-ai/opencode`, then re-registers the capture
plugin using the values already in the local configuration. It is the only command in the product
permitted to make a network request, and it carries nothing about the user's usage in either
direction.

Every other command stays local-only, unchanged and unqualified: ingestion, storage, analysis,
prediction, `doctor`, `export`, `stats`, `status`, `sync`, `setup`, `config`, `data purge`. None of
them gains a "check for updates" path, an availability probe, or a version ping. A command that
observes, stores, analyzes or reports never opens a socket.

## What this changes

Two written boundaries, both in `PLAN.md`:

- "collect metadata only and remain local-only", one of the things SNACK **will** do;
- "`snack setup …` configure capacity sources and register capture integrations with explicit
  confirmation; **it performs no package fetch itself**".

The second sentence was written for `setup`, and it stays true of `setup`: setup still fetches
nothing, and still only writes a registration that OpenCode resolves later. What changes is that the
product now has one command for which the fetch is the entire point.

## Why the boundary moves at all

The alternative was considered first and rejected by the person who has to run it. An update command
that only *prints* the commands would have respected the boundary untouched, and it was recommended
on exactly that ground. The decision was to install.

What made the case is the Phase 1 upgrade, which is the only time anybody has performed this
sequence on a real installation. Bringing `0.8.2` to `1.0.1` required:

1. reading `~/.config/snack/config.jsonc` to recover the alias, provider, profile, plan and plan
   profile of the source being re-registered;
2. reconstructing a `setup` invocation that repeated all five **exactly**, because any field typed
   differently rotates the capacity period and retires the source's accumulated evidence from every
   forecast — the defect `1.0.1` shipped a warning for;
3. remembering that `--enable-prospective-analysis` is not implied by the existing configuration and
   has to be passed again;
4. `npm i -g` for the CLI and a separate `setup --install-plugin` for the plugin, in that order.

Every one of those five values is already known to the program. A product whose upgrade path
requires the user to transcribe its own configuration back into it has moved a real risk — silent
loss of forecast evidence — onto the person least equipped to see it coming. Printing the commands
removes the transcription but not the four-step sequence, and leaves the risk one mistyped flag
away.

## Scope, stated narrowly so it does not become a precedent

`snack update` may:

- resolve and install `@snack-ai/cli` and `@snack-ai/opencode` from the configured package registry,
  by invoking the user's own package manager rather than implementing a client;
- re-register the plugin from values already in the local configuration.

`snack update` may not:

- send anything derived from observations, prompts, usage, timings, identifiers or configuration —
  the request carries a package name and a version and nothing else;
- run implicitly. It is never invoked by another command, never on a schedule, and never as a side
  effect of `status`, `sync` or `doctor`;
- become a general capability. No other command gains network access under this decision, and a
  future one that wants it needs its own ADR rather than a reference to this one.

## Consequences

**A command can now fail for a reason outside the machine.** Offline, a proxy, a registry outage, a
private mirror. The failure has to be legible as *that* and not as a SNACK defect, and it must leave
the installation exactly as it was — a partially updated pair is worse than an outdated one, because
the compatibility matrix pairs the CLI and plugin versions.

**Privacy claims need a qualifier where they are made in prose.** "SNACK makes no network calls" was
a true sentence in three READMEs and is now false as written. Each becomes a sentence that says what
is actually true, which is a stronger claim than a blanket one nobody can verify: no command that
touches your data touches the network.

**Tests must prove the boundary, not assume it.** The existing suite has no assertion that a command
opens no socket, because until now the answer was structural. It stops being structural here, so the
gate becomes explicit: every command other than `update` runs with network access denied.

## Alternatives rejected

**Print the commands, install nothing.** Recommended, and declined. It keeps the boundary intact and
solves the transcription problem, but leaves the user running four steps in an order that matters,
which is where the evidence-loss risk actually lives.

**Re-register the plugin only, no package install.** Solves the half of the problem that has no
network in it and leaves the CLI upgrade — the half that motivated the request — untouched.

**A `--check` flag on `doctor`.** Puts a network call inside a diagnostic command that people run
when something is already wrong, which is the worst place for a new failure mode, and it spreads the
exception across two commands instead of confining it to one.
