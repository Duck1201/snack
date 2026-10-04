# @snack-ai/cli

**Know before you feed the model.**

SNACK estimates the chance that your next prompt goes through without the provider refusing it for a
rate or usage limit. It works from usage metadata alone, and never stores or judges what your
prompts say.

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
npm install -g --allow-scripts=better-sqlite3 @snack-ai/cli   # builds the SQLite driver; npm 12 skips it otherwise
snack setup opencode    # or: snack setup claude, snack setup codex
snack status
```

```text
$ snack status --source work
work
  next prompt  95-100% chance it goes through · risk low
  evidence     moderate — some history, but few refusals seen yet
  pressure     high · higher than every window in your own history · typical prompt
  drivers      prompt count, input tokens
  as of        9m ago · sync ok · period since 2026-10-03
  ! The estimate is not yet calibrated against observed outcomes.
  ! Real provider capacity is unknown.
  ! Usage pressure compares this window with local history; it is not a share of capacity.
```

In plain words, that line says: **go ahead, you are almost certainly fine — but you are having one
of your heaviest hours ever, so do not be surprised if that changes.** Both halves matter. The first
is the answer; the second is the context that makes the answer honest.

Here is what each piece means, no statistics required:

| You see                                        | It means                                                                                                                            |
| ---------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| `95-100% chance it goes through`               | A range, not a promise. Somewhere in there is the chance your next prompt completes.                                                |
| `risk low`                                     | Read off the **bottom** of that range, never the middle. A wide range can never look confident.                                     |
| `evidence moderate`                            | How much your own history actually backs this up. A fresh install says `very_low`, and means it.                                    |
| `pressure high`                                | You, right now, compared to you on a normal day. Nothing to do with your provider's limits.                                         |
| `higher than every window in your own history` | Where this window ranks among your own — this is your busiest hour on record.                                                       |
| `typical prompt`                               | How big your next prompt looks next to your usual ones.                                                                             |
| `drivers`                                      | What is pushing the pressure up: here, how many prompts you sent and how much input they carried.                                   |
| `as of`                                        | How old the newest usage is, whether the last sync worked, and when the current capacity period (this plan, on this account) began. |
| `!`                                            | What SNACK cannot claim. They are on every panel; on a thin history the first one says the starting assumption still dominates.     |

The method, and the evidence gate holding the level down, are one flag away. `--verbose` adds them
to the same panel, and ranks each driver:

```text
$ snack status --source work --verbose
  ...
  drivers      prompt count higher than every window in your own history, input tokens higher than every window in your own history
  gates        sample high · restrictions moderate (limiting) · relevance moderate (limiting) · completeness high
  method       bayesian-pressure-band@1 · model stage5-prediction-v2
  ...
```

Two gates hold this one at `moderate`: `restrictions`, because SNACK has not yet seen a refusal at
this pressure, and `relevance`, because the estimate pools prompts of every size at this pressure
rather than only prompts like yours. More prompts alone will not lift it. Plain `snack status`, with
no `--source`, puts every source on one row so you can compare them.

Planning a run rather than a single prompt? `--sequence <n>` adds the chance that all of the next
`<n>` go through, on a row of its own directly beneath `next prompt`:

```text
$ snack status --source work --sequence 10
work
  next prompt  95-100% chance it goes through · risk low
  next 10      61-100% chance all 10 go through · risk elevated
  evidence     moderate — some history, but few refusals seen yet
  pressure     moderate · above 74% of your own history · typical prompt
  drivers      input tokens, output tokens
  as of        11m ago · sync ok · period since 2026-10-03
  ! The estimate is not yet calibrated against observed outcomes.
  ! Real provider capacity is unknown.
  ! Usage pressure compares this window with local history; it is not a share of capacity.
  ! The 10-prompt estimate assumes each prompt meets the conditions the next one does; it does not model usage pressure rising as they are sent.
