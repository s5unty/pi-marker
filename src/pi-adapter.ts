import { AssistantMessageComponent, type SessionEntry } from "@earendil-works/pi-coding-agent";
import { Container, MouseRegion, matchesKey, type Component, type Token, type TUI } from "@earendil-works/pi-tui";
import { buildTextMap, cellsForTextRange, findTextRanges, hashText, paintLine, quoteForRange, subtractRanges, textRangeForCells, type TextMap, type TextRange } from "./text-map.ts";
import type { MarkSpan, MarkerMode, SpanReplacement } from "./types.ts";
import type { MarkdownEvidence, MarkdownSelection } from "./markdown-export.ts";

export const TESTED_PI_VERSION = "1.5.2";
const ATTACHED = Symbol.for("pi-marker.adapter.v1");
// pi-tidy 0.9.8 renders a separate presentation tree, sometimes without ever
// rendering Pi's original containers. Read its last-frame geometry, not config.
const TIDY_VIEW = Symbol.for("pi-toolbox:message-view");
const TIDY_TURN = Symbol.for("pi-tidy:turn-layout");

// This file is the ONLY private-API adapter. No prototype/global/file patching.
interface ScrollState { scrollTop: number; isScrollbarVisible: boolean }
interface Point { row: number; col: number; boundary?: boolean; scrollView?: ScrollState }
interface Selection { start: Point; end: Point }
interface MouseInput { button: number; x: number; y: number; release: boolean }
interface Rect { x: number; y: number; width: number; height: number }
interface LayoutBox {
  component: Component;
  rect: Rect;
  clip: Rect;
  children: LayoutBox[];
  scrollView?: ScrollState;
  scrollContentLines?: string[];
}
interface Frame { root: LayoutBox; width: number; height: number; primaryScrollView?: ScrollState }
interface MouseLayout { width: number; children: { component: Component; height: number }[] }
interface ContainerInternals { mouseLayout?: MouseLayout }
type AssistantMessage = Extract<SessionEntry, { type: "message" }>["message"] & { role: "assistant" };
interface AssistantInternals {
  contentContainer: Container;
  lastMessage?: AssistantMessage;
  isStreaming: boolean;
  messageId?: string;
  markdownSlots: { kind: "text" | "thinking"; markdown: Component }[];
  [TIDY_VIEW]?: Component & ContainerInternals & { trimTop: number; rawHeight: number };
  [TIDY_TURN]?: { header: boolean; bodyTop: number; chipShift: number };
}
interface PrivateTui {
  mode: string;
  inputListeners: Set<unknown>;
  terminal: { columns: number; rows: number };
  currentLayout?: Frame;
  selectionPressActive: boolean;
  handleSelectionMouseEvent(event: MouseInput): void;
  getSelectionBounds(): Selection | undefined;
  getSelectionColumns(line: string, row: number, selection: Selection): { start: number; end: number };
  applySearchHighlights(screen: string[], frame: Frame): string[];
  applySelection(screen: string[], frame?: Frame): string[];
  handleViewportInput(data: string): { consume: true } | undefined;
  getCopyOnSelect(): boolean;
  setCopyOnSelect(enabled: boolean): void;
  resetTextSelection(): void;
  requestRender(): void;
  [ATTACHED]?: MarkerAdapter;
}

export interface AdapterHost {
  version: string;
  getBranch(): readonly SessionEntry[];
  getMode(): MarkerMode;
  getSpans(): readonly MarkSpan[];
  commitSelection(spans: MarkSpan[], erased?: readonly SpanReplacement[]): boolean;
  report(message: string): void;
}

export interface RenderedBlock {
  entryId: string;
  blockIndex: number;
  sourceHash: string;
  top: number;
  map: TextMap;
  markdown: Component;
}
export type ExportSelection = MarkdownSelection;
interface Snapshot { frame: Frame; box: LayoutBox; blocks: RenderedBlock[]; tidyMessages: number }
interface Drag {
  lines: readonly string[];
  width: number;
  height: number;
  scrollView?: ScrollState;
  identity: string;
  spans: readonly MarkSpan[];
  mode: MarkerMode;
}

