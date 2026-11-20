import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { parseExportDestination, saveMarkdown } from "../src/export-output.ts";

test("export destinations support quoted paths and spaces, and direct clipboard users to copy", () => {
  assert.deepEqual(parseExportDestination(""), { kind: "file" });
  assert.throws(() => parseExportDestination("--clipboard"), /请用 \/marker copy/);
  assert.deepEqual(parseExportDestination('"notes/my highlights.md"'), { kind: "file", path: "notes/my highlights.md" });
  assert.deepEqual(parseExportDestination("'$(touch nope).md'"), { kind: "file", path: "$(touch nope).md" });
  assert.deepEqual(parseExportDestination("my highlights.md"), { kind: "file", path: "my highlights.md" });
  assert.throws(() => parseExportDestination("--bad-flag"), /用法/);
  assert.throws(() => parseExportDestination('"unclosed'), /引号/);
  assert.throws(() => parseExportDestination('""'), /不能为空/);
  assert.throws(() => parseExportDestination("notes\x1b.md"), /控制字符/);
});

test("file export creates private Markdown files with unique defaults and no temporary leftovers", async () => {
  const directory = mkdtempSync(join(tmpdir(), "pi-marker-export-"));
  try {
    const first = await saveMarkdown("**中文**\n", directory);
    const second = await saveMarkdown("second\n", directory);
    assert.notEqual(first, second);
    assert.match(first, /pi-highlights-.*\.md$/);
    assert.equal(readFileSync(first, "utf8"), "**中文**\n");
    if (process.platform !== "win32") assert.equal(statSync(first).mode & 0o777, 0o600);
    const nested = await saveMarkdown("code\n", directory, "notes/my highlights.md");
    assert.equal(nested, join(directory, "notes/my highlights.md"));
    assert.equal(readFileSync(nested, "utf8"), "code\n");
    assert.ok(!readdirSync(directory).some((name) => name.endsWith(".tmp")));
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test("existing files and symlinks are never overwritten", async () => {
  const directory = mkdtempSync(join(tmpdir(), "pi-marker-no-overwrite-"));
  try {
    const target = join(directory, "existing.md");
    writeFileSync(target, "original");
    await assert.rejects(saveMarkdown("replacement", directory, target), /目标已存在/);
    assert.equal(readFileSync(target, "utf8"), "original");
    if (process.platform !== "win32") {
      symlinkSync(target, join(directory, "alias.md"));
      await assert.rejects(saveMarkdown("replacement", directory, "alias.md"), /目标已存在/);
      assert.equal(readFileSync(target, "utf8"), "original");
    }
    assert.ok(!readdirSync(directory).some((name) => name.endsWith(".tmp")));
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test("concurrent exports cannot race an overwrite or publish mixed/partial contents", async () => {
  const directory = mkdtempSync(join(tmpdir(), "pi-marker-race-"));
  try {
    const outputs = ["A".repeat(200_000), "B".repeat(200_000)];
    const results = await Promise.allSettled(outputs.map((text) => saveMarkdown(text, directory, "race.md")));
    assert.equal(results.filter((result) => result.status === "fulfilled").length, 1);
    assert.ok(outputs.includes(readFileSync(join(directory, "race.md"), "utf8")));
    assert.deepEqual(readdirSync(directory), ["race.md"]);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});
