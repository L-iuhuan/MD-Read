/**
 * 多文件打开（M2 波3，用户反馈：同时拖放多个文件不支持；P5 批2 优化渲染量）。
 * 拖放 drop 事件与 second-instance 参数两条入口共用本模块：
 * 筛出全部 Markdown 路径后**串行**逐个打开；仅最后一个文件激活渲染——
 * 中间项 activate=false 只开标签不挂载（alpha 实锤：中间渲染全是白做）。
 * 单个文件打开失败的报错兜底在 opener 内部（openPath 走 flashStatus），
 * 不中断其余文件。
 *
 * P0-6：扩展名清单移入 app/md-ext.ts（唯一事实源）——本模块不再自己判 `.md`，
 * 只按共用清单筛路径；isMd 作旧名的兼容转发保留（调用方都在本仓，可随时收口）。
 */
import { filterMarkdownPaths, isMarkdownPath } from "./md-ext";

/** 是否 Markdown 路径（大小写不敏感）。兼容别名：实现在 app/md-ext.ts。 */
export function isMd(path: string): boolean {
  return isMarkdownPath(path);
}

/** 筛出全部 Markdown 路径，保持原顺序 */
export function selectMdPaths(paths: string[]): string[] {
  return filterMarkdownPaths(paths);
}

/** 串行打开全部 Markdown 路径；open(path, activate) 的 activate 仅末项为 true。
 *  C6（2026-09-29）：被忽略的非 Markdown 文件数 > 0 时经 notifyIgnored 回调闪示
 *  （通道由调用方注入——本模块不背状态栏依赖，测试可桩；缺省则保持旧行为）。 */
export async function openEachMd(
  paths: string[],
  open: (path: string, activate: boolean) => Promise<void>,
  notifyIgnored?: (count: number) => void,
): Promise<void> {
  const mdPaths = selectMdPaths(paths);
  const ignored = paths.length - mdPaths.length;
  if (ignored > 0) {
    notifyIgnored?.(ignored); // 不静默丢弃：用户看得见有文件没被打开
  }
  for (let i = 0; i < mdPaths.length; i++) {
    await open(mdPaths[i], i === mdPaths.length - 1);
  }
}
