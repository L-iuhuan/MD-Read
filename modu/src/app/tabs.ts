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
  activeTab(): Tab | null;
  setDirty(path: string, dirty: boolean): void;
  count(): number;
  /** 标签路径有序快照（用户反馈批次：Ctrl+Tab 循环切换取邻居用） */
  paths(): string[];
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
    throw new Error("界面元素缺失：#tab-list");
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

  function renderBar(): void {
    tabList.textContent = "";
    for (const tab of tabs) {
      tabList.appendChild(buildTabEl(tab, tab.path === activePath));
    }
    bar.hidden = tabs.length === 0;
  }

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

  return {
    openTab,
    activateTab,
    closeTab,
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
  };
}
