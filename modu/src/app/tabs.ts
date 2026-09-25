/**
 * 多标签管理（M2 波1，F5）：懒挂载（规格 D4）——仅活动标签渲染 DOM，
 * 非活动标签只留 source 文本；切换时经 deps.render 重渲并恢复 scroll。
 * P5 批3 增渲染缓存：切走时把 #doc 现有正文零拷贝回收进 tab.cachedFragment
 * （harvestDoc），切回命中即 adoptNode 直挂，跳过 renderDocument——含 mermaid
 * 等增强产物原样回归；未命中才重渲（重渲前经双 rAF 先绘 loading 再开工）。
 * main.ts 通过 mountDoc 回调接管 #doc/大纲/状态栏的接线，本模块不碰渲染管线。
 */
import type { SavedEditorState } from "../editor/editor";
import type { OutlineItem, RenderResult } from "../render/pipeline";
import { createTabMenus, type TabMenus } from "../ui/tabs-menu";

/** 标签状态。dirty/bom/crlf 由 M3 编辑器接线启用；editor 为编辑器态存档 */
export interface Tab {
  path: string;
  title: string;
  encoding: string;
  source: string;
  scroll: number;
  dirty: boolean;
  /** 原文件有无 BOM（save_file 第四参回传，D7 保真） */
  bom: boolean;
  /** 行尾以 CRLF 为主（编辑器 lineSeparator 依据） */
  crlf: boolean;
  /** 每标签编辑器态（EditorState+滚动）；null = 未进过编辑态 */
  editor: SavedEditorState | null;
  /** 渲染缓存（P5 批3）：离开时回收的正文 DOM；null = 无缓存。
 *  失效时机：同路径重开刷新 / 挂载消费后 / harvest 返回 null（编辑态正文滞后 source） */
  cachedFragment: DocumentFragment | null;
  /** 最近一次渲染的大纲（随缓存走，切回免重提） */
  outline: OutlineItem[];
}

export interface TabFile {
  text: string;
  encoding: string;
  /** Rust 车道新增字段，未合入时缺省——按 === true 判定容忍 */
  bom?: boolean;
  crlf?: boolean;
}

export interface MountContext {
  tab: Tab;
  /** 正文节点：挂载方 replaceChildren + adoptNode 直挂（P5 批3 起挂载契约不传 html） */
  fragment: DocumentFragment;
  outline: OutlineItem[];
}

export interface TabManagerDeps {
  render(source: string): RenderResult;
  /** 把渲染结果挂到正文区（含大纲/增强/状态栏），由 main.ts 提供 */
  mountDoc(ctx: MountContext): void;
  getScroll(): number;
  setScroll(top: number): void;
  /** 最后一个标签关闭后的空态（欢迎提示等） */
  onEmpty(): void;
  /** dirty 标签关闭前确认，返回 false 放弃关闭 */
  confirmClose(tab: Tab): boolean;
  /** 切走标签前保存编辑器态（null = 编辑器不属当前标签，保留旧档） */
  saveEditorState?(): SavedEditorState | null;
  /** 激活标签后同步编辑器（恢复存量态或装载源文） */
  loadEditorState?(saved: SavedEditorState | null): void;
  /** 切走时回收 #doc 现有正文为零拷贝缓存；无可回收（编辑态/空）返回 null（P5 批3） */
  harvestDoc?(): DocumentFragment | null;
  /** 重渲前点亮 loading（渲染同步阻塞，须让出一帧先绘制指示符）*/
  beginLoading?(): void;
  /** 挂载完成或让位后熄灭 loading */
  endLoading?(): void;
}