```

| You see                            | It means                                                                                                                                 |
| ---------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| `next 10`                          | The number you asked about, echoed back. SNACK never picks it, and never tells you how far you can go.                                   |
| `61-100% chance all 10 go through` | A range for the whole run. Lower than the single-prompt one, because every one of them has to make it.                                   |
| `risk elevated`                    | Read off the bottom of that range, under the same thresholds as `next prompt`.                                                           |
| the last `!`                       | What the estimate assumes: each prompt meets the conditions the next one does, with no allowance for pressure climbing as you send them. |

The number is a whole number from 1 to 100, and anything else exits `2` without repeating what you
typed. The evidence level is the single-prompt one, because the history behind both is the same, and
the method has its own name — `sequence-bayesian-pressure-band@1` here — on the `--verbose` method
row and in `--json`.

Ask about a long enough run on a short enough history and the range gets wide. When it is wider than
half the scale, the panel says so: on this same history `--sequence 25` reads `29-100%` and adds
"The 25-prompt interval is too wide to say much; it cannot tell whether all of them going through is
more likely than not." Read that as an honest "not enough to say", not as a broken tool: a range
that straddles even odds cannot tell you whether the run is more likely to go through than not. It
suggests no fix, because neither a shorter sequence nor more history reliably narrows it. From `1.6`
that history gets one more line, because no refusal of yours is in its evidence yet: "Your recent
history has no restriction to learn from, so the low end of this interval comes from SNACK's
starting assumption rather than from your history." The bottom of `29-100%` is SNACK's assumption,
not something you have seen happen.

And `snack stats` shows you what your week actually looked like:

```text
$ snack stats
work · anthropic max · generic@1.0.0 · pressure high, rising

  WINDOW  PROMPTS  COUNTED    REFUSED     SET ASIDE  COST  TYPICAL  SLOWEST 10%
  1h        28       28          —            0       —      25s        40s
  5h        38       38          —            0       —      22s        38s
  1d        41       41          —            0       —      23s        40s
  7d        234      234    2 rate limit      0       —      25s        40s

  WINDOW  INPUT  OUTPUT  REASONING  CACHE READ  CACHE WRITE
  1h      3.23K  37.7K       —        1.83M        41.8K
  5h      4.08K  53.5K       —        2.60M        67.1K
  1d      4.49K  56.9K       —        2.76M        70.7K
  7d      25.2K   316K       —        14.7M        466K

  3 forecasts checked against what happened next
  observed up to 2026-10-03T08:57:06.752Z
