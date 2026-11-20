import { randomUUID } from "node:crypto";
import { link, mkdir, open, unlink } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";

export type ExportDestination = { kind: "file"; path?: string };
const USAGE = "用法：/marker export [文件路径]；复制到剪贴板请用 /marker copy";

export function parseExportDestination(args: string): ExportDestination {
  let path = args.trim();
  if (!path) return { kind: "file" };
  if (path.startsWith("--")) throw new Error(USAGE);
  if (path.startsWith('"') || path.startsWith("'")) {
    if (path.length < 2 || !path.endsWith(path[0])) throw new Error("导出路径的引号不匹配。");
    path = path.slice(1, -1);
  }
  if (!path || /[\x00-\x1f\x7f]/.test(path)) throw new Error("导出路径不能为空，也不能包含控制字符。");
  return { kind: "file", path };
}

/** Publish a fully written, private file without an overwrite race. The hard
 * link is atomic and fails if the destination exists (including a symlink).
 * No truncating writes, shell interpolation, or user clipboard access here.
 */
export async function saveMarkdown(markdown: string, cwd: string, requestedPath?: string): Promise<string> {
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const name = requestedPath ?? `pi-highlights-${stamp}-${randomUUID().slice(0, 8)}.md`;
  const expanded = name.startsWith("~/") ? join(homedir(), name.slice(2)) : name;
  const target = resolve(cwd, expanded);
  const directory = dirname(target);
  await mkdir(directory, { recursive: true });
  const temporary = join(directory, `.pi-marker-${randomUUID()}.tmp`);
  let created = false;
  try {
    const handle = await open(temporary, "wx", 0o600);
    created = true;
    try { await handle.writeFile(markdown, "utf8"); }
    finally { await handle.close(); }
    await link(temporary, target);
    return target;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") {
      throw new Error(`目标已存在，未覆盖：${target}。请换一个文件名。`);
    }
    throw new Error(`Markdown 导出失败，未覆盖目标文件：${error instanceof Error ? error.message : String(error)}`);
  } finally {
    if (created) await unlink(temporary).catch(() => {});
  }
}
