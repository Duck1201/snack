---
"@snack-ai/opencode": patch
"@snack-ai/cli": patch
---

Rewrite the package documentation in English and Portuguese.

Each README now opens with a non-technical section that says what SNACK is for and reads its example
output in plain words, then a technical section covering the Beta-Binomial model, the Jeffreys
prior, hierarchical backoff, the evidence gates, usage-pressure percentiles and the calibration
metrics — with references, so the reasoning can be checked rather than trusted.

Both packages ship their README inside the tarball, and both were describing a version nobody was
running: the CLI's said the `0.6` line was the MVP and Claude Code was still to come, and the
plugin's described its compatibility in terms of `0.1.x`. The published support matrices were two
releases stale as well.

Every example is captured from a real run rather than written by hand.
