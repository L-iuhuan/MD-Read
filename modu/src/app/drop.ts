/**
 * 多文件打开（M2 波3，用户反馈：同时拖放多个文件不支持；P5 批2 优化渲染量）。
 * 拖放 drop 事件与 second-instance 参数两条入口共用本模块：
 * 筛出全部 .md 路径后**串行**逐个打开；仅最后一个文件激活渲染——
 * 中间项 activate=false 只开标签不挂载（alpha 实锤：中间渲染全是白做）。
 * 单个文件打开失败的报错兜底在 opener 内部（openPath 走 flashStatus），
 * 不中断其余文件。
 */

/** 是否 .md 路径（大小写不敏感） */
export function isMd(path: string): boolean {
  return path.toLowerCase().endsWith(".md");
}

/** 筛出全部 .md 路径，保持原顺序 */
export function selectMdPaths(paths: string[]): string[] {
  return paths.filter(isMd);
}

/** 串行打开全部 .md 路径；open(path, activate) 的 activate 仅末项为 true */
export async function openEachMd(
  paths: string[],
  open: (path: string, activate: boolean) => Promise<void>,
): Promise<void> {
  const mdPaths = selectMdPaths(paths);
  for (let i = 0; i < mdPaths.length; i++) {
    await open(mdPaths[i], i === mdPaths.length - 1);
  }
}
