#!/usr/bin/env node

import { run } from "./main.js";
import { renderQuestion } from "./terminal-prompt.js";

// A reader that stops early — `snack export --output - | head`, `| jq`, a closed pager — closes
// the pipe under a command that is still writing. Node surfaces that as an unhandled EPIPE on
// the stdout socket, which would replace the output with a stack trace. Ending quietly is what
// every other Unix tool does, and it is the only sensible answer: the consumer got what it
// asked for.
for (const stream of [process.stdout, process.stderr]) {
  stream.on("error", (error) => {
    if (/** @type {NodeJS.ErrnoException} */ (error).code !== "EPIPE") throw error;
  });
}

/** Control flow cannot see the assignment inside `prompt`, so the handle lives in a holder. */
const session =
  /** @type {{terminal: {question(query: string): Promise<string>, close(): void} | null}} */ ({
    terminal: null,
  });

/**
 * Ask one question on the terminal.
 *
 * Wired up only here, at the real I/O boundary, so command tests can script the answers. What the
 * question looks like and how the answer reads belong to `renderQuestion`; this keeps only the
 * readline handle, which is the part no test can hold.
 *
 * One interface serves the whole run and is closed once at the end. Opening and closing one
 * per question pauses stdin between them, and the next question then waits forever.
 *
 * @type {import("./main.js").SetupPrompt}
 */
async function prompt(question) {
  if (session.terminal === null) {
    const { createInterface } = await import("node:readline/promises");
    session.terminal = createInterface({ input: process.stdin, output: process.stdout });
  }
  const rendered = renderQuestion(question);
  for (const line of rendered.lines) process.stdout.write(`${line}\n`);
  return rendered.parse(await session.terminal.question(rendered.prompt));
}

try {
  process.exitCode = await run(process.argv, {
    ...(process.stdin.isTTY === true ? { prompt } : {}),
  });
} finally {
  session.terminal?.close();
}