```

234 prompts in seven days, twice told no, a typical prompt that took twenty-five seconds, and almost
fifteen million tokens read back from cache. Cost reads `—` because Claude Code does not record it,
and SNACK does not make one up. That is a week of your working life, measured — and it never left
your laptop.

## The one thing SNACK refuses to do

It will never show you a percentage of your quota.

Not because it would be hard. Because it would be a **lie**. Your provider does not publish your
real limits, they move, and they differ per account and per model. Any tool showing you "63% of
quota used" made that number up, and a made-up number is worse than no number, because you will plan
around it.

So SNACK shows you what it can actually see: your own usage, an honest range, how much evidence sits
behind it, and which method produced it. When it knows little, it says so loudly, and a fresh
install gets a wide range and `very_low` evidence rather than false comfort.

One client does state a figure of its own. Codex CLI records, for each window it tracks, a fraction,
the window's length and when it resets. SNACK quotes that as the client's statement — on a
`reported` row beside the estimate, never inside it — and does not turn it into a claim about any
capacity, including the one Codex is talking about.

Nothing you write is stored. Not prompt text, not responses, not credentials, not even your project
paths. That is not a policy note — it is a test that pushes canary strings through every command and
fails the build if a single one shows up in any byte SNACK writes.

## The commands

| Command                                     | What it does                                                                                                                                                                                                                                                     |
| ------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `snack setup opencode` / `claude` / `codex` | Maps a client to a capacity source. Shows every change first, backs up, writes nothing until you confirm.                                                                                                                                                        |
| `snack status`                              | The next-prompt assessment: range, risk, evidence, pressure and what drove it, freshness. `--verbose` adds the evidence gates, the method, the policy versions and the shadow estimates; `--sequence <n>` adds the chance that all of the next `<n>` go through. |
| `snack dash`                                | Every source on one live full-screen view, kept current while you work. Needs a terminal.                                                                                                                                                                        |
| `snack stats`                               | What your usage really looks like over rolling horizons, and how well past forecasts scored — per method, under `--verbose`.                                                                                                                                     |
| `snack sync`                                | Imports new history. `--full` re-reads and reconciles everything without duplicating it.                                                                                                                                                                         |
| `snack export`                              | Streams everything to JSON or CSV with schema and provenance. Your data stays yours.                                                                                                                                                                             |
| `snack data purge`                          | Deletes a scope you choose, transactionally, after showing you exactly what goes.                                                                                                                                                                                |
| `snack config`                              | Reads and edits local configuration.                                                                                                                                                                                                                             |
| `snack doctor`                              | Diagnoses the installation without changing it: permissions, schema fingerprints, integrity.                                                                                                                                                                     |
| `snack update`                              | Brings the CLI and the capture plugin to versions that belong together. The only command that installs.                                                                                                                                                          |

Every command takes `--json` and answers with one versioned document, so scripting it never means
parsing prose. Every command is also in `man snack`, which ships in the package and is generated
from the CLI's own flag surface — an undocumented flag fails the build rather than reaching you.

Two clients can share one capacity source. If OpenCode, Claude Code or Codex CLI bill against the
same account, map them to the same alias and SNACK will treat their usage as the single pool it
really is.

## Leave it open: `snack dash`

From `1.6`, `snack dash` is the screen to keep beside your editor: every capacity source on one row,
with the columns plain `snack status` prints, and the selected one in detail beneath — the
`next prompt` line, the evidence, the pressure with a marker on a scale, a plot of the last 24
hours, what drove it, and the caveats.

```text
 snack dash · 2 capacity sources                    synced 6s ago · next in 54s
   SOURCE  NEXT PROMPT   RISK   EVIDENCE  PRESSURE  LAST SEEN   SYNC
 ▸ work      96-100%     low    moderate    low      35m ago     ok
   home      84-100%     low    very_low  unknown    3h ago      ok
 ──────────────────────────────────────────────────────────────────────────────
 work
   next prompt  96-100% chance it goes through · risk low
   evidence     moderate — some history, but few refusals seen yet
   pressure     low · lower than every window in your own history · typical pr…
                lightest ├●────────────────────────┤ heaviest
   by hour      ▃···········▆▅▇▃▆▅▅▁▃▃▃▁  each hour against your own history
                24h ago              now
   drivers      prompt count, input tokens
   as of        35m ago · period since 2026-10-03
   ! The estimate is not yet calibrated against observed outcomes.
   ! Real provider capacity is unknown.
   ! Usage pressure compares this window with local history; it is not a share
     of capacity.

 ↑↓ select   s next N   r sync now   ? help   q quit
