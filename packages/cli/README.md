# @snack-ai/cli

**Know before you feed the model.**

Em português: [README.pt-BR.md](./README.pt-BR.md).

## The friendly version

You know the feeling. You are three hours into something good, the code is finally taking shape, and
you hit send on one more prompt — and the provider says no. Not "in a minute". Just no. The thread
is cold, the flow is gone, and you had no warning at all.

SNACK is a small command that tries to give you that warning.

It reads the history your AI coding tool already keeps on your own machine, works out how hard you
have been going lately, and tells you how likely your next prompt is to go through. That is the
whole idea. No account, no signup, no server, no telemetry. No command that touches your data
touches the network, because there is nowhere for it to send anything to. `snack update` is the one
exception, and it only installs packages.

```bash
npm install -g @snack-ai/cli
snack setup opencode    # or: snack setup claude
snack status
```

```text
work
  viability  95-100%   risk low          evidence moderate
  pressure   high      category typical  ▁▄▅▇█
  drivers    prompts 100th, input_tokens 100th
  method     bayesian-pressure-band@1
  as of      40s ago · sync ok · period since 2026-01-02
  ! Real provider capacity is unknown.
  ! Usage pressure compares this window with local history; it is not a share of capacity.
```

In plain words, that line says: **go ahead, you are almost certainly fine — but you are having one
of your heaviest hours ever, so do not be surprised if that changes.** Both halves matter. The first
is the answer; the second is the context that makes the answer honest.

Here is what each piece means, no statistics required:

| You see             | It means                                                                                         |
| ------------------- | ------------------------------------------------------------------------------------------------ |
| `95-100% viability` | A range, not a promise. Somewhere in there is the chance your next prompt completes.             |
| `risk low`          | Read off the **bottom** of that range, never the middle. A wide range can never look confident.  |
| `evidence moderate` | How much your own history actually backs this up. A fresh install says `very_low`, and means it. |
| `pressure high`     | You, right now, compared to you on a normal day. Nothing to do with your provider's limits.      |
| `prompts 100th`     | The percentile that is driving it — this is your busiest hour on record.                         |
| `category typical`  | How big your next prompt looks next to your usual ones.                                          |

And `snack stats` shows you what your week actually looked like:

```text
work: plan profile generic@1.0.0 (bundled, as of 2026-01-01).
  pressure high (local baseline); trend rising over 4 windows against 14 baseline windows.
  calibration: backtest brier 0.010 (sample 980, coverage 1.00) over 980 forecasts.
  PT1H: 9 prompts; tokens in 22,620 / out 11,580; cost USD 0.24; duration p50 13.0s p90 44.0s.
  P1D:  87 prompts; restrictions rate_limit 2; cost USD 1.99; effective sample 70.06 prompts.
  P7D: 449 prompts; restrictions rate_limit 10; tokens in 909,266 / out 488,902; cost USD 10.06.
```

449 prompts in seven days, ten times told no, ten dollars and six cents, and a median prompt that
took twelve seconds. That is a week of your working life, measured — and it never left your laptop.

## The one thing SNACK refuses to do

It will never show you a percentage of your quota.

Not because it would be hard. Because it would be a **lie**. Your provider does not publish your
real limits, they move, and they differ per account and per model. Any tool showing you "63% of
quota used" made that number up, and a made-up number is worse than no number, because you will plan
around it.

So SNACK shows you what it can actually see: your own usage, an honest range, how much evidence sits
behind it, and which method produced it. When it knows little, it says so loudly, and a fresh
install gets a wide range and `very_low` evidence rather than false comfort.

Nothing you write is stored. Not prompt text, not responses, not credentials, not even your project
paths. That is not a policy note — it is a test that pushes canary strings through every command and
fails the build if a single one shows up in any byte SNACK writes.

## The commands

| Command                                       | What it does                                                                                                                                                       |
| --------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `snack setup opencode` / `snack setup claude` | Maps a client to a capacity source. Shows every change first, backs up, writes nothing until you confirm.                                                          |
| `snack status`                                | The next-prompt assessment: range, risk, evidence, pressure and what drove it, freshness. `--verbose` adds the evidence gates, the method and the policy versions. |
| `snack stats`                                 | What your usage really looks like over rolling horizons, and how well past forecasts scored.                                                                       |
| `snack sync`                                  | Imports new history. `--full` re-reads and reconciles everything without duplicating it.                                                                           |
| `snack export`                                | Streams everything to JSON or CSV with schema and provenance. Your data stays yours.                                                                               |
| `snack data purge`                            | Deletes a scope you choose, transactionally, after showing you exactly what goes.                                                                                  |
| `snack config`                                | Reads and edits local configuration.                                                                                                                               |
| `snack doctor`                                | Diagnoses the installation without changing it: permissions, schema fingerprints, integrity.                                                                       |
| `snack update`                                | Brings the CLI and the capture plugin to versions that belong together. The only command that installs.                                                            |

Every command takes `--json` and answers with one versioned document, so scripting it never means
parsing prose. Every command is also in `man snack`, which ships in the package and is generated
from the CLI's own flag surface — an undocumented flag fails the build rather than reaching you.

