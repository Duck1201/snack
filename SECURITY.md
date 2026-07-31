# Security Policy

## Reporting a vulnerability

Report privately through GitHub's advisory form:
<https://github.com/Duck1201/snack/security/advisories/new>. Do not open a public issue, and do not
send a proof of concept over any public channel.

If you have no GitHub account, open an issue that says only that you have a security report and asks
for a private channel — nothing else. A report that names the defect in public has already spent the
disclosure window.

Include what you can: the SNACK and Node.js versions, the operating system, the commands run, and
what an attacker gains. **Never include the contents of your SNACK database, spool, configuration,
or export.** If a file matters to the report, describe its shape; a maintainer will ask for a
reduced sample if one is needed.

Expect an acknowledgement within seven days and an assessment within thirty. Reports are credited in
the advisory unless you ask otherwise.

## Supported versions

Only the latest published minor is supported. Pre-`1.0.0` releases carry no backport guarantee: a
fix ships in the next release from `main`.

## What counts as a vulnerability

SNACK's security properties are the invariants it is built on, so a break in any of them is a
vulnerability and not a bug report:

- **Content leaves the machine.** SNACK makes no network calls and sends no telemetry. Any outbound
  connection is a vulnerability.
- **Content reaches an artifact.** Prompt text, response text, project paths, titles, or credentials
  appearing in the database, the spool, a log, a backup, or an export. This holds for error messages
  too: a rejected value must not be echoed back.
- **Private files stop being private.** Configuration, database, backups, and spool files are
  created `0600` and lock directories `0700`. A path that creates something more permissive, or a
  race in which a file is briefly readable, is a vulnerability.
- **The plugin escapes its bounds.** `@snack-ai/opencode` must never throw into OpenCode, block it,
  read its credentials, or write outside SNACK's own spool.
- **Ingestion guesses.** An unknown source schema or spool version must refuse rather than
  interpret. Writing canonical rows from a shape SNACK does not recognize is a vulnerability,
  because everything downstream then carries a fabricated meaning.
- **Stored history is altered.** Prediction attempts and deliveries are immutable; only
  `snack data purge` deletes, and only within the scope it previewed.

## What does not count

- An estimate that turns out wrong. SNACK forecasts with a stated interval and evidence level; being
  wrong inside that interval is the design, and calibration is auditable through `snack export`.
- Someone with your user account reading your SNACK data. File permissions defend against other
  users on the machine, not against your own session.
- A denial of service from feeding SNACK a corrupt local database you already control.