function snapshotIdentity(snapshot: Snapshot | undefined): string {
  return JSON.stringify(snapshot?.blocks.map((block) => [block.entryId, block.blockIndex, block.sourceHash, block.top, block.map.hash]) ?? []);
}

/** Pi injects a forwarding Proxy. Unwrap via a temporary, immediately removed method. */
export function resolveRenderer(reference: TUI): object {
  const key = Symbol("pi-marker.unwrap");
  const ref = reference as unknown as Record<symbol, unknown>;
  let renderer: object | undefined;
  try {
    if (!Reflect.set(ref, key, function (this: object) { return this; })) {
      throw new Error("Pi TUI reference is not writable");
    }
    renderer = (ref[key] as () => object)();
    return renderer;
  } finally {
    if (renderer) Reflect.deleteProperty(renderer, key);
    else Reflect.set(ref, key, undefined);
  }
}

function getScrollBox(frame: Frame): LayoutBox | undefined {
  const visit = (box: LayoutBox): LayoutBox | undefined => {
    if (box.scrollView === frame.primaryScrollView && box.scrollContentLines) return box;
    for (const child of box.children) {
      const found = visit(child);
      if (found) return found;
    }
    return undefined;
  };
  return frame.primaryScrollView ? visit(frame.root) : undefined;
}

function layoutOf(component: Component, width: number): MouseLayout | undefined {
  const layout = (component as unknown as ContainerInternals).mouseLayout;
  return layout?.width === width ? layout : undefined;
}

/** Locate text children by component identity in the tree that actually drew them. */
function assistantLayout(component: Component, assistant: AssistantInternals, width: number):
  { width: number; top: number; children: MouseLayout["children"]; wrapped: boolean } | undefined {
  const view = assistant[TIDY_VIEW];
  if (view) {
    const layout = view.mouseLayout;
    const turn = assistant[TIDY_TURN];
    if (!Container.prototype.isPrototypeOf(view) || !layout || !Number.isSafeInteger(layout.width) ||
        layout.width < 1 || layout.width > width || !Number.isSafeInteger(view.trimTop) ||
        view.trimTop < 0 || view.trimTop > view.rawHeight || !Number.isSafeInteger(view.rawHeight) ||
        !Array.isArray(layout.children) || layout.children.some((child) => !Number.isSafeInteger(child.height) || child.height < 0) ||
        layout.children.reduce((sum, child) => sum + child.height, 0) !== view.rawHeight) return undefined;
    if (turn && (typeof turn.header !== "boolean" || !Number.isSafeInteger(turn.bodyTop) ||
        ![0, 1].includes(turn.bodyTop - Number(turn.header)) || ![0, 1].includes(turn.chipShift))) return undefined;
    return { width: layout.width, top: (turn?.bodyTop ?? 0) - view.trimTop, children: layout.children, wrapped: true };
  }
  const outer = layoutOf(component, width);
  const inner = layoutOf(assistant.contentContainer, width);
  if (!outer || !inner) return undefined;
  let top = 0;
  for (const child of outer.children) {
    if (child.component === assistant.contentContainer) return { width, top, children: inner.children, wrapped: false };
    top += child.height;
  }
  return undefined;
}

/** Verify each identity-bound row against the actual frame, including every glyph.
 * Only layout strokes/whitespace may differ. No substring search or global text
 * matching: duplicate text in other messages, thinking or chrome is never used.
 * The resulting columns include pi-tidy's frame/rail indentation.
 */
function projectMap(map: TextMap, displayed: readonly string[]): TextMap | undefined {
  const rows = new Map<number, typeof map.units>();
  for (const unit of map.units) {
    const row = rows.get(unit.row) ?? [];
    row.push(unit);
    rows.set(unit.row, row);
  }
  const units: typeof map.units = [];
  for (const [row, expected] of rows) {
    const actual = buildTextMap([displayed[row] ?? ""]).units;
    if (actual.length !== expected.length || actual.some((unit, index) => unit.text !== expected[index].text)) return undefined;
    units.push(...actual.map((unit) => ({ ...unit, row })));
  }
  return { ...map, units };
}

