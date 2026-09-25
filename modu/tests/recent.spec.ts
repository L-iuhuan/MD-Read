/**
 * 最近文件（M2 波1，F5）断言：增/去重/最新在前/上限 10、损坏存储回退、
 * 下拉菜单点击行为（jsdom localStorage 可用）。
 * 本轮（标签重复缺陷）加 `hydrateRecent`：历史**双形态**值的读取归一到 canonical，
 * 且**只在值真的变了才写回**（没变 ⇒ 一个字节都不动，见下方 spy 断言）。
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

/** mock 的"canonical 形态"：Windows `canonicalize` 产物含 `\\?\` 前缀。 */
const CANONICAL = "\\\\?\\C:\\docs\\笔记.md";
const PLAIN = "C:\\docs\\..\\docs\\笔记.md";

const mocks = vi.hoisted(() => ({
  invoke: vi.fn(async (_cmd: string, args?: Record<string, unknown>) => {
    const raw = String(args?.raw ?? "");
    return raw === PLAIN ? CANONICAL : raw; // 与 Rust `normalize_path` 同语义（认不出就原样）
  }),
}));
vi.mock("@tauri-apps/api/core", () => ({ invoke: mocks.invoke }));

import { dirName, hydrateRecent, loadRecent, pushRecent, setupRecentMenu } from "../src/app/recent";

beforeEach(() => {
  localStorage.clear();
});

describe("recent 存储", () => {
  it("push 后 load 往返一致，最新在前", () => {
    pushRecent("a.md");
    pushRecent("b.md");
    expect(loadRecent()).toEqual(["b.md", "a.md"]);
  });

  it("去重：同路径再 push 移到最前且不重复", () => {
    pushRecent("a.md");
    pushRecent("b.md");
    pushRecent("c.md");
    const list = pushRecent("a.md");
    expect(list).toEqual(["a.md", "c.md", "b.md"]);
    expect(loadRecent()).toEqual(["a.md", "c.md", "b.md"]);
  });

  it("上限 10：第 11 个挤掉最旧", () => {
    for (let i = 1; i <= 11; i++) {
      pushRecent(`f${i}.md`);
    }
    const list = loadRecent();
    expect(list).toHaveLength(10);
    expect(list[0]).toBe("f11.md");
    expect(list).not.toContain("f1.md");
    expect(list[9]).toBe("f2.md");
  });

  it("空存储返回空列表", () => {
    expect(loadRecent()).toEqual([]);
  });

  it("损坏 JSON 回退空列表（不抛错）", () => {
    localStorage.setItem("modu-recent", "{oops");
    expect(loadRecent()).toEqual([]);
  });

  it("非数组/非字符串项被过滤", () => {
    localStorage.setItem("modu-recent", JSON.stringify([1, "a.md", null]));
    expect(loadRecent()).toEqual(["a.md"]);
  });
});

/* ---- 历史双形态收敛（本轮修复）：读取时归一 + 只在值真的变了才写回 ---- */

