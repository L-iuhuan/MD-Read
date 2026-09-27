/**
 * 空态欢迎页（2026-09-23 第二批 · 用户选定的 V1「克制」稿落地）：
 * 主行动按钮接线、最近打开列表（最多 5 条 / 两行式 / 无则整块不出现）、条目点击回调。
 * 判据（body.empty / #empty-hint.hidden）不归本模块管，故这里只测内容与接线。
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { setupEmptyState } from "../src/ui/empty-state";

function mount(): void {
  document.body.innerHTML = `
    <button id="empty-open" type="button">打开 Markdown 文件</button>
    <button id="empty-folder" type="button">打开文件夹为工作区</button>
    <div id="empty-recent" hidden>
      <span id="empty-recent-count"></span>
      <div id="empty-recent-list"></div>
    </div>`;
}

/** 统一造 deps（2026-09-27 起 EmptyStateDeps 多了 onPickFolder：欢迎页选工作区入口）。
 *  不写显式返回类型：vi.fn() 的 Mock 推断在直接内联时可赋给 EmptyStateDeps，
 *  显式注出来反而变成宽泛 Procedure 签名而失配。 */
function makeDeps() {
  return { onOpen: vi.fn(), onPick: vi.fn(), onPickFolder: vi.fn() };
}

const setRecent = (paths: string[]): void =>
  localStorage.setItem("modu-recent", JSON.stringify(paths));

const items = (): HTMLElement[] =>
  Array.from(document.querySelectorAll<HTMLElement>("#empty-recent-list .menu-item"));

const wrap = (): HTMLElement => document.getElementById("empty-recent") as HTMLElement;
const count = (): HTMLElement => document.getElementById("empty-recent-count") as HTMLElement;

describe("空态：最近打开列表", () => {
  beforeEach(() => {
    localStorage.clear();
    mount();
  });

  it("无最近打开：整块不出现（设计稿的无最近对照态），计数留空", () => {
    setRecent([]);
    setupEmptyState(makeDeps());
    expect(wrap().hidden).toBe(true);
    expect(count().textContent).toBe("");
    expect(items()).toHaveLength(0);
  });

  it("存储里有 8 条也只画 5 条（RECENT_MAX），计数回显 5 / 5", () => {
    setRecent(Array.from({ length: 8 }, (_, i) => `D:\\笔记\\第${i}篇.md`));
    setupEmptyState(makeDeps());
    expect(wrap().hidden).toBe(false);
    expect(items()).toHaveLength(5);
    expect(count().textContent).toBe("5 / 5");
  });

  it("两行式：文件名 + 弱化目录；路径没有目录时不画第二行", () => {
    setRecent(["D:\\文档\\笔记\\读书笔记.md", "只有文件名.md"]);
    setupEmptyState(makeDeps());
    const [first, second] = items();
    expect(first?.querySelector(".menu-name")?.textContent).toBe("读书笔记.md");
    expect(first?.querySelector(".menu-path")?.textContent).toBe("D:\\文档\\笔记");
    expect(second?.querySelector(".menu-name")?.textContent).toBe("只有文件名.md");
    expect(second?.querySelector(".menu-path")).toBeNull();
  });

  it("复用 .menu-item 列表语言（与最近下拉/全部标签/溢出菜单同构），且 title 是全路径", () => {
    setRecent(["D:\\a\\b.md"]);
    setupEmptyState(makeDeps());
    const item = items()[0] as HTMLElement;
    expect(item.tagName).toBe("BUTTON");
    expect(item.className).toContain("menu-item");
    expect(item.querySelector(".menu-text")).not.toBeNull();
    expect(item.title).toBe("D:\\a\\b.md");
  });

  it("点主行动按钮 → onOpen（与标签条「＋」同一处理函数）；点条目 → onPick(该路径)", () => {
    const deps = makeDeps();
    setRecent(["D:\\x\\一.md", "D:\\x\\二.md"]);
    setupEmptyState(deps);
    (document.getElementById("empty-open") as HTMLButtonElement).click();
    expect(deps.onOpen).toHaveBeenCalledTimes(1);
    expect(deps.onPick).not.toHaveBeenCalled();
    items()[1]?.click();
    expect(deps.onPick).toHaveBeenCalledWith("D:\\x\\二.md");
    expect(deps.onOpen).toHaveBeenCalledTimes(1); // 条目点击不会串到主行动
  });

  it("点「打开文件夹为工作区」→ onPickFolder（不串到 onOpen）", () => {
    const deps = makeDeps();
    setupEmptyState(deps);
    (document.getElementById("empty-folder") as HTMLButtonElement).click();
    expect(deps.onPickFolder).toHaveBeenCalledTimes(1);
    expect(deps.onOpen).not.toHaveBeenCalled();
  });

  it("refresh：存储变化后重画；从有到无时整块重新隐藏", () => {
    setRecent(["D:\\x\\一.md"]);
    const state = setupEmptyState(makeDeps());
    expect(items()).toHaveLength(1);
    setRecent(["D:\\x\\二.md", "D:\\x\\三.md"]);
    state.refresh();
    expect(items()).toHaveLength(2);
    expect(items()[0]?.title).toBe("D:\\x\\二.md");
    setRecent([]);
    state.refresh();
    expect(wrap().hidden).toBe(true);
    expect(items()).toHaveLength(0);
  });

  it("存储内容损坏（非法 JSON）按「无最近」处理，不抛错", () => {
    localStorage.setItem("modu-recent", "{不是 JSON");
    expect(() => setupEmptyState(makeDeps())).not.toThrow();
    expect(wrap().hidden).toBe(true);
  });
});
