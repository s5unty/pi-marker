import assert from "node:assert/strict";
import test from "node:test";
import { Container, Text, TuiAltScreen, stripTerminalSequences } from "@earendil-works/pi-tui";
import { resolveRenderer } from "../src/pi-adapter.ts";
import { assistantEntry, componentFor, FakeTerminal, harness, highlightedText } from "./helpers.ts";

test("real Pi mouse pipeline commits and retains multiple marks without copying", () => {
  const h = harness();
  try {
    const original = h.tui.getScreenLines().map(stripTerminalSequences);
    h.drag("marker");
    assert.equal(h.spans.length, 1);
    assert.equal(h.tui.hasActiveSelection(), false);
    assert.equal(highlightedText(h.tui.getScreenLines()), "marker");
    h.drag("中文测试", true);
    assert.equal(h.spans.length, 2);
    assert.equal(highlightedText(h.tui.getScreenLines()), "marker中文测试");
    assert.deepEqual(h.copied, []);
    assert.deepEqual(h.tui.getScreenLines().map(stripTerminalSequences), original);
    assert.deepEqual(h.reports, []);
  } finally { h.close(); }
});

test("normal mode retains native copy behavior and old markers", async () => {
  const h = harness();
  try {
    h.drag("marker");
    h.mode = "off";
    h.drag("world");
    await Promise.resolve();
    assert.deepEqual(h.copied, ["world"]);
    assert.equal(h.spans.length, 1);
    assert.equal(h.tui.getCopyOnSelect(), true);
    assert.equal(highlightedText(h.tui.getScreenLines()), "marker");
  } finally { h.close(); }
});

test("real Markdown marks survive reflow, wide/combining characters and new output", () => {
  const entry = assistantEntry("This is a long response with **中文测试 👩🏽‍💻 é** and more words to force wrapping after resizing the terminal.");
  const h = harness([entry], true);
  try {
    h.drag("中文测试 👩🏽‍💻 é");
    assert.equal(h.spans.length, 1);
    assert.equal(h.spans[0].entryId, entry.id);
    h.terminal.resize(24, 20);
    h.tui.renderNow();
    assert.equal(highlightedText(h.tui.getScreenLines()).replaceAll(" ", ""), "中文测试👩🏽‍💻é");
    const next = assistantEntry("Another message.");
    h.chat.addChild(componentFor(next));
    h.branch = [entry, next];
    h.tui.renderNow();
    assert.equal(highlightedText(h.tui.getScreenLines()).replaceAll(" ", ""), "中文测试👩🏽‍💻é");
    assert.equal(h.adapter.diagnostics.mapped, 1);
  } finally { h.close(); }
});

test("same text in different messages never leaks highlights", () => {
  const h = harness([assistantEntry("Repeat this phrase."), assistantEntry("Repeat this phrase.")]);
  try {
    h.drag("Repeat this", false, 1);
    assert.equal(h.spans.length, 1);
    const marked = h.tui.getScreenLines().filter((line) => highlightedText([line]));
    assert.equal(marked.length, 1);
    assert.equal(highlightedText(marked), "Repeat this");
    h.chat.children.unshift(new Text("Inserted output", 0, 0));
    h.tui.renderNow();
    assert.equal(highlightedText(h.tui.getScreenLines()), "Repeat this");
  } finally { h.close(); }
});

test("changing content during a drag cancels instead of marking a shifted range", () => {
  const h = harness();
  try {
    const { row, start, end } = h.locate("marker");
    h.mouse(0, start, row);
    h.chat.children.unshift(new Text("New content", 0, 0));
    h.tui.renderNow();
    h.mouse(32, end, row);
    h.mouse(0, end, row, true);
    assert.equal(h.spans.length, 0);
    assert.match(h.reports[0], /发生变化/);
  } finally { h.close(); }
});