```

| You see                   | It means                                                                                                                                         |
| ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| `▸`                       | The selected source; `↑` `↓` move it.                                                                                                            |
| `lightest ├●──┤ heaviest` | Where this hour sits between your own lightest and heaviest. A marker, never a filled bar: a bar would claim to know how much of a tank is gone. |
| `by hour`                 | The last 24 hours, each against your own history. `·` is an hour with no prompts at all, never a quiet one.                                      |
| `synced 6s ago`           | It synchronizes on its own 60 seconds after the previous synchronization ended, in a child process; `r` does it now.                             |

`s` shows or hides a `next N` row under `next prompt` — the `--sequence` answer for the selected
source — and `+` and `-` move `N` by one, from 1 to 100; it starts at 10 and is always yours. When
that interval is too wide to inform, the row prints no figure: only the sentence `status --sequence`
would print, with the prior-tail line when it applies. The keys never skip or stop at a length
because of it. `?` opens the help and `q` quits.

Shadow estimates are never on this screen; `snack status --verbose` is where they are. A warning a
reading carried — a plan profile that could not be read, say — has no room on the screen, so it is
printed once when you quit, after the terminal is restored. Every forecast the screen draws is
recorded the way a `status` run's is, and only when what it shows changes: a screen left open all
day does not count as a thousand forecasts.

It needs a terminal. `snack dash | cat`, a redirected input, `TERM=dumb` or `--json` exit `2` and
point at `snack status`, which gives the same reading through a pipe.

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

#### Sequence viability

`--sequence <n>` asks about a run instead of one prompt — all of the next `n` — from the same
posterior `p ~ Beta(α, β)`. The point is the posterior predictive probability that all `n` complete,
`E[pⁿ] = ∏ (α + k) / (α + β + k)` for `k` from `0` to `n − 1` — the Beta-Binomial probability of `n`
successes in `n` trials. The tempting shortcut, the point estimate raised to the `n`th power, is
never computed: by Jensen's inequality it is always lower, because it treats the estimate as known
and so counts its uncertainty twice.

The interval needs no new quantile. `p ↦ pⁿ` is increasing on `[0, 1]`, so the single-prompt bounds
raised to `n` are the sequence's bounds at the same `coverage_target`. On a weak posterior and a
long sequence the mean can sit just above the powered upper bound; the interval is then widened to
contain it, which only adds coverage, so the target stays an honest floor. Risk is read off the
lower bound under the same thresholds; evidence is inherited unchanged, with no gate of its own. A
different estimand is a different named method, `sequence-<base method>@1`, and at `n = 1` every
member equals the single-prompt answer bit for bit.

An interval wider than one half (`sequence-width-v1`) necessarily contains one half, so it cannot
say whether the run is more likely to go through than not, and the panel says so. The width
`upperⁿ − lowerⁿ` is not monotone in `n`, and one more success can widen it, which is why that
caveat recommends nothing.

The relation runs one way only, `(posterior, n) → probability`. Nothing in SNACK solves for `n`
given a probability — a test scans the source for any such solver — because that `n` would be a
claim about the capacity a plan allows. `n` stops at 100: past that, the answer is the prior's tail
raised to a power rather than a reading of your history. Each answer is recorded beside its
prediction attempt, with the posterior that produced it, but it is not exported and not yet
calibrated: a sequence scored as if it predicted one prompt would corrupt the live calibration
stream.

How far the answer reaches is documented forward only. The answer weights recent history more — a
30-prompt recency half-life in the same conditions — so the evidence behind it saturates near an
effective sample of 44, and beyond that a longer history does not narrow the interval any further.
[How far the answer reaches](https://github.com/Duck1201/snack/blob/main/docs/specification/analysis.md#how-far-the-answer-reaches)
tabulates it as a history and a length in, the typical interval out. Read backwards, to find where
an interval stops informing, it would be the probability-to-`n` inversion this section refuses, done
by hand.

When the interval is too wide and no restriction carries weight in the evidence
(`sequence-prior-tail-v1`), a second caveat follows the first: "Your recent history has no
restriction to learn from, so the low end of this interval comes from SNACK's starting assumption
rather than from your history." With no restriction of yours left to count, the low end is the
prior's own tail raised to `n`, and that is the one explanation of the width that is true of your
data.

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

Methods are never averaged together either. Wherever a shadow estimate is computed beside the answer
— on every source from `1.6` — `calibration.by_method` scores each named method on its own
forecasts, and scores each shadow a second time, `paired`, on exactly the outcomes the answering
method was scored on: the comparison the rules for ever promoting one are written in.

Under simulation at 1,500 trials per rate, empirical coverage measured 0.911 / 0.880 / 0.863 / 0.864
against true restriction rates of 0.02 / 0.05 / 0.10 / 0.25. The declared `0.8` target is therefore
a **floor**, not an exact claim, and it is documented as one.

#### Longer memories, in shadow

The seven-day decay is not the only weighting. An outcome's weight also halves with every 30
outcomes after it in the same cell — a 30-prompt **recency half-life** — so with a steady history
the effective sample saturates near 44 rather than growing without end. That is deliberate: it is
how quickly the answer notices a provider that has started saying no more often.

From `1.6`, two more named methods run in shadow on every source: `bayesian-pressure-band-hl50@1`
and `bayesian-pressure-band-hl100@1`, the answer's model with a 50- and a 100-prompt recency
half-life and nothing else changed. A longer memory narrows the interval on a steady history; it is
slower to notice a change. Both are recorded beside every answer (`prediction_shadow`, migration
`019`), calibrated per method with a `paired` comparison, shown under `shadow` by `status --verbose`
and listed in the `shadows` array of every `status --json` report. Neither is ever the answer, and
`--sequence` stays the answer's.

Either may displace the 30 only in a later minor, under `recency-variant-promotion-v1`: on real
histories, at least 200 checked live forecasts, at least 5 restrictions live and in the backtest,
and a strictly lower Brier score than the answer's on the same outcomes in both — and one condition
calibration cannot buy. A longer memory may only become the answer if it still notices a provider
changing its behaviour as fast as the current one does. That is the collapse test the 30-prompt
half-life was chosen by: in a simulated drop from 0.99 to 0.70 viability, at a six-minute and at a
two-hour cadence, at most 2 runs in 25 may still claim a lower bound above 0.9 twenty outcomes into
the drop. Today the answer passes it and both variants fail it; `npm run collapse:check` in the
repository prints the counts.

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

`snack setup claude` and `snack setup codex` take the same flags without `--install-plugin`: both
clients are read from the history they already write, and nothing is registered in either.

## Codex CLI

```bash
snack setup codex --non-interactive --source work --provider openai --profile default --plan plus
```

SNACK looks in `$CODEX_HOME` when it is set — a relative value is resolved the way Codex resolves
it, and setup records the resolved path — and in `~/.codex` otherwise. It reads
`sessions/**/rollout-*.jsonl` and `archived_sessions/rollout-*.jsonl`, and nothing else in that
directory. Setup checks the history's fingerprint before asking anything and exits `4` when there is
no sessions directory.

Each rollout line is projected onto an explicit field allowlist, and the rest is dropped unread:
messages, reasoning, tool calls and their output, working directories, git metadata, account
identifiers and error messages never leave the parser. `~/.codex/history.jsonl`, which holds Codex's
raw prompt history, is never opened. Codex `0.145`–`0.147` and `0.159` write two different schema
families, and a session started by one and resumed by the other holds both in one file; each turn is
read by its own family. A refusal is observed from `codex_error_info` as well as from
`rate_limit_reached_type`, because the one real refusal on record was written only in the first.

The figure Codex states about its own windows is quoted on the `reported` row of `snack status`:

```text
$ snack status --source codex
codex
  next prompt  95-100% chance it goes through · risk low
  evidence     moderate — some history, but few refusals seen yet
  pressure     high · higher than every window in your own history · typical prompt
  drivers      prompt count, input tokens
  reported     Codex states 34% of its 5h window, resets in 3h 10m · 19% of its 7d window, resets Wed UTC · 9m ago
  as of        9m ago · sync ok · period since 2026-10-03
  ! The estimate is not yet calibrated against observed outcomes.
  ! Real provider capacity is unknown.
  ! Usage pressure compares this window with local history; it is not a share of capacity.
