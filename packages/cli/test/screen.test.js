import assert from "node:assert/strict";
import { closeSync, openSync, readFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import fc from "fast-check";

import { ENTER, RESTORE, createScreen } from "../src/screen.js";
import { makeVirtualScreen } from "./fixtures/fake-screen.js";

/** A write port that keeps every chunk, so "one frame is one write" is checkable. */
function sink() {
  /** @type {string[]} */
  const writes = [];
  return {
    writes,
    /** @param {string} chunk */
    write(chunk) {
      writes.push(chunk);
    },
  };
}

test("entering takes the alternate buffer, hides the cursor and clears it", () => {
  const out = sink();
  const screen = createScreen(out);
  screen.enter();
  assert.deepEqual(out.writes, [ENTER]);
  assert.ok(ENTER.includes("\u001B[?1049h"));
  assert.ok(ENTER.includes("\u001B[?25l"));
  assert.ok(RESTORE.endsWith("\u001B[?25h\u001B[?1049l"));
});

test("the first frame paints every row, in one write", () => {
  const out = sink();
  const screen = createScreen(out);
  screen.enter();
  screen.frame(["one", "two", "three"]);
  assert.equal(out.writes.length, 2);
  assert.equal(
    out.writes[1],
    "\u001B[1;1Hone\u001B[K\u001B[2;1Htwo\u001B[K\u001B[3;1Hthree\u001B[K\u001B[4;1H\u001B[J",
  );
});

test("an identical frame writes zero bytes", () => {
  const out = sink();
  const screen = createScreen(out);
  screen.frame(["one", "two"]);
  const before = out.writes.length;
  screen.frame(["one", "two"]);
  assert.equal(out.writes.length, before, "no write at all, not an empty one");
});

test("a frame that changes one row writes that row alone", () => {
  const out = sink();
  const screen = createScreen(out);
  screen.frame(["header", "synced 12s ago", "row", "footer"]);
  screen.frame(["header", "synced 13s ago", "row", "footer"]);
  assert.equal(out.writes.at(-1), "\u001B[2;1Hsynced 13s ago\u001B[K");
});

test("only the changed rows are written, each with its own cursor move", () => {
  const out = sink();
  const screen = createScreen(out);
  screen.frame(["a", "b", "c", "d"]);
  screen.frame(["a", "B", "c", "D"]);
  assert.equal(out.writes.at(-1), "\u001B[2;1HB\u001B[K\u001B[4;1HD\u001B[K");
});

test("a shorter frame clears below its last row once", () => {
  const out = sink();
  const screen = createScreen(out);
  screen.frame(["a", "b", "c", "d"]);
  screen.frame(["a", "b"]);
  const last = String(out.writes.at(-1));
  assert.equal(last, "\u001B[3;1H\u001B[J");
  assert.equal(last.split("\u001B[J").length - 1, 1);
});

test("a longer frame writes only the new rows", () => {
  const out = sink();
  const screen = createScreen(out);
  screen.frame(["a"]);
  screen.frame(["a", "b"]);
  assert.equal(out.writes.at(-1), "\u001B[2;1Hb\u001B[K");
});

test("invalidate makes the next frame a full repaint", () => {
  const out = sink();
  const screen = createScreen(out);
  screen.frame(["a", "b"]);
  screen.invalidate();
  screen.frame(["a", "b"]);
  assert.equal(out.writes.at(-1), "\u001B[1;1Ha\u001B[K\u001B[2;1Hb\u001B[K\u001B[3;1H\u001B[J");
});

test("leaving restores the terminal once, however often it is asked", () => {
  const out = sink();
  const screen = createScreen(out);
  screen.enter();
  screen.leave();
  screen.leave();
  assert.deepEqual(out.writes, [ENTER, RESTORE]);
});

test("leaving a screen never entered writes nothing", () => {
  const out = sink();
  createScreen(out).leave();
  assert.deepEqual(out.writes, []);
});

test("after leaving, a frame repaints in full on the next enter", () => {
  const out = sink();
  const screen = createScreen(out);
  screen.enter();
  screen.frame(["a"]);
  screen.leave();
  screen.enter();
  screen.frame(["a"]);
  assert.equal(out.writes.at(-1), "\u001B[1;1Ha\u001B[K\u001B[2;1H\u001B[J");
});

test("whatever the frames before it, the terminal shows the last frame and nothing else", () => {
  const line = fc.stringMatching(/^[a-z ]{0,12}$/u).map((text) => text.trimEnd());
  fc.assert(
    fc.property(
      fc.array(fc.array(line, { maxLength: 8 }), { minLength: 1, maxLength: 6 }),
      fc.boolean(),
      (frames, invalidate) => {
        const terminal = makeVirtualScreen({ columns: 20, rows: 10 });
        const screen = createScreen(terminal);
        screen.enter();
        for (const [index, lines] of frames.entries()) {
          if (invalidate && index % 2 === 1) screen.invalidate();
          screen.frame(lines);
        }
        const last = /** @type {string[]} */ (frames.at(-1));
        const expected = [...last, ...Array.from({ length: 10 - last.length }, () => "")];
        assert.equal(terminal.text(), expected.join("\n"));
      },
    ),
  );
});

test("the synchronous restore writes the restore bytes to a descriptor, once", async () => {
  const directory = await mkdtemp(join(tmpdir(), "snack-screen-"));
  try {
    const file = join(directory, "tty");
    const fd = openSync(file, "w");
    const out = sink();
    const screen = createScreen(out);
    screen.enter();
    screen.restoreSync(fd);
    screen.restoreSync(fd);
    screen.leave();
    closeSync(fd);
    assert.equal(readFileSync(file, "utf8"), RESTORE);
    assert.deepEqual(out.writes, [ENTER], "leave after a synchronous restore writes nothing");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
