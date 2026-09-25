/**
 * DOM 取元素助手（批次 3-7 从 `main.ts` 抽出，供多模块共用）。
 *
 * 语义与 `main.ts` 原先的 `$` **逐字一致**：
 * - 缺失时 `console.error` 记技术细节（`#id`），**抛给使用者的中文错**（不露技术黑话）；
 * - 该错会经 `revealBootFailure` 直达面板（A4：技术细节只进 console）。
 *
 * ⚠ 只搬移、不改语义：`main.ts` 里保留 `const $ = req;` 别名，原有调用点一字未动。
 */
export function req<T extends HTMLElement>(id: string): T {
  const el = document.getElementById(id);
  if (el === null) {
    console.error(`界面元素缺失：#${id}`);
    throw new Error("界面资源未就绪，请重启墨读");
  }
  return el as T;
}
