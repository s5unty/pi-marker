import { mkdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { SessionManager } from "@earendil-works/pi-coding-agent";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const directory = join(root, "examples", "sessions");
mkdirSync(directory, { recursive: true });
const manager = SessionManager.create(root, directory);
const now = Date.now();
manager.appendMessage({ role: "user", content: "请给我一份荧光笔演示文本。", timestamp: now });
manager.appendMessage({
  role: "assistant",
  content: [{ type: "text", text: `# Pi 荧光笔演示

先输入 /marker on，再用鼠标左键拖选下面的文字。松开之后，高亮会留在原文上。

**这一句值得标记。** 接着选择另外一句，前面的标记应该仍然保留。改变窗口宽度后，标记应跟随文字，而不是留在旧屏幕坐标上。

## 中文与 Unicode

中文测试、English words、👩🏽‍💻、🚀、é。你可以试着选中整段，也可以只选其中几个字。

- 第一条：选中这一条里的关键词。
- 第二条：这是重复短语。另一次重复短语只应该在你实际选中的位置高亮。

> 引用中的文字也可以标记。缩窄窗口，使这一段换行，看看高亮是否仍然跟随同一句话。

\`\`\`ts
const message = "在代码中标记这一句";
console.log(message);
\`\`\`

## 操作与恢复

/marker erase 进入擦除模式，拖选高亮文字可擦除整笔。/marker undo 撤销，/marker off 恢复普通选择和复制。

退出后，使用同一个演示会话路径重新启动并加载插件。高亮应该恢复，但笔默认关闭。

本会话是本地静态示例，没有调用模型。
` }],
  api: "openai-completions", provider: "demo", model: "demo-fixture",
  stopReason: "stop", timestamp: now + 1,
  usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
});
const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
console.log(`已创建演示会话：${manager.getSessionFile()}`);
console.log("在另一个终端运行：");
console.log(`pi --tui-mode fullscreen -e ${quote(join(root, "src/index.ts"))} --session ${quote(manager.getSessionFile()!)}`);
