import assert from "node:assert/strict";
import { test } from "node:test";

import { compareArtifacts } from "./release-evidence.mjs";

// The claim `docs/release/artifacts.md` publishes is that packing the same source twice produces
// the same bytes. What makes that claim useful is naming the entry that moved when it does not --
// an outer tarball digest that differs tells you something changed and nothing about what, and the
// whole point of the evidence is to be actionable at three in the morning before a release.

test("two identical packs report nothing", () => {
  const entries = { "package.json": "aaa", "src/cli.js": "bbb" };
  assert.deepEqual(compareArtifacts(entries, { ...entries }), []);
});

test("the entry whose content moved is the one named", () => {
  assert.deepEqual(
    compareArtifacts(
      { "package.json": "aaa", "src/cli.js": "bbb" },
      { "package.json": "aaa", "src/cli.js": "ccc" },
    ),
    ["src/cli.js"],
  );
});

test("an entry present in only one pack is a difference, not a match", () => {
  // A file that appears or vanishes between two packs is the more alarming case of the two: it
  // means `files` resolved differently, which changes what a consumer downloads.
  assert.deepEqual(compareArtifacts({ "a.js": "aaa" }, { "a.js": "aaa", "b.js": "bbb" }), ["b.js"]);
  assert.deepEqual(compareArtifacts({ "a.js": "aaa", "b.js": "bbb" }, { "a.js": "aaa" }), ["b.js"]);
});

test("every differing entry is reported, in a stable order", () => {
  // Reported as a set rather than as the first failure: a release wants the whole list in one pass,
  // and a stable order is what makes two runs of the evidence comparable.
  assert.deepEqual(compareArtifacts({ b: "1", a: "1", c: "1" }, { b: "2", a: "2", c: "1" }), [
    "a",
    "b",
  ]);
});