Two clients can share one capacity source. If OpenCode and Claude Code bill against the same
account, map them to the same alias and SNACK will treat their usage as the single pool it really
is.

---

## Under the hood

Everything above is a fairly thin wrapper over a small number of well-understood statistical
results. SNACK claims no novelty; the value is in applying them honestly to sparse, self-collected
data and refusing to overstate the result. What follows is the actual machinery, with references, so
you can check the reasoning rather than take it on trust.

#### The forecast

Prompt viability is estimated as a Bernoulli success rate with a **Beta-Binomial** conjugate model.
Observed outcomes for a capacity source update a Beta posterior, and the reported range is a pair of
Beta quantiles at a declared coverage target (`0.8` by default, reported in the document as
`coverage_target`).

The prior is `Beta(½, ½)` — the **Jeffreys prior** for a binomial proportion (Jeffreys, 1946), which
is invariant under reparameterization and, unlike the Wald interval, does not collapse to zero width
when a source has seen no restrictions at all. Brown, Cai & DasGupta (2001) survey the alternatives
and recommend exactly this interval for small samples, which is the regime nearly every SNACK
installation lives in.

Outcomes are weighted by **exponential time decay** with a seven-day half-life, so a month-old
pattern still counts but does not outvote this week. The result is reported as `effective_samples` —
the sample size the weighting is actually worth, always smaller than the raw count, and always shown
next to it.

#### Backoff, and why cells

Forecasting from "all your prompts, ever" throws away the fact that a heavy prompt during your
busiest hour is not the same bet as a small one on a quiet Sunday. So outcomes are grouped into
cells of **capacity period × usage-pressure band × prompt-size category**, and the estimate uses the
narrowest cell that carries enough evidence, backing off through progressively broader ones:

```
period + pressure band + size category  →  period + pressure band  →  period  →  prior alone
```

The level actually used is reported as `contributors.backoff_level`, so a forecast never hides how
specific its evidence was. This is ordinary hierarchical partial pooling: borrow strength from the
broader group when the narrow one is thin, in the spirit of Efron & Morris (1975). Only a capacity
period with no eligible outcome at all falls through to the prior alone, and that case reports its
method as `initial-generic` rather than pretending to be a learned estimate.

**A capacity period starts over when you change your provider, profile, plan or plan profile** —
running `snack setup` again with a different `--plan` is enough. That is deliberate: a different
plan is a different capacity regime, and outcomes from the old one are not evidence about the new
one. So the next forecasts lean on the plan profile until the new regime has its own history, and
`setup` tells you how many observed prompts stop informing the estimate before it happens. Nothing
is deleted — `stats`, `observed` and `as_of` still report everything the source holds.

#### Evidence gates, and why a long history can still be weak

A range on its own invites over-reading, so every forecast carries an evidence level on the ladder
`very_low → low → moderate → high`. Four independent gates each name the highest level they can
support, and **the weakest gate caps the result**:

| Gate           | Asks                                                     |
| -------------- | -------------------------------------------------------- |
| `sample`       | Is there enough effective evidence after decay?          |
| `restrictions` | Have any restrictions actually been observed?            |
| `relevance`    | How far did backoff have to travel from the narrow cell? |
| `completeness` | Is ingestion complete, or is some history missing?       |

The `restrictions` gate is the load-bearing one. A source that has run for months without a single
refusal has plenty of data about success and nearly none about failure, and it must not be allowed
to sound authoritative about the thing it has never seen. This is the practical form of the
distinction Gneiting, Balabdaoui & Raftery (2007) draw between **calibration** and **sharpness**:
being right on average is not the same as being usefully precise, and a forecast should never buy
the second at the cost of the first.

Risk labels derive from the **lower bound** of the interval under a versioned threshold policy,
never from the point estimate, which is what makes a wide interval read conservatively instead of
splitting the difference.

#### Usage pressure

Pressure ranks the current rolling window against your own preceding windows of the same length, per
dimension — prompts, each token type, cost, duration. The percentiles are combined under a versioned
weighting blended from the plan profile toward a neutral weighting as local evidence accumulates,
and the top contributing dimensions are reported so the band is never a bare verdict.

Standard horizons are `PT1H`, `PT5H`, `P1D`, `P7D`, half-open, and a window with no prompts is
treated as **absence of observation** rather than as a zero — the distinction that stops a quiet
weekend from looking like a collapse in usage. A minimum number of baseline windows is required
before any window is ranked at all; below it, pressure reports `unknown` instead of guessing.

Pressure is relative to you. It is not, and is never presented as, a fraction of provider capacity.

#### Calibration: does any of this work?

Claiming 90% is easy. Being right 90% of the time is the part that has to be measured, and SNACK
measures it two ways, kept as separate streams that are never averaged together:

- **Live** — forecasts actually delivered to you, scored against what happened next.
- **Backtest** — rolling-origin replay, where each forecast is rebuilt from only the prefix of
  history that preceded it, with the clock set to that prompt. This is the out-of-sample evaluation
  design described by Tashman (2000); the property tests assert that appending future history never
  changes a past forecast, which is what makes leakage a build failure rather than a worry.

