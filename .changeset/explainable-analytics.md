---
"@snack-ai/cli": minor
---

Add explainable analytics: rolling analysis horizons, observed usage profiles, plan profiles, and
usage pressure.

`snack stats` is new. It reports every configured analysis horizon, or one chosen with `--horizon`,
in concise, `--verbose`, and `--json` form: prompt counts by outcome, restrictions by class, token
dimensions kept separate, cost totalled per currency in exact decimal arithmetic, duration
percentiles, freshness, and a time-decayed effective sample size. Absent source fields are reported
as unknown and never as zero, and calibration metrics say not available until a prediction model
exists.

`snack status` now reports real usage pressure instead of a placeholder, and `snack doctor` reports
the plan profile a source uses and warns when it is more than a year past its `as_of` date.

Plan profiles ship as validated data. A source selects one through `sources[].plan_profile`, naming
a bundled profile or a local file. A profile that fails validation is rejected, the generic profile
is used instead, and the command warns rather than substituting silently. Migration 005 stamps the
capacity period with the profile identity and version; changing which profile a source uses opens a
new period, while a new version of the same profile does not.

Usage pressure compares the current window with preceding windows of the same length. It is relative
to local history and is never a share of real provider capacity, which SNACK treats as unknown.
