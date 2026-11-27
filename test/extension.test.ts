import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { SessionManager, discoverAndLoadExtensions, type ExtensionAPI, type ExtensionContext, type ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { Container, ScrollView, Text, TuiAltScreen, TuiMainScreen, VStack, stripTerminalSequences, visibleWidth, type Component, type TUI } from "@earendil-works/pi-tui";
import markerExtension from "../src/index.ts";
import { ENTRY_TYPE, MarkerStore } from "../src/store.ts";
import { assistantEntry, componentFor, FakeTerminal, highlightedText } from "./helpers.ts";

type EventHandler = (event: object, context: ExtensionContext) => unknown;
type Command = { handler(args: string, context: ExtensionCommandContext): Promise<void> };

function extensionFixture(manager: SessionManager, loaded?: Awaited<ReturnType<typeof discoverAndLoadExtensions>>) {
  const terminal = new FakeTerminal();
  let tui: TuiAltScreen | TuiMainScreen = new TuiAltScreen(terminal, false, undefined, { copySelection: async () => true });
  const reference = new Proxy({} as TUI, {
    get: (_target, key) => {
      const target = tui;
      const value = Reflect.get(target, key);
      return typeof value === "function" ? (...args: unknown[]) => Reflect.apply(value, target, args) : value;
    },
    set: (_target, key, value) => Reflect.set(tui, key, value),
    has: (_target, key) => Reflect.has(tui, key),
    getPrototypeOf: () => Object.getPrototypeOf(tui),
  });
  const screen = () => (tui as TuiAltScreen).getScreenLines();
  const chat = new Container();
  for (const entry of manager.getBranch()) {
    if (entry.type === "message" && entry.message.role === "assistant") chat.addChild(componentFor(entry));
  }
  const document = new Container();
  document.addChild(new Text("fixture", 0, 0));
  document.addChild(chat);
  const widgets = new Container();
  const scroll = new ScrollView(document, { primary: true, follow: "end" });
  const root = new VStack([{ component: scroll, grow: 1, basis: 0 }, widgets, new Text("editor", 0, 0)]);
  tui.setLayoutRoot(root);
  const notifications: string[] = [];
  const clipboard: string[] = [];
  let rejectClipboard = false;
  const statuses = new Map<string, string>();
  const events = new Map<string, EventHandler>();
  const commands = new Map<string, Command>();
  let rejectWrites = false;
  const context = {
    mode: "tui", hasUI: true, sessionManager: manager, cwd: manager.getCwd(),
    ui: {
      theme: { fg: (_color: string, text: string) => text },
      notify: (message: string) => notifications.push(message),
      confirm: async () => true,
      setStatus: (key: string, value?: string) => value ? statuses.set(key, value) : statuses.delete(key),
      setWidget: (_key: string, factory?: (tui: TUI) => Component) => {
        for (const component of widgets.children) (component as Component & { dispose?(): void }).dispose?.();
        widgets.clear();
        if (factory) widgets.addChild(factory(reference));
      },
    },
  } as unknown as ExtensionCommandContext;
  const pi = {
    on: (event: string, handler: EventHandler) => { events.set(event, handler); return () => events.delete(event); },
    registerCommand: (name: string, command: Command) => commands.set(name, command),
    appendEntry: (type: string, data: unknown) => {
      if (rejectWrites) throw new Error("simulated write failure");
      manager.appendCustomEntry(type, data);
    },
  } as unknown as ExtensionAPI;
  const register = () => {
    if (!loaded) {
      markerExtension(pi, { copyToClipboard: async (text) => {
        if (rejectClipboard) throw new Error("simulated clipboard failure");
        clipboard.push(text);
      } });
      return;
    }
    loaded.runtime.appendEntry = (type, data) => {
      if (rejectWrites) throw new Error("simulated write failure");
      manager.appendCustomEntry(type, data);
    };
    const extension = loaded.extensions[0];
    for (const [name, handlers] of extension.handlers) {
      events.set(name, (event, ctx) => { for (const handler of handlers) handler(event, ctx); });
    }
    for (const [name, command] of extension.commands) commands.set(name, command);
  };
  register();
  events.get("session_start")!({ reason: "startup" }, context);
  tui.start();
  tui.renderNow();
  const command = async (args: string) => {
    await commands.get("marker")!.handler(args, context);
    tui.renderNow();
  };
  const locate = (text: string) => {
    const row = screen().findIndex((line) => stripTerminalSequences(line).includes(text));
    assert.ok(row >= 0);
    const line = stripTerminalSequences(screen()[row]);
    const start = visibleWidth(line.slice(0, line.indexOf(text)));
    return { row, start, end: start + visibleWidth(text) - 1 };
  };
  const mouse = (button: number, col: number, row: number, release = false) => {
    terminal.send(`\x1b[<${button};${col + 1};${row + 1}${release ? "m" : "M"}`);
    tui.renderNow();
  };
  const drag = (text: string, reverse = false) => {
    const { row, start, end } = locate(text);
    mouse(0, reverse ? end : start, row);
    mouse(32, reverse ? start : end, row);
    mouse(0, reverse ? start : end, row, true);
  };
  return {
    get tui() { return tui as TuiAltScreen; },
    terminal, notifications, clipboard, statuses, events, context, command, drag, locate, mouse,
    set rejectClipboard(value: boolean) { rejectClipboard = value; },
    set rejectWrites(value: boolean) { rejectWrites = value; },
    reload() {
      events.get("session_shutdown")!({ reason: "reload" }, context);
      events.clear(); commands.clear();
      register();
      events.get("session_start")!({ reason: "reload" }, context);
      tui.renderNow();
    },
    switchMode(mode: "fullscreen" | "regular") {
      tui.stop();
      tui = mode === "fullscreen" ? new TuiAltScreen(terminal) : new TuiMainScreen(terminal);
      if (tui instanceof TuiAltScreen) tui.setLayoutRoot(root);
      else tui.addChild(root);
      tui.start();
      tui.renderNow();
      tui.renderNow();
    },
    close() { events.get("session_shutdown")!({ reason: "quit" }, context); tui.stop(); },
  };
}

function session(text = "Highlight this phrase. Also 中文测试.") {
  const directory = mkdtempSync(join(tmpdir(), "pi-marker-extension-"));
  const manager = SessionManager.create(directory, directory);
  const answerId = manager.appendMessage(assistantEntry(text).message);
  return { directory, manager, answerId, clean() { rmSync(directory, { recursive: true, force: true }); } };
}

test("full extension mouse marks persist and render after session reopen", async () => {
  const s = session();
  let f = extensionFixture(s.manager);
  try {
    const originalContext = s.manager.buildSessionProjection().messages;
    await f.command("on");
    assert.equal(f.statuses.get("pi-marker"), "marker: 0");
    f.drag("this phrase");
    assert.equal(f.statuses.get("pi-marker"), "marker: 1");
    assert.equal(highlightedText(f.tui.getScreenLines()), "this phrase");
    assert.ok(s.manager.getBranch().some((entry) => entry.type === "custom" && entry.customType === ENTRY_TYPE));
    assert.deepEqual(s.manager.buildSessionProjection().messages, originalContext);
    f.close();
    const reopened = SessionManager.open(s.manager.getSessionFile()!, s.directory);
    f = extensionFixture(reopened);
    assert.equal(highlightedText(f.tui.getScreenLines()), "this phrase");
    assert.equal(f.statuses.has("pi-marker"), false);
    await f.command("undo");
    assert.equal(highlightedText(f.tui.getScreenLines()), "");
  } finally { f.close(); s.clean(); }
});

test("bare marker toggles marking and hides the status bar when off without losing marks", async () => {
  const s = session();
  const f = extensionFixture(s.manager);
  try {
    assert.equal(f.statuses.has("pi-marker"), false);
    await f.command("");
    assert.equal(f.statuses.get("pi-marker"), "marker: 0");
    f.drag("this phrase");
    await f.command("status");
    assert.equal(f.notifications.at(-1), "marker: mark · 1 笔 · 1/1 段已匹配");
    await f.command("");
    assert.equal(f.statuses.has("pi-marker"), false);
    const leaf = s.manager.getLeafId();
    f.drag("中文测试");
    assert.equal(s.manager.getLeafId(), leaf, "dragging while off must not add a mark");
    await f.command("status");
    assert.equal(f.notifications.at(-1), "marker: off · 1 笔 · 1/1 段已匹配");
    assert.equal(f.statuses.has("pi-marker"), false);
    assert.equal(highlightedText(f.tui.getScreenLines()), "this phrase");
    await f.command("erase");
    assert.equal(f.statuses.get("pi-marker"), "marker: 1");
    await f.command("   ");
    assert.equal(f.statuses.has("pi-marker"), false);
    await f.command("");
    assert.equal(f.statuses.get("pi-marker"), "marker: 1");
    f.drag("中文测试");
    assert.equal(f.statuses.get("pi-marker"), "marker: 2");
  } finally { f.close(); s.clean(); }
});

test("commands support keyboard marks, erasing, clear, undo and branch navigation", async () => {
  const s = session();
  const f = extensionFixture(s.manager);
  try {
    await f.command("text this phrase");
    await f.command("text 中文测试");
    const markedLeaf = s.manager.getLeafId()!;
    assert.equal(f.statuses.has("pi-marker"), false);
    assert.equal(highlightedText(f.tui.getScreenLines()), "this phrase中文测试");
    await f.command("erase");
    assert.equal(f.statuses.get("pi-marker"), "marker: 2");
    f.drag("中文测试");
    assert.equal(f.statuses.get("pi-marker"), "marker: 1");
    assert.equal(highlightedText(f.tui.getScreenLines()), "this phrase");
    await f.command("undo");
    assert.equal(f.statuses.get("pi-marker"), "marker: 2");
    assert.equal(highlightedText(f.tui.getScreenLines()), "this phrase中文测试");
    await f.command("clear");
    assert.equal(f.statuses.get("pi-marker"), "marker: 0");
    assert.equal(highlightedText(f.tui.getScreenLines()), "");
    await f.command("undo");
    assert.equal(f.statuses.get("pi-marker"), "marker: 2");
    assert.equal(highlightedText(f.tui.getScreenLines()), "this phrase中文测试");
    s.manager.branch(s.answerId);
    f.events.get("session_tree")!({}, f.context);
    f.tui.renderNow();
    assert.equal(f.statuses.get("pi-marker"), "marker: 0");
    assert.equal(highlightedText(f.tui.getScreenLines()), "");
    s.manager.branch(markedLeaf);
    f.events.get("session_tree")!({}, f.context);
    f.tui.renderNow();
    assert.equal(f.statuses.get("pi-marker"), "marker: 2");
    assert.equal(highlightedText(f.tui.getScreenLines()), "this phrase中文测试");
    assert.ok(!f.notifications.some((text) => text.includes("失败")));
  } finally { f.close(); s.clean(); }
});

test("a failed append never leaves an unsaved visible mark", async () => {
  const s = session();
  const f = extensionFixture(s.manager);
  try {
    f.rejectWrites = true;
    await f.command("text this phrase");
    assert.equal(highlightedText(f.tui.getScreenLines()), "");
    assert.match(f.notifications[0], /保存失败/);
    assert.equal(s.manager.getBranch().filter((entry) => entry.type === "custom").length, 0);
    f.rejectWrites = false;
    await f.command("text this phrase");
    assert.equal(highlightedText(f.tui.getScreenLines()), "this phrase");
  } finally { f.close(); s.clean(); }
});

test("reload and fullscreen/regular replacement rebind the stable TUI proxy safely", async () => {
  const s = session();
  const f = extensionFixture(s.manager);
  try {
    await f.command("text this phrase");
    f.reload();
    assert.equal(highlightedText(f.tui.getScreenLines()), "this phrase");
    await f.command("on");
    f.switchMode("regular");
    assert.equal(f.statuses.has("pi-marker"), false);
    await f.command("status");
    assert.match(f.notifications.at(-1)!, /^marker: off · 1 笔 · 0\/1 段已匹配 · Pi \S+：[^\r\n]*Fullscreen[^\r\n]*$/);
    await f.command("on");
    assert.match(f.notifications.at(-1)!, /Fullscreen/);
    f.switchMode("fullscreen");
    assert.equal(highlightedText(f.tui.getScreenLines()), "this phrase");
    await f.command("on");
    f.drag("中文测试");
    assert.equal(highlightedText(f.tui.getScreenLines()), "this phrase中文测试");
    f.close();
    assert.equal(f.statuses.has("pi-marker"), false);
  } finally { f.close(); s.clean(); }
});

test("a clear confirmation cannot clear a different branch after navigation", async () => {
  const s = session();
  const f = extensionFixture(s.manager);
  try {
    await f.command("text this phrase");
    const branchA = s.manager.getLeafId()!;
    s.manager.branch(s.answerId);
    f.events.get("session_tree")!({}, f.context);
    await f.command("text 中文测试");
    const branchB = s.manager.getLeafId()!;
    s.manager.branch(branchA);
    f.events.get("session_tree")!({}, f.context);
    f.context.ui.confirm = async () => {
      s.manager.branch(branchB);
      f.events.get("session_tree")!({}, f.context);
      return true;
    };
    await f.command("clear");
    assert.equal(highlightedText(f.tui.getScreenLines()), "中文测试");
    assert.ok(f.notifications.some((message) => message.includes("会话位置发生变化")));
  } finally { f.close(); s.clean(); }
});

test("export commands preserve Markdown, deduplicate, and never change marks or model context", async () => {
  const s = session("Before **alpha beta gamma** after. Also *中文测试*.");
  const f = extensionFixture(s.manager);
  try {
    await f.command("text beta gamma");
    await f.command("text alpha beta");
    await f.command("text 中文测试");
    await f.command("off");
    const status = f.statuses.get("pi-marker");
    const branch = JSON.stringify(s.manager.getBranch());
    const model = s.manager.buildSessionProjection().messages;
    const expected = "**alpha beta gamma**\n\n---\n\n*中文测试*\n";
    await f.command('export "notes/my highlights.md"');
    assert.equal(readFileSync(join(s.directory, "notes/my highlights.md"), "utf8"), expected);
    await f.command("copy");
    assert.deepEqual(f.clipboard, [expected]);
    assert.equal(f.statuses.get("pi-marker"), status);
    assert.equal(JSON.stringify(s.manager.getBranch()), branch);
    assert.deepEqual(s.manager.buildSessionProjection().messages, model);
    assert.equal(highlightedText(f.tui.getScreenLines()), "alpha beta gamma中文测试");
  } finally { f.close(); s.clean(); }
});

test("copy rejects arguments and the retired clipboard flag points to the new command", async () => {
  const s = session();
  const f = extensionFixture(s.manager);
  try {
    await f.command("text this phrase");
    await f.command("copy extra");
    assert.match(f.notifications.at(-1)!, /用法：\/marker copy/);
    assert.deepEqual(f.clipboard, []);
    await f.command("export --clipboard");
    assert.match(f.notifications.at(-1)!, /请用 \/marker copy/);
    assert.deepEqual(f.clipboard, []);
    await f.command("copy");
    assert.deepEqual(f.clipboard, ["this phrase\n"]);
    assert.equal(readdirSync(s.directory).filter((name) => name.endsWith(".md")).length, 0);
  } finally { f.close(); s.clean(); }
});

test("export chooses a default Markdown filename and refuses existing destinations", async () => {
  const s = session();
  const f = extensionFixture(s.manager);
  try {
    await f.command("text this phrase");
    await f.command("export");
    const files = readdirSync(s.directory).filter((name) => name.endsWith(".md"));
    assert.equal(files.length, 1);
    assert.equal(readFileSync(join(s.directory, files[0]), "utf8"), "this phrase\n");
    writeFileSync(join(s.directory, "existing.md"), "original");
    await f.command("export existing.md");
    assert.equal(readFileSync(join(s.directory, "existing.md"), "utf8"), "original");
    assert.match(f.notifications.at(-1)!, /目标已存在/);
  } finally { f.close(); s.clean(); }
});

test("empty and failed clipboard exports report errors without creating files or losing marks", async () => {
  const s = session();
  const f = extensionFixture(s.manager);
  try {
    await f.command("export empty.md");
    assert.ok(!existsSync(join(s.directory, "empty.md")));
    assert.match(f.notifications.at(-1)!, /没有可导出/);
    await f.command("text this phrase");
    f.rejectClipboard = true;
    await f.command("copy");
    assert.match(f.notifications.at(-1)!, /剪贴板导出失败/);
    assert.deepEqual(f.clipboard, []);
    assert.equal(highlightedText(f.tui.getScreenLines()), "this phrase");
    await f.command("export fallback.md");
    assert.equal(readFileSync(join(s.directory, "fallback.md"), "utf8"), "this phrase\n");
  } finally { f.close(); s.clean(); }
});

test("export follows the active branch and works after extension reload", async () => {
  const s = session();
  const f = extensionFixture(s.manager);
  try {
    await f.command("text this phrase");
    const firstBranch = s.manager.getLeafId()!;
    s.manager.branch(s.answerId);
    f.events.get("session_tree")!({}, f.context);
    await f.command("text 中文测试");
    await f.command("copy");
    assert.equal(f.clipboard.at(-1), "中文测试\n");
    s.manager.branch(firstBranch);
    f.events.get("session_tree")!({}, f.context);
    f.reload();
    await f.command("copy");
    assert.equal(f.clipboard.at(-1), "this phrase\n");
  } finally { f.close(); s.clean(); }
});

test("drag erasure previews immediately, shrinks from the saved snapshot and commits one undo step", async () => {
  const s = session("ABCDEFGHIJ");
  const f = extensionFixture(s.manager);
  try {
    await f.command("on");
    f.drag("ABCDEFGHIJ");
    const leaf = s.manager.getLeafId();
    const plain = f.tui.getScreenLines().map(stripTerminalSequences);
    const { row, start, end } = f.locate("CDEFG");
    f.mouse(0, start, row);
    f.mouse(32, end, row);
    assert.equal(highlightedText(f.tui.getScreenLines()), "ABHIJ");
    assert.ok(!f.tui.getScreenLines()[row].includes("\x1b[7m"), "native inverse selection must not cover erased text");
    assert.equal(s.manager.getLeafId(), leaf, "motion is not persisted");
    assert.deepEqual(f.tui.getScreenLines().map(stripTerminalSequences), plain);
    f.mouse(32, start + 1, row);
    assert.equal(highlightedText(f.tui.getScreenLines()), "ABEFGHIJ", "shrinking restores the unselected tail");
    f.mouse(0, start + 1, row, true);
    assert.equal(highlightedText(f.tui.getScreenLines()), "ABEFGHIJ");
    assert.equal(f.tui.hasActiveSelection(), false);
    const entry = s.manager.getLeafEntry();
    assert.ok(entry?.type === "custom");
    assert.equal(entry.parentId, leaf, "one operation per drag");
    assert.equal((entry.data as { kind: string }).kind, "replace");
    await f.command("undo");
    assert.equal(highlightedText(f.tui.getScreenLines()), "ABCDEFGHIJ");
    await f.command("undo");
    assert.equal(highlightedText(f.tui.getScreenLines()), "");
  } finally { f.close(); s.clean(); }
});

test("mixed selections erase every overlapping stroke but never color new text", async () => {
  const s = session("aa BBBB cc DDDD ee");
  const f = extensionFixture(s.manager);
  try {
    for (const text of ["BBBB", "BBBB", "DDDD", "ee"]) await f.command(`text ${text}`);
    await f.command("on");
    f.drag("aa BBBB cc DD", true);
    assert.equal(highlightedText(f.tui.getScreenLines()), "DDee");
    const store = new MarkerStore();
    assert.equal(store.restore(s.manager.getBranch()).invalid, 0);
    assert.equal(store.groups.length, 2);
    await f.command("undo");
    assert.equal(highlightedText(f.tui.getScreenLines()), "BBBBDDDDee");
    f.drag("aa");
    assert.equal(highlightedText(f.tui.getScreenLines()), "aaBBBBDDDDee", "no overlap still adds a mark");
  } finally { f.close(); s.clean(); }
});

test("moving back out of an overlap restores the highlight and commits only the final new selection", async () => {
  const s = session("aa BBBB cc");
  const f = extensionFixture(s.manager);
  try {
    await f.command("text BBBB");
    await f.command("on");
    const { row, start, end } = f.locate("aa BB");
    f.mouse(0, start, row);
    f.mouse(32, end, row);
    assert.equal(highlightedText(f.tui.getScreenLines()), "BB");
    f.mouse(32, start + 1, row);
    assert.equal(highlightedText(f.tui.getScreenLines()), "BBBB");
    f.mouse(0, start + 1, row, true);
    assert.equal(highlightedText(f.tui.getScreenLines()), "aaBBBB");
    await f.command("undo");
    assert.equal(highlightedText(f.tui.getScreenLines()), "BBBB");
  } finally { f.close(); s.clean(); }
});

test("split Unicode anchors survive reopening, reflow, Markdown export and undo", async () => {
  const s = session("Before **甲乙丙丁戊己** after.");
  let f = extensionFixture(s.manager);
  try {
    await f.command("text 甲乙丙丁戊己");
    await f.command("on");
    f.drag("丙丁", true);
    assert.equal(highlightedText(f.tui.getScreenLines()), "甲乙戊己");
    f.close();
    const reopened = SessionManager.open(s.manager.getSessionFile()!, s.directory);
    f = extensionFixture(reopened);
    f.terminal.resize(23);
    f.tui.renderNow();
    assert.equal(highlightedText(f.tui.getScreenLines()), "甲乙戊己");
    await f.command("copy");
    assert.equal(f.clipboard.at(-1), "**甲乙**\n\n---\n\n**戊己**\n");
    await f.command("undo");
    assert.equal(highlightedText(f.tui.getScreenLines()), "甲乙丙丁戊己");
  } finally { f.close(); s.clean(); }
});

test("partial erase preserves whole emoji and combining graphemes", async () => {
  const s = session("AB👩🏽‍💻éCD");
  const f = extensionFixture(s.manager);
  try {
    await f.command("text AB👩🏽‍💻éCD");
    await f.command("on");
    f.drag("👩🏽‍💻é");
    assert.equal(highlightedText(f.tui.getScreenLines()), "ABCD");
    await f.command("copy");
    assert.equal(f.clipboard.at(-1), "AB\n\n---\n\nCD\n");
  } finally { f.close(); s.clean(); }
});

test("erasing part of a multi-message stroke preserves its other spans and stroke identity", async () => {
  const s = session("ABCD EFGH");
  s.manager.appendMessage(assistantEntry("IJKL MNOP").message);
  const f = extensionFixture(s.manager);
  try {
    await f.command("on");
    const first = f.locate("ABCD EFGH");
    const last = f.locate("IJKL MNOP");
    f.mouse(0, first.start, first.row);
    f.mouse(32, last.end, last.row);
    f.mouse(0, last.end, last.row, true);
    const store = new MarkerStore();
    store.restore(s.manager.getBranch());
    const original = store.groups[0];
    assert.equal(original.spans.length, 2);
    f.drag("BC");
    assert.equal(highlightedText(f.tui.getScreenLines()), "AD EFGHIJKL MNOP");
    store.restore(s.manager.getBranch());
    assert.equal(store.groups.length, 1);
    assert.equal(store.groups[0].id, original.id);
    assert.equal(store.spans.length, 3);
    assert.equal(f.statuses.get("pi-marker"), "marker: 1", "count strokes rather than segments");
    assert.deepEqual(store.spans[2], original.spans[1]);
    await f.command("undo");
    assert.equal(highlightedText(f.tui.getScreenLines()), "ABCD EFGHIJKL MNOP");
  } finally { f.close(); s.clean(); }
});

test("explicit erase mode and keyboard erasure subtract only selected text", async () => {
  const s = session("ABCDEFGHIJ");
  const f = extensionFixture(s.manager);
  try {
    await f.command("text ABCDEFGHIJ");
    await f.command("erase");
    f.drag("CDEF");
    assert.equal(highlightedText(f.tui.getScreenLines()), "ABGHIJ");
    await f.command("undo");
    await f.command("text CDEF");
    assert.equal(highlightedText(f.tui.getScreenLines()), "ABGHIJ");
    const leaf = s.manager.getLeafId();
    f.drag("CDEF");
    assert.equal(s.manager.getLeafId(), leaf);
    assert.match(f.notifications.at(-1)!, /没有.*相交/);
  } finally { f.close(); s.clean(); }
});

test("cancel, focus loss, mode changes, resize and reload discard the preview without saving", async () => {
  for (const action of ["escape", "focus-loss", "off", "resize", "reload"]) {
    const s = session("ABCDEFGHIJ");
    const f = extensionFixture(s.manager);
    try {
      await f.command("text ABCDEFGHIJ");
      await f.command("on");
      const leaf = s.manager.getLeafId();
      const { row, start, end } = f.locate("CDEF");
      f.mouse(0, start, row);
      f.mouse(32, end, row);
      assert.equal(highlightedText(f.tui.getScreenLines()), "ABGHIJ", action);
      if (action === "escape") f.terminal.send("\x1b");
      else if (action === "focus-loss") f.terminal.send("\x1b[O");
      else if (action === "off") await f.command("off");
      else if (action === "resize") f.terminal.resize(70);
      else f.reload();
      f.tui.renderNow();
      assert.equal(highlightedText(f.tui.getScreenLines()), "ABCDEFGHIJ", action);
      assert.equal(s.manager.getLeafId(), leaf, action);
      f.mouse(0, end, row, true);
      assert.equal(s.manager.getLeafId(), leaf, `late release after ${action}`);
    } finally { f.close(); s.clean(); }
  }
});

test("a failed erasure write restores the original highlight and leaves undo history intact", async () => {
  const s = session("ABCDEFGHIJ");
  const f = extensionFixture(s.manager);
  try {
    await f.command("text ABCDEFGHIJ");
    await f.command("on");
    const leaf = s.manager.getLeafId();
    f.rejectWrites = true;
    const { row, start, end } = f.locate("CDEF");
    f.mouse(0, start, row);
    f.mouse(32, end, row);
    assert.equal(highlightedText(f.tui.getScreenLines()), "ABGHIJ");
    f.mouse(0, end, row, true);
    assert.equal(highlightedText(f.tui.getScreenLines()), "ABCDEFGHIJ");
    assert.equal(f.tui.hasActiveSelection(), false);
    assert.equal(s.manager.getLeafId(), leaf);
    assert.match(f.notifications.at(-1)!, /保存失败/);
    f.rejectWrites = false;
    await f.command("undo");
    assert.equal(highlightedText(f.tui.getScreenLines()), "");
  } finally { f.close(); s.clean(); }
});

test("full erasure restores the exact original ANSI-styled frame, including during preview", async () => {
  const s = session("**bold** and *italic* and `code`");
  const f = extensionFixture(s.manager);
  try {
    const original = f.tui.getScreenLines();
    await f.command("on");
    f.drag("bold and italic and code");
    const { row, start, end } = f.locate("bold and italic and code");
    f.mouse(0, start, row);
    f.mouse(32, end, row);
    assert.deepEqual(f.tui.getScreenLines(), original);
    f.mouse(0, end, row, true);
    assert.deepEqual(f.tui.getScreenLines(), original);
    await f.command("undo");
    assert.equal(highlightedText(f.tui.getScreenLines()), "bold and italic and code");
  } finally { f.close(); s.clean(); }
});

test("the actual Pi jiti loader can load the package without registering model-facing tools", async () => {
  const directory = mkdtempSync(join(tmpdir(), "pi-marker-loader-"));
  try {
    const loaded = await discoverAndLoadExtensions([resolve("src/index.ts")], directory, directory);
    assert.deepEqual(loaded.errors, []);
    assert.equal(loaded.extensions.length, 1);
    assert.ok(loaded.extensions[0].commands.has("marker"));
    assert.ok(!loaded.extensions[0].commands.has("mark"));
    assert.equal(loaded.extensions[0].tools.size, 0);
    const s = session();
    const f = extensionFixture(s.manager, loaded);
    try {
      await f.command("on");
      f.drag("this phrase");
      assert.equal(highlightedText(f.tui.getScreenLines()), "this phrase", JSON.stringify(f.notifications));
      await f.command("export loader-export.md");
      assert.equal(readFileSync(join(s.directory, "loader-export.md"), "utf8"), "this phrase\n");
    } finally { f.close(); s.clean(); }
  } finally { rmSync(directory, { recursive: true, force: true }); }
});
