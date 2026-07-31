# Security Policy

Thank you for taking the time to look at SNACK's security. Reports are genuinely welcome, including
uncertain ones — if something looks wrong to you, it is worth sending.

## Reporting a vulnerability

The best channel is GitHub's private advisory form:
<https://github.com/Duck1201/snack/security/advisories/new>. It keeps the details between us while a
fix is prepared, which is why a public issue or a proof of concept posted publicly is worth
avoiding: once the defect is described in the open, users are exposed before there is anything for
them to upgrade to.

Without a GitHub account, you can open an issue saying only that you have a security report and
asking for a private channel, and a maintainer will set one up. Please leave the details out of that
first message.

Helpful things to include, as far as you have them:

- the SNACK and Node.js versions, and the operating system;
- the commands you ran;
- what an attacker would gain.

One request: please keep the contents of your SNACK database, spool, configuration, or exports out
of the report. They are yours and they may hold more than you expect. Describing the shape of a file
is usually enough, and a maintainer will ask for a reduced sample if the report really needs one.

You can expect an acknowledgement within seven days and an assessment within thirty. Reporters are
credited in the advisory unless you would rather not be.

## Supported versions

The latest published minor receives fixes. Before `1.0.0` there are no backports to earlier
versions: a fix ships in the next release from `main`.

## In scope

SNACK's security properties are the invariants it is built on, so a break in any of these is treated
as a vulnerability rather than an ordinary bug:

- **Content leaving the machine.** SNACK makes no network calls and sends no telemetry, so any
  outbound connection qualifies.
- **Content reaching an artifact.** Prompt text, response text, project paths, titles, or
  credentials appearing in the database, the spool, a log, a backup, or an export. Error messages
  count too — a rejected value should not be echoed back.
- **Private files becoming readable.** Configuration, database, backups, and spool files are created
  `0600`, and lock directories `0700`. Anything that creates something more permissive qualifies,
  including a race where a file is briefly readable.
- **The plugin exceeding its bounds.** `@snack-ai/opencode` should never throw into OpenCode, block
  it, read its credentials, or write outside SNACK's own spool.
- **Ingestion guessing.** An unknown source schema or spool version is meant to refuse rather than
  interpret. Writing canonical rows from an unrecognized shape qualifies, because everything
  downstream then carries a meaning that was invented.
- **Stored history changing.** Prediction attempts and deliveries are immutable; only
  `snack data purge` deletes, and only within the scope it previewed.

## Out of scope

These are worth reporting as ordinary issues rather than security reports:

- An estimate that turns out wrong. SNACK forecasts with a stated interval and evidence level, and
  being wrong inside that interval is the design; calibration is auditable through `snack stats` and
  `snack export`.
- Someone already signed in as you reading your SNACK data. File permissions defend against other
  users on the machine, not against your own session.
- A crash or hang caused by feeding SNACK a corrupt local database that you control.

If you are unsure which side of that line something falls on, send it privately anyway. A
misclassified report is easy to redirect; a public one cannot be taken back.
