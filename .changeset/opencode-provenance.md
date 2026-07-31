---
"@snack-ai/opencode": patch
---

Republish the OpenCode capture plugin from the protected release workflow so the version
served on `next` carries an npm provenance attestation.

The plugin's first publication had to be performed manually, because npm cannot bind a
trusted publisher to a package that does not exist yet, and a local publish cannot generate
provenance. This release contains no behavior change: it exists so that the installable
version is the one built and attested by CI.