/** Replay only this Markdown instance, at its last rendered width, to capture
 * token provenance. Restore the exact method descriptor even on failure. This
 * avoids a second Markdown parser (Pi has CJK/math-specific tokenization) and
 * records pi-tidy's actual code borders rather than guessing their labels.
 */
function markdownEvidence(component: Component, source: string, expected: TextMap): MarkdownEvidence {
  const raw = component as unknown as {
    cachedWidth?: number;
    cachedTokens?: WeakRef<{ source: string; tokens: Token[] }>;
    options?: { preserveOrderedListMarkers?: boolean };
    renderToken(token: Token, ...args: unknown[]): string[];
    renderInlineTokens(tokens: Token[]): string;
  };
  const width = raw.cachedWidth;
  if (!Number.isSafeInteger(width) || width! < 1 || typeof raw.renderToken !== "function" || typeof raw.renderInlineTokens !== "function") {
    throw new Error("当前 Markdown 渲染器没有可验证的导出接口，未导出。");
  }
  const original = raw.renderToken;
  const descriptor = Object.getOwnPropertyDescriptor(component, "renderToken");
  const blocks = new Map<Token, readonly string[]>();
  Object.defineProperty(component, "renderToken", { configurable: true, writable: true,
    value(this: typeof raw, token: Token, ...args: unknown[]) {
      const lines = original.call(this, token, ...args);
      blocks.set(token, lines);
      return lines;
    },
  });
  try {
    component.invalidate();
    const lines = component.render(width!);
    if (buildTextMap(lines).hash !== expected.hash) throw new Error("导出时显示内容发生变化，请确认高亮位置后重试。");
    const parsed = raw.cachedTokens?.deref();
    if (!parsed || !Array.isArray(parsed.tokens)) throw new Error("无法读取 Markdown 结构，未导出。");
    if (parsed.source !== source.replace(/\t/g, "   ")) {
      throw new Error("显示插件改写了原始 Markdown，无法保证原文格式，未导出。请关闭对应的文本变换后确认高亮是否仍匹配。");
    }
    const inline = new Map<Token, string>();
    const visited = new Set<object>();
    const visit = (value: unknown): void => {
      if (!value || typeof value !== "object" || visited.has(value)) return;
      visited.add(value);
      if (Array.isArray(value)) { for (const child of value) visit(child); return; }
      const token = value as Token;
      if (typeof token.type === "string" && (!blocks.has(token) || token.type === "link" || token.type === "text")) {
        inline.set(token, raw.renderInlineTokens([token]));
      }
      const fields = value as { tokens?: unknown; items?: unknown; header?: unknown; rows?: unknown };
      for (const child of [fields.tokens, fields.items, fields.header, fields.rows]) visit(child);
    };
    visit(parsed.tokens);
    return { tokens: parsed.tokens, blocks, inline, preserveOrderedListMarkers: !!raw.options?.preserveOrderedListMarkers };
  } finally {
    if (descriptor) Object.defineProperty(component, "renderToken", descriptor);
    else Reflect.deleteProperty(component, "renderToken");
  }
}

function blockKey(block: Pick<RenderedBlock, "entryId" | "blockIndex">): string {
  return `${block.entryId}:${block.blockIndex}`;
}

export function spanForRange(block: RenderedBlock, range: TextRange): MarkSpan {
  return {
    entryId: block.entryId, blockIndex: block.blockIndex, sourceHash: block.sourceHash,
    displayHash: block.map.hash, ...range, rangeHash: hashText(quoteForRange(block.map, range)),
  };
}

function matchesBlock(span: MarkSpan, block: RenderedBlock): boolean {
  return span.sourceHash === block.sourceHash && span.displayHash === block.map.hash &&
    span.start >= 0 && span.end <= block.map.units.length && span.end > span.start &&
    span.rangeHash === hashText(quoteForRange(block.map, span));
}

