# @snack-ai/opencode

Live metadata capture for [SNACK](https://github.com/Duck1201/snack), an OpenCode plugin that
records what happened to each prompt — never what was in it.

## You do not install this yourself

This package is registered in OpenCode's own configuration by the SNACK CLI:

```bash
npm install -g @snack-ai/cli
snack setup opencode --install-plugin
```

Setup shows the exact configuration change before making it, keeps a backup, and does nothing until
you confirm. `snack doctor` afterwards reports whether the registration is one SNACK can read.

SNACK works without this plugin: it can read OpenCode's own database directly. The plugin adds what
a database read cannot give you — outcomes observed as they happen, including restrictions that
leave no durable trace, and optional prompt-size features that are computed and discarded rather
than stored.

## What it writes

One line of JSON per event, appended to a private spool directory that setup configured, under a
versioned schema (`spool-event-v1`) that both packages ship a byte-identical copy of. Every field is
metadata:

- which prompt and session it belongs to, by identifier;
- the provider and model, and when it happened;
- how it ended: completed, cancelled, an operational error, or an observed restriction and its
  class;
- token counts and cost as the provider reported them.

There is no field for prompt text or response text, and the schema refuses unknown fields outright.

With `--enable-prospective-analysis`, each prompt additionally carries a few non-semantic shape
features: an estimated token count, a bucketed line count, a bucketed count of fenced code blocks,
and how many files were attached. They are derived in memory from text the plugin never writes down.

## What it will not do

**It will not break OpenCode.** Capture failures are swallowed, never thrown into the host, and
never allowed to block a prompt. If the spool cannot be written, the plugin warns at most once a
minute and OpenCode carries on as though it were not installed.

**It will not read what it does not need.** It never opens SQLite, never imports the SNACK CLI, and
never touches OpenCode's credentials. It writes to its own spool directory and nowhere else.

**It will not guess.** An event that does not validate against the shipped schema is dropped rather
than partially interpreted, because a canonical record built from a shape SNACK does not recognize
would carry an invented meaning downstream.

## Compatibility

Requires Node.js 24 and a `@snack-ai/cli` that accepts `spool-event-v1`. Every `0.1.x` of this
plugin emits that contract, so a CLI on the MVP line reads any of them; `snack doctor` reports a
registration pinned at a different `0.1.x` as outdated rather than incompatible, and re-running
`snack setup opencode --install-plugin` updates the pin.

Apache-2.0. Security reports go through the private channel described in
[SECURITY.md](https://github.com/Duck1201/snack/blob/main/SECURITY.md).
