# 02 — purge warned about a plugin that was never registered

Status: done Severity: P3

## Report

`snack data purge --include-config` always emitted the `plugin_still_registered` warning, telling
the user to run `snack setup opencode` to stop a plugin that was not running. `doctor` reported the
opposite on the same installation, and a Claude-only installation was told about an OpenCode plugin
it had never had.

Carried from Stage 8, where it was documented rather than fixed.

## Cause

`removePurgedSources` returned the warning unconditionally after a successful configuration write.

## Fix

Gated on `inspectPluginRegistration`, the reader `doctor` already uses, so the two commands cannot
disagree about what is registered.

## Comments

Fixed in Stage 9 Wave 1. Covered by `packages/cli/test/purge.test.js` in both directions -- the
registered case still warns -- and confirmed against the installed binary.
