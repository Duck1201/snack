---
"@snack-ai/cli": patch
---

Ask each guided-setup question before offering its choices. The numbered list was printed first, so
every question with choices read back to front. The rendering is now a pure function with its own
tests, leaving the executable only the readline handle.
