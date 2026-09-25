/**
 * D-05 新增功能 · 壳层两个下拉菜单（ui/tabs-menu.ts）的行为锚。
 *   ▾ 全部标签列表：两行式、当前项浅主色底、脏点、底部批量关闭；
 *   ⋯ 溢出菜单：拥挤态收进来的常显动作代理项（最近 / Aa / ◐ / PDF）+ 批量关闭；
 *              **只在顶栏拥挤时出现**；**没有「打开」项**（文件入口只剩标签条的 ＋）；
 *   两者共用：一次只开一个、点外部收起、aria-expanded 回显、溢出才显示 #tabs-nav。
 * jsdom 无布局引擎 → 溢出判定用 Object.defineProperty 直接给 scrollWidth/clientWidth；
 * 拥挤态（header.overflow）用 class 直接切，等价于 main.ts 的 ResizeObserver 行为。
 */
import { describe, expect, it, vi } from "vitest";
import { createTabMenus, dirOf, type TabMenusDeps } from "../src/ui/tabs-menu";
import type { Tab } from "../src/app/tabs";

const MENU_DOM = `
  <header id="titlebar" class="topbar">
  <div id="tabbar"><div id="tab-list"></div><button id="btn-newtab">＋</button></div>
  <div id="tabs-nav" hidden>
    <button id="tabs-prev" disabled>‹</button>
    <button id="tabs-next" disabled>›</button>
    <button id="tabs-list" aria-haspopup="menu" aria-expanded="false">▾</button>
    <div id="tabs-menu" role="menu" hidden></div>
  </div>
  <div class="actions">
    <button id="btn-edit">编辑</button>
    <div id="recent-wrap"><button id="btn-recent">最近</button><div id="recent-menu" hidden></div></div>
    <div class="settings-wrap"><button id="btn-settings">Aa</button><div id="settings-panel" hidden></div></div>
    <button id="btn-theme">◐</button>
    <button id="btn-export">PDF</button>
    <div id="overflow-wrap">
      <button id="btn-overflow" aria-haspopup="menu" aria-expanded="false" hidden>⋯</button>
      <div id="overflow-menu" role="menu" hidden></div>
    </div>
  </div>
  </header>`;

function tab(path: string, dirty = false): Tab {
  return {
    path,
    title: path.split(/[\\/]/).pop() ?? path,
    encoding: "UTF-8",
    source: "",
    scroll: 0,
    dirty,
    bom: false,
    crlf: false,
    editor: null,
    cachedFragment: null,
    outline: [],
  };
}

interface Harness {
  menus: ReturnType<typeof createTabMenus>;
  tabs: Tab[];
  active: { path: string | null };
  activate: ReturnType<typeof vi.fn>;
  closeTab: ReturnType<typeof vi.fn>;
  closeOthers: ReturnType<typeof vi.fn>;
  closeAll: ReturnType<typeof vi.fn>;
  el: (id: string) => HTMLElement;
  setOverflow(on: boolean): void;
  setCrowded(on: boolean): void;
}

function setup(tabs: Tab[], activePath: string | null, crowded = true): Harness {
  document.body.innerHTML = MENU_DOM;
  const header = document.getElementById("titlebar") as HTMLElement;
  if (crowded) {
    header.classList.add("overflow"); // 默认按「拥挤态」建：⋯ 只在该态出现，菜单才有意义
  }
  const active = { path: activePath };
  const list = document.getElementById("tab-list") as HTMLElement;
  const state = { over: false };
  Object.defineProperty(list, "scrollWidth", { get: () => (state.over ? 900 : 100), configurable: true });
  Object.defineProperty(list, "clientWidth", { get: () => 200, configurable: true });
  const activate = vi.fn((path: string) => {
    active.path = path;
  });
  const deps: TabMenusDeps = {
    bar: document.getElementById("tabbar") as HTMLElement,
    getTabs: () => tabs,
    activePath: () => active.path,
    activate,
    closeTab: vi.fn(),
    closeOthers: vi.fn(),
    closeAll: vi.fn(),
  };
  const menus = createTabMenus(deps);
  return {
    menus,
    tabs,
    active,
    activate,
    closeTab: deps.closeTab as ReturnType<typeof vi.fn>,
    closeOthers: deps.closeOthers as ReturnType<typeof vi.fn>,
    closeAll: deps.closeAll as ReturnType<typeof vi.fn>,
    el: (id: string) => document.getElementById(id) as HTMLElement,
    setOverflow(on: boolean) {
      state.over = on;
    },
    setCrowded(on: boolean) {
      header.classList.toggle("overflow", on);
    },
  };
}