export class MarkerAdapter {
  private readonly tui: PrivateTui;
  private readonly host: AdapterHost;
  private disposed = false;
  private failed = false;
  private readonly restore: (() => void)[] = [];
  private previousBranch?: readonly SessionEntry[];
  private readonly messages = new Map<string, AssistantMessage>();
  private identities = new WeakMap<object, string>();
  private readonly signatures = new Map<string, string[]>();
  private readonly messageKeys = new WeakMap<object, string>();
  private readonly maps = new WeakMap<Component, {
    source: string; lines: readonly string[]; displayed: readonly string[]; map?: TextMap; sourceHash: string;
  }>();
  private snapshot?: Snapshot;
  private drag?: Drag;
  private preview?: readonly MarkSpan[];
  private mapped = 0;

  constructor(renderer: object, host: AdapterHost) {
    if (host.version !== TESTED_PI_VERSION) {
      throw new Error(`pi-marker 仅验证过 Pi ${TESTED_PI_VERSION}；当前为 ${host.version}，已禁用私有接口适配。`);
    }
    const tui = renderer as PrivateTui;
    if (tui.mode !== "fullscreen") throw new Error("pi-marker 需要 Fullscreen 模式。");
    for (const name of ["handleSelectionMouseEvent", "getSelectionBounds", "getSelectionColumns", "applySearchHighlights", "applySelection", "handleViewportInput", "getCopyOnSelect", "setCopyOnSelect", "resetTextSelection", "requestRender"] as const) {
      if (typeof tui[name] !== "function") throw new Error(`不兼容的 Pi TUI：缺少 ${name}。`);
    }
    if (!(tui.inputListeners instanceof Set)) throw new Error("不兼容的 Pi TUI 输入层。");
    if (tui[ATTACHED]) throw new Error("pi-marker 已加载；请移除重复的插件配置。");
    this.tui = tui;
    this.host = host;
    tui[ATTACHED] = this;
    const adapter = this;
    try {
      this.patch("applySearchHighlights", function (original, screen, frame) {
        let decorated = screen;
        if (!adapter.disposed && !adapter.failed) {
          try {
            adapter.snapshot = adapter.collect(frame);
            adapter.updatePreview();
            decorated = adapter.paint(screen);
          } catch (error) { adapter.fail(error); }
        }
        // Markers are below native search, overlays, and active selection.
        return original.call(this, decorated, frame);
      });
      this.patch("applySelection", function (original, screen, frame) {
        // Keep the native drag geometry/autoscroll, but don't cover an erasure
        // preview with inverse-video selection: erased text shows its real style.
        if (!adapter.disposed && !adapter.failed && adapter.preview !== undefined) return screen;
        return original.call(this, screen, frame);
      });
      this.patch("handleViewportInput", function (original, data) {
        // Pi's first input listener calls this method dynamically. Cancel before
        // native search can consume Escape, while still letting it close search.
        if (!adapter.disposed && !adapter.failed && adapter.drag && this.selectionPressActive && matchesKey(data, "escape")) {
          adapter.cancelSelection();
          return original.call(this, data) ?? { consume: true };
        }
        return original.call(this, data);
      });
      this.patch("handleSelectionMouseEvent", function (original, event) {
        const active = !adapter.disposed && !adapter.failed && adapter.host.getMode() !== "off";
        const wasPressed = this.selectionPressActive;
        const copy = this.getCopyOnSelect();
        if (active) this.setCopyOnSelect(false);
        try { original.call(this, event); }
        finally { if (active) this.setCopyOnSelect(copy); }
        if (!active) return;
        try {
          if (!event.release && (event.button & 32) === 0 && this.selectionPressActive) adapter.beginDrag();
          if (event.release && wasPressed && !this.selectionPressActive) adapter.finishDrag();
        } catch (error) { adapter.fail(error); }
      });
    } catch (error) {
      this.dispose();
      throw error;
    }
    tui.requestRender();
  }

  private patch<K extends "handleSelectionMouseEvent" | "applySearchHighlights" | "applySelection" | "handleViewportInput">(
    key: K,
    wrapper: (this: PrivateTui, original: PrivateTui[K], ...args: Parameters<PrivateTui[K]>) => ReturnType<PrivateTui[K]>,
  ): void {
    const original = this.tui[key];
    const descriptor = Object.getOwnPropertyDescriptor(this.tui, key);
    const patched = function (this: PrivateTui, ...args: Parameters<PrivateTui[K]>) {
      return wrapper.call(this, original, ...args);
    };
    Object.defineProperty(this.tui, key, { value: patched, writable: true, configurable: true });
    this.restore.push(() => {
      if (this.tui[key] !== patched) return; // Do not overwrite a later extension's wrapper.
      if (descriptor) Object.defineProperty(this.tui, key, descriptor);
      else Reflect.deleteProperty(this.tui, key);
    });
  }

