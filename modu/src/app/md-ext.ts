/**
 * Markdown 扩展名唯一事实源（P0-6）。
 *
 * 背景：修 P0-6 之前，四个入口各写一份接受清单，互不一致——
 * 关联注册（tauri.conf.json）认 md/markdown/mdx，打开对话框只认 md/markdown，
 * 拖放只认 .md，命令行只认 .md 且只取第一个。双击一个 .mdx 能被系统关联起来，
 * 却在应用内被拒之门外。本模块把这套清单收成一处，四个入口全部从这里取。
 *
 * 三个入口共用同一份清单：
 *   1. 双击文件关联 —— tauri.conf.json `bundle.fileAssociations[0].ext`
 *      （由 tests/md-ext.spec.ts 直接对拍该配置，改一处不改另一处会红）；
 *   2. 打开对话框 filter（main.ts onOpenClick）；
 *   3. 拖放 / 命令行 / 二次实例转发（drop.ts 与 Rust 侧 md_paths）。
 *
 * Rust 侧无法 import 本模块（跨语言），对应实现在 src-tauri/src/lib.rs 的
 * `MD_EXTENSIONS` / `has_md_extension`，注释互为引用；实机对拍见 P0-6 验证记录。
 */

/** 接受的 Markdown 扩展名（小写，不含点）。与 tauri.conf.json 的 ext 列表逐项一致。 */
export const MD_EXTENSIONS: readonly string[] = ["md", "markdown", "mdx"];

/** 打开对话框的 filter 用扩展名（不带点，plugin-dialog 的约定）。 */
export function mdExtensions(): string[] {
  return [...MD_EXTENSIONS];
}

/** 路径是否 Markdown 文件（大小写不敏感；只看扩展名，不碰文件系统）。
 *  先切出文件名再看扩展名：`C:\a.md\file` 这种「目录名带点」的路径不能被误判，
 *  而 `dir\a.md` 与 `a.MDX` 必须判真。 */
export function isMarkdownPath(path: string): boolean {
  const name = path.split(/[\\/]/).pop() ?? "";
  return MD_EXTENSIONS.some((extension) => name.toLowerCase().endsWith(`.${extension}`));
}

/** 从任意路径列表中筛出 Markdown 文件，保持原顺序（拖放 / 命令行 / 二次实例共用）。 */
export function filterMarkdownPaths(paths: readonly string[]): string[] {
  return paths.filter((path) => isMarkdownPath(path));
}
