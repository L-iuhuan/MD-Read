/**
 * 多标签管理（M2 波1，F5）：懒挂载（规格 D4）——仅活动标签渲染 DOM，
 * 非活动标签只留 source 文本；切换时经 deps.render 重渲并恢复 scroll。
 * main.ts 通过 mountDoc 回调接管 #doc/大纲/状态栏的接线，本模块不碰渲染管线。
 */
import type { OutlineItem } from "../render/pipeline";

/** 标签状态。dirty 恒为 false 直到 M3 编辑器，但字段与圆点渲染已就绪 */
export interface Tab {
  path: string;
  title: string;
  encoding: string;
  source: string;
  scroll: number;
  dirty: boolean;
}

export interface TabFile {
  text: string;
  encoding: string;
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
}

export interface TabManager {
  openTab(path: string, file: TabFile): void;
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
    }
    activePath = path;
    renderBar();
    const result = deps.render(target.source); // 切换即重渲（D4：非活动不留 DOM）
    deps.mountDoc({ tab: target, html: result.html, outline: result.outline });
    deps.setScroll(target.scroll);
    if (typeof requestAnimationFrame === "function") {
      requestAnimationFrame(() => deps.setScroll(target.scroll)); // 懒内容撑高后再钉一次
    }
  }

  function openTab(path: string, file: TabFile): void {
    const existing = find(path);
    if (existing === null) {
      tabs.push({
        path,
        title: fileName(path),
        encoding: file.encoding,
        source: file.text,
        scroll: 0,
        dirty: false,
      });
    } else {
      existing.source = file.text; // 同路径重开 = 刷新内容并回到顶部（M1 语义）
      existing.encoding = file.encoding;
      existing.scroll = 0;
    }
    activateTab(path);
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
