/**
 * 多标签管理（M2 波1，F5）：懒挂载（规格 D4）——仅活动标签渲染 DOM，
 * 非活动标签只留 source 文本；切换时经 deps.render 重渲并恢复 scroll。
 * main.ts 通过 mountDoc 回调接管 #doc/大纲/状态栏的接线，本模块不碰渲染管线。
 */
import type { SavedEditorState } from "../editor/editor";
import type { OutlineItem } from "../render/pipeline";

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
  html: string;
  outline: OutlineItem[];
}

export interface TabManagerDeps {
  render(source: string): { html: string; outline: OutlineItem[] };
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
}

function fileName(path: string): string {
  return path.split(/[\\/]/).pop() ?? path;
}

export function createTabManager(bar: HTMLElement, deps: TabManagerDeps): TabManager {
  const list = bar.querySelector<HTMLElement>("#tab-list");
  if (list === null) {
    throw new Error("界面元素缺失：#tab-list");
  }
  const tabList: HTMLElement = list; // 闭包内保住非空类型
  const tabs: Tab[] = [];
  let activePath: string | null = null;

  function find(path: string): Tab | null {
    return tabs.find((tab) => tab.path === path) ?? null;
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

  function activateTab(path: string): void {
    const target = find(path);
    if (target === null) {
      throw new Error(`标签不存在：${path}`);
    }
    const current = activePath === null ? null : find(activePath);
    if (current !== null && current !== target) {
      current.scroll = deps.getScroll(); // 离开前把阅读位置存回标签（懒挂载）
      const saved = deps.saveEditorState?.();
      if (saved !== null && saved !== undefined) {
        current.editor = saved; // 编辑器态同样随标签走（跨标签保撤销）
      }
    }
    activePath = path;
    renderBar();
    const result = deps.render(target.source); // 切换即重渲（D4：非活动不留 DOM）
    deps.mountDoc({ tab: target, html: result.html, outline: result.outline });
    deps.setScroll(target.scroll);
    if (typeof requestAnimationFrame === "function") {
      requestAnimationFrame(() => deps.setScroll(target.scroll)); // 懒内容撑高后再钉一次
    }
    deps.loadEditorState?.(target.editor);
  }

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
      });
    } else {
      wasActive = existing.path === activePath;
      existing.source = file.text; // 同路径重开 = 刷新内容并回到顶部（M1 语义）
      existing.encoding = file.encoding;
      existing.scroll = 0;
      existing.bom = file.bom === true;
      existing.crlf = file.crlf === true;
      existing.editor = null; // 内容已刷新，旧编辑器态作废
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
  };
}
