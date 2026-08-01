---
"@snack-ai/opencode": major
"@snack-ai/cli": major
---

First stable release.

Six surfaces are public contracts under strict SemVer from here: the documented commands and flags,
the exit-code categories, the `--json` envelope and its per-command payload schemas, the
configuration schema, the export document, and the spool event contract. They are the surfaces
frozen at `0.9` and confirmed rather than redefined by this release — a change to any of them during
the stable gate audit would have reset the freeze and required a new `0.9.x`.

No product behavior changes. What this release adds is the evidence that the contracts hold: the
documents `0.9.0` emits are captured and still validate unchanged, every published release from the
`0.6.0` migration floor forward upgrades under the candidate with integrity intact, and the
artifacts are staged on an isolated registry and checksum-verified before npm sees them.

The OpenCode plugin reaches `1.0.0` alongside the CLI. Its behavior and its `spool-event-v1`
contract are unchanged; the version moves because the packages are released together and its
documentation did.
