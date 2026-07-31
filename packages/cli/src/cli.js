#!/usr/bin/env node

import { run } from "./main.js";

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

process.exitCode = await run(process.argv);