  private fail(error: unknown): void {
    this.failed = true;
    this.drag = undefined;
    this.preview = undefined;
    this.host.report(`pi-marker 已停止标记以保护显示：${error instanceof Error ? error.message : String(error)}`);
    this.tui.requestRender();
  }

  private messageKey(message: AssistantMessage): string {
    let key = this.messageKeys.get(message);
    if (!key) {
      key = `${message.timestamp}:${hashText(JSON.stringify(message.content))}`;
      this.messageKeys.set(message, key);
    }
    return key;
  }

  private refreshMessages(): void {
    const branch = this.host.getBranch();
    if (branch === this.previousBranch) return;
    this.previousBranch = branch;
    this.messages.clear();
    this.identities = new WeakMap();
    this.signatures.clear();
    for (const entry of branch) {
      if (entry.type !== "message" || entry.message.role !== "assistant") continue;
      const message = entry.message;
      this.messages.set(entry.id, message);
      this.identities.set(message, entry.id);
      const key = this.messageKey(message);
      const ids = this.signatures.get(key) ?? [];
      ids.push(entry.id);
      this.signatures.set(key, ids);
    }
  }

  private messageId(component: AssistantInternals): string | undefined {
    const message = component.lastMessage;
    if (!message) return undefined;
    if (component.messageId && this.messages.has(component.messageId)) return component.messageId;
    const identity = this.identities.get(message);
    if (identity) return identity;
    // Live finalized components have no messageId in Pi 1.5.2. Only a unique
    // timestamp + content signature is acceptable; never search text globally.
    const matches = this.signatures.get(this.messageKey(message));
    return matches?.length === 1 ? matches[0] : undefined;
  }

  private collect(frame: Frame): Snapshot | undefined {
    this.refreshMessages();
    const box = getScrollBox(frame);
    const contentBox = box?.children[0];
    if (!box || !contentBox) return undefined;
    const width = contentBox.rect.width;
    const blocks: RenderedBlock[] = [];
    let tidyMessages = 0;
    const visit = (component: Component, top: number, height: number): void => {
      // A folded message can retain stale native/presentation caches.
      if (height <= 0) return;
      if (component instanceof AssistantMessageComponent) {
        const assistant = component as unknown as AssistantInternals;
        const message = assistant.lastMessage;
        if (!message || assistant.isStreaming || ["aborted", "error", "length"].includes(message.stopReason)) return;
        const entryId = this.messageId(assistant);
        if (!entryId) return;
        const texts = message.content.flatMap((part, index) => part.type === "text" && part.text.trim() ? [{ index, text: part.text }] : []);
        const slots = assistant.markdownSlots.filter((slot) => slot.kind === "text");
        if (texts.length !== slots.length) return;
        const layout = assistantLayout(component, assistant, width);
        if (!layout) return;
        if (layout.wrapped) tidyMessages++;
        let contentTop = top + layout.top;
        for (const child of layout.children) {
          const sourceComponent = layout.wrapped && child.component instanceof MouseRegion
            ? (child.component as unknown as { child: Component }).child : child.component;
          const slotIndex = slots.findIndex((slot) => slot.markdown === sourceComponent);
          if (slotIndex >= 0 && child.height > 0) {
            const source = texts[slotIndex];
            // pi-tidy's MouseRegions return captured rows. Do NOT re-render the
            // underlying Markdown at the outer width or mutate its code caches.
            const lines = child.component.render(layout.width);
            if (lines.length !== child.height) return;
            const displayed = lines.map((_line, row) => {
              const absoluteRow = contentTop + row;
              return absoluteRow >= top && absoluteRow < top + height ? box.scrollContentLines?.[absoluteRow] ?? "" : "";
            });
            let cached = this.maps.get(sourceComponent);
            if (!cached || cached.lines !== lines || cached.source !== source.text ||
                cached.displayed.length !== displayed.length || displayed.some((line, row) => line !== cached!.displayed[row])) {
              cached = { lines, displayed, source: source.text, sourceHash: hashText(source.text), map: projectMap(buildTextMap(lines), displayed) };
              this.maps.set(sourceComponent, cached);
            }
            if (cached.map) blocks.push({ entryId, blockIndex: source.index, sourceHash: cached.sourceHash, top: contentTop, map: cached.map, markdown: sourceComponent });
          }
          contentTop += child.height;
        }
        return;
      }
      // Only recurse through Pi's plain concatenating Containers. Box/third-party
      // wrappers can add padding or transform content and must not be guessed.
      if (Object.getPrototypeOf(component) !== Container.prototype) return;
      const layout = layoutOf(component, width);
      if (!layout) return;
      let childTop = top;
      for (const child of layout.children) {
        visit(child.component, childTop, child.height);
        childTop += child.height;
      }
    };
    visit(contentBox.component, 0, box.scrollContentLines?.length ?? 0);
    return { frame, box, blocks, tidyMessages };
  }

