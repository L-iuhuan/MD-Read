/**
 * 壳层两个下拉菜单（D-05 新增功能）：
 *   ▾ 全部标签列表 —— 两行式（文件名 + 弱化目录）、当前项浅主色底、脏点；
 *                     底部「关闭其他标签 / 关闭全部标签」。
 *   ⋯ 溢出菜单     —— 顶栏拥挤（标签条可用宽度 < --w-tabs-min）时收进来的动作：
 *                     「打开… / 最近」的代理项 + 标签批量操作。
 *
 * 为什么独立一文件而不是塞进 app/tabs.ts：tabs.ts 已 460+ 行（超 400 铁律，本批
 * 不扩大改动面），菜单是**壳层 DOM** 而非标签状态机，放 ui/ 与 findbar/settings 同层。
 * 两个菜单都是 index.html 里的常驻空容器（默认 hidden），内容每次打开现填 ——
 * 样式来源唯一（app.css §7c），不靠运行时注入 <style>。
 *
 * 「代理点击」的做法与理由：被收进 ⋯ 的「打开… / 最近」按钮仍然留在 DOM 里
 * （只是 `.topbar.overflow` 下 display:none），它们的 click 监听器仍在原处。
 * 菜单项只做 `proxy.click()`，**不复制一份打开逻辑** —— 复制会让「打开文件」出现
 * 两条实现，是迟早会分叉的那种债。
 */
import type { Tab } from "../app/tabs";

export interface TabMenus {
  /** 标签集合或活动项变化后调用：重填 ▾ 菜单、切换 #tabs-nav 的显隐与 ⋯ 按钮 */
  sync(): void;
  /** 关掉两个菜单（点外部 / Esc / 切标签时用） */
  close(): void;
  /** 是否有菜单开着（Esc 仲裁取用） */
  isOpen(): boolean;
}

export interface TabMenusDeps {
  /** 标签条外层（#tabbar），用来读可用宽度判断「有没有溢出」 */
  bar: HTMLElement;
  getTabs(): Tab[];
  activePath(): string | null;
  activate(path: string): void;
  closeTab(path: string): void;
  closeOthers(): void;
  closeAll(): void;
}

/** 目录部分（去掉文件名，去掉末尾分隔符）；没有目录时返回空串 → 不渲染第二行 */
export function dirOf(path: string): string {
  const cut = Math.max(path.lastIndexOf("\\"), path.lastIndexOf("/"));
  return cut <= 0 ? "" : path.slice(0, cut);
}

/** 两行式菜单条目的内容区（文件名 + 弱化目录）。第二行按「路径里真的有目录」渲染。 */
function fillText(box: HTMLElement, name: string, path: string): void {
  const n = document.createElement("span");
  n.className = "menu-name";
  n.textContent = name;
  box.appendChild(n);
  const dir = dirOf(path);
  if (dir !== "") {
    const p = document.createElement("span");
    p.className = "menu-path";
    p.textContent = dir;
    box.appendChild(p);
  }
}

/** 造一枚条目（button，role=menuitem），可选前缀脏点 */
function makeItem(className = ""): HTMLButtonElement {
  const item = document.createElement("button");
  item.type = "button";
  item.className = className === "" ? "menu-item" : `menu-item ${className}`;
  item.setAttribute("role", "menuitem");
  return item;
}

function addDot(item: HTMLElement, dirty: boolean): void {
  const dot = document.createElement("span");
  dot.className = "menu-dot";
  dot.hidden = !dirty;
  item.appendChild(dot);
}

function addText(item: HTMLElement, name: string, path: string): void {
  const box = document.createElement("span");
  box.className = "menu-text";
  fillText(box, name, path);
  item.appendChild(box);
}

function addSeparator(menu: HTMLElement): void {
  const line = document.createElement("div");
  line.className = "menu-sep";
  menu.appendChild(line);
}

/** 代点：把一次「菜单项点击」转成对顶栏原按钮的点击（逻辑只此一份） */
function proxyClick(id: string): void {
  const target = document.getElementById(id);
  if (target instanceof HTMLElement) {
    target.click();
  }
}

