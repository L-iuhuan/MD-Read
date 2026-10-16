/**
 * 提示类浮层 · 全局小气泡（提示 UI 统一批次，2026-10-16）
 * --------------------------------------------------------------------------
 * 为什么要有它：原生 title 气泡（OS 画，CSS 管不了）与编辑器内四种浮层皮肤
 * 并存，风格各不相同。本模块把「悬停 / 键盘焦点提示」收成**一条全局委托**：
 *
 *   · 宿主两类：显式 `data-tip`（新接线，优先）/ 原生 `title`（存量运行时接管）；
 *   · 鼠标路径：pointerover 后延迟 300ms 亮泡；悬停期**借用** title（摘除，
 *     防原生气泡与自定义泡同显），离开即还原 ⇒ 静止态、读屏、源码测试永远
 *     看得到 title 原文（toolbar.spec / theme.spec 等对 title 的断言不受影响）；
 *   · 键盘路径：focusin 且 :focus-visible（区分鼠标点击引发的 focus）立即亮泡，
 *     **不动 title**（AT 在键盘路径永远读得到）；
 *   · 单泡复用：一个 .modu-tip 节点（懒建，挂 #app 内 ⇒ 吃全局 [hidden] 兜底、
 *     导出冻结层与 prefers-reduced-motion 降级）；fixed 定位，展示前量尺寸做
 *     视口夹取（空间不够翻到宿主下方）；
 *   · 关闭路径：离开宿主子树 / 失焦 / Escape / 任意 pointerdown / 滚动（capture）/
 *     窗口缩放 / 窗口失焦。
 *
 * 豁免（不接管，交原生或各域自管）：
 *   · `<option>` / `<optgroup>`：原生下拉项由 OS 渲染，接管不了也不该接管；
 *   · `.cm-editor` 内部：CM 自有悬停体系（lint 气泡等），不叠泡；
 *   · 触屏 pointerType 与按住拖拽（event.buttons !== 0，防选中/拖窗期误亮）。
 *
 * 样式在 ./tooltip.css（随本模块导入；模块 CSS 不进 app.css 棘轮）。
 */

import "./tooltip.css";

/** 鼠标路径亮泡延迟（ms）：横扫工具条不闪泡；键盘路径不延迟 */
const SHOW_DELAY_MS = 300;
/** 泡与宿主、与视口边缘的间距（px） */
const GAP_PX = 8;
/** 视口夹取时左侧/上侧的最小留白（px） */
const EDGE_PX = 8;

interface TipTarget {
  host: HTMLElement;
  text: string;
}

let tipEl: HTMLElement | null = null;
let activeHost: HTMLElement | null = null;
let showTimer: number | null = null;
let wired = false;
/** 悬停期被借用的 title 原文：离开即还原（悬停期被程序改写 title 则不覆盖） */
const borrowedTitles = new WeakMap<HTMLElement, string>();

/** 懒建单泡（首亮时才进 DOM；挂 #app 内，无 #app 的测试环境退 body） */
function ensureTip(): HTMLElement {
  if (tipEl !== null) {
    return tipEl;
  }
  const el = document.createElement("div");
  el.className = "modu-tip";
  el.id = "modu-tip";
  el.setAttribute("role", "tooltip");
  el.setAttribute("aria-hidden", "true"); // 读屏走宿主 title / aria-label，泡本身不播报
  el.hidden = true;
  (document.getElementById("app") ?? document.body).append(el);
  tipEl = el;
  return el;
}

/**
 * 自事件目标向上找提示宿主：data-tip 优先；title 兜底（原生语义 = 子树继承，故向上走）。
 * 返回 null 的两种情况都要停：豁免域（CM 编辑器 / 原生下拉项）与非 HTMLElement 命中。
 */
function findTipHost(target: EventTarget | null): TipTarget | null {
  if (!(target instanceof Element)) {
    return null;
  }
  if (target.closest(".cm-editor") !== null) {
    return null; // CM 自有悬停体系
  }
  let el: Element | null = target;
  while (el !== null && el !== document.body && el !== document.documentElement) {
    if (el.tagName === "OPTION" || el.tagName === "OPTGROUP") {
      return null; // 原生下拉项
    }
    if (el instanceof HTMLElement) {
      const dataTip = el.dataset.tip;
      if (dataTip !== undefined && dataTip !== "") {
        return { host: el, text: dataTip };
      }
    }
    const title = el.getAttribute("title");
    if (title !== null && title !== "") {
      return el instanceof HTMLElement ? { host: el, text: title } : null;
    }
    el = el.parentElement;
  }
  return null;
}

function cancelTimer(): void {
  if (showTimer !== null) {
    window.clearTimeout(showTimer);
    showTimer = null;
  }
}

