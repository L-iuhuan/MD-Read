/**
 * 沉浸淡出的豁免状态（X1，2026-09-23 第二批）。
 *
 * 背景（性能实验 §4.3 实测 A-B-A）：`app.css` 里 7 条根级 `html:has(...)` 选择器
 * 让**每次 DOM 变动都退化成整文档样式重算**（公式文档：删规则后 FPS ×2.26、
 * RecalcStyleDuration 7.04s → 0.22s；把同样规则原样插回后回落）。本批把它们换成
 * `html` 上的**显式状态类**——类只在开关浮层/切编辑态时写一次，Blink 的失效重算
 * 回到"只重算匹配该类的元素"，不再关注文档里的其它 DOM 变动。
 *
 * 语义必须逐条保真（原来 7 条选择器 = 两组职责）：
 *   · `html.panel-open`   —— 四个浮层（最近下拉 / Aa 面板 / ▾ 全部标签 / ⋯ 溢出菜单）
 *     任一打开时，顶栏**不参与** chrome-dim 淡出（原 4 条 `html:has(#X:not([hidden])) .topbar`）；
 *   · `html.settings-open` —— 只有 Aa 面板打开时 `#btn-settings` 才点灯
 *     （原 `html:has(#settings-panel:not([hidden])) #btn-settings`）；
 *   · `html.editing`      —— 编辑态（`#editor-pane` 未 hidden）时顶栏/标题栏不淡出
 *     （原 2 条 `html:has(#editor-pane:not([hidden])) .titlebar/.topbar`）。
 *
 * 为什么用 MutationObserver 而不是在 4 处开关代码里各调一次：浮层的关闭路径不止一条
 * （点按钮 / 点外部 / Esc / 切标签 / 顶栏翻转时被强制收起），逐个插桩迟早漏一处，
 * 而漏一处的表现是"浮层开着但顶栏变淡"（用户可见的破相）。这里只观察那 5 个元素
 * 的 `hidden` 属性——**它们的 hidden 本来就是这套语义的唯一事实源**，任何路径改了它
 * 都会回到同一个 `sync()`（单一入口，不散落 set/remove）。成本：5 个元素的属性观察，
 * 与"整文档样式重算"不是一个量级。
 *
 * ⚠ 判据与 CSS 一致：只认 `hidden` 属性（等价于原来的 `:not([hidden])`），
 *   不引入 `display`/`visibility` 这类第二判据。
 */

/** 参与「顶栏淡出豁免」的四个浮层（id 与 index.html 一致） */
const PANELS: readonly string[] = ["recent-menu", "settings-panel", "tabs-menu", "overflow-menu"];
/** Aa 面板单独一份状态（只有它让 #btn-settings 点灯） */
const SETTINGS_PANEL = "settings-panel";
/** 编辑态：这个容器不 hidden 就是编辑态 */
const EDITOR_PANE = "editor-pane";

export interface OverlayState {
  /** 现算一次并同步类（DOM 直接改动后需要立刻生效时可显式调用） */
  sync(): void;
}

function visible(id: string): boolean {
  const el = document.getElementById(id);
  return el !== null && !el.hidden; // 与 `:not([hidden])` 同判据
}

export function setupOverlayState(): OverlayState {
  const root = document.documentElement;

  function sync(): void {
    root.classList.toggle("panel-open", PANELS.some(visible));
    root.classList.toggle("settings-open", visible(SETTINGS_PANEL));
    root.classList.toggle("editing", visible(EDITOR_PANE));
  }

  const observer = new MutationObserver(sync);
  for (const id of [...PANELS, EDITOR_PANE]) {
    const el = document.getElementById(id);
    if (el === null) {
      console.error(`界面元素缺失：#${id}`); // A4：技术细节只进 console
      continue; // 单个浮层缺席不该让整块豁免失效：其余元素照常观察
    }
    observer.observe(el, { attributes: true, attributeFilter: ["hidden"] });
  }
  sync(); // 初值现算：启动时（编辑态/浮层都关着）三档状态必须先落对
  return { sync };
}
