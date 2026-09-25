/**
 * X2：大纲跟随「实时二分」实现 —— 等价语义的单测。
 *
 * jsdom 没有布局引擎，所以这里**合成几何**：给每个标题桩一个 getBoundingClientRect，
 * 返回值由测试控制的 `fold`（= #content 的 scrollTop）推算，
 * `rect.top = baseTop − fold`、`rect.bottom = baseTop + height − fold`；
 * #content 的 rect.top 固定 0、clientHeight 固定 1000。
 * 于是「滚动」= 改 fold，可以把旧 IO 版的三条判据逐条钉死：
 *   ① 可见集合里 |rect.top| 最小者高亮；
 *   ② 一个都不可见时保持上一次高亮；
 *   ③ id 为空的标题胜出时不改。
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createOutlineFollow, type OutlineFollow } from "../src/app/outline-follow";

const VIEW_H = 1000;
/** 每个标题：id + 文档序 top（互不重叠） */
const LAYOUT: ReadonlyArray<readonly [string, number]> = [
  ["h-0", 0],
  ["h-1", 800],
  ["h-2", 1600],
  ["h-3", 9000],
  ["", 9600],
  ["h-4", 20000],
];
const HEIGHT = 60;

let fold = 0;

function mount(): { content: HTMLElement; doc: HTMLElement; links: Map<string, HTMLAnchorElement> } {
  document.body.innerHTML = `<main id="content"><article id="doc"></article></main><nav id="outline-list"></nav>`;
  const content = document.getElementById("content") as HTMLElement;
  const doc = document.getElementById("doc") as HTMLElement;
  const list = document.getElementById("outline-list") as HTMLElement;
  content.getBoundingClientRect = () => ({ top: 0, bottom: VIEW_H, left: 0, right: 100, x: 0, y: 0, width: 100, height: VIEW_H, toJSON: () => ({}) }) as DOMRect;
  Object.defineProperty(content, "clientHeight", { value: VIEW_H, configurable: true });

  const links = new Map<string, HTMLAnchorElement>();
  for (const [id, top] of LAYOUT) {
    const h = document.createElement("h2");
    if (id !== "") h.id = id;
    h.getBoundingClientRect = () =>
      ({ top: top - fold, bottom: top + HEIGHT - fold, left: 0, right: 100, x: 0, y: 0, width: 100, height: HEIGHT, toJSON: () => ({}) }) as DOMRect;
    doc.appendChild(h);
    if (id !== "") {
      const a = document.createElement("a");
      a.href = `#${id}`;
      list.appendChild(a);
      links.set(id, a);
    }
  }
  return { content, doc, links };
}

function setup(): { follow: OutlineFollow; links: Map<string, HTMLAnchorElement> } {
  fold = 0;
  const { content, doc, links } = mount();
  const follow = createOutlineFollow({ content: () => content, doc: () => doc, links: () => links });
  follow.reset();
  return { follow, links };
}

const activeIds = (links: Map<string, HTMLAnchorElement>): string[] =>
  [...links.entries()].filter(([, a]) => a.classList.contains("active")).map(([id]) => id);

