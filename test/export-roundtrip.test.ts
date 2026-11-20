import assert from "node:assert/strict";
import test from "node:test";
import { getMarkdownTheme } from "@earendil-works/pi-coding-agent";
import { Markdown } from "@earendil-works/pi-tui";
import { extractMarkdown } from "../src/markdown-export.ts";
import { buildTextMap } from "../src/text-map.ts";
import { assistantEntry, harness } from "./helpers.ts";

test("every inline subrange round-trips without adding or losing visible graphemes", () => {
  const sources = [
    "A **bold words** Z", "A **bold *deep* end** Z", "A *B **CD** E* F",
    "零**中文**壹*斜体*尾", "a***bc***de", "**foo***bar*", "a ~~old **bold**~~ z",
    "a [red *blue*](https://example.test) z", "[label](https://example.test)tail",
    "a `` `back` `` z", "A e**́** B", "A **👩🏽‍💻** Z", "A &amp; B \\*lit\\*",
    "a <span>text</span> z", "A **x*y*z** B", "normal **end**.",
  ];
  let checked = 0;
  for (const source of sources) {
    const h = harness([assistantEntry(source)]);
    try {
      const text = buildTextMap(new Markdown(source, 1, 0, getMarkdownTheme()).render(h.terminal.columns)).text;
      h.adapter.markText(text);
      const selection = h.adapter.exportSelections()[0];
      for (let start = 0; start < selection.map.units.length; start++) {
        for (let end = start + 1; end <= selection.map.units.length; end++) {
          const [markdown] = extractMarkdown({ ...selection, ranges: [{ start, end }] });
          const actual = buildTextMap(new Markdown(markdown, 0, 0, getMarkdownTheme()).render(100)).text;
          const wanted = selection.map.units.slice(start, end).map((unit) => unit.text).join("");
          assert.equal(actual, wanted, JSON.stringify({ source, start, end, markdown }));
          checked++;
        }
      }
    } finally { h.close(); }
  }
  assert.ok(checked > 500);
});
