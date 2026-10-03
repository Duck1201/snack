import assert from "node:assert/strict";
import { test } from "node:test";

import { packResults } from "./npm-pack.mjs";

const result = { filename: "snack-ai-cli-1.2.0.tgz", files: [{ path: "package.json" }] };

test("npm 11 prints an array, and the first entry is the package", () => {
  assert.deepEqual(packResults(JSON.stringify([result])), [result]);
});

test("npm 12 prints an object keyed by package name, and reads the same", () => {
  assert.deepEqual(packResults(JSON.stringify({ "@snack-ai/cli": result })), [result]);
});

test("anything else is refused rather than read as an empty pack", () => {
  assert.throws(() => packResults("null"), /neither an array nor an object/u);
  assert.throws(() => packResults('"snack-ai-cli-1.2.0.tgz"'), /neither an array nor an object/u);
});
