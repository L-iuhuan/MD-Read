/**
 * 多文件打开（M2 波3，用户反馈：同时拖放多个文件不支持）。
 * 拖放 drop 事件与 second-instance 参数两条入口共用本模块：
 * 筛出全部 .md 路径后**串行**逐个打开——openTab 每次激活当前标签，
 * 串行 await 保证最后一个 .md 最终成为活动标签；单个文件打开失败的
 * 报错兜底在 opener 内部（openPath 已有 showError），不中断其余文件。
 */

/** 是否 .md 路径（大小写不敏感） */
export function isMd(path: string): boolean {
  return path.toLowerCase().endsWith(".md");
}

/** 筛出全部 .md 路径，保持原顺序 */
export function selectMdPaths(paths: string[]): string[] {
  return paths.filter(isMd);
}

/** 串行打开全部 .md 路径 */
export async function openEachMd(
  paths: string[],
  open: (path: string) => Promise<void>,
): Promise<void> {
  for (const path of selectMdPaths(paths)) {
    await open(path);
  }
}
