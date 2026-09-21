/**
 * 最近文件（M2 波1，F5）断言：增/去重/最新在前/上限 10、损坏存储回退、
 * 下拉菜单点击行为（jsdom localStorage 可用）。
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { loadRecent, pushRecent, setupRecentMenu } from "../src/app/recent";

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
    const item = menu.querySelector(".recent-item") as HTMLElement;
    expect(item.textContent).toBe("a.md"); // 显示文件名
    item.click();
    expect(onPick).toHaveBeenCalledWith("D:\\docs\\a.md");
    expect(menu.hidden).toBe(true);
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
