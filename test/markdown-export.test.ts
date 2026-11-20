import assert from "node:assert/strict";
import test from "node:test";
import { formatHighlights } from "../src/markdown-export.ts";
import { assistantEntry, harness, highlightedText } from "./helpers.ts";

function exported(source: string, ...phrases: string[]): string {
  const h = harness([assistantEntry(source)]);
  try {
    for (const phrase of phrases) { h.adapter.markText(phrase); h.tui.renderNow(); }
    return formatHighlights(h.adapter.exportSelections()).markdown;
  } finally { h.close(); }
}

test("export prunes emphasis to selected words, including CJK and nested styles", () => {
  assert.equal(exported("Do **keep this phrase** but not outside.", "this phrase"), "**this phrase**\n");
  assert.equal(exported("A **bold *nested words* ending** Z", "nested words"), "***nested words***\n");
  assert.equal(exported("前缀 **中文加粗** 后缀 ~~删除部分~~", "中文", "删除"), "**中文**\n\n---\n\n~~删除~~\n");
});

test("partial links preserve destinations but never copy unselected labels or titles", () => {
  assert.equal(exported('A [descriptive title](https://example.test/path?a=1&b=2 "private title") Z', "criptive tit"),
    "[criptive tit](<https://example.test/path?a=1&b=2>)\n");
  assert.equal(exported("A [reference label][site] Z\n\n[site]: https://example.test", "label"), "[label](<https://example.test>)\n");
});

test("inline and fenced code preserve syntax without copying surrounding statements", () => {
  assert.equal(exported("Run ``a`b + c`` now.", "a`b"), "``a`b``\n");
  assert.equal(exported("```ts\nconst unused = 1;\nconst target = 'yes';\nconst tail = 2;\n```", "target = 'yes'"), "```ts\ntarget = 'yes'\n```\n");
  assert.equal(exported("```py\nif ready:\n    selected()\n    next_step()\n    hidden()\n```", "selected()\n    next_step()"),
    "```py\nselected()\n    next_step()\n```\n");
  assert.equal(exported("~~~~md\nstart\n```\nend\n~~~~", "```\nend"), "````md\n```\nend\n````\n");
});

test("headings, lists, tasks and blockquotes retain structural Markdown", () => {
  assert.equal(exported("### Heading target remainder", "target"), "### target\n");
  assert.equal(exported("7. first **chosen item** end\n8. other", "chosen"), "7. **chosen**\n");
  assert.equal(exported("- parent hidden\n  - **deep chosen** remainder\n- next", "chosen"), "- **chosen**\n");
  assert.equal(exported("- [x] finished selectedwords", "selectedwords"), "- [x] selectedwords\n");
  assert.equal(exported("> outside **quoted target** end", "target"), "> **target**\n");
});

test("partial tables leave unselected cells empty instead of leaking their content", () => {
  const source = "| Name | State |\n| --- | --- |\n| Alice | **Ready** |\n| Bob | Waiting |";
  assert.equal(exported(source, "Ready"), "|  |  |\n| --- | --- |\n|  | **Ready** |\n");
});

test("overlaps merge and disjoint fragments never bridge unselected words", () => {
  assert.equal(exported("One **alpha beta gamma** end.", "beta gamma", "alpha beta", "alpha beta"), "**alpha beta gamma**\n");
  assert.equal(exported("**red hidden blue**", "blue", "red"), "**red**\n\n---\n\n**blue**\n");
});

test("identical phrases are resolved by stored positions, not a first-text match", () => {
  const h = harness([assistantEntry("**repeat one** and *repeat one*")]);
  try {
    h.drag("repeat one", false, 1);
    assert.equal(formatHighlights(h.adapter.exportSelections()).markdown, "*repeat one*\n");
  } finally { h.close(); }
});

test("answers export in branch order even when strokes were made in reverse order", () => {
  const h = harness([assistantEntry("Early **alpha**."), assistantEntry("Later *beta*.")]);
  try {
    h.drag("beta");
    h.drag("alpha");
    assert.equal(formatHighlights(h.adapter.exportSelections()).markdown, "**alpha**\n\n---\n\n*beta*\n");
  } finally { h.close(); }
});

