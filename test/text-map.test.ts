import assert from "node:assert/strict";
import test from "node:test";
import { setCapabilities, stripTerminalSequences, visibleWidth } from "@earendil-works/pi-tui";
import { buildTextMap, cellsForTextRange, findTextRanges, paintLine, textRangeForCells } from "../src/text-map.ts";
import { highlightedText } from "./helpers.ts";

setCapabilities({ trueColor: true, hyperlinks: true, images: null });

test("anchors survive wrapping, padding, ANSI and quote/table border strokes", () => {
  const first = buildTextMap([" \x1b[1mHello 中文 👩🏽‍💻 é\x1b[0m "]);
  const second = buildTextMap(["│ Hello 中文", "│ 👩🏽‍💻 é"]);
  assert.equal(first.hash, second.hash);
  assert.equal(first.units.at(-2)?.text, "👩🏽‍💻");
  assert.equal(first.units.at(-1)?.text, "é");
  const range = findTextRanges(first, "中文 👩🏽‍💻")[0];
  assert.equal(cellsForTextRange(second, range).length, 2);
});

test("selecting either cell of a wide grapheme selects the entire character", () => {
  const map = buildTextMap(["a中👩🏽‍💻é"]);
  const range = textRangeForCells(map, [{ row: 0, start: 2, end: 4 }])!;
  assert.deepEqual(range, { start: 1, end: 3 });
  assert.deepEqual(cellsForTextRange(map, range), [{ row: 0, start: 1, end: 5 }]);
  assert.equal(textRangeForCells(buildTextMap(["   "]), [{ row: 0, start: 0, end: 3 }]), undefined);
});

test("range painting preserves width, original text, hyperlinks and following styles", () => {
  const link = "\x1b]8;;https://example.test\x07";
  const line = `\x1b[34mhello ${link}\x1b[1m中文\x1b[0m world\x1b]8;;\x07 tail`;
  const result = paintLine(line, [{ start: 6, end: 16 }]);
  assert.equal(stripTerminalSequences(result), stripTerminalSequences(line));
  assert.equal(visibleWidth(result), visibleWidth(line));
  assert.ok(result.includes(link));
  assert.equal(highlightedText([result]), "中文 world");
  assert.ok(!highlightedText([result]).includes("tail"));
  assert.equal(paintLine(line, []), line);
});

test("overlapping spans merge, and image lines remain untouched", () => {
  const line = "abcdef";
  assert.equal(highlightedText([paintLine(line, [{ start: 1, end: 4 }, { start: 2, end: 5 }])]), "bcde");
  const image = "\x1b_Ga=T;payload\x1b\\";
  assert.equal(paintLine(image, [{ start: 0, end: 99 }]), image);
});

test("literal lookup does not silently choose among repeated phrases", () => {
  const map = buildTextMap(["hello hello"]);
  assert.equal(findTextRanges(map, "hello").length, 2);
  assert.equal(findTextRanges(map, " ").length, 0);
});