export interface TabManager {
  /** activate=false：只上栏不渲染不激活（多文件连开时中间项省掉白做的渲染，P5 批2）；
   *  默认 true。刷新当前活动标签时强制重挂（防 stale DOM），忽略 false。 */
  openTab(path: string, file: TabFile, activate?: boolean): void;
  activateTab(path: string): void;
  closeTab(path: string): void;
  /** 关掉除活动项以外的全部标签（▾ / ⋯ 菜单「关闭其他标签」）。脏标签逐个走确认。 */
  closeOthers(): void;
  /** 关掉全部标签（菜单「关闭全部标签」）。脏标签逐个走确认。 */
  closeAll(): void;
  activeTab(): Tab | null;
  setDirty(path: string, dirty: boolean): void;
  count(): number;
  /** 标签路径有序快照（用户反馈批次：Ctrl+Tab 循环切换取邻居用） */
  paths(): string[];
  /** 是否有标签带未保存改动（P0-7 关窗口守卫的判据；复用 dirty 单一来源） */
  hasDirty(): boolean;
  /** 未保存标签快照（P0-7：关窗口前逐个落盘取用） */
  dirtyTabs(): Tab[];
  /** 壳层菜单（▾ / ⋯）的显隐重算。CDP 探针手工翻转顶栏拥挤态后调用；
   *  正常路径由 renderBar / syncNav 自动触发，无需外部调用。 */
  syncMenus(): void;
}

/** 关闭守卫（P0-7）用户三选一：保存 / 放弃 / 取消 */
export type CloseChoice = "save" | "discard" | "cancel";
/** 处置结论：save-then-close=先存后关、close=直接关、stay=不关 */
export type CloseAction = "close" | "save-then-close" | "stay";

/** 拦不拦这次关闭请求（P0-7 回归修复·纯函数，脱离 Tauri 可单测）。
 *  返回 false ⇒ 调用方**不得**调 event.preventDefault()：放默认行为走完，
 *  @tauri-apps/api 的 onCloseRequested 才会在 handler 返回后自动 destroy 窗口。
 *  返回 true ⇒ 这次要问人/落盘，必须先 preventDefault 把窗口留住。 */
export function shouldGuardClose(hasDirty: boolean): boolean {
  return hasDirty; // 只有真有未保存改动才拦；干净态一律放行
}

/** 关闭决策（P0-7·纯函数，脱离 Tauri 可单测）：脏才拦，选保存且落盘失败也不关窗 */
export function resolveCloseAction(
  hasDirty: boolean,
  choice: CloseChoice | null,
  saveFailed = false
): CloseAction {
  if (!hasDirty) {
    return "close";
  }
  if (choice === "save") {
    return saveFailed ? "stay" : "save-then-close";
  }
  return choice === "discard" ? "close" : "stay"; // cancel / 未作答：不关窗
}

/** 关窗守卫的对外依赖（main.ts 只做接线，行为在本模块可测） */
export interface CloseGuardDeps {
  /** 当前是否有未保存改动（问询期间可变化，每次现取不缓存） */
  hasDirty(): boolean;
  /** 未保存标签数（问询文案用，现取） */
  dirtyCount(): number;
  /** 弹三选一浮层并等答案 */
  ask(message: string): Promise<CloseChoice>;
  /** 逐个落盘；任一失败返回 false（窗口不关） */
  save(): Promise<boolean>;
  /** 真的关窗（Tauri 侧 close()，重入时守卫放行） */
  quit(): Promise<void>;
}

/** 关窗守卫状态机（P0-7 回归修复）：只有「确实要拦」的那一轮才 preventDefault。
 *
 *  为什么必须这么分（2026-09-23 实机测量）：
 *  - @tauri-apps/api 的 onCloseRequested = `await handler(evt)` 之后
 *    `if (!evt.isPreventDefault()) await window.destroy()`。无条件 preventDefault
 *    等于把这条唯一的自动关窗收尾掐死；
 *  - 手动补的那次 destroy() 又被 ACL 拒（`core:window:allow-destroy` 未授）。
 *
 *  三条出口：
 *  - 干净态：不 preventDefault，直接返回 → 交给自动 destroy；
 *  - 取消/保存失败：preventDefault 留住窗口，复位问询标记，下一次 ✕ 重新弹窗；
 *  - 保存/放弃成功：置 confirmed 再触发一次关窗请求，重入的那一轮不 preventDefault、
 *    不询问 → 又走回自动 destroy。 */
