/**
 * A virtual terminal for the bytes `src/screen.js` emits: a `rows × columns` grid that applies the
 * cursor-addressing subset the dash uses (absolute moves, erase to end of line, erase below) and
 * drops every other escape -- colour, the alternate buffer, the cursor's visibility.
 *
 * Assertions made against it are about what a reader would see, not about bytes: a row the frame
 * diff skipped still shows what the previous frame left there.
 *
 * @param {{columns: number, rows: number}} size
 */
export function makeVirtualScreen(size) {
  /** @type {string[][]} */
  const grid = Array.from({ length: size.rows }, () =>
    Array.from({ length: size.columns }, () => " "),
  );
  let row = 0;
  let column = 0;

  /** @param {number} from */
  function eraseLine(from) {
    const line = grid[row];
    if (line === undefined) return;
    for (let at = from; at < size.columns; at += 1) line[at] = " ";
  }

  return {
    /** @param {string} chunk */
    write(chunk) {
      // eslint-disable-next-line no-control-regex -- the escape sequences are what is parsed
      for (const [token] of chunk.matchAll(/\u001B\[[?0-9;]*[A-Za-z]|[\s\S]/gu)) {
        if (!token.startsWith("\u001B[")) {
          const line = grid[row];
          if (line !== undefined && column < size.columns) line[column] = token;
          column += 1;
          continue;
        }
        const command = token.at(-1);
        const parameters = token.slice(2, -1);
        if (command === "H") {
          const [line = "1", col = "1"] = parameters.split(";");
          row = Number(line || 1) - 1;
          column = Number(col || 1) - 1;
        } else if (command === "K") {
          eraseLine(column);
        } else if (command === "J") {
          if (parameters === "2") {
            for (const line of grid) line.fill(" ");
          } else {
            eraseLine(column);
            for (let below = row + 1; below < size.rows; below += 1) grid[below]?.fill(" ");
          }
        }
      }
    },
    /** The screen as text, one line per row, trailing blanks trimmed. */
    text() {
      return grid.map((line) => line.join("").trimEnd()).join("\n");
    },
  };
}
