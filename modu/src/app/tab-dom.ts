/**
 * 标签 DOM 构建（批次 3-7 阶段二·块 1）—— 自 `tabs.ts` 整段搬出。
 *
 * 搬移纪律：块内容逐字搬移，**只做 deps 注入**（`activateTab`/`closeTab` → `deps.*`，共 3 处调用点）
 * + 新增 `deps` 形参与 `export` 前缀；类型 `Tab` 走 `import type`（**不进 deps** ✓）。
 *
 * ⚠ 静态锚：`tests/panel-unify.spec.ts` 等若断言本块内的 DOM 细节，需改指本模块（断言不减）。
 */
import type { Tab } from "./tabs";

/** 块 1 的运行时依赖（**只传活绑定**：箭头函数引用 `tabs.ts` 里的闭包函数）*/
export interface TabDomDeps {
  activateTab(path: string): void;
  closeTab(path: string): void;
}
export function buildTabEl(tab: Tab, isActive: boolean, deps: TabDomDeps): HTMLElement {
  const el = document.createElement("div");
  el.className = isActive ? "tab active" : "tab";
  el.dataset.path = tab.path;
  el.title = tab.path;
  // 键盘可达性（波2 designer 遗留#1）：div 默认不可聚焦，补语义与键激活
  el.setAttribute("role", "tab");
  el.setAttribute("aria-selected", String(isActive));
  el.tabIndex = 0;
  el.draggable = true; // 拖拽排序（用户反馈批次）：HTML5 DnD，见 setupTabDnd
  const dot = document.createElement("span");
  dot.className = "tab-dirty";
  dot.hidden = !tab.dirty; // dirty 圆点（M3 启用，渲染逻辑先就位）
  dot.textContent = "●";
  const title = document.createElement("span");
  title.className = "tab-title";
  title.textContent = tab.title;
  const close = document.createElement("button");
  close.type = "button";
  close.className = "tab-close";
  close.textContent = "✕";
  close.title = "关闭标签";
  close.addEventListener("click", (event) => {
    event.stopPropagation();
    deps.closeTab(tab.path);
  });
  el.addEventListener("click", () => deps.activateTab(tab.path));
  el.addEventListener("keydown", (event) => {
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      deps.activateTab(tab.path);
    }
  });
  el.append(dot, title, close);
  return el;
}

/** 标签之间的 1px × 14px 细分隔线（S1）。用真元素而非 ::before：
 *  「活动/悬停标签两侧不画线」靠 CSS 的 `+` / `:has(+ …)` 兄弟选择器表达，
 *  比在 JS 里维护「谁是相邻的」索引稳得多（也不怕拖拽重排）。 */
export function buildSepEl(): HTMLElement {
  const sep = document.createElement("span");
  sep.className = "tab-sep";
  sep.setAttribute("aria-hidden", "true");
  return sep;
}

