# 01 — doctor gave an unknown alias a clean bill of health

Status: done Severity: P3

## Report

`snack doctor --source <alias-that-does-not-exist>` exited 0 and reported twelve passing checks.
Every other command refuses an unknown alias with exit 4. A typo therefore came back as a healthy
installation, which is the opposite of what the command exists to say.

Carried from Stage 8, where it was documented rather than fixed, and assigned to Stage 9 because
that is where the CLI surface is frozen and audited.

## Cause

`runDoctor` filtered the configured sources by the requested alias and looped over the result. An
alias nobody answers to selected nothing, so the per-source checks were skipped and every check that
remained -- runtime, permissions, storage, plugin registration -- was about the installation and
passed.

## Fix

The guard already existed, written inline in `buildExportScope`. Moved to `config.js` as
`requireConfiguredSource` and called from both, so a command cannot restate it by omission. It
refuses without echoing the alias back: argv is where a private value gets pasted by accident.

## Comments

Fixed in Stage 9 Wave 1. Covered by `packages/cli/test/doctor.test.js` and confirmed against the
installed binary.