export function createCloseGuard(deps: CloseGuardDeps) {
  let asking = false; // 问询/落盘在飞：忽略连点
  let confirmed = false; // 用户已批准关窗：后续请求一律放行

  return async function onCloseRequested(event: { preventDefault(): void }): Promise<void> {
    if (confirmed || asking || !shouldGuardClose(deps.hasDirty())) {
      return; // 放行：不 preventDefault，让默认的 destroy 收尾
    }
    event.preventDefault(); // 从这里开始要异步问人/落盘，窗口必须留住
    asking = true;
    try {
      const message = `有 ${deps.dirtyCount()} 个文件尚未保存，关闭窗口前要保存吗？`;
      const planned = resolveCloseAction(true, await deps.ask(message));
      asking = false; // 问询收场：取消/保存失败都从此刻起可再次弹窗
      if (planned === "stay") {
        return;
      }
      if (planned === "save-then-close" && !(await deps.save())) {
        return; // 保存失败：不关窗（中文错误已由保存链闪显）
      }
      confirmed = true;
      await deps.quit();
    } finally {
      asking = false; // 任何提前返回/抛错都不把窗口锁在「问询在飞」
    }
  };
}

function fileName(path: string): string {
  return path.split(/[\\/]/).pop() ?? path;
}

/** 双 rAF：本帧先让 loading 落 DOM 并完成绘制，下一帧才跑同步重渲染——
 *  若同任务内连跑（class 加完立刻 renderDocument），长任务会饿死绘制，
 *  指示符直到渲染结束才可见，等于没挂（P5 批3·loading 先绘的帧预算事实）。 */
function whenPainted(run: () => void): void {
  if (typeof requestAnimationFrame !== "function") {
    run();
    return;
  }
  requestAnimationFrame(() => requestAnimationFrame(run));
}

