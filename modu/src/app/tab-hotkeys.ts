/**
 * 标签快捷键（`Ctrl+W` 关闭当前 / `Ctrl+Tab` 循环）—— **自 `main.ts` 整段外移**（2026-09-27 · Phase 2.5）。
 *
 * 为什么拆：`main.ts` 的行数棘轮只剩 **5 行**余量 ✗ ⇒ 任何后续改动都会红 ✓
 *（棘轮只许往紧的方向转 ⇒ 正解是继续外移，不是抬上限 ✓）。
 *
 * ⚠ 搬移边界（两条纪律 ✓）：
 *  ① **不搬可变状态** ✗：原实现读模块级 `activeTabs` ✓ ⇒ 这里改用 **getter 注入** ✓；
 *     若把 `activeTabs` 搬进来，`main.ts` 里那些赋值点就会失效 ✗（静默错位）。
 *  ② **定义侧与使用侧一起走** ✓：两个函数原本互相调用（`setupTabHotkeys` → `cycleTab` ✓），
 *     整段搬 ⇒ 调用关系不变 ✓；对外只暴露 `setupTabHotkeys` ✓。
 *
 * 行为逐字保持：Ctrl+W 走 `closeTab`（dirty 标签仍由 close-guard 弹确认 ✓）、
 * Ctrl+Tab / Ctrl+Shift+Tab 在标签间循环（0/1 张时不动 ✓）、
 * 两者都 `preventDefault + stopPropagation` 且用 **capture 阶段**注册 ✓（与拆前一致 ✓）。
 */
import type { TabManager } from "./tabs";

/** 取当前标签管理器（`main.ts` 里是模块级 `activeTabs`，可能为 null ✓） */
export type TabsGetter = () => TabManager | null;

/** `Ctrl+Tab` / `Ctrl+Shift+Tab`：在标签间循环（0/1 张时不动 ✓） */
export function cycleTab(getTabs: TabsGetter, delta: number): void {
  const tabs = getTabs();
  if (tabs === null) {
    return;
  }
  const paths = tabs.paths();
  if (paths.length < 2) {
    return; // 0/1 张标签无可切换
  }
  const active = tabs.activeTab();
  if (active === null) {
    return;
  }
  const idx = paths.indexOf(active.path);
  if (idx < 0) {
    return;
  }
  tabs.activateTab(paths[(idx + delta + paths.length) % paths.length]);
}

/** 注册标签快捷键（capture 阶段 ✓ 与拆前一致） */
export function setupTabHotkeys(getTabs: TabsGetter): void {
  document.addEventListener(
    "keydown",
    (event) => {
      if (!(event.ctrlKey || event.metaKey)) {
        return;
      }
      if (event.key.toLowerCase() === "w") {
        event.preventDefault();
        event.stopPropagation();
        const tabs = getTabs();
        if (tabs !== null) {
          const tab = tabs.activeTab();
          if (tab !== null) {
            tabs.closeTab(tab.path); // dirty 标签走 confirmClose 确认
          }
        }
        return;
      }
      if (event.key === "Tab") {
        event.preventDefault();
        event.stopPropagation();
        cycleTab(getTabs, event.shiftKey ? -1 : 1);
      }
    },
    true,
  );
}