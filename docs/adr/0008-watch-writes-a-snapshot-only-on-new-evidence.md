---
status: accepted
---

# `status --watch` writes a prediction snapshot only when the evidence changed

> **The surface this names was renamed after this decision was accepted.** `status --watch` was
> dropped from `1.2.0` and superseded by `snack dash`, a command of its own: the `1.1.3` interface
> work established that `status` is a stream read through pipes and that a full-screen drawing
> cannot be its stdout. Nothing below changes. The decision was always about a screen that redraws
> faster than evidence arrives, and it applies to `snack dash` word for word — read `--watch` as
> "the live screen" throughout. `dash` keys its snapshots on the rendered estimate, which is this
> rule stated in terms of what the reader actually saw.

A `--watch` tick that ingested no new observation redraws the estimate already on screen and writes
nothing. A new prediction snapshot is written only when the set of observations behind the estimate
changed. This makes "delivery-confirmed" mean the first delivery of a given estimate rather than
every repaint of it.

`--watch` refreshes every 30 seconds by default, and its whole purpose is to be left open. Eight
hours of that is roughly 960 estimates put in front of the user. A prediction snapshot is a
delivery-confirmed record, and calibration is defined as the agreement between what forecasts
claimed and what later happened — Brier score, reliability by bucket, empirical interval coverage,
each beside its sample size. If every repaint were a snapshot, hundreds of near-identical records
would pair with a single subsequent outcome, and the Brier score would report how long the terminal
stayed open. That is not a cosmetic problem: it is calibration data written wrong, permanently,
which puts it in the same class as the data-corruption defects the project treats as blocking.

Writing nothing at all was the safer-looking alternative and is worse than it looks. A forecast the
user saw, and acted on, would be absent from the record of forecasts the user received, which is
precisely what the snapshot stream is for. Writing every tick and tagging its origin was the other
alternative; it keeps the full history, at the price of a filter that becomes permanent and that
every consumer of the export has to learn about in order to read the calibration figures correctly.

The redraw stays honest because it is the same estimate, not a new one, and the freshness and `as_of`
fields already tell the user how old the observations behind it are. A tick that cannot synchronize
because another process holds the lock is skipped rather than queued, and the screen says the data
is stale.

`--watch` is human presentation. Combined with `--json` it is a usage error, and so is `--watch`
without a TTY: the alternative — emitting one envelope per tick — would turn a frozen contract from
a document into a stream, and a script that passed the flag by accident would never find out.

This decision is reopened if watch-mode estimates ever need to be evaluated as their own stream, in
which case they need a separate table and a separate calibration report, not a flag on the existing
one.
