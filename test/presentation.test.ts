import assert from "node:assert/strict";
import test from "node:test";
import { Container, MouseRegion, stripTerminalSequences, type Component } from "@earendil-works/pi-tui";
import { assistantEntry, harness, highlightedText } from "./helpers.ts";

const VIEW = Symbol.for("pi-toolbox:message-view");
const TURN = Symbol.for("pi-tidy:turn-layout");

/** Model pi-tidy's identity-preserving, trimmed presentation tree.
 * Real pi-tidy is exercised separately by test/cli-smoke.py.
 */
class Presentation extends Container {
  trimTop = 0;
  rawHeight = 0;
  override render(width: number): string[] {
    const lines = super.render(width);
    this.rawHeight = lines.length;
    let end = lines.length;
    this.trimTop = 0;
    while (this.trimTop < end && !stripTerminalSequences(lines[this.trimTop]).trim()) this.trimTop++;
    while (end > this.trimTop && !stripTerminalSequences(lines[end - 1]).trim()) end--;
    return lines.slice(this.trimTop, end);
  }
}

function present(component: Component) {
  const state = { style: "frame", header: false, hidden: false, hideThinking: true, invalid: false,
    runGap: 0, stepGap: 0, padding: 0, chipShift: undefined as number | undefined,
    transform: (line: string) => line, renders: 0 };
  const raw = component as unknown as { mouseLayout?: unknown; childLines?: unknown; contentContainer: { children: Component[] };
    [VIEW]?: Presentation; [TURN]?: { header: boolean; bodyTop: number; chipShift: number } };
  // No native render cache, as when pi-tidy renders a restored final answer.
  delete raw.mouseLayout;
  delete raw.childLines;
  Reflect.deleteProperty(raw.contentContainer, "mouseLayout");
  Reflect.deleteProperty(raw.contentContainer, "childLines");
  component.render = (width) => {
    if (state.hidden) return []; // Deliberately retain stale caches.
    const framed = ["frame", "rail", "rules"].includes(state.style);
    const innerWidth = framed ? width - (state.style === "rules" ? 0 : 2) : width - 1;
    const view = new Presentation();
    for (const child of raw.contentContainer.children) {
      if (state.hideThinking && child instanceof MouseRegion) continue;
      state.renders++;
      const rows = child.render(innerWidth);
      const region = new MouseRegion(child, () => undefined);
      region.render = () => rows;
      view.addChild(region);
    }
    const body = view.render(innerWidth);
    raw[VIEW] = view;
    raw[TURN] = { header: state.header,
      bodyTop: state.runGap + Number(state.header) + state.stepGap + Number(framed) + state.padding,
      chipShift: state.chipShift ?? (framed && state.style !== "rules" ? 1 : 0) };
    if (state.invalid) view.trimTop = -1;
    return [
      ...Array<string>(state.runGap).fill(""),
      ...(state.header ? ["▾ turn summary"] : []),
      ...Array<string>(state.stepGap).fill(""),
      ...(framed ? ["╭─ fixture reply ─╮"] : []),
      ...Array<string>(state.padding).fill("│"),
      ...body.map((line) => state.transform(state.style === "rules" ? line : `│${line}${state.style === "frame" ? "│" : ""}`)),
      ...Array<string>(state.padding).fill("│"),
      ...(framed ? ["╰────────────────╯"] : []),
    ];
  };
  return state;
}

for (const style of ["frame", "rail", "rules", "process-rail"]) {
  test(`pi-tidy ${style}: selection uses presentation rows and exact visible columns`, () => {
    const h = harness([assistantEntry("Hello marker target 中文 👩🏽‍💻 é.")]);
    try {
      const state = present(h.components[0]);
      state.style = style;
      state.header = true;
      h.tui.renderNow();
      h.drag("marker target");
      h.drag("中文");
      assert.equal(h.spans.length, 2);
      assert.equal(highlightedText(h.tui.getScreenLines()), "marker target中文");
      assert.equal(h.adapter.diagnostics.tidyMessages, 1);
      assert.deepEqual(h.reports, []);
      const renders = state.renders;
      h.adapter.markText("👩🏽‍💻");
      assert.equal(state.renders, renders, "collection must not re-render the underlying Markdown");
      h.terminal.resize(39, 24);
      h.tui.renderNow();
      assert.equal(h.adapter.diagnostics.mapped, 3);
      assert.equal(highlightedText(h.tui.getScreenLines()).replaceAll(" ", ""), "markertarget中文👩🏽‍💻");
    } finally { h.close(); }
  });
}

