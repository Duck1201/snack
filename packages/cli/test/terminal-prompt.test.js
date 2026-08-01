import assert from "node:assert/strict";
import { test } from "node:test";

import { renderQuestion } from "../src/terminal-prompt.js";

test("a question is asked before its choices are offered", () => {
  const rendered = renderQuestion({
    id: "plan_profile",
    message: "Which billing archetype should the initial prior assume?",
    choices: [
      { value: "generic", label: "generic - neutral weighting" },
      { value: "subscription-window", label: "subscription-window - flat subscription" },
    ],
    default: "generic",
  });

  assert.deepEqual(rendered.lines, [
    "Which billing archetype should the initial prior assume?",
    "  1) generic - neutral weighting",
    "  2) subscription-window - flat subscription",
  ]);
  // The cursor sits on a short label taken from the question id, so a long question does not have
  // to be repeated to say what is being answered.
  assert.equal(rendered.prompt, "plan profile [generic]: ");
});

test("a question without choices keeps its single line", () => {
  const rendered = renderQuestion({
    id: "profile",
    message: "Name the local account or profile this maps to",
    default: "default",
  });

  assert.deepEqual(rendered.lines, []);
  assert.equal(rendered.prompt, "Name the local account or profile this maps to [default]: ");
});

test("a question with no default offers none", () => {
  const rendered = renderQuestion({ id: "alias", message: "Name this capacity source" });

  assert.equal(rendered.prompt, "Name this capacity source: ");
});

test("an answer is a choice number, a choice value, or anything else typed", () => {
  const { parse } = renderQuestion({
    id: "prospective_analysis",
    message: "Analyze unsent prompts locally for size only?",
    choices: [
      { value: "yes", label: "yes" },
      { value: "no", label: "no" },
    ],
    default: "no",
  });

  assert.equal(parse("1"), "yes");
  assert.equal(parse("2"), "no");
  assert.equal(parse("yes"), "yes");
  assert.equal(parse("  yes  "), "yes");
  // Out of range is not silently taken for a neighbouring choice.
  assert.equal(parse("3"), "3");
  assert.equal(parse("0"), "0");
});

test("an empty answer takes the offered default", () => {
  const withDefault = renderQuestion({ id: "alias", message: "Name this", default: "work" });
  const without = renderQuestion({ id: "alias", message: "Name this" });

  assert.equal(withDefault.parse(""), "work");
  assert.equal(withDefault.parse("   "), "work");
  assert.equal(without.parse(""), "");
});