describe("dirOf", () => {
  it("去掉文件名；无目录返回空串", () => {
    expect(dirOf("D:\\a\\b\\c.md")).toBe("D:\\a\\b");
    expect(dirOf("/x/y/c.md")).toBe("/x/y");
    expect(dirOf("c.md")).toBe("");
  });
});

describe("▾ 全部标签列表", () => {
  it("两行式：文件名 + 弱化目录；当前项浅主色底；脏标签带 ●", () => {
    const h = setup([tab("D:\\docs\\a.md"), tab("D:\\docs\\sub\\b.md", true)], "D:\\docs\\a.md");
    h.el("tabs-list").click();
    const menu = h.el("tabs-menu");
    expect(menu.hidden).toBe(false);
    // 只看标签条目（底部的批量操作也是 .menu-item，故按 .is-action 排除）
    const items = Array.from(menu.querySelectorAll<HTMLElement>(".menu-item:not(.is-action)"));
    expect(items).toHaveLength(2);
    expect(items[0]?.querySelector(".menu-name")?.textContent).toBe("a.md");
    expect(items[0]?.querySelector(".menu-path")?.textContent).toBe("D:\\docs");
    expect(items[0]?.classList.contains("is-current")).toBe(true);
    expect(items[1]?.classList.contains("is-current")).toBe(false);
    // 脏点：第二条可见、第一条隐藏
    expect(items[0]?.querySelector<HTMLElement>(".menu-dot")?.hidden).toBe(true);
    expect(items[1]?.querySelector<HTMLElement>(".menu-dot")?.hidden).toBe(false);
  });

  it("点条目切标签并收起菜单", () => {
    const h = setup([tab("a.md"), tab("b.md")], "a.md");
    h.el("tabs-list").click();
    const items = Array.from(
      h.el("tabs-menu").querySelectorAll<HTMLElement>(".menu-item:not(.is-action)"),
    );
    (items[1] as HTMLElement).click();
    expect(h.activate).toHaveBeenCalledWith("b.md");
    expect(h.el("tabs-menu").hidden).toBe(true);
    expect(h.el("tabs-list").getAttribute("aria-expanded")).toBe("false");
  });

  it("底部两条批量关闭各自回调并收起菜单", () => {
    const h = setup([tab("a.md"), tab("b.md")], "a.md");
    h.el("tabs-list").click();
    const actions = Array.from(h.el("tabs-menu").querySelectorAll<HTMLElement>(".menu-item.is-action"));
    expect(actions.map((el) => el.textContent)).toEqual(["关闭其他标签", "关闭全部标签"]);
    (actions[0] as HTMLElement).click();
    expect(h.closeOthers).toHaveBeenCalledTimes(1);
    expect(h.el("tabs-menu").hidden).toBe(true);

    h.el("tabs-list").click();
    const again = Array.from(h.el("tabs-menu").querySelectorAll<HTMLElement>(".menu-item.is-action"));
    (again[1] as HTMLElement).click();
    expect(h.closeAll).toHaveBeenCalledTimes(1);
  });

  it("无标签时空态文案 + 不渲染批量操作", () => {
    const h = setup([], null);
    h.el("tabs-list").click();
    const menu = h.el("tabs-menu");
    expect(menu.querySelector(".recent-empty")?.textContent).toBe("暂无打开的标签");
    expect(menu.querySelectorAll(".menu-item.is-action")).toHaveLength(0);
  });
});

describe("⋯ 溢出菜单", () => {
  it("代理项点的是顶栏原按钮（不复制打开/主题/导出逻辑），且没有「打开」项", () => {
    const h = setup([tab("a.md")], "a.md");
    const spies = {
      "btn-recent": vi.fn(),
      "btn-settings": vi.fn(),
      "btn-theme": vi.fn(),
      "btn-export": vi.fn(),
    };
    for (const [id, spy] of Object.entries(spies)) {
      h.el(id).addEventListener("click", spy);
    }
    // jsdom 的 .click() 不冒泡，而真实点击**会**冒泡到 document（菜单靠这条委托点外收起），
    // 故这里用 dispatchEvent 复刻真实路径。
    const realClick = (el: HTMLElement): void => {
      el.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
    };

    h.el("btn-overflow").click();
    const menu = h.el("overflow-menu");
    const items = Array.from(menu.querySelectorAll<HTMLElement>(".menu-item:not(.is-action)"));
    expect(items.map((el) => el.textContent)).toEqual(["最近", "Aa", "◐", "PDF"]);
    expect(items.map((el) => el.textContent)).not.toContain("打开");

    // 逐项点一遍：每个代理项各命中一次自己的原按钮，且点完菜单先收起
    const ids = ["btn-recent", "btn-settings", "btn-theme", "btn-export"] as const;
    for (let i = 0; i < ids.length; i += 1) {
      if (menu.hidden) {
        h.el("btn-overflow").click();
      }
      const again = Array.from(menu.querySelectorAll<HTMLElement>(".menu-item:not(.is-action)"));
      realClick(again[i] as HTMLElement);
      expect(menu.hidden).toBe(true); // 先收菜单，再把点击交给原按钮
    }
    for (const [id, spy] of Object.entries(spies)) {
      expect(spy, `${id} 未被代理点击命中`).toHaveBeenCalledTimes(1);
    }
  });
});

