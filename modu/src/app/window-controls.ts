/**
 * 无边框窗口标题栏（M2 波3 反馈⑤；2026-09-27 从 `main.ts` 整段外移）。
 *
 * 为什么外移：`src/main.ts` 的行数棘轮（`tests/css-budget.spec.ts`）只剩 1 行余量，
 * 任何后续 UI 改动都会被门禁挡死 ⇒ 按"每段外移到 `src/app/`"的既有做法搬出这一段。
 * 搬移**逐字**进行（含注释），只把 `$` 换成它逐字等价的 `req`（见 `app/dom.ts` 头注）。
 *
 * ⚠ **关闭守卫（P0-7）不在本模块**：它依赖 `main.ts` 里的 `closeGuard` 实例，
 * 仍由 `main.ts` 在 `boot()` 中挂 `win.onCloseRequested(...)`——同一入口（标题栏 ✕ 与
 * Alt+F4 都发 close-requested）。这样本模块无需任何回调参数，调用点保持零参不变。
 */
import { getCurrentWindow, type Window as TauriWindow } from "@tauri-apps/api/window";
import { req } from "./dom";

/** 最大化/还原图标状态切换（用户反馈批次）：两套 SVG（#ic-max 单框 /
 *  #ic-restore 双框）+ title/aria 同步「最大化 / 向下还原」 */
async function syncMaxState(win: TauriWindow): Promise<void> {
  let maximized = false;
  try {
    maximized = await win.isMaximized();
  } catch {
    return; // 查询失败（窗口关闭中等）：维持当前图标态
  }
  const btn = req("win-max");
  btn.title = maximized ? "向下还原" : "最大化";
  btn.setAttribute("aria-label", maximized ? "向下还原" : "最大化");
  document.getElementById("ic-max")?.toggleAttribute("hidden", maximized);
  document.getElementById("ic-restore")?.toggleAttribute("hidden", !maximized);
}

export function setupWindowControls(): void {
  const win = getCurrentWindow();
  req("win-min").addEventListener("click", () => void win.minimize());
  req("win-max").addEventListener("click", () => void win.toggleMaximize());
  req("win-close").addEventListener("click", () => void win.close());
  // 双击顶栏空白 = 最大化/还原（Windows 标题栏惯例）。
  // D-05：拖拽垫片 .titlebar-drag 已删，双击改绑在 <header> 本体上；
  // 因此必须按事件目标排除控件——否则双击标签/按钮会连带最大化（旧实现绑在垫片上，
  // 那时不需要这层判断，现在结构变了，这层判断就是正确性的一部分）。
  const header = req("titlebar");
  header.addEventListener("dblclick", (event) => {
    const target = event.target;
    if (target instanceof Element && target.closest("button, .tab, input, select, a") !== null) {
      return; // 控件上的双击归控件自己（标签双击不该最大化窗口）
    }
    void win.toggleMaximize();
  });
  void syncMaxState(win); // 启动对齐（可能是系统记住的最大化态）
  void win.onResized(() => void syncMaxState(win)); // 最大化/还原随尺寸变化即时切图标
}
