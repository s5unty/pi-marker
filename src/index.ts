import { randomUUID } from "node:crypto";
import { copyToClipboard, VERSION, type ExtensionAPI, type ExtensionContext, type SessionEntry } from "@earendil-works/pi-coding-agent";
import type { Component, TUI } from "@earendil-works/pi-tui";
import { MarkerAdapter, resolveRenderer } from "./pi-adapter.ts";
import { ENTRY_TYPE, MarkerStore, type MarkerOperation } from "./store.ts";
import type { MarkSpan, MarkerMode, SpanReplacement } from "./types.ts";
import { formatHighlights } from "./markdown-export.ts";
import { parseExportDestination, saveMarkdown } from "./export-output.ts";

const HELP = "/marker [on|off|erase|undo|clear|status|copy]；/marker text <唯一片段>；/marker export [路径]";

export interface MarkerServices { copyToClipboard(text: string): Promise<void> }

export default function markerExtension(pi: ExtensionAPI, services: MarkerServices = { copyToClipboard }): void {
  let context: ExtensionContext | undefined;
  let reference: TUI | undefined;
  let renderer: object | undefined;
  let adapter: MarkerAdapter | undefined;
  let mode: MarkerMode = "off";
  let alive = false;
  let store = new MarkerStore();
  let cachedLeaf: string | null | undefined;
  let cachedBranch: readonly SessionEntry[] = [];
  let unavailable: string | undefined;
  let lastStatus: string | undefined;
  let warnedEphemeral = false;

  const branch = (): readonly SessionEntry[] => {
    if (!alive || !context) return [];
    const leaf = context.sessionManager.getLeafId();
    if (cachedLeaf !== leaf) {
      cachedLeaf = leaf;
      cachedBranch = context.sessionManager.getBranch();
    }
    return cachedBranch;
  };

  const report = (message: string) => {
    if (adapter?.diagnostics.failed) {
      mode = "off";
      unavailable = "适配器已安全停用，请 /reload 后重试。";
      status();
    }
    if (alive && context?.mode === "tui") context.ui.notify(message, "warning");
  };

  const status = () => {
    if (!alive || !context || context.mode !== "tui") return;
    const count = store.groups.length;
    const value = mode === "off" && count === 0 ? undefined :
      context.ui.theme.fg(mode === "off" ? "dim" : "accent", `marker:${mode} · ${count}笔${unavailable ? " (暂停)" : ""}`);
    if (value === lastStatus) return;
    lastStatus = value;
    context.ui.setStatus("pi-marker", value);
  };

  const warnIfEphemeral = () => {
    if (!warnedEphemeral && !context?.sessionManager.getSessionFile()) {
      warnedEphemeral = true;
      report("当前会话未落盘：高亮只能保留到本次进程结束。请使用普通持久会话。");
    }
  };

  const commit = (operation: MarkerOperation): boolean => {
    if (!alive || !context || !store.wouldChange(operation)) return false;
    // Persist first. A rejected write must not leave an apparently saved mark.
    try {
      pi.appendEntry(ENTRY_TYPE, operation);
    } catch (error) {
      report(`标记保存失败，未修改高亮：${error instanceof Error ? error.message : String(error)}`);
      return false;
    }
    store.apply(operation);
    warnIfEphemeral();
    cachedLeaf = undefined;
    status();
    adapter?.requestRender();
    return true;
  };

  const commitSelection = (spans: MarkSpan[], erased?: readonly SpanReplacement[]): boolean => {
    if (erased) {
      if (erased.length === 0) { report("选区没有与已保存的标记相交。"); return false; }
      return commit(store.replaceSpans(erased));
    }
    return commit({ version: 1, kind: "add", group: { id: randomUUID(), spans } });
  };

  const detach = () => {
    adapter?.dispose();
    adapter = undefined;
    renderer = undefined;
  };

  const ensureAdapter = () => {
    if (!alive || !reference) return;
    if (reference.mode !== "fullscreen") {
      detach();
      unavailable = "pi-marker 需要 Fullscreen 模式：通过 /settings 切换，或使用 --tui-mode fullscreen 启动。";
      mode = "off";
      status();
      return;
    }
    // The injected reference follows renderer replacement in /settings. Compare
    // per-renderer input-listener sets, not the stable Proxy or terminal object.
    if (renderer && (renderer as { inputListeners?: unknown }).inputListeners ===
        (reference as unknown as { inputListeners?: unknown }).inputListeners) return;
    detach();
    try {
      renderer = resolveRenderer(reference);
      adapter = new MarkerAdapter(renderer, { getBranch: branch, getMode: () => mode,
        getSpans: () => store.spans, commitSelection, report });
      unavailable = undefined;
    } catch (error) {
      unavailable = error instanceof Error ? error.message : String(error);
      mode = "off";
    }
    status();
  };

  const requireAdapter = (): MarkerAdapter => {
    ensureAdapter();
    if (!adapter) throw new Error(unavailable ?? "TUI 尚未准备好，请稍后重试。");
    if (adapter.diagnostics.failed) throw new Error("适配器已安全停用，请 /reload 后重试。");
    return adapter;
  };

  const setMode = (next: MarkerMode) => {
    const current = requireAdapter();
    current.cancelSelection();
    mode = next;
    if (next !== "off") warnIfEphemeral();
    status();
  };

  const reconstruct = (ctx: ExtensionContext) => {
    context = ctx;
    cachedLeaf = undefined;
    const { invalid } = store.restore(branch());
    adapter?.cancelSelection();
    adapter?.requestRender();
    if (invalid) report(`忽略了 ${invalid} 条格式或版本不兼容的标记记录；未改写这些记录。`);
    status();
  };

  pi.on("session_start", (_event, ctx) => {
    alive = true;
    mode = "off";
    warnedEphemeral = false;
    store = new MarkerStore();
    lastStatus = undefined;
    reconstruct(ctx);
    if (ctx.mode !== "tui") return;
    // Zero-height bridge: acquire Pi's TUI without replacing editor/footer or
    // creating a second renderer. Also notices fullscreen/regular switches.
    ctx.ui.setWidget("pi-marker-bridge", (tui) => {
      reference = tui;
      ensureAdapter();
      return {
        render() { ensureAdapter(); return []; },
        invalidate() {},
        dispose() { detach(); },
      } satisfies Component & { dispose(): void };
    });
  });

  pi.on("session_tree", (_event, ctx) => reconstruct(ctx));
  pi.on("session_compact", (_event, ctx) => reconstruct(ctx));
  pi.on("agent_settled", (_event, ctx) => {
    context = ctx;
    cachedLeaf = undefined;
    adapter?.requestRender();
  });
  pi.on("session_shutdown", (_event, ctx) => {
    alive = false;
    detach();
    if (ctx.mode === "tui") {
      ctx.ui.setStatus("pi-marker", undefined);
      ctx.ui.setWidget("pi-marker-bridge", undefined);
    }
    reference = undefined;
    context = undefined;
    cachedBranch = [];
    mode = "off";
  });

  pi.registerCommand("marker", {
    description: "荧光笔：鼠标标记 AI 回答；on/off/erase/undo/clear/status/text/export/copy",
    getArgumentCompletions: (prefix) => ["on", "off", "erase", "undo", "clear", "status", "text", "export", "copy", "help"]
      .filter((value) => value.startsWith(prefix)).map((value) => ({ value, label: value })),
    handler: async (args, ctx) => {
      if (ctx.mode !== "tui") { ctx.ui.notify("pi-marker 仅支持交互式 Fullscreen TUI。", "error"); return; }
      context = ctx;
      const input = args.trim();
      const [action] = input.split(/\s+/);
      try {
        if (!input) { setMode(mode === "off" ? "mark" : "off"); return; }
        if (action === "export" || action === "copy") {
          if (action === "copy" && input !== action) throw new Error("用法：/marker copy（复制全部高亮为 Markdown，无需参数）");
          const destination = action === "copy" ? { kind: "clipboard" as const } : parseExportDestination(input.slice(6));
          // Freeze and validate every fragment before any asynchronous output.
          // This neither appends a session operation nor changes the pen mode.
          const result = formatHighlights(requireAdapter().exportSelections());
          if (destination.kind === "clipboard") {
            try { await services.copyToClipboard(result.markdown); }
            catch (error) { throw new Error(`剪贴板导出失败：${error instanceof Error ? error.message : String(error)}。可改用 /marker export 保存文件。`); }
            if (alive) ctx.ui.notify(`已将 ${result.fragments} 个高亮片段以 Markdown 复制到剪贴板。`, "info");
          } else {
            const path = await saveMarkdown(result.markdown, ctx.cwd, destination.path);
            if (alive) ctx.ui.notify(`已导出 ${result.fragments} 个高亮片段：${path}`, "info");
          }
          return;
        }
        if (action === "text") {
          const text = input.slice(4).trim();
          if (!text) throw new Error("用法：/marker text <最近回答中唯一的文字片段>");
          const current = requireAdapter();
          const previous = mode;
          if (mode === "off") mode = "mark";
          try { current.markText(text); }
          finally { mode = previous; status(); }
          return;
        }
        if (input !== action) throw new Error(HELP);
        switch (action) {
          case "on": setMode("mark"); break;
          case "off": mode = "off"; adapter?.cancelSelection(); status(); break;
          case "erase": setMode("erase"); break;
          case "undo":
            if (!store.canUndo) ctx.ui.notify("没有可撤销的标记操作。", "info");
            else commit({ version: 1, kind: "undo" });
            break;
          case "clear": {
            if (store.groups.length === 0) { ctx.ui.notify("当前分支没有标记。", "info"); break; }
            const leaf = ctx.sessionManager.getLeafId();
            if (await ctx.ui.confirm("清除荧光笔标记", `清除当前分支的 ${store.groups.length} 笔标记？可用 /marker undo 撤销。`)) {
              if (!alive) return;
              if (context?.sessionManager.getLeafId() !== leaf) report("确认期间会话位置发生变化，请重新执行 /marker clear。");
              else commit({ version: 1, kind: "clear" });
            }
            break;
          }
          case "status": {
            ensureAdapter();
            const info = adapter?.diagnostics;
            const adapterStatus = unavailable ?? (info?.failed ? "适配器已停用，请 /reload。" :
              info ? "私有接口适配已启用。" : "TUI 尚未准备好。");
            ctx.ui.notify(`marker:${mode}；${store.groups.length} 笔 / ${store.spans.length} 段；${info?.mapped ?? 0} 段已匹配当前文档。\n` +
              `会话 AI 消息 ${info?.messages ?? 0}；可标记文本块 ${info?.indexed ?? 0}；pi-tidy 布局 ${info?.tidyMessages ?? 0} 条。\n` +
              `Pi ${VERSION}：${adapterStatus}` +
              "\n未匹配的标记会保留记录但不绘制，不猜测位置。", "info");
            break;
          }
          case "help": ctx.ui.notify(HELP + "\n开启后拖选：碰到高亮只擦除交集，无交集则新增；拖动实时预览，松手保存，Esc 取消。erase 始终局部擦除；off 恢复普通复制。\nexport 将当前分支的全部高亮保存为 Markdown 文件，不覆盖已有文件；copy 将相同内容复制到剪贴板。", "info"); break;
          default: throw new Error(HELP);
        }
      } catch (error) {
        ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
      }
    },
  });
}
