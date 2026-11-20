import assert from "node:assert/strict";
import test from "node:test";
import { stripTerminalSequences, visibleWidth } from "@earendil-works/pi-tui";
import { paintLine } from "../src/text-map.ts";
import { assistantEntry, componentFor, harness, highlightedText } from "./helpers.ts";

test("ANSI inside an emoji or combining cluster cannot delete output", () => {
  for (const line of ["👩\x1b[1m🏽‍💻", "e\x1b[31ḿ", "A 👩\x1b[1m🏽‍💻 B", "\x1b[34mX e\x1b[0ḿ tail"]) {
    const result = paintLine(line, [{ start: 0, end: 99 }]);
    assert.equal(stripTerminalSequences(result), stripTerminalSequences(line));
    assert.equal(visibleWidth(result), visibleWidth(line));
    assert.equal(highlightedText([result]), stripTerminalSequences(line));
  }
});

test("identical pixels from a replacement message do not retarget an ongoing drag", () => {
  const h = harness([assistantEntry("identical answer text")]);
  try {
    const { row, start, end } = h.locate("answer");
    h.mouse(0, start, row);
    const replacement = assistantEntry("identical answer text");
    h.chat.clear();
    h.chat.addChild(componentFor(replacement));
    h.branch = [replacement];
    h.tui.renderNow();
    h.mouse(32, end, row);
    h.mouse(0, end, row, true);
    assert.equal(h.spans.length, 0);
    assert.match(h.reports[0], /发生变化/);
  } finally { h.close(); }
});

test("a source update before a pending render cannot use stale displayed coordinates", () => {
  const entry = assistantEntry("original visible phrase");
  const h = harness([entry]);
  try {
    const { row, start, end } = h.locate("visible");
    h.mouse(0, start, row);
    h.mouse(32, end, row);
    if (entry.message.role !== "assistant") throw new Error("fixture");
    h.components[0].updateContent({ ...entry.message, content: [{ type: "text", text: "replaced content phrase" }] }, false);
    // Deliberately release before rendering the queued content update.
    h.terminal.send(`\x1b[<0;${end + 1};${row + 1}m`);
    h.tui.renderNow();
    assert.equal(h.spans.length, 0);
    assert.match(h.reports[0], /发生变化/);
  } finally { h.close(); }
});

test("a later wrapper is not overwritten on disposal", () => {
  const h = harness();
  try {
    const raw = h.tui as unknown as { applySearchHighlights(...args: unknown[]): string[] };
    const previous = raw.applySearchHighlights;
    const later = function (this: unknown, ...args: unknown[]) { return previous.apply(this, args); };
    raw.applySearchHighlights = later;
    h.adapter.dispose();
    assert.equal(raw.applySearchHighlights, later);
    h.tui.renderNow();
    assert.deepEqual(h.reports, []);
  } finally { h.close(); }
});
