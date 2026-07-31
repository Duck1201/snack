# @snack-ai/opencode

## 0.1.2

### Patch Changes

- Republish both packages so npm serves the documentation the MVP deserves.

  npm renders the README inside the published tarball, so rewriting it in the repository changed
  nothing for anyone arriving at the package page: `0.6.0` still introduced itself as the "OpenCode
  tracer preview" that `0.2.0` was. The CLI page now says what SNACK does, what it refuses to claim,
  what each of the eight commands is for, how the forecast is reached, and what upgrading from a
  pre-`0.6` preview means for data written before the migration-preservation baseline.

  The plugin's page explains that nobody installs it directly, what it actually appends to the spool
  field by field, that SNACK works without it by reading OpenCode's database, and the three things
  it will not do: break OpenCode, read what it does not need, or interpret an event it cannot
  validate.

  Setup now registers `@snack-ai/opencode@0.1.2`. Every `0.1.x` emits the same `spool-event-v1`, so
  a registration pinned at an earlier one keeps working and `snack doctor` reports it as outdated
  rather than incompatible.

## 0.1.1

### Patch Changes

- b8d7d9f: Republish the OpenCode capture plugin from the protected release workflow so the version
  served on `next` carries an npm provenance attestation.

  The plugin's first publication had to be performed manually, because npm cannot bind a trusted
  publisher to a package that does not exist yet, and a local publish cannot generate provenance.
  This release contains no behavior change: it exists so that the installable version is the one
  built and attested by CI.
