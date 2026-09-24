/**
 * P0-6 · Markdown 扩展名唯一事实源（app/md-ext.ts）。
 *
 * 这一组的价值全在「对拍」：修 P0-6 之前四个入口各写一份清单，双击一个 .mdx
 * 能被系统关联起来、却在打开对话框/拖放/命令行里被拒。所以断言分两层：
 *   1. 判据本身（大小写、目录名带点、非 Markdown）；
 *   2. 清单与另外三处实现**逐项一致**——tauri.conf.json 的 fileAssociations.ext
 *      （读真配置，不写死副本）、Rust 侧 lib.rs 的 MD_EXTENSIONS。
 *      任何一处单独改动都会在这里变红，这正是本组要防的回归。
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  MD_EXTENSIONS,
  filterMarkdownPaths,
  isMarkdownPath,
  mdExtensions,
} from "../src/app/md-ext";

interface FileAssociation {
  ext?: unknown;
}

/** 读真配置里的关联扩展名（不 import JSON：tsconfig 的 include 只含 src，
 *  测试侧按文本读更稳，也和 css-fixes.spec.ts 的读法一致）。 */
function associationExtensions(): string[] {
  const config: { bundle?: { fileAssociations?: FileAssociation[] } } = JSON.parse(
    readFileSync("src-tauri/tauri.conf.json", "utf8"),
  );
  const ext = config.bundle?.fileAssociations?.[0]?.ext;
  return Array.isArray(ext) ? ext.map((item: unknown): string => String(item)) : [];
}

describe("P0-6 · isMarkdownPath（共用扩展名判据）", () => {
  it("接受 md / markdown / mdx 三种扩展名", () => {
    expect(isMarkdownPath("C:\\doc\\a.md")).toBe(true);
    expect(isMarkdownPath("C:\\doc\\a.markdown")).toBe(true);
    expect(isMarkdownPath("C:\\doc\\a.mdx")).toBe(true);
  });

  it("大小写不敏感（含混合大小写）", () => {
    expect(isMarkdownPath("a.MD")).toBe(true);
    expect(isMarkdownPath("a.MarkDown")).toBe(true);
    expect(isMarkdownPath("a.MdX")).toBe(true);
  });

  it("拒绝其它扩展名与无扩展名文件", () => {
    expect(isMarkdownPath("a.txt")).toBe(false);
    expect(isMarkdownPath("a.mdown")).toBe(false);
    expect(isMarkdownPath("a.md.bak")).toBe(false);
    expect(isMarkdownPath("README")).toBe(false);
    expect(isMarkdownPath("")).toBe(false);
  });

  it("目录名带点不误判：只看最后一段文件名", () => {
    expect(isMarkdownPath("C:\\notes.md\\report")).toBe(false);
    expect(isMarkdownPath("C:\\notes.md\\report.MD")).toBe(true);
  });

  it("只认扩展名，不碰文件系统（不存在的路径照判）", () => {
    expect(isMarkdownPath("Z:\\不存在的盘\\幽灵.mdx")).toBe(true);
  });

  it("filterMarkdownPaths 保持原顺序，mdExtensions 返回不带点的副本", () => {
    const paths = ["a.md", "b.txt", "c.MDX", "d.markdown", "e.png"];
    expect(filterMarkdownPaths(paths)).toEqual(["a.md", "c.MDX", "d.markdown"]);
    expect(mdExtensions()).toEqual(["md", "markdown", "mdx"]);
    // 副本：外部改动不得污染模块内的清单
    mdExtensions().push("evil");
    expect(mdExtensions()).toEqual(["md", "markdown", "mdx"]);
  });
});

describe("P0-6 · 三处清单必须同集（漂移即红）", () => {
  it("tauri.conf.json 的 fileAssociations.ext 与 MD_EXTENSIONS 逐项一致", () => {
    expect(associationExtensions()).toEqual([...MD_EXTENSIONS]);
  });

  it("Rust 侧 lib.rs 的 MD_EXTENSIONS 与 TS 清单逐项一致（跨语言手工同集）", () => {
    const rust = readFileSync("src-tauri/src/lib.rs", "utf8");
    const declaration = /const MD_EXTENSIONS: \[&str; (\d+)\] = \[([^\]]*)\];/.exec(rust);
    expect(declaration, "lib.rs 应声明 MD_EXTENSIONS").not.toBeNull();
    const count = Number(declaration?.[1]);
    const items = (declaration?.[2] ?? "")
      .split(",")
      .map((raw) => raw.trim().replace(/^"|"$/g, ""))
      .filter((raw) => raw !== "");
    expect(count).toBe(items.length); // 数组长度声明不许与字面量脱节
    expect(items).toEqual([...MD_EXTENSIONS]);
  });

  it("三入口共用一份清单：drop.ts 不再自写扩展名、main.ts 对话框取 mdExtensions()", () => {
    const drop = readFileSync("src/app/drop.ts", "utf8");
    const main = readFileSync("src/main.ts", "utf8");
    expect(drop).toMatch(/from "\.\/md-ext"/);
    expect(drop).not.toMatch(/endsWith\(/); // 判据不再散落在 drop.ts
    expect(main).toMatch(/extensions:\s*mdExtensions\(\)/);
    expect(main).not.toMatch(/extensions:\s*\[/); // 对话框不许再写死一份
    expect(main).toMatch(/multiple:\s*true/); // P0-6：对话框支持多选
  });

  it("Rust 侧多文件解析：take_pending_files + md_paths（旧的单文件契约已迁移）", () => {
    const rust = readFileSync("src-tauri/src/lib.rs", "utf8");
    expect(rust).toMatch(/fn md_paths\(args: &\[String\]\) -> Vec<String>/);
    expect(rust).toMatch(/fn take_pending_files\(state: State<PendingFiles>\) -> Vec<String>/);
    expect(rust).not.toMatch(/fn md_arg\(/);
    expect(rust).not.toMatch(/fn take_pending_file\(/);
  });

  it("前端不再调用旧的单文件命令，改取列表", () => {
    const main = readFileSync("src/main.ts", "utf8");
    expect(main).toMatch(/invoke<string\[\]>\("take_pending_files"\)/);
    expect(main).not.toMatch(/take_pending_file"/);
  });
});
