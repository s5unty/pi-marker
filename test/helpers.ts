import { AssistantMessageComponent, getMarkdownTheme, initTheme, type SessionEntry } from "@earendil-works/pi-coding-agent";
import { Container, ScrollView, Text, TuiAltScreen, VStack, setCapabilities, stripTerminalSequences, visibleWidth, type Terminal, type ProgramStatus } from "@earendil-works/pi-tui";
import { MarkerAdapter } from "../src/pi-adapter.ts";
import type { MarkSpan, MarkerMode } from "../src/types.ts";

initTheme("dark", false);
setCapabilities({ trueColor: true, hyperlinks: true, images: null });

export class FakeTerminal implements Terminal {
  columns = 65;
  rows = 20;
  kittyProtocolActive = false;
  writes: string[] = [];
  onInput?: (data: string) => void;
  onResize?: () => void;
  start(onInput: (data: string) => void, onResize: () => void) { this.onInput = onInput; this.onResize = onResize; }
  stop() { this.onInput = undefined; this.onResize = undefined; }
  async drainInput() {}
  write(data: string) { this.writes.push(data); }
  moveBy(_lines: number) {}
  hideCursor() {}
  showCursor() {}
  clearLine() {}
  clearFromCursor() {}
  clearScreen() {}
  setTitle(_title: string) {}
  setProgress(_active: boolean) {}
  setProgramStatus(_status: ProgramStatus) {}
  resize(columns: number, rows = this.rows) { this.columns = columns; this.rows = rows; this.onResize?.(); }
  send(data: string) { this.onInput?.(data); }
}

type MessageEntry = Extract<SessionEntry, { type: "message" }>;
export type AssistantEntry = MessageEntry & { message: Extract<MessageEntry["message"], { role: "assistant" }> };
let serial = 0;
export function assistantEntry(text: string): AssistantEntry {
  const number = ++serial;
  return {
    id: `assistant-${number}`, parentId: null, type: "message", timestamp: new Date(number).toISOString(),
    message: {
      role: "assistant", content: [{ type: "text", text }], api: "openai-completions", provider: "fixture", model: "fixture",
      timestamp: number, stopReason: "stop",
      usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
    },
  };
}

export function componentFor(entry: Extract<SessionEntry, { type: "message" }>, live = false): AssistantMessageComponent {
  if (entry.message.role !== "assistant") throw new Error("assistant fixture required");
  return new AssistantMessageComponent(entry.message, true, getMarkdownTheme(), "Thinking...", 1, [], live ? undefined : entry.id, entry.timestamp);
}

export function harness(entries = [assistantEntry("Hello **marker** world. 中文测试 👩🏽‍💻 é.")], live = false) {
  const terminal = new FakeTerminal();
  const copied: string[] = [];
  const tui = new TuiAltScreen(terminal, false, undefined, { copySelection: async (text) => { copied.push(text); return true; } });
  const chat = new Container();
  const components = entries.map((entry) => componentFor(entry, live));
  for (const component of components) chat.addChild(component);
  const document = new Container();
  document.addChild(new Text("fixture header", 0, 0));
  document.addChild(chat);
  const scroll = new ScrollView(document, { primary: true, follow: "end" });
  tui.setLayoutRoot(new VStack([{ component: scroll, grow: 1, basis: 0 }, new Text("fixture editor", 0, 0)]));
  let mode: MarkerMode = "mark";
  let branch: readonly SessionEntry[] = entries;
  let spans: MarkSpan[] = [];
  const reports: string[] = [];
  const adapter = new MarkerAdapter(tui, {
    getBranch: () => branch,
    getMode: () => mode,
    getSpans: () => spans,
    commitSelection: (selected, erased) => {
      if (erased) {
        const replacements = new Map(erased.map(({ span, remaining }) => [span, remaining]));
        spans = spans.flatMap((span) => replacements.get(span) ?? [span]);
        return erased.length > 0;
      }
      spans = [...spans, ...selected];
      return true;
    },
    report: (message) => reports.push(message),
  });
  tui.start();
  tui.renderNow();
  const mouse = (button: number, x: number, y: number, release = false) => {
    terminal.send(`\x1b[<${button};${x + 1};${y + 1}${release ? "m" : "M"}`);
    tui.renderNow();
  };
  const locate = (text: string, occurrence = 0) => {
    let count = 0;
    for (const [row, raw] of tui.getScreenLines().entries()) {
      const line = stripTerminalSequences(raw);
      for (let from = 0; from <= line.length;) {
        const index = line.indexOf(text, from);
        if (index < 0) break;
        if (count++ === occurrence) return { row, start: visibleWidth(line.slice(0, index)), end: visibleWidth(line.slice(0, index + text.length)) - 1 };
        from = index + Math.max(1, text.length);
      }
    }
    throw new Error(`Not visible: ${text}\n${tui.getScreenLines().map(stripTerminalSequences).join("\n")}`);
  };
  const drag = (text: string, reverse = false, occurrence = 0) => {
    const { row, start, end } = locate(text, occurrence);
    mouse(0, reverse ? end : start, row);
    mouse(32, reverse ? start : end, row);
    mouse(0, reverse ? start : end, row, true);
  };
  return {
    terminal, tui, chat, scroll, components, adapter, copied, reports, mouse, locate, drag,
    get spans() { return spans; },
    set spans(next: MarkSpan[]) { spans = next; },
    set branch(next: readonly SessionEntry[]) { branch = next; },
    set mode(next: MarkerMode) { mode = next; },
    close() { adapter.dispose(); tui.stop(); },
  };
}

export function highlightedText(lines: readonly string[]): string {
  const parts: string[] = [];
  for (const line of lines) {
    let active = false;
    let position = 0;
    for (const match of line.matchAll(/\x1b\[[0-9;:]*m/g)) {
      if (active) parts.push(stripTerminalSequences(line.slice(position, match.index)));
      const params = match[0].slice(2, -1);
      if (params === "0" || params === "" || params === "49") active = false;
      if (params.startsWith("48;")) active = params === "48;2;255;220;85";
      position = match.index + match[0].length;
    }
    if (active) parts.push(stripTerminalSequences(line.slice(position)));
  }
  return parts.join("");
}
