import { createHash } from "node:crypto";
import { backgroundAnsi, foregroundAnsi, getTerminalColorMode, rgbColor, stripTerminalSequences, visibleWidth } from "@earendil-works/pi-tui";

const segmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });
// Whitespace and terminal table/quote/rule strokes are layout, not anchor units.
// If any other rendered text changes, the whole display hash must still match.
const LAYOUT_ONLY = /^[\s\u2500-\u257f]+$/u;

export interface CellUnit {
  text: string;
  row: number;
  start: number;
  end: number;
}

export interface TextMap {
  units: CellUnit[];
  text: string;
  hash: string;
  lines: readonly string[];
}

export interface CellRange { row: number; start: number; end: number }
export interface TextRange { start: number; end: number }

export function hashText(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

export function isImageLine(line: string): boolean {
  return line.includes("\x1b_G") || line.includes("\x1b]1337;File=");
}

export function buildTextMap(lines: readonly string[]): TextMap {
  const units: CellUnit[] = [];
  for (let row = 0; row < lines.length; row++) {
    if (isImageLine(lines[row])) continue;
    let column = 0;
    for (const { segment } of segmenter.segment(stripTerminalSequences(lines[row]))) {
      const width = visibleWidth(segment);
      if (width > 0 && !LAYOUT_ONLY.test(segment)) {
        units.push({ text: segment, row, start: column, end: column + width });
      }
      column += width;
    }
  }
  const text = units.map((unit) => unit.text).join("");
  return { units, text, hash: hashText(text), lines };
}

/** Convert intersected terminal cells to a half-open grapheme range. */
export function textRangeForCells(map: TextMap, cells: readonly CellRange[]): TextRange | undefined {
  const byRow = new Map(cells.map((cell) => [cell.row, cell]));
  let start = -1;
  let end = -1;
  for (let index = 0; index < map.units.length; index++) {
    const unit = map.units[index];
    const cell = byRow.get(unit.row);
    if (cell && unit.start < cell.end && unit.end > cell.start) {
      if (start < 0) start = index;
      end = index + 1;
    }
  }
  return start < 0 ? undefined : { start, end };
}

/** Include inter-word spaces, but not leading/trailing padding or empty lines. */
export function cellsForTextRange(map: TextMap, range: TextRange): CellRange[] {
  if (!Number.isSafeInteger(range.start) || !Number.isSafeInteger(range.end) ||
      range.start < 0 || range.end <= range.start || range.end > map.units.length) return [];
  const rows = new Map<number, CellRange>();
  for (let index = range.start; index < range.end; index++) {
    const unit = map.units[index];
    const previous = rows.get(unit.row);
    if (previous) previous.end = unit.end;
    else rows.set(unit.row, { row: unit.row, start: unit.start, end: unit.end });
  }
  return [...rows.values()];
}

export function quoteForRange(map: TextMap, range: TextRange): string {
  return map.units.slice(range.start, range.end).map((unit) => unit.text).join("");
}

/** Keyboard fallback. Whitespace-insensitive, but never guesses among repeats. */
export function findTextRanges(map: TextMap, text: string): TextRange[] {
  const wanted = buildTextMap([text]).units.map((unit) => unit.text);
  if (wanted.length === 0) return [];
  const matches: TextRange[] = [];
  for (let start = 0; start + wanted.length <= map.units.length; start++) {
    if (wanted.every((unit, index) => unit === map.units[start + index].text)) {
      matches.push({ start, end: start + wanted.length });
    }
  }
  return matches;
}

/** Subtract half-open ranges without mutating the original range or cuts. */
export function subtractRanges(range: TextRange, cuts: readonly TextRange[]): TextRange[] {
  const remaining: TextRange[] = [];
  let start = range.start;
  for (const cut of [...cuts].sort((a, b) => a.start - b.start)) {
    if (cut.end <= start || cut.end <= cut.start) continue;
    if (cut.start >= range.end) break;
    if (cut.start > start) remaining.push({ start, end: cut.start });
    start = Math.max(start, Math.min(cut.end, range.end));
    if (start >= range.end) break;
  }
  if (start < range.end) remaining.push({ start, end: range.end });
  return remaining;
}

function mergeRanges(ranges: readonly TextRange[]): TextRange[] {
  const merged: TextRange[] = [];
  for (const range of [...ranges].sort((a, b) => a.start - b.start)) {
    const previous = merged.at(-1);
    if (previous && range.start <= previous.end) previous.end = Math.max(previous.end, range.end);
    else merged.push({ ...range });
  }
  return merged;
}

/** Post-render decoration, including ANSI boundaries *inside* a grapheme.
 * Never slice the raw string by columns: that can split a styled emoji cluster.
 * Terminal widths still come exclusively from Pi's visibleWidth().
 */
export function paintLine(line: string, ranges: readonly TextRange[]): string {
  if (isImageLine(line) || ranges.length === 0) return line;
  const plain = stripTerminalSequences(line);
  const selected: TextRange[] = [];
  let column = 0;
  for (const { segment, index } of segmenter.segment(plain)) {
    const width = visibleWidth(segment);
    if (width > 0 && ranges.some((range) => column < range.end && column + width > range.start)) {
      selected.push({ start: index, end: index + segment.length });
    }
    column += width;
  }
  const merged = mergeRanges(selected);
  if (merged.length === 0) return line;

  const tokens: { raw: string; escape: boolean }[] = [];
  const escapes = /\x1b(?:\[[0-?]*[ -/]*[@-~]|\][\s\S]*?(?:\x07|\x1b\\)|[PX^_][\s\S]*?(?:\x07|\x1b\\)|[ -/]*[0-~])/g;
  let rawOffset = 0;
  for (const match of line.matchAll(escapes)) {
    tokens.push({ raw: line.slice(rawOffset, match.index), escape: false }, { raw: match[0], escape: true });
    rawOffset = match.index + match[0].length;
  }
  tokens.push({ raw: line.slice(rawOffset), escape: false });
  // Unknown terminal encodings are left untouched, never guessed.
  if (tokens.filter((token) => !token.escape).map((token) => token.raw).join("") !== plain) return line;

  const mode = getTerminalColorMode();
  const color = foregroundAnsi(rgbColor(35, 30, 12), mode) + backgroundAnsi(rgbColor(255, 220, 85), mode);
  const transitions = merged.flatMap((range) => [{ offset: range.start, active: true }, { offset: range.end, active: false }]);
  let transition = 0;
  let offset = 0;
  let active = false;
  let originalSgr = "";
  let result = "";
  const change = () => {
    while (transitions[transition]?.offset === offset) {
      active = transitions[transition++].active;
      // Replay original SGR state, never OSCs: links stay in their original order.
      result += active ? color : "\x1b[39m\x1b[49m" + originalSgr;
    }
  };
  for (const token of tokens) {
    change();
    if (token.escape) {
      result += token.raw;
      if (/^\x1b\[[0-9;:]*m$/.test(token.raw)) {
        originalSgr += token.raw;
        if (active) result += color;
      }
      continue;
    }
    let consumed = 0;
    while (consumed < token.raw.length) {
      change();
      const remaining = token.raw.length - consumed;
      const length = Math.min(remaining, (transitions[transition]?.offset ?? Infinity) - offset);
      result += token.raw.slice(consumed, consumed + length);
      consumed += length;
      offset += length;
    }
  }
  change();
  return stripTerminalSequences(result) === plain && visibleWidth(result) === visibleWidth(line) ? result : line;
}
