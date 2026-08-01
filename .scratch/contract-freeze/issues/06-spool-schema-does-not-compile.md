# 06 — The published spool schema did not compile under the product's own Ajv

Status: done Severity: P2

## Report

`schemas/spool-event.schema.json` is shipped by both packages and named in `docs/compatibility.md`
as one of the six frozen public contracts. Compiling it with the Ajv configuration the product
itself uses — `{ allErrors: true, strict: true }`, the one `config.js` validates configuration with
— throws:

```
strict mode: missing type "array" for keyword "maxItems"
  at .../spool-event/v1#/allOf/0/then/properties/restrictions (strictTypes)
```

So a downstream consumer following SNACK's own conventions gets a compile error rather than a
validator. Nothing in the product validates against this file at runtime — the two hand-written
predicates in `spool.js` and `plugin.js` do that work — which is exactly why nobody had ever
compiled it.

Found while writing the Stage 9 Wave 2 property test that uses the schema as the arbiter between
those two hand-written validators.

## Cause

The conditional branches use `maxItems` and `minItems` on `restrictions`, and `properties` and
`required` inside `if`/`then`, without restating the type at that level. The root schema declares
both types, but Ajv strict checks each subschema on its own.

The same trap the `snack-public-contract-schemas` skill records for the envelope's per-command
routing, met again in the one schema that had no test compiling it.

## Fix

`"type": "object"` on every `if` and `then`, and `"type": "array"` on `restrictions` wherever a
branch constrains its length. Written to both packages from one source so the byte-identical
assertion in `contracts.test.js` still holds.

**This does not reset the Stage 9 freeze.** The added types were already implied by the root schema,
which declares the document an object and `restrictions` an array, so the set of documents the
schema accepts is unchanged. It is a correction to the form of the contract, not to what the
contract says.

## Comments

Fixed in Stage 9 Wave 2. Covered by
`every event the published schema accepts is an event this reader reads` in
`packages/cli/test/spool.property.test.js`, which compiles the schema with the product's own Ajv
configuration — so the schema failing to compile is now a test failure rather than a downstream
consumer's problem.

That test also closes the gap the plan named: the spool has three descriptions of a valid event —
the shared schema, the plugin's check on the way in, and the reader's on the way out — and only the
schema is the contract. A reader stricter than the contract would drop conforming events as
rejections, which reads as corruption rather than as disagreement.
