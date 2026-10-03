import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";

import { supportMatrixIncomplete } from "./support-matrix-gate.mjs";

test("a support matrix blocks the release until its Status line says complete", () => {
  assert.equal(supportMatrixIncomplete("# Matrix\n\nStatus: complete.\n"), false);
  assert.equal(supportMatrixIncomplete("# Matrix\n\nStatus: in progress.\n"), true);
  // "incomplete" is not "complete", and a sentence further down does not count for the line.
  assert.equal(supportMatrixIncomplete("Status: incomplete.\n"), true);
  assert.equal(supportMatrixIncomplete("Status: pending.\nthis says complete\n"), true);
  // A page with no Status line at all has not said it is finished.
  assert.equal(supportMatrixIncomplete("# Matrix\n"), true);
});

test("every client's published matrix is held to the gate", async () => {
  const script = await readFile(new URL("./check-release-readiness.mjs", import.meta.url), "utf8");
  for (const page of ["claude-support.md", "codex-support.md"]) {
    assert.ok(script.includes(`../docs/${page}`), `the readiness script never reads ${page}`);
  }
  assert.match(script, /supportMatrixIncomplete\(codexSupport\)/u);

  // The Claude page has finished its validation; the gate must not block a release on it.
  const claude = await readFile(new URL("../docs/claude-support.md", import.meta.url), "utf8");
  assert.equal(supportMatrixIncomplete(claude), false);
});
