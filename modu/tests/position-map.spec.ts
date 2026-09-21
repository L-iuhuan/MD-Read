/**
 * 块级保位纯函数（M3-A，F7 / 规格D1）：jsdom 造 [data-line] 块，
 * mock getBoundingClientRect().top 模拟滚动，验证视口首块与最近上方块。
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { firstVisibleLine, nearestBlockLine } from "../src/editor/position-map";

/** lines 里的 "bad" 表示造一个非法 data-line 值的块 */
function buildDoc(lines: Array<number | "bad">): HTMLElement {
  const content = document.createElement("main");
  const doc = document.createElement("article");
  for (const line of lines) {
    const p = document.createElement("p");
    p.setAttribute("data-line", line === "bad" ? "abc" : String(line));
    doc.appendChild(p);
  }
  content.appendChild(doc);
  document.body.innerHTML = "";
  document.body.appendChild(content);
  return content;
}

/** jsdom 的 getBoundingClientRect 恒为 0：容器顶=视口顶，按块序注入 top */
function mockTops(container: HTMLElement, tops: number[]): void {
  vi.spyOn(container, "getBoundingClientRect").mockReturnValue({ top: 0 } as DOMRect);
  Array.from(container.querySelectorAll("[data-line]")).forEach((el, i) => {
    vi.spyOn(el, "getBoundingClientRect").mockReturnValue({ top: tops[i] ?? 0 } as DOMRect);
  });
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("firstVisibleLine：视口内首个 [data-line] 块", () => {
  it("首块滚出视口时返回首个顶部进入视口的块", () => {
    const c = buildDoc([1, 5, 10]);
    mockTops(c, [-120, 30, 80]);
    expect(firstVisibleLine(c)).toBe(5);
  });

  it("未滚动时返回首块", () => {
    const c = buildDoc([1, 5, 10]);
    mockTops(c, [10, 60, 120]);
    expect(firstVisibleLine(c)).toBe(1);
  });

  it("全部滚过视口时回退最后一个块", () => {
    const c = buildDoc([1, 5, 10]);
    mockTops(c, [-300, -200, -100]);
    expect(firstVisibleLine(c)).toBe(10);
  });

  it("非法 data-line 块被跳过", () => {
    const c = buildDoc(["bad", 5]);
    mockTops(c, [30, 60]);
    expect(firstVisibleLine(c)).toBe(5);
  });

  it("无块返回 null", () => {
    const c = buildDoc([]);
    expect(firstVisibleLine(c)).toBeNull();
  });
});

describe("nearestBlockLine：离 fromLine 最近的上方（或相等）块", () => {
  it("取小于等于 fromLine 的最大行号（D1：块落最近上方块）", () => {
    const c = buildDoc([1, 5, 10]);
    expect(nearestBlockLine(c, 7)).toBe(5);
    expect(nearestBlockLine(c, 10)).toBe(10);
    expect(nearestBlockLine(c, 11)).toBe(10);
  });

  it("fromLine 在首块之前回退首块", () => {
    const c = buildDoc([3, 8]);
    expect(nearestBlockLine(c, 0)).toBe(3);
    expect(nearestBlockLine(c, 2)).toBe(3);
  });

  it("空文档返回 null；非法行号被忽略", () => {
    expect(nearestBlockLine(buildDoc([]), 5)).toBeNull();
    const c = buildDoc(["bad", 4]);
    expect(nearestBlockLine(c, 100)).toBe(4);
  });
});