```

Windows are named by their length, never by Codex's `primary`/`secondary` slot, which changed
meaning between versions. A window whose reset has passed is not repeated. The row is not part of
the `next prompt` interval, the evidence level or the usage pressure, and nothing in the forecast
reads it. In `--json` it is the optional `reported_capacity` array on that source's report. It stays
local: `export` does not include it, and `data purge` deletes it with the rest of the scope.
`snack doctor` warns about what a Codex history holds that SNACK deliberately does not count —
forked subagents from Codex `0.147` or earlier, compressed `rollout-*.jsonl.zst` files, and stated
figures that could not be quoted.

### The shadow estimate

From `1.5`, every `status` on a Codex source also computes a **shadow estimate** from a second named
method, `reported-capacity@1`, and records it beside the answer. It is never the answer: the
`next prompt` line, the risk, the evidence, `--sequence` and every `--json` member `1.4` emitted
come from the baseline, unchanged. It shows on one `--verbose` row, worded so it cannot be taken for
the answer:

```text
$ snack status --source codex --verbose
codex
  next prompt  94-100% chance it goes through · risk low
  evidence     moderate — some history, but few refusals seen yet
  ...
  method       bayesian-pressure-band@1 · model stage5-prediction-v2
  reported     Codex states 85% of its 5h window, resets in 1h 32m · 30% of its 7d window, resets Thu UTC · 4m ago
  shadow       reported-capacity@1 would say 90-100% · risk low · evidence low — recorded to compare, not the answer above
               reads what Codex states about its 5h window — in the near band · reported-capacity-v1
               bayesian-pressure-band-hl50@1 would say 95-100% · risk low · evidence moderate
               bayesian-pressure-band-hl100@1 would say 96-100% · risk low · evidence moderate
               the answer's model with a 50- and a 100-prompt recency half-life instead of the answer's 30-prompt
  as of        3m ago · sync ok · period since 2026-10-03
  ...