Both report:

- **Brier score** (Brier, 1950) — mean squared error of the probability forecast. `0` is perfect,
  `0.25` is what you get by always saying 50%. In the example above, `0.010` over 980 replayed
  forecasts.
- **Reliability by bucket** — 0.1-wide bins, comparing claimed probability to observed frequency.
  This is the reliability component of Murphy's (1973) decomposition of the Brier score.
- **Empirical interval coverage** — how often the true outcome fell inside the published range,
  measured per bucket against that bucket's own interval.

Every figure is reported beside its sample size, and never as zero when the sample is empty:
`not_available` and `0.000` are very different statements, and conflating them is how a dashboard
starts flattering itself.

Under simulation at 1,500 trials per rate, empirical coverage measured 0.911 / 0.880 / 0.863 / 0.864
against true restriction rates of 0.02 / 0.05 / 0.10 / 0.25. The declared `0.8` target is therefore
a **floor**, not an exact claim, and it is documented as one.

#### Versioning

Every policy that can change an interpretation carries a version, stamped on the row it produced:
the parser, the classifier, the analyzer, the prediction policy, the evidence policy, the risk
thresholds, the calibration definitions. A forecast made last month can be read with the rules that
made it, rather than with today's. From `1.0`, the JSON envelope, the export document, the config
schema, the exit codes, the documented flags, and the spool contract are public contracts under
strict SemVer.

#### References

- Brier, G. W. (1950). Verification of forecasts expressed in terms of probability. _Monthly Weather
  Review_, 78(1), 1–3.
- Brown, L. D., Cai, T. T., & DasGupta, A. (2001). Interval estimation for a binomial proportion.
  _Statistical Science_, 16(2), 101–133.
- Efron, B., & Morris, C. (1975). Data analysis using Stein's estimator and its generalizations.
  _Journal of the American Statistical Association_, 70(350), 311–319.
- Gneiting, T., Balabdaoui, F., & Raftery, A. E. (2007). Probabilistic forecasts, calibration and
  sharpness. _Journal of the Royal Statistical Society: Series B_, 69(2), 243–268.
- Gneiting, T., & Raftery, A. E. (2007). Strictly proper scoring rules, prediction, and estimation.
  _Journal of the American Statistical Association_, 102(477), 359–378.
- Jeffreys, H. (1946). An invariant form for the prior probability in estimation problems.
  _Proceedings of the Royal Society A_, 186(1007), 453–461.
- Murphy, A. H. (1973). A new vector partition of the probability score. _Journal of Applied
  Meteorology_, 12(4), 595–600.
- Tashman, L. J. (2000). Out-of-sample tests of forecasting accuracy: an analysis and review.
  _International Journal of Forecasting_, 16(4), 437–450.

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

## Supported clients

Support is decided by a structural fingerprint, not by a version string, and an unrecognized shape
refuses rather than guesses. The published matrices are
[OpenCode](https://github.com/Duck1201/snack/blob/main/docs/opencode-support.md) and
[Claude Code](https://github.com/Duck1201/snack/blob/main/docs/claude-support.md); the promise is
the newest validated schema family plus one previous, per client.

Requires Node.js 24 on Linux, macOS, or Windows through WSL2.

## Upgrading

**From `1.1.0`, run `snack update`.** It works out how this CLI was installed, shows you the exact
command before running it, installs, and then re-registers the capture plugin at the version this
release was validated against. Doing that by hand meant reading your own configuration back and
retyping five values into `setup` exactly — and any one of them typed differently starts a new
capacity period, which retires everything SNACK has learned about that source. `snack update` never
rotates a capacity period.

It is also the only command in the product that reaches the network, and it carries a package name
and a version and nothing else. If SNACK cannot tell how it was installed, it refuses and prints the
command to run yourself rather than installing somewhere you did not expect.

`0.6.0` is the guaranteed migration baseline: every release from it forward preserves your data and
configuration through documented migrations. After installing, run `snack sync` — the first command
that opens storage for writing applies pending migrations, taking a backup first. Read-only commands
refuse rather than crash until it has.

The full upgrade path, including the one payload that changed shape at the `0.9` freeze, is in
[docs/compatibility.md](https://github.com/Duck1201/snack/blob/main/docs/compatibility.md).

**If you pinned the `stable` tag**, this is the release you were waiting for. `stable` held `0.6.1`
through the whole pre-1.0 line, because until now the newest release was allowed to evolve flags and
JSON shapes and the MVP was the only surface being held still. From `1.0.0` breaking any public
contract requires a major version, so `latest` and `stable` name the same release again. `0.6.1`
stays installable by exact version; it just stops being what `stable` resolves to.

## More

Source, roadmap, threat model, architecture, and the full specification live at
[github.com/Duck1201/snack](https://github.com/Duck1201/snack). Security reports go through the
private channel in [SECURITY.md](https://github.com/Duck1201/snack/blob/main/SECURITY.md).

Apache-2.0.