export function createTabMenus(deps: TabMenusDeps): TabMenus {
  const nav = document.getElementById("tabs-nav");
  const listBtn = document.getElementById("tabs-list");
  const listMenu = document.getElementById("tabs-menu");
  const overflowBtn = document.getElementById("btn-overflow");
  const overflowMenu = document.getElementById("overflow-menu");
  const wrappers = [listMenu, overflowMenu].filter((el): el is HTMLElement => el !== null);

  function hide(el: HTMLElement | null): void {
    if (el !== null && !el.hidden) {
      el.hidden = true;
    }
  }

  function close(): void {
    for (const menu of wrappers) {
      hide(menu);
    }
    listBtn?.setAttribute("aria-expanded", "false");
    overflowBtn?.setAttribute("aria-expanded", "false");
  }

  function toggle(menu: HTMLElement | null, btn: HTMLElement | null): void {
    if (menu === null || btn === null) {
      return;
    }
    const opening = menu.hidden;
    close(); // 一次只开一个
    menu.hidden = !opening;
    btn.setAttribute("aria-expanded", String(opening));
  }

  /** ▾ 全部标签列表：每项两行式，当前项浅主色底，脏标签带 ● */
  function renderList(): void {
    if (listMenu === null) {
      return;
    }
    listMenu.textContent = "";
    const tabs = deps.getTabs();
    const active = deps.activePath();
    for (const tab of tabs) {
      const item = makeItem(tab.path === active ? "is-current" : "");
      addDot(item, tab.dirty);
      addText(item, tab.title, tab.path);
      item.addEventListener("click", () => {
        close();
        deps.activate(tab.path);
      });
      listMenu.appendChild(item);
    }
    if (tabs.length === 0) {
      const empty = document.createElement("span");
      empty.className = "recent-empty";
      empty.textContent = "暂无打开的标签";
      listMenu.appendChild(empty);
      return;
    }
    addSeparator(listMenu);
    for (const [label, run] of [
      ["关闭其他标签", deps.closeOthers],
      ["关闭全部标签", deps.closeAll],
    ] as const) {
      const item = makeItem("is-action");
      item.textContent = label;
      item.addEventListener("click", () => {
        close();
        run();
      });
      listMenu.appendChild(item);
    }
  }

  /** ⋯ 溢出菜单：被收起的「打开… / 最近」代理项 + 标签批量操作 */
  function renderOverflowActions(): void {
    if (overflowMenu === null) {
      return;
    }
    addSeparator(overflowMenu);
    for (const [label, run] of [
      ["关闭其他标签", deps.closeOthers],
      ["关闭全部标签", deps.closeAll],
    ] as const) {
      const item = makeItem("is-action");
      item.textContent = label;
      item.addEventListener("click", () => {
        close();
        run();
      });
      overflowMenu.appendChild(item);
    }
  }

  function renderOverflow(): void {
    if (overflowMenu === null) {
      return;
    }
    overflowMenu.textContent = "";
    for (const [label, id] of [
      ["打开…", "btn-open"],
      ["最近", "btn-recent"],
    ] as const) {
      const item = makeItem();
      item.textContent = label;
      item.addEventListener("click", () => {
        close(); // 先收菜单：原按钮的「点外部收起」委托会看到这次点击，晚收会被它误关
        proxyClick(id);
      });
      overflowMenu.appendChild(item);
    }
    if (deps.getTabs().length === 0) {
      // 空态：无标签时批量操作没有意义，但保留一行说明比留一个空壳好
      const empty = document.createElement("span");
      empty.className = "recent-empty";
      empty.textContent = "暂无打开的标签";
      overflowMenu.appendChild(empty);
      return;
    }
    renderOverflowActions();
  }

  /** 标签是否有溢出（单行滚动）：内容宽 > 可视宽即溢出 */
  function overflowing(): boolean {
    const list = deps.bar.querySelector<HTMLElement>("#tab-list");
    if (list === null) {
      return false;
    }
    return list.scrollWidth > list.clientWidth + 1;
  }

  function sync(): void {
    const count = deps.getTabs().length;
    const over = count > 0 && overflowing();
    if (nav !== null) {
      nav.hidden = !over;
    }
    if (overflowBtn !== null) {
      overflowBtn.hidden = count === 0;
    }
    if (!over) {
      hide(listMenu);
    }
    if (count === 0) {
      hide(overflowMenu);
    }
    // 开着的时候重填：标签增删/切活性时内容要跟着变
    if (listMenu !== null && !listMenu.hidden) {
      renderList();
    }
    if (overflowMenu !== null && !overflowMenu.hidden) {
      renderOverflow();
    }
  }

  if (listBtn !== null && listMenu !== null) {
    listBtn.addEventListener("click", () => {
      const opening = listMenu.hidden;
      if (opening) {
        renderList();
      }
      toggle(listMenu, listBtn);
    });
  }
  if (overflowBtn !== null && overflowMenu !== null) {
    overflowBtn.addEventListener("click", () => {
      const opening = overflowMenu.hidden;
      if (opening) {
        renderOverflow();
      }
      toggle(overflowMenu, overflowBtn);
    });
  }
  // 点外部收起（与最近下拉 / Aa 面板同款 document 委托）
  document.addEventListener("click", (event) => {
    const target = event.target;
    if (!(target instanceof Node)) {
      return;
    }
    for (const [menu, btn] of [
      [listMenu, listBtn],
      [overflowMenu, overflowBtn],
    ] as const) {
      if (menu === null || menu.hidden) {
        continue;
      }
      if (menu.contains(target) || (btn !== null && btn.contains(target))) {
        continue;
      }
      close();
    }
  });

  return {
    sync,
    close,
    isOpen: () => wrappers.some((menu) => !menu.hidden),
  };
}