```

— the three lines after `reported-capacity-v1` are the
[longer recency half-lives](#longer-memories-in-shadow) every source gets from `1.6` — in
`status --json` as the additive `shadow` member — the method, whether it was computed and why not,
the binding window without its figure, and when computed its interval, risk and evidence; from `1.6`
also the first entry of `shadows` — and in `stats --verbose` as a `by method` block
(`calibration.by_method` in `--json`):

```text
$ snack stats --verbose
  ...
  by method
    bayesian-pressure-band@1        answer · live not available yet · backtest brier 0.004, sample 297
    reported-capacity@1             shadow · live not available yet · backtest brier 0.004, sample 281
                                    same outcomes as the baseline · live not available yet · backtest brier 0.004 against 0.004, sample 281, 1 restricted
    bayesian-pressure-band-hl50@1   shadow · live not available yet · backtest brier 0.004, sample 297
                                    same outcomes as the baseline · live not available yet · backtest brier 0.004 against 0.004, sample 297, 1 restricted
    bayesian-pressure-band-hl100@1  shadow · live not available yet · backtest brier 0.004, sample 297
                                    same outcomes as the baseline · live not available yet · backtest brier 0.004 against 0.004, sample 297, 1 restricted
```

The method reads the **binding window** — of Codex's latest statement, the window with the highest
figure — and puts it in a **stated band**: `clear` below 80, `near` from 80, `full` at 100. Each
past prompt is given the band in force when it started, and the shadow learns from your own outcomes
in the same band instead of the same pressure band. A statement more than six hours old, one made
before the capacity period, one whose window has reset, or a `clear` or `near` one followed by
another client's prompt binds nothing, and the row says why: `not computed — stale, stated 7h ago`.
`full` starts from an assumption that leans toward refusal and is labelled as one. Its evidence
never rises above `low`. Each prompt's band is stored beside it, recomputed after each `sync` and
`data purge`, and never exported.

It does not answer because the real Codex history it was designed from could not calibrate it: one
refusal in 65 days, no figure of 100 ever stated, and the figure in hand when the refused prompt
started was 20%. A later minor release promotes it only if its own calibration beats the baseline's
under `reported-capacity-promotion-v1`: on a real Codex history, at least 200 checked live
forecasts, at least 5 restrictions both live and in the backtest, and a strictly lower Brier score
than the baseline's on the same outcomes in both. No setting turns it on or off. A source no Codex
installation feeds never computes it; its `--verbose` panel shows only the longer recency
half-lives.

## Supported clients

Support is decided by a structural fingerprint, not by a version string, and an unrecognized shape
refuses rather than guesses. The published matrices are
[OpenCode](https://github.com/Duck1201/snack/blob/main/docs/opencode-support.md),
[Claude Code](https://github.com/Duck1201/snack/blob/main/docs/claude-support.md) and
[Codex CLI](https://github.com/Duck1201/snack/blob/main/docs/codex-support.md); the promise is the
newest validated schema family plus one previous, per client.

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