  private paint(screen: string[]): string[] {
    this.mapped = 0;
    const snapshot = this.snapshot;
    if (!snapshot) return screen;
    const { box, blocks } = snapshot;
    const scroll = box.scrollView!;
    const byKey = new Map(blocks.map((block) => [blockKey(block), block]));
    const rows = new Map<number, TextRange[]>();
    const top = Math.max(0, box.rect.y, box.clip.y);
    const bottom = Math.min(screen.length, box.rect.y + box.rect.height, box.clip.y + box.clip.height);
    const left = Math.max(0, box.rect.x, box.clip.x);
    const right = Math.min(this.tui.terminal.columns, box.clip.x + box.clip.width,
      box.rect.x + box.rect.width - (scroll.isScrollbarVisible ? 1 : 0));
    for (const span of this.preview ?? this.host.getSpans()) {
      const block = byKey.get(blockKey(span));
      if (!block || !matchesBlock(span, block)) continue;
      this.mapped++;
      for (const cell of cellsForTextRange(block.map, span)) {
        const row = box.rect.y + block.top + cell.row - scroll.scrollTop;
        if (row < top || row >= bottom) continue;
        const start = Math.max(left, box.rect.x + cell.start);
        const end = Math.min(right, box.rect.x + cell.end);
        if (end <= start) continue;
        const ranges = rows.get(row) ?? [];
        ranges.push({ start, end });
        rows.set(row, ranges);
      }
    }
    if (rows.size === 0) return screen;
    const result = [...screen];
    for (const [row, ranges] of rows) result[row] = paintLine(screen[row], ranges);
    return result;
  }

  private erasuresForSelection(selection: readonly MarkSpan[], snapshot: Snapshot,
    saved: readonly MarkSpan[] = this.host.getSpans()): SpanReplacement[] {
    const blocks = new Map(snapshot.blocks.map((block) => [blockKey(block), block]));
    return saved.flatMap((span) => {
      const block = blocks.get(blockKey(span));
      if (!block || !matchesBlock(span, block)) return [];
      const cuts = selection.filter((selected) => blockKey(selected) === blockKey(span) &&
        selected.sourceHash === span.sourceHash && selected.displayHash === span.displayHash &&
        selected.start < span.end && selected.end > span.start);
      if (!cuts.length) return [];
      return [{ span, remaining: subtractRanges(span, cuts).map((range) => spanForRange(block, range)) }];
    });
  }

  private selectionSpans(snapshot: Snapshot, selection: Selection): MarkSpan[] {
    const spans: MarkSpan[] = [];
    const lines = snapshot.box.scrollContentLines!;
    for (const block of snapshot.blocks) {
      const first = Math.max(block.top, selection.start.row);
      const last = Math.min(block.top + block.map.lines.length - 1, selection.end.row);
      if (first > last) continue;
      const cells = [];
      for (let row = first; row <= last; row++) {
        cells.push({ row: row - block.top, ...this.tui.getSelectionColumns(lines[row] ?? "", row, selection) });
      }
      const range = textRangeForCells(block.map, cells);
      if (range) spans.push(spanForRange(block, range));
    }
    return spans;
  }

