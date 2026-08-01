---
"@snack-ai/cli": patch
---

Keep the identifier rule off the guided-setup questions. `0.8.1` put the pattern on every question
so the shape was known before the answer was typed, which spent a line of regex on everyone who was
going to type something ordinary anyway. The rule now appears only on a refusal, where it answers
something that just happened. A refusal still costs one answer rather than the whole questionnaire.
