import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import { TuiAltScreen, stripTerminalSequences, type Component } from "@earendil-works/pi-tui";
import { formatHighlights } from "../src/markdown-export.ts";
import { MarkerAdapter, type AdapterHost } from "../src/pi-adapter.ts";
import { ENTRY_TYPE, MarkerStore } from "../src/store.ts";
import { assistantEntry, FakeTerminal, harness, highlightedText } from "./helpers.ts";

test("missing fullscreen capabilities fail before any renderer hooks are installed", () => {
  const host: AdapterHost = {
    getBranch: () => [], getMode: () => "off", getSpans: () => [],
    commitSelection: () => assert.fail("must not save marks"), report: () => assert.fail("must not run hooks"),
  };
  for (const capability of ["handleSelectionMouseEvent", "getSelectionBounds", "getSelectionColumns", "applySearchHighlights",
    "applySelection", "handleViewportInput", "getCopyOnSelect", "setCopyOnSelect", "resetTextSelection", "requestRender",
    "inputListeners", "selectionPressActive"]) {
    const tui = new TuiAltScreen(new FakeTerminal());
    Object.defineProperty(tui, capability, { value: undefined });
    const before = Object.getOwnPropertyDescriptors(tui);
    assert.throws(() => new MarkerAdapter(tui, host), new RegExp(`不兼容的 Pi TUI：.*${capability}`));
    assert.deepEqual(Object.getOwnPropertyDescriptors(tui), before);
  }
});

test("frozen render arrays remain unchanged through marking, preview, export, resize and disposal", () => {
  const h = harness([assistantEntry("Before **alpha beta gamma** after.")]);
  try {
    const raw = h.components[0] as unknown as { contentContainer: Component; markdownSlots: { markdown: Component }[] };
    const copies = new Map<readonly string[], readonly string[]>();
    for (const component of [h.chat, h.components[0], raw.contentContainer, ...raw.markdownSlots.map((slot) => slot.markdown)]) {
      const original = component.render;
      component.render = function (width) {
        const lines = original.call(this, width);
        if (!copies.has(lines)) copies.set(lines, [...lines]);
        Object.freeze(lines);
        return lines;
      };
    }
    h.tui.renderNow();
    const originalScreen = h.tui.getScreenLines().map(stripTerminalSequences);
    const chat = h.chat as unknown as { childLines?: { lines: readonly string[] } };
    const cached = chat.childLines?.lines;
    h.drag("alpha beta gamma");
    assert.equal(highlightedText(h.tui.getScreenLines()), "alpha beta gamma");
    const saved = h.spans;
    const { row, start, end } = h.locate("beta");
    h.mouse(0, start, row);
    h.mouse(32, end, row);
    assert.equal(highlightedText(h.tui.getScreenLines()).replaceAll(" ", ""), "alphagamma");
    assert.equal(h.spans, saved);
    h.adapter.cancelSelection();
    h.tui.renderNow();
    assert.equal(highlightedText(h.tui.getScreenLines()), "alpha beta gamma");
    h.drag("beta");
    assert.equal(formatHighlights(h.adapter.exportSelections()).markdown, "**alpha**\n\n---\n\n**gamma**\n");
    h.tui.renderNow();
    assert.deepEqual(h.tui.getScreenLines().map(stripTerminalSequences), originalScreen);
    if (cached) assert.equal(chat.childLines?.lines, cached, "Pi 1.6.0 must retain its unchanged Container cache");
    h.terminal.resize(24);
    h.tui.renderNow();
    assert.equal(highlightedText(h.tui.getScreenLines()).replaceAll(" ", ""), "alphagamma");
    h.adapter.dispose();
    h.tui.renderNow();
    assert.equal(highlightedText(h.tui.getScreenLines()), "");
    for (const [lines, copy] of copies) assert.deepEqual(lines, copy, "marker must never paint into component caches");
    assert.deepEqual(h.reports, []);
  } finally { h.close(); }
});

