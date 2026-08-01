---
"@snack-ai/cli": patch
---

`snack setup opencode --install-plugin` now registers `@snack-ai/opencode@1.0.0`, the version
published alongside this CLI. `1.0.0` still wrote `0.1.2`: every setup installed a plugin three
minors old, and `doctor` told anyone already pinned at `1.0.0` that their registration was "another
version" and to re-run setup — advice that would have downgraded them. A test now asserts the pin
equals what the plugin workspace publishes, so the two cannot drift apart again.
