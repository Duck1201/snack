import { writeSync } from "node:fs";

/**
 * The screen buffer behind `snack dash`: the alternate buffer, a hidden cursor, and a frame diff.
 *
 * Lines arrive already fitted to the terminal by the view (`dash-view.js`); nothing here measures,
 * wraps or colours. What this module owns is the byte stream: a frame is compared row by row with
 * the previous one and only the rows that differ are rewritten, so a redraw once a second whose
 * only change is "synced 12s ago" becoming "synced 13s ago" costs one row, and a frame identical to
 * the last costs nothing at all. Every byte of one frame leaves in one `write`, so a terminal never
 * shows half a frame.
 */

/** Alternate buffer on, cursor hidden, the buffer cleared and the cursor home. */
export const ENTER = "\u001B[?1049h\u001B[?25l\u001B[2J\u001B[H";

/** Attributes reset, cursor shown, alternate buffer off: the terminal as it was found. */
export const RESTORE = "\u001B[0m\u001B[?25h\u001B[?1049l";

/**
 * @typedef {object} Screen
 * @property {() => void} enter
 * @property {(lines: string[]) => void} frame
 * @property {() => void} invalidate Forget the previous frame: the next one repaints every row.
 * @property {() => void} leave Idempotent; writes nothing for a screen not entered.
 * @property {(fd: number) => void} restoreSync The last resort from `process.on("exit")`.
 */

/**
 * @param {{write(chunk: string): unknown}} out
 * @returns {Screen}
 */
export function createScreen(out) {
  /** @type {string[] | null} */
  let previous = null;
  let entered = false;

  return {
    enter() {
      out.write(ENTER);
      entered = true;
      previous = null;
    },
    frame(lines) {
      const chunk = diff(previous, lines);
      previous = [...lines];
      if (chunk !== "") out.write(chunk);
    },
    invalidate() {
      previous = null;
    },
    leave() {
      if (!entered) return;
      entered = false;
      previous = null;
      out.write(RESTORE);
    },
    restoreSync(fd) {
      if (!entered) return;
      entered = false;
      previous = null;
      writeSync(fd, RESTORE);
    },
  };
}

/**
 * The bytes that turn the `previous` frame into `next`.
 *
 * Each changed row is addressed absolutely (`ESC[row;1H`) and closed with erase-to-end-of-line,
 * which clears whatever a longer old row left to the right. Rows below a shorter frame are cleared
 * once with erase-below. With no previous frame -- the first one, or after `invalidate` -- the
 * screen's content is unknown, so every row is written and everything below is cleared.
 *
 * @param {string[] | null} previous
 * @param {string[]} next
 */
function diff(previous, next) {
  let chunk = "";
  for (const [index, line] of next.entries()) {
    if (previous !== null && previous[index] === line) continue;
    chunk += `\u001B[${index + 1};1H${line}\u001B[K`;
  }
  if (previous === null || previous.length > next.length) {
    chunk += `\u001B[${next.length + 1};1H\u001B[J`;
  }
  return chunk;
}