test("malformed native layout caches fail closed without discarding saved marks", () => {
  const h = harness([assistantEntry("A target phrase.")]);
  const raw = h.chat as unknown as Record<string, unknown>;
  const key = raw.childLines ? "childLines" : "mouseLayout";
  const layout = raw[key] as Record<string, unknown>;
  const mouseDescriptor = Object.getOwnPropertyDescriptor(h.chat, "mouseLayout");
  try {
    h.drag("target");
    const saved = h.spans;
    const valid = raw[key] as Record<string, unknown>;
    const malformed: Record<string, unknown>[] = [{ ...valid, width: 0 }, { ...valid, width: Number(valid.width) + 1 }, { ...valid, children: [undefined] }];
    if (key === "childLines") {
      malformed.push({ ...valid, parts: [] }, { ...valid, parts: [null] }, { ...valid, lines: [] });
      // A corrupt modern cache must not fall back to a stale legacy cache.
      raw.mouseLayout = { width: valid.width, children: [{ component: h.components[0], height: (valid.lines as string[]).length }] };
    } else {
      malformed.push({ ...valid, children: [{ component: h.components[0], height: -1 }] });
    }
    for (const broken of malformed) {
      raw[key] = broken;
      assert.throws(() => h.adapter.markText("phrase"), /没有找到/);
      assert.throws(() => h.adapter.exportSelections(), /无法精确还原/);
      assert.equal(h.spans, saved);
    }
  } finally {
    raw[key] = layout;
    if (mouseDescriptor) Object.defineProperty(h.chat, "mouseLayout", mouseDescriptor);
    else Reflect.deleteProperty(h.chat, "mouseLayout");
    h.close();
  }
});

test("actual Pi 1.5.2 anchors replay, reflow, export and undo on the installed host", () => {
  // Captured from the real 1.5.2 renderer before upgrading dependencies; never regenerate with the current host.
  const fixture = JSON.parse(readFileSync(new URL("./fixtures/pi-1.5.2-marks.json", import.meta.url), "utf8")) as {
    piVersion: string; source: string; entryId: string; operations: unknown[]; expectedText: string; expectedMarkdown: string;
  };
  assert.equal(fixture.piVersion, "1.5.2");
  const entry = assistantEntry(fixture.source);
  entry.id = fixture.entryId;
  const branch: SessionEntry[] = [entry, ...fixture.operations.map((data, index): SessionEntry => ({
    type: "custom", customType: ENTRY_TYPE, id: `legacy-operation-${index}`,
    parentId: index === 0 ? entry.id : `legacy-operation-${index - 1}`, timestamp: entry.timestamp, data,
  }))];
  const before = JSON.stringify(branch);
  const store = new MarkerStore();
  assert.deepEqual(store.restore(branch), { invalid: 0 });
  const h = harness([entry]);
  try {
    h.branch = branch;
    h.spans = [...store.spans];
    h.tui.renderNow();
    assert.equal(highlightedText(h.tui.getScreenLines()).replaceAll(" ", ""), fixture.expectedText);
    assert.equal(formatHighlights(h.adapter.exportSelections()).markdown, fixture.expectedMarkdown);
    h.terminal.resize(24);
    h.tui.renderNow();
    assert.equal(h.adapter.diagnostics.mapped, 3);
    assert.equal(formatHighlights(h.adapter.exportSelections()).markdown, fixture.expectedMarkdown);
    assert.equal(store.apply({ version: 1, kind: "undo" }), true);
    h.spans = [...store.spans];
    h.tui.renderNow();
    assert.equal(highlightedText(h.tui.getScreenLines()).replaceAll(" ", ""), "alphabetagamma中文测试");
    assert.equal(formatHighlights(h.adapter.exportSelections()).markdown, "**alpha beta gamma**\n\n---\n\n*中文测试*\n");
    assert.equal(JSON.stringify(branch), before, "old session records must not be migrated or rewritten");
    assert.deepEqual(h.reports, []);
  } finally { h.close(); }
});