  private validDrag(drag: Drag, snapshot: Snapshot | undefined): snapshot is Snapshot {
    const lines = snapshot?.box.scrollContentLines;
    return !!snapshot && !!lines && snapshot.box.scrollView === drag.scrollView &&
      drag.width === this.tui.terminal.columns && drag.height === this.tui.terminal.rows &&
      drag.width === snapshot.frame.width && drag.height === snapshot.frame.height &&
      lines.length === drag.lines.length && lines.every((line, index) => line === drag.lines[index]) &&
      snapshotIdentity(snapshot) === drag.identity && this.host.getSpans() === drag.spans &&
      this.host.getMode() === drag.mode;
  }

  private updatePreview(): void {
    this.preview = undefined;
    const drag = this.drag;
    if (!drag) return;
    if (!this.tui.selectionPressActive || this.host.getMode() === "off") { this.drag = undefined; return; }
    const snapshot = this.snapshot;
    if (!this.validDrag(drag, snapshot)) {
      this.cancelSelection();
      this.host.report("拖选期间内容、标记或窗口尺寸发生变化，本次未标记，请重新选择。");
      return;
    }
    const selection = this.tui.getSelectionBounds();
    if (!selection || selection.start.scrollView !== drag.scrollView) return;
    const spans = this.selectionSpans(snapshot, selection);
    if (!spans.length || spans.length > 128) return;
    const erased = this.erasuresForSelection(spans, snapshot, drag.spans);
    if (drag.mode !== "erase" && !erased.length) return;
    // Always derive from the press-time snapshot, never the previous preview.
    const replacements = new Map(erased.map(({ span, remaining }) => [span, remaining]));
    this.preview = drag.spans.flatMap((span) => replacements.get(span) ?? [span]);
  }

  private beginDrag(): void {
    this.drag = undefined;
    this.preview = undefined;
    const frame = this.tui.currentLayout;
    const box = frame && getScrollBox(frame);
    const selection = this.tui.getSelectionBounds();
    // On a single press getSelectionBounds is empty; the scroll target is
    // validated on release. Snapshot logical content so autoscroll remains safe.
    if (selection && selection.start.scrollView !== box?.scrollView) return;
    if (!box?.scrollContentLines || !frame || this.snapshot?.frame !== frame) return;
    this.drag = { lines: box.scrollContentLines, width: frame.width, height: frame.height, scrollView: box.scrollView,
      identity: snapshotIdentity(this.snapshot), spans: this.host.getSpans(), mode: this.host.getMode() };
  }

  private finishDrag(): void {
    const drag = this.drag;
    this.drag = undefined;
    this.preview = undefined;
    const selection = this.tui.getSelectionBounds();
    const frame = this.tui.currentLayout;
    if (!drag || !selection || !frame || selection.start.scrollView !== drag.scrollView) return;
    const box = getScrollBox(frame);
    const lines = box?.scrollContentLines;
    if (!lines || box?.scrollView !== drag.scrollView) return;
    const current = this.collect(frame);
    if (!this.validDrag(drag, current) || this.snapshot?.frame !== frame || snapshotIdentity(this.snapshot) !== drag.identity) {
      this.tui.resetTextSelection();
      this.host.report("拖选期间内容、标记或窗口尺寸发生变化，本次未标记，请重新选择。");
      return;
    }
    const snapshot = current;
    const spans = this.selectionSpans(snapshot, selection);
    if (spans.length === 0) {
      this.host.report(snapshot.blocks.length === 0 && this.messages.size > 0
        ? "未识别到当前布局中的可标记回答；请执行 /marker status，并反馈是否启用了界面美化插件。"
        : "请选择已完成 AI 回答中的文字；工具输出、思考区和纯空白不支持标记。");
      return;
    }
    if (spans.length > 128) {
      this.host.report("一次最多标记 128 个文本块，请分段选择。");
      return;
    }
    const erased = this.erasuresForSelection(spans, snapshot, drag.spans);
    const erasing = drag.mode === "erase" || erased.length > 0;
    const committed = this.host.commitSelection(spans, erasing ? erased : undefined);
    // A failed erasure write must restore the saved appearance too.
    if (committed || erasing) this.tui.resetTextSelection();
    this.tui.requestRender();
  }