describe("hydrateRecent（读取时归一）", () => {
  function stored(): string[] {
    return JSON.parse(localStorage.getItem("modu-recent") ?? "[]") as string[];
  }

  it("同一文件的 plain 与 canonical 两条历史值 ⇒ 收敛成一条（去重前是两个条目）", async () => {
    localStorage.setItem("modu-recent", JSON.stringify([PLAIN, CANONICAL, "D:\\other.md"]));
    expect(loadRecent()).toHaveLength(3); // 存储层原样读：确实并存两条形态（缺陷现场）
    const setItem = vi.spyOn(Storage.prototype, "setItem");
    try {
      const list = await hydrateRecent();
      expect(list).toEqual([CANONICAL, "D:\\other.md"]);
      expect(stored()).toEqual([CANONICAL, "D:\\other.md"]);
      expect(loadRecent()).toEqual([CANONICAL, "D:\\other.md"]); // 写回后 load 也只剩一条
      expect(setItem).toHaveBeenCalled(); // 变了的这一侧必须真写（下面那条才有鉴别力）
    } finally {
      setItem.mockRestore();
    }
  });

  it("⭐ 值没变 ⇒ 不写回（不每次启动都写使用者可见的列表）", async () => {
    localStorage.setItem("modu-recent", JSON.stringify([CANONICAL, "D:\\other.md"]));
    const before = localStorage.getItem("modu-recent"); // 逐字快照（含 JSON 形态）
    const setItem = vi.spyOn(Storage.prototype, "setItem");
    try {
      const list = await hydrateRecent();
      expect(list).toEqual([CANONICAL, "D:\\other.md"]);
      expect(setItem).not.toHaveBeenCalled(); // 一个字节都没写
      expect(localStorage.getItem("modu-recent")).toBe(before);
    } finally {
      setItem.mockRestore();
    }
  });

  it("空存储：不归一、不写回、不凭空造键", async () => {
    const setItem = vi.spyOn(Storage.prototype, "setItem");
    try {
      expect(await hydrateRecent()).toEqual([]);
      expect(setItem).not.toHaveBeenCalled();
      expect(localStorage.getItem("modu-recent")).toBeNull();
    } finally {
      setItem.mockRestore();
    }
  });

  it("收敛后仍守上限 10（去重让列表变短，不会因此变长）", async () => {
    const eleven = Array.from({ length: 11 }, (_, i) => `D:\\d\\f${i}.md`);
    localStorage.setItem("modu-recent", JSON.stringify(eleven));
    expect(await hydrateRecent()).toHaveLength(10);
  });
});

describe("recent 菜单", () => {
  function mountMenu(): { btn: HTMLButtonElement; menu: HTMLElement } {
    document.body.innerHTML =
      '<div id="recent-wrap"><button id="btn-recent">最近</button>' +
      '<div id="recent-menu" hidden></div></div>';
    return {
      btn: document.getElementById("btn-recent") as HTMLButtonElement,
      menu: document.getElementById("recent-menu") as HTMLElement,
    };
  }

  it("点击展开、点项回调 onPick 并收起", () => {
    pushRecent("D:\\docs\\a.md");
    const { btn, menu } = mountMenu();
    const onPick = vi.fn();
    setupRecentMenu(onPick);
    btn.click();
    expect(menu.hidden).toBe(false);
    const item = menu.querySelector(".menu-item") as HTMLElement;
    expect(item.querySelector(".menu-name")?.textContent).toBe("a.md"); // 第一行：文件名
    item.click();
    expect(onPick).toHaveBeenCalledWith("D:\\docs\\a.md");
    expect(menu.hidden).toBe(true);
  });

  it("两行式：第二行是弱化目录（S-5），无目录的路径不渲染第二行", () => {
    pushRecent("D:\\docs\\sub\\a.md");
    pushRecent("b.md"); // 无目录
    const { btn, menu } = mountMenu();
    setupRecentMenu(vi.fn());
    btn.click();
    const items = Array.from(menu.querySelectorAll<HTMLElement>(".menu-item"));
    expect(items).toHaveLength(2);
    expect(items[0]?.querySelector(".menu-name")?.textContent).toBe("b.md");
    expect(items[0]?.querySelector(".menu-path")).toBeNull(); // 无目录 → 不渲染第二行
    expect(items[1]?.querySelector(".menu-name")?.textContent).toBe("a.md");
    expect(items[1]?.querySelector(".menu-path")?.textContent).toBe("D:\\docs\\sub");
  });

  it("dirName：去掉文件名与末尾分隔符；无目录返回空串", () => {
    expect(dirName("D:\\docs\\sub\\a.md")).toBe("D:\\docs\\sub");
    expect(dirName("/home/u/a.md")).toBe("/home/u");
    expect(dirName("b.md")).toBe("");
  });

  it("再次点击按钮收起", () => {
    pushRecent("a.md");
    const { btn, menu } = mountMenu();
    setupRecentMenu(vi.fn());
    btn.click();
    btn.click();
    expect(menu.hidden).toBe(true);
  });

  it("空列表显示「暂无最近文件」", () => {
    const { btn, menu } = mountMenu();
    setupRecentMenu(vi.fn());
    btn.click();
    const empty = menu.querySelector(".recent-empty") as HTMLElement;
    expect(empty.textContent).toBe("暂无最近文件");
  });
});