for (const style of ["frame", "rail", "rules", "process-rail"]) {
  test(`pi-tidy ${style}: measured gaps and frame padding do not shift marks`, () => {
    const h = harness([assistantEntry("Hello marker target 中文.")]);
    try {
      const state = present(h.components[0]);
      Object.assign(state, { style, header: true, runGap: 2, stepGap: 1,
        padding: style === "frame" ? 1 : 0, chipShift: ["rail", "rules"].includes(style) ? 2 : 1 });
      h.tui.renderNow();
      h.drag("marker target");
      assert.equal(highlightedText(h.tui.getScreenLines()), "marker target");
      assert.equal(h.adapter.diagnostics.tidyMessages, 1);
      h.terminal.resize(32, 24);
      h.tui.renderNow();
      assert.equal(highlightedText(h.tui.getScreenLines()), "marker target");
      assert.deepEqual(h.reports, []);
      // Impossible metadata must still fail closed, without a native fallback.
      const turn = (h.components[0] as unknown as { [TURN]: { bodyTop: number } })[TURN];
      turn.bodyTop = 10_000;
      assert.throws(() => h.adapter.markText("中文"), /没有找到/);
      assert.throws(() => h.adapter.exportSelections(), /无法精确还原/);
    } finally { h.close(); }
  });
}

test("presentation skips thinking and supports several Markdown slots without native caches", () => {
  const entry = assistantEntry("Alpha target");
  entry.message.content = [{ type: "thinking", thinking: "private reasoning" },
    { type: "text", text: "Alpha target" }, { type: "text", text: "Beta target" }];
  const h = harness([entry]);
  try {
    const state = present(h.components[0]);
    state.hideThinking = false;
    h.tui.renderNow();
    h.drag("Thinking...");
    assert.equal(h.spans.length, 0);
    h.drag("Alpha target");
    h.drag("Beta target");
    assert.deepEqual(h.spans.map((span) => span.blockIndex), [1, 2]);
    assert.equal(highlightedText(h.tui.getScreenLines()), "Alpha targetBeta target");
    state.hideThinking = true;
    h.tui.renderNow();
    assert.equal(highlightedText(h.tui.getScreenLines()), "Alpha targetBeta target");
  } finally { h.close(); }
});

test("a hidden presentation cannot mark a different message with identical text", () => {
  const entries = [assistantEntry("same target words"), assistantEntry("same target words")];
  const h = harness(entries);
  try {
    const first = present(h.components[0]);
    present(h.components[1]);
    h.tui.renderNow();
    h.drag("target", false, 0);
    assert.equal(h.spans[0].entryId, entries[0].id);
    first.hidden = true;
    h.tui.renderNow();
    assert.equal(highlightedText(h.tui.getScreenLines()), "");
    h.drag("target");
    assert.equal(h.spans[1].entryId, entries[1].id);
    assert.equal(highlightedText(h.tui.getScreenLines()), "target");
  } finally { h.close(); }
});

test("unknown geometry and transformed glyphs are rejected rather than guessed", () => {
  const h = harness([assistantEntry("original target text")]);
  try {
    const state = present(h.components[0]);
    state.invalid = true;
    h.tui.renderNow();
    h.drag("target");
    assert.equal(h.spans.length, 0);
    assert.match(h.reports.at(-1)!, /未识别到当前布局/);
    state.invalid = false;
    state.transform = (line) => line.replace("original", "modified");
    h.tui.renderNow();
    h.drag("target");
    assert.equal(h.spans.length, 0);
    assert.equal(h.adapter.diagnostics.indexed, 0);
  } finally { h.close(); }
});