  /** No mouse required: select a unique phrase in the latest completed answer. */
  markText(text: string): void {
    if (this.disposed || this.failed) throw new Error("标记适配器不可用，请 /reload 后重试。");
    const frame = this.tui.currentLayout;
    const snapshot = frame && this.collect(frame);
    const latest = [...this.messages.keys()].at(-1);
    const candidates = snapshot?.blocks.filter((block) => block.entryId === latest) ?? [];
    const matches = candidates.flatMap((block) => findTextRanges(block.map, text).map((range) => spanForRange(block, range)));
    if (matches.length !== 1) {
      throw new Error(matches.length === 0 ? "最近一条已完成回答中没有找到该文字。" : "该文字出现多次，请提供更长且唯一的片段，或用鼠标选择。");
    }
    // Keyboard marking stays additive; explicit erase uses the same exact cuts.
    this.host.commitSelection(matches, this.host.getMode() === "erase" ? this.erasuresForSelection(matches, snapshot!) : undefined);
    this.tui.requestRender();
  }

  /** Freeze all current-branch marks for export. Never silently omit a stale or
   * folded mark: every stored span must pass the same checks as painting.
   */
  exportSelections(): ExportSelection[] {
    if (this.disposed || this.failed) throw new Error("标记适配器不可用，请 /reload 后重试。");
    const spans = this.host.getSpans();
    if (spans.length === 0) throw new Error("当前分支没有可导出的高亮。");
    const frame = this.tui.currentLayout;
    const snapshot = frame && this.collect(frame);
    const blocks = new Map(snapshot?.blocks.map((block) => [blockKey(block), block]));
    const selected = new Map<string, Omit<ExportSelection, "evidence">>();
    let unmatched = 0;
    for (const span of spans) {
      const block = blocks.get(blockKey(span));
      const source = this.messages.get(span.entryId)?.content[span.blockIndex];
      if (!block || !matchesBlock(span, block) || source?.type !== "text") { unmatched++; continue; }
      const key = blockKey(span);
      const item = selected.get(key) ?? { entryId: span.entryId, blockIndex: span.blockIndex,
        source: source.text, map: block.map, ranges: [] };
      item.ranges.push({ start: span.start, end: span.end });
      selected.set(key, item);
    }
    if (unmatched) throw new Error(`有 ${unmatched} 段高亮暂时无法精确还原，未导出任何内容。请展开被折叠的回答，或恢复标记时的显示布局后重试。`);
    const order = new Map([...this.messages.keys()].map((id, index) => [id, index]));
    const ordered = [...selected.values()].sort((a, b) => order.get(a.entryId)! - order.get(b.entryId)! || a.blockIndex - b.blockIndex);
    try {
      return ordered.map((item) => ({ ...item, evidence: markdownEvidence(blocks.get(blockKey(item))!.markdown, item.source, item.map) }));
    } finally {
      this.tui.requestRender(); // Reconcile the rebuilt per-instance caches with the next frame.
    }
  }

  get diagnostics(): { mapped: number; total: number; failed: boolean; messages: number; indexed: number; tidyMessages: number } {
    return { mapped: this.mapped, total: this.host.getSpans().length, failed: this.failed,
      messages: this.messages.size, indexed: this.snapshot?.blocks.length ?? 0, tidyMessages: this.snapshot?.tidyMessages ?? 0 };
  }

  requestRender(): void { this.tui.requestRender(); }

  cancelSelection(): void {
    this.drag = undefined;
    this.preview = undefined;
    this.tui.resetTextSelection();
    this.tui.requestRender();
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.drag = undefined;
    this.preview = undefined;
    for (const restore of this.restore.reverse()) restore();
    if (this.tui[ATTACHED] === this) delete this.tui[ATTACHED];
    this.tui.requestRender();
  }
}
