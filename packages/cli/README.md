# @snack-ai/cli

**Know before you feed the model.** SNACK reads your local AI-tool history, describes how you have
actually been using it, and estimates whether your next prompt is likely to complete without hitting
a restriction.

It runs entirely on your machine. No account, no telemetry, no network client, no service behind it.

```bash
npm install -g @snack-ai/cli
snack setup opencode   # guided: finds your OpenCode database, asks only what it cannot observe
snack status
```

```text
work: 86-97% viability; risk low; evidence moderate; method bayesian-pressure-band@1;
period 2026-07-24T09:12:03.000Z; pressure elevated; contributors output_tokens 88th, prompts 71st;
category typical; as_of 2026-07-31T10:41:55.000Z; sync ok.
Caveat: Real provider capacity is unknown.
```

Requires Node.js 24, on Linux, macOS, or Windows through WSL2. The `0.6` line is the MVP and
supports OpenCode; Claude Code follows in `0.7`.

## What it will not tell you

SNACK does not know your provider's real quota, and nothing in it pretends otherwise. You will never
see a percentage of quota, a balance, or a count of prompts remaining, because those would be
fabrications dressed as measurements.

What you get instead is an estimate with its uncertainty attached: an interval, an evidence level
that says how much local history stands behind it, the named and versioned method that produced it,
and the caveats that apply. A fresh install reports `very_low` evidence and a wide interval, because
that is the truth about a fresh install.

Nothing you write is stored. Prompt text, response text, credentials, and project paths never reach
the database, the spool, the logs, an export, or an error message. That is enforced by tests that
drive canary strings through every command in both output modes and assert they appear in no byte
SNACK writes.

## The commands

| Command                | What it does                                                                                                                           |
| ---------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| `snack setup opencode` | Maps an OpenCode installation to a capacity source. Offers to register the fail-open capture plugin. Writes nothing until you confirm. |
| `snack status`         | The next-prompt assessment: viability interval, risk, evidence, usage pressure and what drove it, freshness.                           |
| `snack stats`          | What your usage actually looks like over rolling horizons, and how well past forecasts scored.                                         |
| `snack sync`           | Imports new history. `--full` re-reads and reconciles everything without duplicating it.                                               |
| `snack export`         | Streams everything to JSON or CSV with schema and provenance, so the data stays yours to read elsewhere.                               |
| `snack data purge`     | Deletes a scope you choose, transactionally, after previewing exactly what goes.                                                       |
| `snack config`         | Reads and edits local configuration.                                                                                                   |
| `snack doctor`         | Diagnoses the installation without changing it: permissions, schema fingerprints, plugin registration, storage integrity.              |

Every command takes `--json` and answers with one versioned document, so scripting it does not mean
parsing prose.

## How it decides

Observed outcomes update a weighted Beta-Binomial baseline, which backs off from the narrowest
comparable cell to broader ones when evidence is thin, and reports which level it used. Risk follows
the lower bound of the interval rather than the point estimate, so a wide interval cannot look
confident.

Evidence gates cap what a history is allowed to claim: a source that has never been restricted
cannot reach high evidence about restrictions, and incomplete ingestion caps the level no matter how
long the history is. Forecasts are recorded and later scored against the prompts that followed them,
which is what `snack stats` reports — including when it has nothing to report yet.

Usage pressure ranks your current window against your own preceding windows of the same length. It
is a comparison with your history, never a share of capacity.

## Upgrading from an earlier preview

`0.1.x` through `0.5.x` were technical previews: `0.1.0` proved installation and storage, `0.2.0`
added the OpenCode tracer and a broad initial estimate. If you installed one of those, you were
running something that could not yet do most of what is described above.

`0.6.0` is also the first guaranteed migration-preservation baseline: from here forward, documented
migrations preserve your data and configuration into later releases. Data written by a preview
before it is not covered by that promise. Run `snack doctor` after upgrading; if it reports storage
it cannot read, `snack data purge --all --yes` followed by `snack sync --full` rebuilds everything
from your OpenCode history, which SNACK only ever reads.

## Setup without the questions

```bash
snack setup opencode --non-interactive \
  --source work --provider anthropic --profile default --plan pro \
  --install-plugin --yes
```

- `--source` names the capacity source in SNACK; `--provider` and `--profile` say which provider
  account it maps to. Run without `--install-plugin` to configure backfill only.
- `--plan` records what you call your plan. It is a label, not a lookup key.
- `--plan-profile` selects the prior SNACK starts from, and defaults to `generic`. Profiles are
  named after a billing archetype rather than a provider: `subscription-window` for a flat
  subscription, where pressure follows requests and generated volume concentrating in a window, and
  `metered-credit` for per-token or credit billing, where it tracks cumulative volume. The choice
  changes how usage is weighed, never what SNACK claims your capacity is, and local evidence blends
  it away as history accumulates.
- `--install-plugin` registers `@snack-ai/opencode` in the global OpenCode configuration and needs
  `--yes` to confirm; `--dry-run` shows the proposal and changes nothing.
- `--enable-prospective-analysis` is opt-in and enables local, ephemeral, allowlisted prompt-size
  features only. The text itself is never stored, and no option accepts it on the command line,
  where other processes could read it.

## Supported OpenCode versions

Backfill supports fingerprint family `oc-sqlite-msgpart-v1`, validated against OpenCode `1.17.19`,
`1.17.20`, `1.18.1`, and `1.18.9`; `1.18.10` additionally supports live capture. Compatibility is
determined by structural and JSON fingerprints, not by version strings, and an unrecognized shape
refuses rather than guesses.

## More

Source, roadmap, threat model, and the full specification live at
[github.com/Duck1201/snack](https://github.com/Duck1201/snack). Security reports go through the
private channel in [SECURITY.md](https://github.com/Duck1201/snack/blob/main/SECURITY.md).

Apache-2.0.