export function createTabManager(bar: HTMLElement, deps: TabManagerDeps): TabManager {
  const list = bar.querySelector<HTMLElement>("#tab-list");
  if (list === null) {
    console.error("界面元素缺失：#tab-list"); // A4：技术细节只进 console，使用者只看下一行
    throw new Error("界面资源未就绪，请重启墨读");
  }
  const tabList: HTMLElement = list; // 闭包内保住非空类型
  const tabs: Tab[] = [];
  let activePath: string | null = null;
  /** 激活票据：快速连点/连开时只有最新一张票有权渲染挂载，过期者在渲染前让位 */
  let renderTicket = 0;
  /** 在途延迟渲染数：loading 灯随最后一个结束才熄（连点不中途闪灭） */
  let pendingLoads = 0;

  function find(path: string): Tab | null {
    return tabs.find((tab) => tab.path === path) ?? null;
  }

  function settleLoading(): void {
    if (pendingLoads === 0) {
      deps.endLoading?.();
    }
  }

  /** 切走标签前：scroll / 编辑器态 / 正文 DOM（零拷贝回收）三样随标签走 */
  function stashCurrent(target: Tab): void {
    const current = activePath === null ? null : find(activePath);
    if (current === null || current === target) {
      return;
    }
    current.scroll = deps.getScroll(); // 离开前把阅读位置存回标签（懒挂载）
    const saved = deps.saveEditorState?.();
    if (saved !== null && saved !== undefined) {
      current.editor = saved; // 编辑器态同样随标签走（跨标签保撤销）
    }
    current.cachedFragment = deps.harvestDoc?.() ?? null; // 正文回收：切回命中免重渲
  }

  /** 挂载收尾：消费缓存 → mountDoc → 钉滚动（两帧）→ 同步编辑器 */
  function finishMount(target: Tab, ctx: MountContext, ticket: number): void {
    target.cachedFragment = null; // 内容上屏即消费（缓存单次有效）
    deps.mountDoc(ctx);
    deps.setScroll(target.scroll);
    if (typeof requestAnimationFrame === "function") {
      requestAnimationFrame(() => {
        if (ticket === renderTicket) {
          deps.setScroll(target.scroll); // 懒内容撑高后再钉一次
        }
      });
    }
    deps.loadEditorState?.(target.editor);
  }

  function activateTab(path: string): void {
    const target = find(path);
    if (target === null) {
      throw new Error(`标签不存在：${path}`);
    }
    stashCurrent(target);
    activePath = path;
    renderBar();
    const ticket = ++renderTicket;
    const cached = target.cachedFragment;
    if (cached !== null) {
      // 命中缓存：同步直挂（adoptNode 零重渲），不点亮 loading
      finishMount(target, { tab: target, fragment: cached, outline: target.outline }, ticket);
      return;
    }
    deps.beginLoading?.();
    pendingLoads++;
    whenPainted(() => {
      pendingLoads--;
      if (ticket !== renderTicket) {
        settleLoading(); // 过期：已被更新的激活接管，本票不渲染不挂载
        return;
      }
      try {
        const result = deps.render(target.source); // 未命中：切换即重渲（D4：非活动不留 DOM）
        target.outline = result.outline;
        finishMount(target, { tab: target, fragment: result.fragment, outline: result.outline }, ticket);
      } finally {
        settleLoading();
      }
    });
  }

  function buildTabEl(tab: Tab, isActive: boolean): HTMLElement {
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
      closeTab(tab.path);
    });
    el.addEventListener("click", () => activateTab(tab.path));
    el.addEventListener("keydown", (event) => {
      if (event.key === "Enter" || event.key === " ") {
        event.preventDefault();
        activateTab(tab.path);
      }
    });
    el.append(dot, title, close);
    return el;
  }

  /** 标签之间的 1px × 14px 细分隔线（S1）。用真元素而非 ::before：
   *  「活动/悬停标签两侧不画线」靠 CSS 的 `+` / `:has(+ …)` 兄弟选择器表达，
   *  比在 JS 里维护「谁是相邻的」索引稳得多（也不怕拖拽重排）。 */
  function buildSepEl(): HTMLElement {
    const sep = document.createElement("span");
    sep.className = "tab-sep";
    sep.setAttribute("aria-hidden", "true");
    return sep;
  }

  /** 把新激活的标签滚进可视区（用户定稿：切标签时自动滚）。同步调用——
   *  renderBar 已重建 DOM，布局同步可得；`inline: "nearest"` 表示已经可见就不动。
   *  `typeof` 守卫是为 jsdom：它不实现 scrollIntoView（测试环境没有布局引擎），
   *  真机（WebView2）恒有。守卫让同一份代码在两侧都能跑，不必给测试打补丁。 */
  function revealTab(path: string): void {
    const el = tabList.querySelector<HTMLElement>(`.tab[data-path="${CSS.escape(path)}"]`);
    if (el !== null && typeof el.scrollIntoView === "function") {
      el.scrollIntoView({ block: "nearest", inline: "nearest" });
    }
  }

  function renderBar(): void {
    tabList.textContent = "";
    for (const tab of tabs) {
      tabList.appendChild(buildTabEl(tab, tab.path === activePath));
      if (tab !== tabs[tabs.length - 1]) {
        tabList.appendChild(buildSepEl()); // 分隔线只画在标签之间，两端不画
      }
    }
    bar.hidden = tabs.length === 0;
    // syncNav 里会读 scrollWidth/clientWidth 与 scrollLeft —— 必须在节点已入 DOM 之后
    syncNav();
    if (activePath !== null) {
      revealTab(activePath);
    }
  }

  /* ---- 标签条滚动：‹ › 可用性 / 滚轮横滚 / ▾ ⋯ 菜单 ---- */

  const prevBtn = document.getElementById("tabs-prev");
  const nextBtn = document.getElementById("tabs-next");

  /** ‹ › 的可用性判据是「**该侧确实还有标签**」，不是「方向」（用户定稿）：
   *  scrollLeft > 0 ⇒ 左侧还有被滚出去的标签；未到右端 ⇒ 右侧还有。 */
  function syncScrollButtons(): void {
    const max = tabList.scrollWidth - tabList.clientWidth;
    if (prevBtn instanceof HTMLButtonElement) {
      prevBtn.disabled = tabList.scrollLeft <= 0;
    }
    if (nextBtn instanceof HTMLButtonElement) {
      nextBtn.disabled = tabList.scrollLeft >= max - 1;
    }
  }

  /** 一次滚动约「一个可视宽的一半」，最少一枚标签的宽度 */
  function navStep(): number {
    return Math.max(80, Math.round(tabList.clientWidth / 2));
  }

  function syncNav(): void {
    syncScrollButtons();
    menus?.sync();
  }

  const menus: TabMenus | null = createTabMenus({
    bar,
    getTabs: () => tabs,
    activePath: () => activePath,
    activate: activateTab,
    closeTab,
    closeOthers,
    closeAll,
  });

  prevBtn?.addEventListener("click", () => {
    tabList.scrollBy({ left: -navStep(), behavior: "smooth" });
  });
  nextBtn?.addEventListener("click", () => {
    tabList.scrollBy({ left: navStep(), behavior: "smooth" });
  });
  tabList.addEventListener("scroll", syncScrollButtons, { passive: true });
  /* 滚轮在标签条上 → 横向滚动（用户定稿）。Chrome 对 overflow-x:auto + overflow-y:hidden
     的容器**已经**支持纵向滚轮横滚，但触控板横向手势与 Shift+滚轮仍会落到纵向分量上，
     这里统一归一化：把 deltaY 翻成 scrollLeft，deltaX 原样叠加。
     preventDefault 是必要的 —— 否则页面/正文会跟着滚（内容区就在正下方）。 */
  tabList.addEventListener(
    "wheel",
    (event) => {
      const delta = Math.abs(event.deltaX) > Math.abs(event.deltaY) ? event.deltaX : event.deltaY;
      if (delta === 0) {
        return;
      }
      const max = tabList.scrollWidth - tabList.clientWidth;
      if (max <= 0) {
        return; // 无溢出：不拦滚轮，交给祖先（滚动条只在真有溢出时才「吃」滚轮）
      }
      event.preventDefault();
      tabList.scrollLeft += delta;
    },
    { passive: false }
  );

  /** 拖拽排序（用户反馈批次）：HTML5 DnD——dragstart 记源并半透明（.dragging），
   *  dragover preventDefault + 按命中标签中点实时挪 DOM 插入位，drop/dragend
   *  按 DOM 序回写 tabs 数组并重渲标签栏（活动标签与正文不动，纯重排）。 */
  function setupTabDnd(): void {
    let dragging: HTMLElement | null = null;

    tabList.addEventListener("dragstart", (event) => {
      const target = event.target;
      if (!(target instanceof HTMLElement) || !target.classList.contains("tab")) {
        return;
      }
      dragging = target;
      target.classList.add("dragging");
      if (event.dataTransfer != null) {
        // jsdom 裸 Event 无 dataTransfer（undefined），真拖拽恒有
        event.dataTransfer.effectAllowed = "move";
        event.dataTransfer.setData("text/plain", target.dataset.path ?? ""); // Firefox 需数据
      }
    });

    tabList.addEventListener("dragover", (event) => {
      if (dragging === null || dragging.parentNode !== tabList) {
        return;
      }
      event.preventDefault(); // 声明落点，否则 drop 不触发
      if (event.dataTransfer != null) {
        event.dataTransfer.dropEffect = "move"; // jsdom 裸 Event 无此属性，真拖拽恒有
      }
      const over = event.target instanceof HTMLElement ? tabUnder(event.target) : null;
      if (over !== null) {
        const rect = over.getBoundingClientRect();
        const before = event.clientX < rect.left + rect.width / 2;
        const ref = before ? over : over.nextElementSibling;
        if (ref !== dragging) {
          tabList.insertBefore(dragging, ref); // ref 为 null 即追加到末尾
        }
      } else if (tabList.lastElementChild !== dragging) {
        tabList.appendChild(dragging); // 悬停在条尾空隙
      }
    });

    function tabUnder(target: HTMLElement): HTMLElement | null {
      const tab = target.closest(".tab");
      return tab instanceof HTMLElement && tab !== dragging ? tab : null;
    }

    function commit(): void {
      if (dragging === null) {
        return;
      }
      dragging.classList.remove("dragging");
      dragging = null;
      const order = new Map(
        Array.from(tabList.children).map((el, i) => [
          (el as HTMLElement).dataset.path ?? "",
          i,
        ]),
      );
      tabs.sort((a, b) => (order.get(a.path) ?? 0) - (order.get(b.path) ?? 0));
      renderBar();
    }
    tabList.addEventListener("drop", (event) => {
      event.preventDefault();
      commit();
    });
    tabList.addEventListener("dragend", () => commit()); // 落点在列表外也按当前 DOM 序收场
  }

  setupTabDnd();

  function openTab(path: string, file: TabFile, activate = true): void {
    const existing = find(path);
    let wasActive = false;
    if (existing === null) {
      tabs.push({
        path,
        title: fileName(path),
        encoding: file.encoding,
        source: file.text,
        scroll: 0,
        dirty: false,
        bom: file.bom === true, // 字段可空容忍：Rust 车道未合入时缺省为 false
        crlf: file.crlf === true,
        editor: null,
        cachedFragment: null,
        outline: [],
      });
    } else {
      wasActive = existing.path === activePath;
      existing.source = file.text; // 同路径重开 = 刷新内容并回到顶部（M1 语义）
      existing.encoding = file.encoding;
      existing.scroll = 0;
      existing.bom = file.bom === true;
      existing.crlf = file.crlf === true;
      existing.editor = null; // 内容已刷新，旧编辑器态作废
      existing.cachedFragment = null; // 缓存同步作废（P5 批3 失效条件①：防挂旧文）
    }
    if (activate || wasActive) {
      activateTab(path);
    } else {
      renderBar(); // 中间项：只上栏，正文留待末项统一挂载
    }
  }

  function closeTab(path: string): void {
    const idx = tabs.findIndex((tab) => tab.path === path);
    if (idx < 0) {
      return;
    }
    const tab = tabs[idx];
    if (tab.dirty && !deps.confirmClose(tab)) {
      return; // 用户取消，标签保留
    }
    tabs.splice(idx, 1);
    if (path !== activePath) {
      renderBar();
      return;
    }
    activePath = null;
    const neighbor = tabs[idx] ?? tabs[idx - 1] ?? null;
    if (neighbor === null) {
      renderBar();
      deps.onEmpty();
    } else {
      activateTab(neighbor.path);
    }
  }

  /** 关闭一批标签（▾ / ⋯ 菜单的批量关闭）。逐个走 closeTab —— dirty 标签照常弹确认，
   *  用户取消的那一个就留下（批量操作不做「全有或全无」，与单个关闭的语义一致）。
   *  ⚠ 快照路径再遍历：closeTab 会改 tabs 数组，直接迭代 live 数组会跳项。 */
  function closeMany(paths: string[]): void {
    for (const path of [...paths]) {
      if (find(path) !== null) {
        closeTab(path);
      }
    }
  }

  function closeOthers(): void {
    closeMany(tabs.filter((tab) => tab.path !== activePath).map((tab) => tab.path));
  }

  function closeAll(): void {
    closeMany(tabs.map((tab) => tab.path));
  }

  return {
    openTab,
    activateTab,
    closeTab,
    closeOthers,
    closeAll,
    activeTab: () => find(activePath ?? ""),
    setDirty(path: string, dirty: boolean): void {
      const tab = find(path);
      if (tab === null) {
        throw new Error(`标签不存在：${path}`);
      }
      tab.dirty = dirty;
      renderBar();
    },
    count: () => tabs.length,
    paths: () => tabs.map((tab) => tab.path),
    hasDirty: () => tabs.some((tab) => tab.dirty),
    dirtyTabs: () => tabs.filter((tab) => tab.dirty),
    /** 顶栏拥挤态实测用（CDP 探针手工切 .overflow 类后要重算 ⋯ 显隐）：把壳层菜单的
     *  sync 透出来。取用方只有 main.ts 的 DEV 探针钩子；生产路径不调它。 */
    syncMenus: () => menus?.sync(),
  };
}
