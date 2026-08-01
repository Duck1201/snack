/**
 * Render one guided-setup question for a terminal, and read back what was typed.
 *
 * Kept apart from `cli.js` because that file is the executable and cannot be imported without
 * running the CLI. Everything here is a pure function of the question, so the order the lines come
 * out in — and the rule for reading an answer — are ordinary tests rather than a behaviour only a
 * real terminal ever exercises. Command tests inject their own prompt port, so this is the one
 * place the wording of a real question is decided.
 *
 * @param {{id: string, message: string, choices?: {value: string, label: string}[], default?: string}} question
 */
export function renderQuestion(question) {
  const choices = question.choices ?? [];
  const suffix = question.default === undefined ? "" : ` [${question.default}]`;
  // A question with choices needs its own line, or the list reads as the answer to whatever came
  // before it. The cursor then sits on a short label rather than the question repeated in full.
  const label = choices.length === 0 ? question.message : question.id.replaceAll("_", " ");
  return {
    lines: choices.length === 0 ? [] : [question.message, ...choices.map(numbered)],
    prompt: `${label}${suffix}: `,
    /** @param {string} answer */
    parse(answer) {
      const typed = answer.trim();
      if (typed === "") return question.default ?? "";
      return choices[Number(typed) - 1]?.value ?? typed;
    },
  };
}

/**
 * @param {{value: string, label: string}} choice
 * @param {number} index
 */
function numbered(choice, index) {
  return `  ${index + 1}) ${choice.label}`;
}