test("Unicode graphemes remain intact across Markdown style boundaries", () => {
  assert.equal(exported("before e**́** after", "é"), "e**́**\n");
  assert.equal(exported("before **👩🏽‍💻** after", "👩🏽‍💻"), "**👩🏽‍💻**\n");
});

test("escaped syntax and hidden comments cannot inject unselected Markdown", () => {
  assert.equal(exported("before \\*literal\\* after", "*literal*"), "\\*literal\\*\n");
  assert.equal(exported("before A <!-- private hidden text --> B after", "A B"), "A  B\n");
});

test("stale marks abort the entire export rather than silently dropping a fragment", () => {
  const h = harness([assistantEntry("first target second")]);
  try {
    h.drag("target");
    h.spans = [...h.spans, { ...h.spans[0], sourceHash: "0".repeat(64) }];
    assert.throws(() => h.adapter.exportSelections(), /有 1 段高亮/);
  } finally { h.close(); }
});

test("export includes off-screen highlights and preserves content-block order", () => {
  const entry = assistantEntry("First **alpha**");
  entry.message.content = [{ type: "text", text: "First **alpha**" }, { type: "thinking", thinking: "not exported" },
    { type: "text", text: Array.from({ length: 30 }, (_, index) => `Row ${index} filler`).join("\n\n") + "\n\nLast *omega*" }];
  const h = harness([entry]);
  try {
    h.drag("omega");
    h.scroll.scrollToStart();
    h.tui.renderNow();
    h.drag("alpha");
    h.scroll.scrollToEnd();
    h.tui.renderNow();
    assert.equal(formatHighlights(h.adapter.exportSelections()).markdown, "**alpha**\n\n---\n\n*omega*\n");
  } finally { h.close(); }
});

test("complete formulas retain source notation while partial formulas fail closed", () => {
  assert.equal(exported("A $x^2$ Z", "x²"), "$x^2$\n");
  assert.throws(() => exported("A $x^2$ Z", "x"), /公式只能整段导出/);
});

test("unselected transformed tables do not prevent exporting a separate supported paragraph", () => {
  const source = "| Header one | Header two |\n| --- | --- |\n| " + "long cell words ".repeat(8) + " | " + "another long cell ".repeat(8) + " |\n\nKeep **target** only.";
  assert.equal(exported(source, "target"), "**target**\n");
});

test("failed provenance checks restore renderer methods and reject display-only source rewrites", () => {
  const h = harness([assistantEntry("Keep **this phrase**.")]);
  try {
    h.drag("this phrase");
    const raw = h.components[0] as unknown as { markdownSlots: { markdown: { options: { transform?: (text: string) => string }; invalidate(): void } }[] };
    const markdown = raw.markdownSlots[0].markdown;
    const before = Object.getOwnPropertyDescriptor(markdown, "renderToken");
    markdown.options.transform = (text) => text + "\n\n<!-- invisible extra source -->";
    markdown.invalidate();
    h.tui.renderNow();
    assert.throws(() => h.adapter.exportSelections(), /显示插件改写/);
    assert.deepEqual(Object.getOwnPropertyDescriptor(markdown, "renderToken"), before);
    delete markdown.options.transform;
    markdown.invalidate();
    h.tui.renderNow();
    assert.equal(formatHighlights(h.adapter.exportSelections()).markdown, "**this phrase**\n");
  } finally { h.close(); }
});

test("export restores render methods and leaves highlights and source unchanged", () => {
  const entry = assistantEntry("Keep **this phrase** exactly.");
  const h = harness([entry]);
  try {
    h.drag("this phrase");
    const raw = h.components[0] as unknown as { markdownSlots: { markdown: object }[] };
    const markdown = raw.markdownSlots[0].markdown;
    const before = Object.getOwnPropertyDescriptor(markdown, "renderToken");
    const source = JSON.stringify(entry);
    const marks = JSON.stringify(h.spans);
    assert.equal(formatHighlights(h.adapter.exportSelections()).markdown, "**this phrase**\n");
    assert.deepEqual(Object.getOwnPropertyDescriptor(markdown, "renderToken"), before);
    assert.equal(JSON.stringify(entry), source);
    assert.equal(JSON.stringify(h.spans), marks);
    h.tui.renderNow();
    assert.equal(highlightedText(h.tui.getScreenLines()), "this phrase");
  } finally { h.close(); }
});
