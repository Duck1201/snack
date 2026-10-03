import assert from "node:assert/strict";
import { test } from "node:test";

import { changelogSection } from "./release-notes.mjs";

const changelog = `# @snack-ai/cli

## 1.2.1

### Patch Changes

- abc1234: The fix.

## 1.2.0

### Minor Changes

- def5678: The feature.
`;

test("the section is the body under the version heading, up to the next one", () => {
  assert.equal(changelogSection(changelog, "1.2.1"), "### Patch Changes\n\n- abc1234: The fix.");
});

test("the last section runs to the end of the file", () => {
  assert.equal(
    changelogSection(changelog, "1.2.0"),
    "### Minor Changes\n\n- def5678: The feature.",
  );
});

test("a version that was never cut has no section, rather than a neighbour's", () => {
  assert.equal(changelogSection(changelog, "1.2.2"), null);
  // `1.2.1` must not match `1.2.10`: the heading is compared whole.
  assert.equal(changelogSection("## 1.2.10\n\nlater\n", "1.2.1"), null);
});
