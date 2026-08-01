# @snack-ai/opencode

Live metadata capture for [SNACK](https://github.com/Duck1201/snack) — an OpenCode plugin that
records what happened to each prompt, and never what was in it.

Em português: [README.pt-BR.md](./README.pt-BR.md).

## The friendly version

OpenCode already writes down what you did. This plugin watches it happen instead of reading about it
afterwards.

That difference matters more than it sounds. Some things simply do not survive to disk — a prompt
the provider refuses outright can leave no durable trace in OpenCode's own database, and a refusal
SNACK cannot see is a refusal it cannot learn from. The plugin catches those as they happen.

It is deliberately tiny. It appends one line of JSON per event to a private file and gets out of the
way. It never opens a database, never imports the SNACK CLI, never phones anywhere, and never —
under any failure — gets between you and your prompt.

## You do not install this yourself

The SNACK CLI registers it in OpenCode's own configuration for you:

```bash
npm install -g @snack-ai/cli
snack setup opencode --install-plugin
```

Setup shows the exact configuration change before making it, keeps a backup, and does nothing until
you confirm. `snack doctor` afterwards tells you whether the registration is one SNACK can read.

**SNACK works fine without it.** The CLI can read OpenCode's database directly, and that is the
default. The plugin is the upgrade: outcomes observed live, including the refusals that leave no
trace, and optional prompt-size features that are computed in memory and thrown away.

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
minute and OpenCode carries on exactly as if it were not installed. This is not best-effort
politeness; it is the plugin's first design constraint, and it is tested by faulting the write path
and asserting the host never sees an exception.

**It will not read what it does not need.** It never opens SQLite, never imports the SNACK CLI, and
never touches OpenCode's credentials. It writes to its own spool directory and nowhere else.

**It will not guess.** An event that does not validate against the shipped schema is dropped rather
than partially interpreted, because a canonical record built from a shape SNACK does not recognize
would carry an invented meaning downstream for as long as it lived.

---

## Under the hood

#### The spool

Events are appended as NDJSON to segment files with `0600` permissions in a `0700` directory. Append
is the only write operation; nothing is ever rewritten in place, which is what makes a crash
mid-write recoverable rather than corrupting.

A line cut short by a crash is exactly what truncation recovery expects: the reader validates each
line, discards the incomplete one with a sanitized diagnostic, and keeps everything before it. The
count of refused records surfaces in `snack sync` as `rejected_invalid` rather than disappearing.

Segments are removed only after **every configured source has committed past them**. A cursor that
advanced without its transaction committing would silently drop history, so cursors move only inside
the committing transaction.

#### Reconciliation with backfill

The plugin and the database reader will both see most prompts. That is the intended arrangement, not
a bug to avoid, and SNACK reconciles the two into one canonical record by stable identity, revision
domain, and finality — never by trusting whichever arrived first.

Restrictions are unioned across both paths: a refusal seen by either observer counts. Conflicting
final revisions that cannot be ordered are excluded rather than resolved by guesswork. Property
tests assert convergence under duplicates, reordering, and gaps, because "eventually consistent"
without a proof is just hope.

#### Content-free by construction

The schema has no field that could carry prompt or response text, so leakage is a schema violation
rather than a policy failure. The privacy canaries are shared byte-identically between both packages
and driven through the capture path in tests; a canary reaching any written byte fails the build.

The provider's own error **code** is stored on purpose — it is what distinguishes a rate limit from
a timeout, and classifying that difference correctly is the entire reason SNACK does not treat your
flaky Wi-Fi as a quota event. The error _message_ is not stored.

## Compatibility

Requires Node.js 24 and a `@snack-ai/cli` that accepts `spool-event-v1`. Event `schema_version` is
`1` and has been stable since the plugin's first release, so a current CLI reads any published
version of this plugin. `snack doctor` reports a registration pinned at an older version as outdated
rather than incompatible, and re-running `snack setup opencode --install-plugin` updates the pin.

Apache-2.0. Security reports go through the private channel in
[SECURITY.md](https://github.com/Duck1201/snack/blob/main/SECURITY.md).
