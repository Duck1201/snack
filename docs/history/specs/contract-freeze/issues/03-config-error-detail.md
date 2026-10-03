# 03 — a rejected configuration said only where, never why

Status: done Severity: P3

## Report

An unknown adapter, a missing required field and a malformed identifier all answered with
`Configuration schema rejected /sources/0.`, and the JSON error object carried no more detail than
the human line -- one reason code, `config_schema_error`, for every kind of mistake. The location
alone does not say whether to add a field, correct a value, or stop naming a client SNACK has never
heard of.

Carried from Stage 8, where it was documented rather than fixed.

## Fix

Each rule now has its own reason code and a sentence naming it: `config_schema_required`,
`config_schema_pattern`, `config_schema_unsupported_value`, `config_schema_type`,
`config_schema_unknown_property`, with `config_schema_error` remaining for anything unmapped. The
codes are named in `config.js` rather than derived from Ajv's keyword, because they are frozen as a
public contract and `enum` and `const` are two spellings of one answer.

Choosing which Ajv error to report needed a rule of its own. A field's own declaration beats a
`oneOf` branch: an unsupported adapter fails every branch, so the branch errors accused whichever
field that branch happened to pin -- reporting the fingerprint for a mistyped client name.

The rejected value never appears in the message. A configuration is exactly where a private path
would sit.

## Comments

Fixed in Stage 9 Wave 1. Covered by `packages/cli/test/config.test.js` and confirmed against the
installed binary.
