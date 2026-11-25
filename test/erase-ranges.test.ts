import assert from "node:assert/strict";
import test from "node:test";
import { subtractRanges, type TextRange } from "../src/text-map.ts";

const cells = (ranges: readonly TextRange[]) => ranges.flatMap(({ start, end }) =>
  Array.from({ length: end - start }, (_, index) => start + index));

test("range subtraction covers no overlap, full removal, edge trimming and splitting", () => {
  const range = { start: 3, end: 10 };
  for (const [cuts, expected] of [
    [[], [{ start: 3, end: 10 }]],
    [[{ start: 0, end: 3 }, { start: 10, end: 12 }], [{ start: 3, end: 10 }]],
    [[{ start: 0, end: 12 }], []],
    [[{ start: 0, end: 5 }], [{ start: 5, end: 10 }]],
    [[{ start: 7, end: 12 }], [{ start: 3, end: 7 }]],
    [[{ start: 5, end: 7 }], [{ start: 3, end: 5 }, { start: 7, end: 10 }]],
    [[{ start: 7, end: 9 }, { start: 4, end: 6 }, { start: 5, end: 8 }], [{ start: 3, end: 4 }, { start: 9, end: 10 }]],
    [[{ start: 5, end: 5 }], [{ start: 3, end: 10 }]],
  ] as [TextRange[], TextRange[]][]) {
    const original = JSON.stringify({ range, cuts });
    assert.deepEqual(subtractRanges(range, cuts), expected);
    assert.equal(JSON.stringify({ range, cuts }), original);
  }
});

test("all pairs of small selection ranges match exact set subtraction", () => {
  const range = { start: 2, end: 8 };
  for (let a = 0; a <= 10; a++) for (let b = a; b <= 10; b++) {
    for (let c = 0; c <= 10; c++) for (let d = c; d <= 10; d++) {
      const cuts = [{ start: c, end: d }, { start: a, end: b }];
      const removed = new Set(cells(cuts));
      assert.deepEqual(cells(subtractRanges(range, cuts)), cells([range]).filter((cell) => !removed.has(cell)));
    }
  }
});