test("source changes or damaged anchors suppress decoration rather than retarget", () => {
  const h = harness();
  try {
    h.drag("marker");
    const saved = h.spans[0];
    h.spans = [{ ...saved, displayHash: "wrong" }];
    h.tui.renderNow();
    assert.equal(highlightedText(h.tui.getScreenLines()), "");
    h.spans = [{ ...saved, rangeHash: "wrong" }];
    h.tui.renderNow();
    assert.equal(highlightedText(h.tui.getScreenLines()), "");
  } finally { h.close(); }
});

test("tool-like output and streaming answers are not markable", () => {
  const h = harness();
  try {
    h.chat.addChild(new Text("tool result text", 1, 0));
    h.tui.renderNow();
    h.drag("tool result");
    assert.equal(h.spans.length, 0);
    const entry = assistantEntry("Streaming text");
    if (entry.message.role !== "assistant") throw new Error("fixture");
    h.components[0].updateContent(entry.message, true);
    h.tui.renderNow();
    h.drag("Streaming");
    assert.equal(h.spans.length, 0);
  } finally { h.close(); }
});

test("overlays cover markers rather than being painted over", () => {
  const h = harness();
  try {
    h.drag("marker");
    const overlay = h.tui.showOverlay(new Text("opaque overlay", 0, 0), { anchor: "top-left", width: "100%", maxHeight: "100%" });
    h.tui.renderNow();
    assert.equal(highlightedText(h.tui.getScreenLines().filter((line) => stripTerminalSequences(line).includes("opaque overlay"))), "");
    overlay.hide();
    h.tui.renderNow();
    assert.equal(highlightedText(h.tui.getScreenLines()), "marker");
  } finally { h.close(); }
});

test("dispose restores exact original methods and removes decorations", () => {
  const h = harness();
  try {
    h.drag("marker");
    h.adapter.dispose();
    assert.equal(Object.hasOwn(h.tui, "applySearchHighlights"), false);
    assert.equal(Object.hasOwn(h.tui, "handleSelectionMouseEvent"), false);
    assert.equal(Object.hasOwn(h.tui, "applySelection"), false);
    assert.equal(Object.hasOwn(h.tui, "handleViewportInput"), false);
    h.tui.renderNow();
    assert.equal(highlightedText(h.tui.getScreenLines()), "");
    h.drag("world");
    assert.equal(h.spans.length, 1);
  } finally { h.close(); }
});

test("keyboard fallback requires an unambiguous literal in the latest answer", () => {
  const h = harness([assistantEntry("repeat repeat unique phrase")]);
  try {
    assert.throws(() => h.adapter.markText("repeat"), /多次/);
    h.adapter.markText("unique phrase");
    h.tui.renderNow();
    assert.equal(highlightedText(h.tui.getScreenLines()), "unique phrase");
  } finally { h.close(); }
});

test("Escape cancels an owned drag even when native transcript search consumes the key", () => {
  const h = harness();
  try {
    h.drag("marker");
    const saved = h.spans;
    const { row, start, end } = h.locate("arke");
    h.mouse(0, start, row);
    h.mouse(32, end, row);
    assert.equal(highlightedText(h.tui.getScreenLines()), "mr");
    h.terminal.send("\x1b[102;6u"); // Ctrl+Shift+F opens native transcript search.
    h.tui.renderNow();
    assert.equal(h.tui.hasOverlay(), true);
    h.terminal.send("\x1b");
    h.tui.renderNow();
    assert.equal(h.tui.hasOverlay(), false);
    assert.equal(h.tui.hasActiveSelection(), false);
    h.mouse(0, end, row, true);
    assert.equal(h.spans, saved);
    assert.equal(highlightedText(h.tui.getScreenLines()), "marker");
  } finally { h.close(); }
});

test("proxy unwrapping does not leave properties", () => {
  const tui = new TuiAltScreen(new FakeTerminal());
  const before = Reflect.ownKeys(tui);
  const reference = new Proxy(tui, {
    get(target, key) {
      const value = Reflect.get(target, key);
      return typeof value === "function" ? (...args: unknown[]) => value.apply(target, args) : value;
    },
  });
  assert.equal(resolveRenderer(reference), tui);
  assert.deepEqual(Reflect.ownKeys(tui), before);
});