describe("X2 大纲跟随：实时二分的等价语义", () => {
  beforeEach(() => {
    fold = 0;
  });

  it("顶部：第一个标题可见 → 高亮它（与旧版一致）", () => {
    const { follow, links } = setup();
    expect(follow.update()).toBe(true);
    expect(activeIds(links)).toEqual(["h-0"]);
  });

  it("标题完全滚出上沿后，换成紧接着的下一个（不是\"当前节\"）", () => {
    const { follow, links } = setup();
    follow.update(); // h-0
    fold = 900; // h-0 的 bottom = 60-900 < 0 → 不可见；h-1（top 800-900=-100，bottom -40）也不可见 → h-2?
    // h-1 bottom = 860-900 = -40 ≤ 0 也不可见；h-2 top = 700 < 1000 可见 → 高亮 h-2
    expect(follow.update()).toBe(true);
    expect(activeIds(links)).toEqual(["h-2"]);
  });

  it("标题部分滚出上沿（bottom > 上沿）时仍是它 —— 与 IO 的\"相交\"判据等价", () => {
    const { follow, links } = setup();
    follow.update();
    fold = 100; // h-0: top=-100, bottom=-40 → 不可见；h-1: top=700 → 可见
    follow.update();
    expect(activeIds(links)).toEqual(["h-1"]);
    fold = 30; // h-0: top=-30, bottom=30 > 0 → 仍相交，且 |top| 最小 → 仍是 h-0
    follow.update();
    expect(activeIds(links)).toEqual(["h-0"]);
  });

  it("一个标题都不可见时保持上一次高亮（旧版 best=null 也不改）", () => {
    const { follow, links } = setup();
    fold = 5000; // h-2: top=-3400 不可见；h-3: top=4000 ≥ 1000 不可见 → 无候选
    follow.update();
    expect(activeIds(links)).toEqual([]); // 首次就没有候选 → 不高亮任何一条
    fold = 700; // h-1 可见 → 高亮
    follow.update();
    expect(activeIds(links)).toEqual(["h-1"]);
    fold = 5000; // 又回到\"一个都不可见\"：上一次的高亮必须保持
    expect(follow.update()).toBe(false);
    expect(activeIds(links)).toEqual(["h-1"]);
  });

  it("id 为空的标题胜出时不改（旧版 best.id !== \"\" 才写）", () => {
    const { follow, links } = setup();
    fold = 9500; // 无 id 的那个（top 9600-9500=100）比 h-3（top -500 已不可见）更近
    expect(follow.update()).toBe(false);
    expect(activeIds(links)).toEqual([]);
  });

  it("当前项没变就不碰 DOM；变了只做「一移一加」两次写", () => {
    const { follow, links } = setup();
    const addSpy = vi.spyOn(DOMTokenList.prototype, "add");
    const removeSpy = vi.spyOn(DOMTokenList.prototype, "remove");
    follow.update(); // h-0（首次高亮：只有一次 add，没有 remove）
    expect(addSpy).toHaveBeenCalledTimes(1);
    expect(removeSpy).toHaveBeenCalledTimes(0);
    expect(follow.update()).toBe(false); // 同一位置再算一次：零写入
    expect(addSpy).toHaveBeenCalledTimes(1);
    expect(removeSpy).toHaveBeenCalledTimes(0);
    fold = 100; // h-1 成为当前项：恰好一移一加
    expect(follow.update()).toBe(true);
    expect(addSpy).toHaveBeenCalledTimes(2);
    expect(removeSpy).toHaveBeenCalledTimes(1);
    expect(addSpy.mock.calls[1]).toEqual(["active"]);
    expect(links.get("h-0")?.classList.contains("active")).toBe(false);
    expect(links.get("h-1")?.classList.contains("active")).toBe(true);
    addSpy.mockRestore();
    removeSpy.mockRestore();
  });

  it("reset()：正文换掉/空态 → 标题列表清空，update() 不再动作", () => {
    const { follow, links } = setup();
    follow.update();
    expect(activeIds(links)).toEqual(["h-0"]);
    (document.getElementById("doc") as HTMLElement).innerHTML = "";
    follow.reset();
    expect(follow.update()).toBe(false);
    expect(activeIds(links)).toEqual(["h-0"]); // 高亮留在旧链接上（等 mountOutline 重建新链接）
  });

  it("#doc 处于 hidden（空态）时 reset 得到空列表", () => {
    const { content, doc, links } = (() => {
      const m = mount();
      return m;
    })();
    doc.hidden = true;
    const follow = createOutlineFollow({ content: () => content, doc: () => doc, links: () => links });
    follow.reset();
    expect(follow.update()).toBe(false);
  });
});
