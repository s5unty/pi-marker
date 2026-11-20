import assert from "node:assert/strict";
import test from "node:test";
import { HStack, Text, VStack, visibleWidth } from "@earendil-works/pi-tui";
import { assistantEntry, harness, highlightedText } from "./helpers.ts";

test("a multi-line stroke skips thinking and tool rows while retaining separate text blocks", () => {
  const first = assistantEntry("Alpha answer");
  first.message.content = [
    { type: "text", text: "Alpha answer" },
    { type: "thinking", thinking: "hidden reasoning" },
    { type: "text", text: "Beta answer" },
  ];
  const h = harness([first, assistantEntry("Gamma answer")]);
  try {
    h.chat.children.splice(1, 0, new Text("tool-only row", 1, 0));
    h.tui.renderNow();
    const start = h.locate("Alpha answer");
    const end = h.locate("Gamma answer");
    h.mouse(0, start.start, start.row);
    h.mouse(32, end.end, end.row);
    h.mouse(0, end.end, end.row, true);
    assert.equal(h.spans.length, 3);
    assert.deepEqual(h.spans.slice(0, 2).map((span) => span.blockIndex), [0, 2]);
    assert.equal(highlightedText(h.tui.getScreenLines()), "Alpha answerBeta answerGamma answer");
  } finally { h.close(); }
});

test("auto-scrolling a drag uses document coordinates, not old viewport rows", () => {
  const h = harness([assistantEntry(Array.from({ length: 40 }, (_, index) => `Line ${String(index).padStart(2, "0")} marker words`).join("\n\n"))]);
  try {
    h.scroll.scrollToStart();
    h.tui.renderNow();
    const start = h.locate("Line 00");
    h.mouse(0, start.start, start.row);
    const edge = h.terminal.rows - 2;
    h.mouse(32, 10, edge);
    const native = h.tui as unknown as { autoScrollSelection(): void };
    for (let index = 0; index < 5; index++) { native.autoScrollSelection(); h.tui.renderNow(); }
    assert.ok(h.scroll.scrollTop > 0);
    h.mouse(0, 10, edge, true);
    assert.equal(h.spans.length, 1);
    assert.equal(h.spans[0].start, 0);
    assert.ok(h.spans[0].end > 100);
    h.scroll.scrollToStart();
    h.tui.renderNow();
    assert.ok(highlightedText(h.tui.getScreenLines()).includes("Line 00"));
    assert.deepEqual(h.reports, []);
  } finally { h.close(); }
});

test("nonzero transcript origins and visible scrollbars do not shift highlights", () => {
  const h = harness();
  try {
    h.scroll.setScrollbar("always");
    h.tui.setLayoutRoot(new VStack([
      new Text("top header", 0, 0),
      { component: new HStack([{ component: new Text("sidebar", 0, 0), basis: 9 }, { component: h.scroll, grow: 1, basis: 0 }]), grow: 1, basis: 0 },
      new Text("editor", 0, 0),
    ]));
    h.tui.renderNow();
    h.drag("中文测试");
    assert.equal(highlightedText(h.tui.getScreenLines()), "中文测试");
    assert.ok(h.tui.getScreenLines().every((line) => visibleWidth(line) <= h.terminal.columns));
    h.scroll.setScrollbar("auto");
    h.tui.renderNow();
    assert.equal(highlightedText(h.tui.getScreenLines()), "中文测试");
  } finally { h.close(); }
});

test("code, list and blockquote text remains anchored after Markdown reflow", () => {
  const h = harness([assistantEntry("# Heading\n\n- Some list words around the target phrase and more wrapping words.\n\n> Quote words around another target phrase and wrapping words.\n\n```ts\nconst example = 'code target';\n```\n")]);
  try {
    h.drag("target phrase", false, 0);
    h.drag("code target");
    h.terminal.resize(30, 30);
    h.tui.renderNow();
    assert.equal(h.adapter.diagnostics.mapped, 2);
    assert.equal(highlightedText(h.tui.getScreenLines()).replaceAll(" ", ""), "targetphrasecodetarget");
  } finally { h.close(); }
});
