/**
 * 宽表自动横排 + "可能被截"提醒的单测锚（2026-09-23 用户裁决）。
 *
 * 边界（来历见 src/render/print-ready.ts 顶部注释）：
 *   竖版可印宽 658px（A4 210mm − 2×18mm = 174mm，按 96dpi 换算，**推断**）
 *   横版可印宽 987px（297mm − 36mm = 261mm 同上）
 * 规则：`658 < 内容宽 ≤ 987` → 打 `wide-page`（打印时横排）；`> 987` → 不横排、只提醒；
 *       `pre` 不进清单（print.css 已让长代码行换行）。
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  LANDSCAPE_PRINTABLE_PX,
  PORTRAIT_PRINTABLE_PX,
  blockContentWidth,
  markLandscapeBlocks,
  overflowWarning,
  tooWideBlocks,
} from "../src/render/print-ready";

/** 造一个 `.table-wrap`，内部 table 的内容宽可控（jsdom 的 scrollWidth 恒 0，必须显式定义） */
function wrapWithTable(width: number): HTMLElement {
  const wrap = document.createElement("div");
  wrap.className = "table-wrap";
  const table = document.createElement("table");
  Object.defineProperty(table, "scrollWidth", { value: width, configurable: true });
  wrap.appendChild(table);
  Object.defineProperty(wrap, "scrollWidth", { value: 0, configurable: true });
  return wrap;
}

describe("宽表自动横排 · 边界与幂等", () => {
  it("阈值常量来历固定：658 / 987（改这两个数必须同步改注释里的推导线）", () => {
    expect([PORTRAIT_PRINTABLE_PX, LANDSCAPE_PRINTABLE_PX]).toEqual([658, 987]);
  });

  it("blockContentWidth 取 max(表自然宽, 容器宽)", () => {
    const narrowTableWideWrap = wrapWithTable(800);
    Object.defineProperty(narrowTableWideWrap, "scrollWidth", { value: 1665, configurable: true });
    expect(blockContentWidth(narrowTableWideWrap)).toBe(1665);
    const wideTable = wrapWithTable(1870);
    Object.defineProperty(wideTable, "scrollWidth", { value: 734, configurable: true });
    expect(blockContentWidth(wideTable)).toBe(1870);
  });

  it("只有「竖版放不下、横版放得下」的块被打 wide-page（含两侧边界）", () => {
    const root = document.createElement("div");
    const exactPortrait = wrapWithTable(PORTRAIT_PRINTABLE_PX); // 658：竖版刚好放得下 → 不横排
    const justOver = wrapWithTable(PORTRAIT_PRINTABLE_PX + 1);
    const exactLandscape = wrapWithTable(LANDSCAPE_PRINTABLE_PX); // 987：横版刚好放得下 → 横排
    const tooWide = wrapWithTable(LANDSCAPE_PRINTABLE_PX + 1);
    root.append(exactPortrait, justOver, exactLandscape, tooWide);
    expect(markLandscapeBlocks(root)).toBe(2);
    expect(exactPortrait.classList.contains("wide-page")).toBe(false);
    expect(justOver.classList.contains("wide-page")).toBe(true);
    expect(exactLandscape.classList.contains("wide-page")).toBe(true);
    expect(tooWide.classList.contains("wide-page")).toBe(false); // 超宽：不横排、不缩放
  });

  it("幂等且能清掉旧标记（重复调用 / 变窄后不残留）", () => {
    const root = document.createElement("div");
    const box = wrapWithTable(800);
    root.append(box);
    expect(markLandscapeBlocks(root)).toBe(1);
    expect(markLandscapeBlocks(root)).toBe(1);
    expect(root.querySelectorAll(".wide-page").length).toBe(1);
    Object.defineProperty(box.querySelector("table") as HTMLElement, "scrollWidth", {
      value: 600,
      configurable: true,
    });
    Object.defineProperty(box, "scrollWidth", { value: 0, configurable: true });
    expect(markLandscapeBlocks(root)).toBe(0);
    expect(box.classList.contains("wide-page")).toBe(false);
  });

  it("没有表格的文档：不标记、不提醒", () => {
    const root = document.createElement("div");
    const p = document.createElement("p");
    p.textContent = "纯正文";
    root.append(p);
    expect(markLandscapeBlocks(root)).toBe(0);
    expect(tooWideBlocks(root)).toEqual([]);
    expect(overflowWarning([])).toBeNull();
  });
});

describe("超宽（> 横版可印宽）· 只提醒不横排", () => {
  it(">987 的表格进提醒清单，且不会被横排", () => {
    const root = document.createElement("div");
    const huge = wrapWithTable(1870);
    root.append(huge);
    expect(tooWideBlocks(root)).toEqual(["宽表格"]);
    expect(markLandscapeBlocks(root)).toBe(0);
    expect(huge.classList.contains("wide-page")).toBe(false);
  });

  it('提醒文案：中文、含处数、明示"横版"、不含技术黑话', () => {
    const note = overflowWarning(["宽表格", "宽表格"]);
    expect(note).toBe("本文档有 2 处表格比 A4 横版可印宽还宽（宽表格），PDF 中可能被截断");
    expect(note).not.toMatch(/scrollWidth|page|landscape|px|transform/);
  });

  it("中等宽 + 超宽混排：只有超宽进提醒、只有中等宽被横排", () => {
    const root = document.createElement("div");
    const medium = wrapWithTable(800);
    const huge = wrapWithTable(1870);
    root.append(medium, huge);
    expect(markLandscapeBlocks(root)).toBe(1);
    expect(medium.classList.contains("wide-page")).toBe(true);
    expect(huge.classList.contains("wide-page")).toBe(false);
    expect(tooWideBlocks(root)).toEqual(["宽表格"]);
  });
});

describe("print.css 打印契约锚（命名页 + 红线同层）", () => {
  it("有 @page wide（A4 landscape）与 .mdc .wide-page{page:wide}，且行级分页/表头重复仍在", () => {
    const css = readFileSync("src/typography/print.css", "utf8");
    expect(css).toMatch(/@page wide\s*\{[^}]*size:\s*A4 landscape/);
    expect(css).toMatch(/\.mdc \.wide-page\s*\{[^}]*page:\s*wide/);
    expect(css).toMatch(/tr\s*\{[^}]*break-inside:\s*avoid/);
    expect(css).toMatch(/thead\s*\{[^}]*display:\s*table-header-group/);
    expect(css).toMatch(/@page\s*\{[^}]*size:\s*A4;[^}]*margin:\s*18mm/);
  });
});
