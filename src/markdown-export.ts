import { stripTerminalSequences, visibleWidth, type Token } from "@earendil-works/pi-tui";
import { buildTextMap, type TextMap, type TextRange } from "./text-map.ts";

/** Evidence captured from one identity-checked Markdown component at its actual width. */
export interface MarkdownEvidence {
  tokens: readonly Token[];
  blocks: ReadonlyMap<Token, readonly string[]>;
  inline: ReadonlyMap<Token, string>;
  preserveOrderedListMarkers: boolean;
}
export interface MarkdownSelection {
  entryId: string;
  blockIndex: number;
  source: string;
  map: TextMap;
  ranges: TextRange[];
  evidence: MarkdownEvidence;
}

interface Node {
  kind: string;
  start: number;
  end: number;
  children: Node[];
  text?: string;
  prefix?: string;
  href?: string;
  language?: string;
  raw?: string;
  reason?: string;
  cells?: Node[][];
  align?: (string | null)[];
}
interface Unit { text: string; start: number; end: number }
const segmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });
const layoutOnly = /^[\s\u2500-\u257f]+$/u;
const clean = (text: string): string => stripTerminalSequences(text).replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, "");
const children = (token: Token): Token[] => "tokens" in token && Array.isArray(token.tokens) ? token.tokens : [];
const normalized = (text: string): string => buildTextMap([text]).text;
const escapeText = (text: string): string => text.replace(/[\\`*_{}\[\]()<>#+\-.!|~&=]/g, "\\$&");
const destination = (href: string): string => clean(href).replace(/[\\<>\s]/g, (char) => encodeURIComponent(char));

export function mergeRanges(ranges: readonly TextRange[]): TextRange[] {
  const result: TextRange[] = [];
  for (const range of [...ranges].sort((a, b) => a.start - b.start || a.end - b.end)) {
    const previous = result.at(-1);
    if (previous && range.start <= previous.end) previous.end = Math.max(previous.end, range.end);
    else result.push({ ...range });
  }
  return result;
}

function longestRun(text: string, pattern: RegExp): number {
  let longest = 0;
  for (const match of text.matchAll(pattern)) longest = Math.max(longest, match[0].length);
  return longest;
}
function codeSpan(text: string): string {
  const longest = longestRun(text, /`+/g);
  const fence = "`".repeat(longest + 1);
  const pad = text.startsWith("`") || text.endsWith("`") || (text.startsWith(" ") && text.endsWith(" ") && !/^ +$/.test(text)) ? " " : "";
  return `${fence}${pad}${text}${pad}${fence}`;
}
function codeBlock(text: string, language = ""): string {
  // Keep the language, not optional unselected titles/attributes from the info string.
  const info = clean(language).trim().split(/\s+/)[0];
  const languageName = /^[\w.+#-]+$/u.test(info) ? info : "";
  const fence = "`".repeat(Math.max(3, longestRun(text, /`+/g) + 1));
  return `${fence}${languageName}\n${text}\n${fence}`;
}
function wrapInline(text: string, marker: string): string {
  const body = text.trim();
  if (!body) return text;
  return text.slice(0, text.indexOf(body)) + marker + body + marker + text.slice(text.indexOf(body) + body.length);
}
function tableCell(text: string): string {
  let result = "";
  let slashes = 0;
  for (const char of text) {
    if (char === "|" && slashes % 2 === 0) result += "\\";
    result += char === "\n" ? "<br>" : char;
    slashes = char === "\\" ? slashes + 1 : 0;
  }
  return result;
}

/** A deterministic provenance tree. Each content leaf owns a UTF-16 interval in
 * the projected display stream; synthetic chrome has no exportable content.
 * We verify the ENTIRE grapheme stream before pruning, never search for quotes.
 */
class Projection {
  private chunks: string[] = [];
  private offset = 0;
  private readonly evidence: MarkdownEvidence;
  constructor(evidence: MarkdownEvidence) { this.evidence = evidence; }
  get text(): string { return this.chunks.join(""); }

  private leaf(kind: string, value: string): Node {
    const text = clean(value);
    const start = this.offset;
    this.offset += text.length;
    this.chunks.push(text);
    return { kind, text, start, end: this.offset, children: [] };
  }
  private node(kind: string, make: () => Node[], metadata: Partial<Node> = {}): Node {
    const start = this.offset;
    const nodes = make();
    return { ...metadata, kind, start, end: this.offset, children: nodes };
  }
  private displayed(token: Token): string {
    const block = this.evidence.blocks.get(token);
    return block ? block.join("\n") : this.evidence.inline.get(token) ?? "";
  }
  private opaque(token: Token, reason: string, raw?: string): Node {
    const leaf = this.leaf("opaque", this.displayed(token));
    return { ...leaf, reason, raw };
  }
  private inline(token: Token): Node {
    const kids = children(token);
    switch (token.type) {
      case "strong": case "em": case "del":
        return this.node(token.type, () => kids.map((child) => this.inline(child)));
      case "text": case "paragraph":
        return kids.length ? this.node("inline", () => kids.map((child) => this.inline(child)))
          : this.leaf("text", this.evidence.inline.get(token) ?? String(token.text ?? ""));
      case "escape": case "html":
        return this.leaf("text", this.evidence.inline.get(token) ?? "");
      case "br": return this.leaf("break", "\n");
      case "codespan": return this.node("codespan", () => [this.leaf("code-text", String(token.text ?? ""))]);
      case "link": {
        const chunk = this.chunks.length;
        const node = this.node("link", () => [this.node("label", () => kids.map((child) => this.inline(child)))], { href: token.href });
        const label = this.chunks.slice(chunk).join("");
        const actual = clean(this.evidence.inline.get(token) ?? "");
        // Pi optionally prints the destination when OSC 8 is unavailable. It is
        // metadata when a label is selected, but can itself be copied if selected alone.
        if (normalized(actual) !== normalized(label)) {
          const suffix = ` (${token.href})`;
          if (normalized(actual) !== normalized(label + suffix)) throw new Error("链接显示经过未知变换，无法精确导出。");
          node.children.push(this.leaf("link-url", suffix));
          node.end = this.offset;
        }
        return node;
      }
      case "latex": return this.opaque(token, "公式只能整段导出，不能把局部字形猜成原始公式。", token.raw);
      default: return this.opaque(token, `暂不支持局部导出 ${token.type} 格式。`);
    }
  }

  sequence(tokens: readonly Token[]): Node {
    return this.node("sequence", () => {
      const nodes: Node[] = [];
      for (const token of tokens) {
        if (token.type === "space") continue;
        if (nodes.length) nodes.push(this.leaf("gap", "\n\n"));
        nodes.push(this.block(token));
      }
      return nodes;
    });
  }
  private block(token: Token): Node {
    switch (token.type) {
      case "paragraph": case "text": return this.inline(token);
      case "heading": return this.node("heading", () => [
        ...(token.depth >= 3 ? [this.leaf("chrome", `${"#".repeat(token.depth)} `)] : []),
        ...children(token).map((child) => this.inline(child)),
      ], { prefix: `${"#".repeat(token.depth)} ` });
      case "blockquote": return this.node("quote", () => [this.sequence(children(token))]);
      case "list": return this.node("list", () => {
        const nodes: Node[] = [];
        for (const [index, item] of token.items.entries()) {
          if (nodes.length) nodes.push(this.leaf("gap", "\n"));
          const ordinary = token.ordered ? `${Number(token.start) + index}. ` : "- ";
          const original = /^(?: {0,3})(\d{1,9}[.)]|[-+*])(?:[ \t]+|(?=\r?\n|$))/.exec(item.raw)?.[1];
          const bullet = this.evidence.preserveOrderedListMarkers && original ? `${original} ` : ordinary;
          const marker = bullet + (item.task ? `[${item.checked ? "x" : " "}] ` : "");
          nodes.push(this.node("item", () => {
            const result: Node[] = [];
            let rendered = false;
            for (const child of item.tokens) {
              if (result.length) result.push(this.leaf("gap", "\n\n"));
              if (!rendered && child.type !== "list") result.push(this.leaf("chrome", marker));
              result.push(this.block(child));
              rendered = true;
            }
            if (!rendered) result.push(this.leaf("chrome", marker));
            return result;
          }, { prefix: marker }));
        }
        return nodes;
      });
      case "code": {
        const lines = this.evidence.blocks.get(token);
        const body = String(token.text ?? "");
        const count = body.split("\n").length;
        if (!lines || lines.length < count + 2 || normalized(lines.slice(1, 1 + count).join("\n")) !== normalized(body)) {
          return this.opaque(token, "代码被转换成了图形或分栏，无法精确还原选中的代码片段。");
        }
        return this.node("code", () => [this.leaf("chrome", `${lines[0]}\n`), this.leaf("code-text", body),
          this.leaf("chrome", `\n${lines.slice(1 + count).join("\n")}`)], { language: token.lang ?? "" });
      }
      case "table": {
        const before = this.offset;
        const chunks = this.chunks.length;
        const cells: Node[][] = [];
        const result = this.node("table", () => {
          const nodes: Node[] = [];
          for (const row of [token.header, ...token.rows]) {
            const rowNodes: Node[] = [];
            for (const cell of row) {
              const node = this.node("cell", () => cell.tokens.map((child: Token) => this.inline(child)));
              rowNodes.push(node);
              nodes.push(node, this.leaf("gap", " "));
            }
            cells.push(rowNodes);
            nodes.push(this.leaf("gap", "\n"));
          }
          return nodes;
        }, { cells, align: token.align });
        // Wrapped/vertical tables can reorder cell fragments. Do not guess that mapping.
        if (normalized(this.chunks.slice(chunks).join("")) === normalized(this.displayed(token))) return result;
        this.offset = before;
        this.chunks.length = chunks;
        return this.opaque(token, "当前表格换行或分栏改变了字符顺序；请加宽窗口、确认高亮仍匹配后再导出。");
      }
      case "html": return this.leaf("text", this.displayed(token));
      case "hr": return this.leaf("chrome", this.displayed(token));
      case "space": return this.leaf("gap", "\n\n");
      case "latexBlock": return this.opaque(token, "公式只能整段导出，不能把局部字形猜成原始公式。", token.raw);
      default: return this.opaque(token, `暂不支持局部导出 ${token.type} 格式。`);
    }
  }
}

function serialize(node: Node, start: number, end: number): string {
  if (node.end <= start || node.start >= end) return "";
  const selectedText = () => (node.text ?? "").slice(Math.max(0, start - node.start), Math.min(node.end, end) - node.start);
  if (node.kind === "chrome") return "";
  if (node.kind === "text" || node.kind === "link-url") return escapeText(selectedText());
  if (["code-text", "gap", "break"].includes(node.kind)) return selectedText();
  if (node.kind === "opaque") {
    const text = node.text ?? "";
    const first = [...segmenter.segment(text)].find((part) => !layoutOnly.test(part.segment) && visibleWidth(part.segment) > 0)?.index ?? 0;
    const last = text.trimEnd().length;
    if (!node.raw || start > node.start + first || end < node.start + last) throw new Error(node.reason);
    if (normalized(node.raw) !== normalized(text) && /<!--|%/.test(node.raw)) {
      throw new Error("公式包含不可见的注释，无法保证只导出选中内容。");
    }
    return clean(node.raw).trim();
  }
  const parts = node.children.map((child) => serialize(child, start, end));
  const content = parts.join("");
  if (!content.trim()) return "";
  switch (node.kind) {
    case "strong": return wrapInline(content, "**");
    case "em": return wrapInline(content, "*");
    case "del": return wrapInline(content, "~~");
    case "codespan": return codeSpan(content);
    case "code": return codeBlock(content, node.language);
    case "heading": return node.prefix + content.trim();
    case "quote": return content.trim().split("\n").map((line) => `> ${line}`).join("\n");
    case "link": return parts[0]?.trim() ? `[${parts[0]}](<${destination(node.href ?? "")}>)` : parts.slice(1).join("");
    case "item": {
      const active = node.children.filter((child, index) => !["gap", "chrome"].includes(child.kind) && parts[index].trim());
      if (active.length === 1 && active[0].kind === "list") return content.trim();
      const prefix = node.prefix ?? "- ";
      return prefix + content.trim().split("\n").join(`\n${" ".repeat(Math.max(4, prefix.length))}`);
    }
    case "table": {
      const rows = node.cells!.map((row) => row.map((cell) => tableCell(serialize(cell, start, end).trim())));
      const header = rows[0];
      const body = rows.slice(1).filter((row) => row.some(Boolean));
      const delimiter = header.map((_cell, index) => node.align?.[index] === "center" ? ":---:" : node.align?.[index] === "right" ? "---:" : "---");
      return [header, delimiter, ...body].map((row) => `| ${row.join(" | ")} |`).join("\n");
    }
    default: return content;
  }
}

export function extractMarkdown(selection: MarkdownSelection): string[] {
  const projection = new Projection(selection.evidence);
  const tree = projection.sequence(selection.evidence.tokens);
  const text = projection.text;
  const units: Unit[] = [];
  for (const part of segmenter.segment(text)) {
    if (!layoutOnly.test(part.segment) && visibleWidth(part.segment) > 0) {
      units.push({ text: part.segment, start: part.index, end: part.index + part.segment.length });
    }
  }
  if (units.length !== selection.map.units.length || units.some((unit, index) => unit.text !== selection.map.units[index].text)) {
    throw new Error("Markdown 与已标记的显示文字无法精确对应，未导出。可能存在自定义渲染或格式变换。");
  }
  return mergeRanges(selection.ranges).map((range) => {
    if (!Number.isSafeInteger(range.start) || !Number.isSafeInteger(range.end) || range.start < 0 || range.end <= range.start || range.end > units.length) {
      throw new Error("高亮范围无效，未导出。");
    }
    const output = serialize(tree, units[range.start].start, units[range.end - 1].end).trim();
    if (!output) throw new Error("选区只有界面装饰或格式标签，没有可导出的正文。");
    return output;
  });
}

export function formatHighlights(selections: readonly MarkdownSelection[]): { markdown: string; fragments: number } {
  if (!selections.length) throw new Error("当前分支没有可导出的高亮。");
  const fragments = selections.flatMap((selection) => extractMarkdown(selection));
  // Explicit separators never imply that disjoint selections were contiguous.
  return { markdown: fragments.join("\n\n---\n\n") + "\n", fragments: fragments.length };
}