/** 借用 title：摘除防原生同显，记原文待还 */
function borrowTitle(host: HTMLElement): void {
  if (borrowedTitles.has(host)) {
    return;
  }
  const title = host.getAttribute("title");
  if (title === null || title === "") {
    return;
  }
  borrowedTitles.set(host, title);
  host.removeAttribute("title");
}

/** 还原被借用的 title：若悬停期 title 已被程序改写（如 #win-max 双态），不覆盖新值 */
function restoreTitle(host: HTMLElement): void {
  const saved = borrowedTitles.get(host);
  if (saved === undefined) {
    return;
  }
  borrowedTitles.delete(host);
  if (!host.hasAttribute("title")) {
    host.setAttribute("title", saved);
  }
}

/** 收起：清计时器、还原 title、藏泡——所有关闭路径的唯一出口 */
function hideTip(): void {
  cancelTimer();
  if (activeHost !== null) {
    restoreTitle(activeHost);
  }
  activeHost = null;
  if (tipEl !== null) {
    tipEl.hidden = true;
  }
}

/** fixed 定位：宿主上方居中；上方空间不够翻到下方；左右/上下按视口夹取 */
function placeTip(tip: HTMLElement, host: HTMLElement): void {
  const rect = host.getBoundingClientRect();
  const width = tip.offsetWidth;
  const height = tip.offsetHeight;
  let top = rect.top - height - GAP_PX;
  if (top < EDGE_PX) {
    top = rect.bottom + GAP_PX;
  }
  top = Math.min(top, window.innerHeight - height - EDGE_PX);
  const left = Math.min(
    Math.max(EDGE_PX, rect.left + rect.width / 2 - width / 2),
    window.innerWidth - width - EDGE_PX,
  );
  tip.style.left = `${Math.round(left)}px`;
  tip.style.top = `${Math.round(top)}px`;
}

function showTip(target: TipTarget): void {
  const tip = ensureTip();
  tip.textContent = target.text;
  tip.hidden = false; // 先显形再量尺寸
  placeTip(tip, target.host);
}

function onPointerOver(event: PointerEvent): void {
  if (event.pointerType === "touch" || event.buttons !== 0) {
    return; // 触屏无悬停语义；按住拖拽（选中/拖窗）不亮泡
  }
  const found = findTipHost(event.target);
  if (found === null) {
    if (activeHost !== null) {
      hideTip();
    }
    return;
  }
  if (found.host === activeHost) {
    borrowTitle(found.host); // 键盘先亮、鼠标后到的组合也要摘 title 防双泡
    return;
  }
  hideTip(); // 先收旧（含还原其 title）
  borrowTitle(found.host);
  activeHost = found.host;
  showTimer = window.setTimeout(() => {
    showTimer = null;
    if (activeHost === found.host) {
      showTip(found);
    }
  }, SHOW_DELAY_MS);
}

function onPointerOut(event: PointerEvent): void {
  if (activeHost === null) {
    return;
  }
  const to = event.relatedTarget;
  if (to instanceof Node && activeHost.contains(to)) {
    return; // 还在宿主子树里（含子元素间切换）
  }
  hideTip();
}

function onFocusIn(event: FocusEvent): void {
  const found = findTipHost(event.target);
  if (found === null) {
    return;
  }
  if (!found.host.matches(":focus-visible")) {
    return; // 鼠标点击也会发 focusin——只对键盘焦点亮泡，点击不弹
  }
  if (found.host !== activeHost) {
    hideTip();
    activeHost = found.host;
  }
  cancelTimer();
  showTip(found);
}

function onFocusOut(event: FocusEvent): void {
  if (activeHost === null) {
    return;
  }
  const to = event.relatedTarget;
  if (to instanceof Node && activeHost.contains(to)) {
    return;
  }
  hideTip();
}

function onKeyDown(event: KeyboardEvent): void {
  if (event.key === "Escape") {
    hideTip();
  }
}

/** 装配：全局委托只挂一次（幂等；Esc 由找它们的既有处理链共存，不拦截不阻止冒泡） */
export function setupTooltips(): void {
  if (wired) {
    return;
  }
  wired = true;
  document.addEventListener("pointerover", onPointerOver);
  document.addEventListener("pointerout", onPointerOut);
  document.addEventListener("focusin", onFocusIn);
  document.addEventListener("focusout", onFocusOut);
  document.addEventListener("pointerdown", hideTip);
  document.addEventListener("keydown", onKeyDown);
  window.addEventListener("scroll", hideTip, true);
  window.addEventListener("resize", hideTip);
  window.addEventListener("blur", hideTip);
}