describe("⋯ 只在拥挤态出现", () => {
  it("拥挤态且有标签才显示；无标签 / 非拥挤态都不显示（它不是常驻按钮）", () => {
    const empty = setup([], null);
    empty.menus.sync();
    expect(empty.el("btn-overflow").hidden).toBe(true); // 无标签

    const notCrowded = setup([tab("a.md")], "a.md", false);
    notCrowded.menus.sync();
    expect(notCrowded.el("btn-overflow").hidden).toBe(true); // 有标签但不拥挤

    const h = setup([tab("a.md")], "a.md");
    h.menus.sync();
    expect(h.el("btn-overflow").hidden).toBe(false); // 拥挤态
  });

  it("拥挤态翻转（#titlebar class 变化）即时重算显隐并收掉开着的菜单", async () => {
    const h = setup([tab("a.md")], "a.md");
    h.menus.sync();
    expect(h.el("btn-overflow").hidden).toBe(false);

    h.el("btn-overflow").click();
    expect(h.el("overflow-menu").hidden).toBe(false);
    expect(h.el("btn-overflow").getAttribute("aria-expanded")).toBe("true");

    h.setCrowded(false); // main.ts 的 ResizeObserver 改的正是这一个 class
    await new Promise((r) => { setTimeout(r, 0); }); // MutationObserver 回调排在微任务之后
    expect(h.el("btn-overflow").hidden).toBe(true);
    expect(h.el("overflow-menu").hidden).toBe(true); // 按钮不可见 → 浮层必须一起收
    expect(h.el("btn-overflow").getAttribute("aria-expanded")).toBe("false");
  });
});

describe("共用行为：一次只开一个 / 点外部收起 / 溢出判定", () => {
  it("开 ▾ 会收起 ⋯，反之亦然（一次只开一个）", () => {
    const h = setup([tab("a.md")], "a.md");
    h.el("tabs-list").click();
    expect(h.el("tabs-menu").hidden).toBe(false);
    h.el("btn-overflow").click();
    expect(h.el("overflow-menu").hidden).toBe(false);
    expect(h.el("tabs-menu").hidden).toBe(true);
    expect(h.el("tabs-list").getAttribute("aria-expanded")).toBe("false");
  });

  it("点菜单外部收起（document 委托）", () => {
    const h = setup([tab("a.md")], "a.md");
    h.el("tabs-list").click();
    expect(h.el("tabs-menu").hidden).toBe(false);
    document.body.click();
    expect(h.el("tabs-menu").hidden).toBe(true);
  });

  it("isOpen/close 反映两个菜单的整体状态", () => {
    const h = setup([tab("a.md")], "a.md");
    expect(h.menus.isOpen()).toBe(false);
    h.el("tabs-list").click();
    expect(h.menus.isOpen()).toBe(true);
    h.menus.close();
    expect(h.menus.isOpen()).toBe(false);
  });

  it("#tabs-nav 只在标签确有溢出时出现；不溢出时 ▾ 菜单一并收起", () => {
    const h = setup([tab("a.md"), tab("b.md")], "a.md");
    h.setOverflow(false);
    h.menus.sync();
    expect(h.el("tabs-nav").hidden).toBe(true);

    h.setOverflow(true);
    h.menus.sync();
    expect(h.el("tabs-nav").hidden).toBe(false);

    // 开着 ▾ 时溢出消失：菜单必须跟着收（按钮都藏了，菜单不能留在屏上）
    h.el("tabs-list").click();
    expect(h.el("tabs-menu").hidden).toBe(false);
    h.setOverflow(false);
    h.menus.sync();
    expect(h.el("tabs-menu").hidden).toBe(true);
  });

  it("无标签时 #tabs-nav 不出现（哪怕 scrollWidth 判定为溢出）", () => {
    const h = setup([], null);
    h.setOverflow(true);
    h.menus.sync();
    expect(h.el("tabs-nav").hidden).toBe(true);
  });
});
