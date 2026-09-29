/**
 * 宽表横排 + 超宽表压列换行 + 「可能被截」提醒已撤（2026-09-23 用户裁决）。
 *
 * 三层（来历见 src/render/print-ready.ts 顶部注释）：
 *   竖版可印宽 658px（A4 210mm − 2×18mm = 174mm，按 96dpi 换算，**推断**）
 *   横版可印宽 987px（297mm − 36mm = 261mm 同上；纸型都是实测的）
 *   `w ≤ 658` 竖版自然宽 ｜ `658 < w ≤ 987` → `wide-page` 横排 ｜ `w > 987` → `+ squeeze-page` 压列换行
 * 提醒：压列后表格不再丢列、图片有 `max-inline-size:100%`、`pre` 会换行 ⇒ **无真实触发条件 ⇒ 已撤除**。
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  LANDSCAPE_PRINTABLE_PX,
  PORTRAIT_PRINTABLE_PX,
  blockContentWidth,
  markPrintBlocks,
  printFitScale,
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

describe("打印标记 · 三层边界", () => {
  it("阈值常量来历固定：658 / 987（改这两个数必须同步改注释里的推导线）", () => {
    expect([PORTRAIT_PRINTABLE_PX, LANDSCAPE_PRINTABLE_PX]).toEqual([658, 987]);
  });

  it("blockContentWidth 只量表自身的宽（撑满容器的表不再被误判成宽表）", () => {
    // jsdom 无真实布局（getBoundingClientRect().width 恒 0）⇒ 走 table.scrollWidth 回退；
    // 关键是**不再把容器宽度算进来**：旧口径 max(表, 容器) 会把每张小表都读成 734px。
    const narrowInWideWrap = wrapWithTable(800);
    Object.defineProperty(narrowInWideWrap, "scrollWidth", { value: 1665, configurable: true });
    expect(blockContentWidth(narrowInWideWrap)).toBe(800);
    const wide = wrapWithTable(1870);
    expect(blockContentWidth(wide)).toBe(1870);
    const noTable = document.createElement("div");
    Object.defineProperty(noTable, "scrollWidth", { value: 1234, configurable: true });
    expect(blockContentWidth(noTable)).toBe(1234);
  });

  it("658 及以下：竖版自然宽 —— 两个类都不打", () => {
    const root = document.createElement("div");
    const exact = wrapWithTable(PORTRAIT_PRINTABLE_PX);
    root.append(exact);
    expect(markPrintBlocks(root)).toEqual({ landscape: 0, squeeze: 0, tall: 0 });
    expect(exact.classList.contains("wide-page")).toBe(false);
    expect(exact.classList.contains("squeeze-page")).toBe(false);
  });

  it("659 ~ 987：只横排、不压列（列宽不受影响）", () => {
    const root = document.createElement("div");
    const low = wrapWithTable(PORTRAIT_PRINTABLE_PX + 1);
    const high = wrapWithTable(LANDSCAPE_PRINTABLE_PX);
    root.append(low, high);
    expect(markPrintBlocks(root)).toEqual({ landscape: 2, squeeze: 0, tall: 0 });
    for (const box of [low, high]) {
      expect(box.classList.contains("wide-page")).toBe(true);
      expect(box.classList.contains("squeeze-page")).toBe(false);
    }
  });

  it("988 及以上：横排 + 压列两个类都打（超宽表）", () => {
    const root = document.createElement("div");
    const over = wrapWithTable(LANDSCAPE_PRINTABLE_PX + 1);
    const huge = wrapWithTable(1870);
    root.append(over, huge);
    expect(markPrintBlocks(root)).toEqual({ landscape: 2, squeeze: 2, tall: 0 });
    for (const box of [over, huge]) {
      expect(box.classList.contains("wide-page")).toBe(true);
      expect(box.classList.contains("squeeze-page")).toBe(true);
    }
  });

  it("幂等且能清掉旧标记（重复调用 / 变窄后不残留）", () => {
    const root = document.createElement("div");
    const box = wrapWithTable(1870);
    root.append(box);
    expect(markPrintBlocks(root)).toEqual({ landscape: 1, squeeze: 1, tall: 0 });
    expect(markPrintBlocks(root)).toEqual({ landscape: 1, squeeze: 1, tall: 0 });
    expect(root.querySelectorAll(".squeeze-page").length).toBe(1);
    Object.defineProperty(box.querySelector("table") as HTMLElement, "scrollWidth", {
      value: 600,
      configurable: true,
    });
    Object.defineProperty(box, "scrollWidth", { value: 0, configurable: true });
    expect(markPrintBlocks(root)).toEqual({ landscape: 0, squeeze: 0, tall: 0 });
    expect(box.className).toBe("table-wrap");
  });

  it("混合文档：常规表 / 中等宽表 / 超宽表 各归其位", () => {
    const root = document.createElement("div");
    const normal = wrapWithTable(600);
    const medium = wrapWithTable(734);
    const huge = wrapWithTable(1870);
    root.append(normal, medium, huge);
    expect(markPrintBlocks(root)).toEqual({ landscape: 2, squeeze: 1, tall: 0 });
    expect(normal.className).toBe("table-wrap");
    expect(medium.classList.contains("squeeze-page")).toBe(false);
    expect(huge.classList.contains("squeeze-page")).toBe(true);
  });
});

describe("提醒已撤除（无真实触发条件）", () => {
  it("print-ready.ts 不再导出 overflowWarning / tooWideBlocks（留着就会撒谎）", () => {
    const src = readFileSync("src/render/print-ready.ts", "utf8");
    expect(src).not.toMatch(/export function overflowWarning/);
    expect(src).not.toMatch(/export function tooWideBlocks/);
  });

  it("main.ts 不再调用提醒，只打标记", () => {
    const src = readFileSync("src/main.ts", "utf8");
    expect(src).not.toMatch(/overflowWarning|tooWideBlocks|overflowingBlocks/);
    expect(src).toMatch(/markPrintBlocks\(doc\)/);
  });
});

describe("print.css 打印契约锚（命名页 + 压列 + 红线同层）", () => {
  const css = readFileSync("src/typography/print.css", "utf8");

  it("有 @page wide（A4 landscape）与 .mdc .wide-page{page:wide}", () => {
    expect(css).toMatch(/@page wide\s*\{[^}]*size:\s*A4 landscape/);
    expect(css).toMatch(/\.mdc \.wide-page\s*\{[^}]*page:\s*wide/);
  });

  it("UX-9：超页高单体走 .print-tall + zoom: var(--print-fit)（markPrintBlocks 内联比例）", () => {
    expect(css).toMatch(/\.print-tall\s*\{[^}]*zoom:\s*var\(--print-fit/);
  });

  it("压列用**物理宽**（禁止回退成百分比）+ fixed + 单元格换行；无缩放/transform", () => {
    expect(css).toMatch(/\.mdc \.squeeze-page table\s*\{[^}]*table-layout:\s*fixed/);
    // 用户裁决 C（2026-09-23）：横版命名页的排版内容盒仍是竖版 174mm ⇒ 写 % 拿不到 261mm（归因轮实测）
    expect(css).toMatch(/\.mdc \.squeeze-page table\s*\{[^}]*inline-size:\s*calc\(261mm - 2mm\)/);
    expect(css).not.toMatch(/\.mdc \.squeeze-page table\s*\{[^}]*inline-size:\s*100%\s*;/);
    expect(css).toMatch(/\.mdc \.squeeze-page th,\s*\.mdc \.squeeze-page td\s*\{[^}]*overflow-wrap:\s*anywhere/);
    expect(css).toMatch(/\.mdc \.squeeze-page th,\s*\.mdc \.squeeze-page td\s*\{[^}]*white-space:\s*normal/);
    expect(css).not.toMatch(/transform:\s*scale/);
  });

  it("红线仍在：行级分页 + 表头重复 + 默认 @page A4/18mm", () => {
    expect(css).toMatch(/tr\s*\{[^}]*break-inside:\s*avoid/);
    expect(css).toMatch(/thead\s*\{[^}]*display:\s*table-header-group/);
    expect(css).toMatch(/@page\s*\{[^}]*size:\s*A4;[^}]*margin:\s*18mm/);
  });
});

/* UX-9（des-5·P2-15）：超页高单体（大 mermaid / 长图）——break-inside:avoid 管不了
 * 超过一页高的单体，Chromium 会硬裁；markPrintBlocks 量块高、按比例内联 --print-fit。
 * 测量/比例逻辑是纯函数与可桩路径；**最终 PDF 效果需人工验证**（jsdom 无打印排版）。 */
describe("UX-9 · 超页高单体缩放", () => {
  it("printFitScale：不超高 → null；超高 → 可印高/块高；极超高 clamp 到下限 0.4", () => {
    expect(printFitScale(986, 986)).toBe(null); // 恰好等于可印高：不需要缩
    expect(printFitScale(500, 986)).toBe(null);
    expect(printFitScale(1972, 986)).toBeCloseTo(0.5);
    expect(printFitScale(9860, 986)).toBe(0.4); // 名义 0.1 → clamp 下限（再小不可读）
  });

  it("markPrintBlocks 给超高单体打 .print-tall + 内联 --print-fit；不超高的不打", () => {
    const root = document.createElement("div");
    const box = document.createElement("div");
    box.className = "mermaid";
    const svg = document.createElement("svg");
    Object.defineProperty(svg, "getBoundingClientRect", {
      value: () => ({ height: 1972 }),
      configurable: true,
    });
    box.appendChild(svg);
    const img = document.createElement("img");
    Object.defineProperty(img, "getBoundingClientRect", {
      value: () => ({ height: 300 }),
      configurable: true,
    });
    root.append(box, img);
    expect(markPrintBlocks(root)).toEqual({ landscape: 0, squeeze: 0, tall: 1 });
    expect(svg.classList.contains("print-tall")).toBe(true);
    expect(svg.style.getPropertyValue("--print-fit")).toBe("0.5");
    expect(img.classList.contains("print-tall")).toBe(false);
    expect(img.style.getPropertyValue("--print-fit")).toBe("");
  });

  it("幂等：单体变矮后重算，标记与内联变量一并清掉", () => {
    const root = document.createElement("div");
    const img = document.createElement("img");
    Object.defineProperty(img, "getBoundingClientRect", {
      value: () => ({ height: 2000 }),
      configurable: true,
    });
    root.append(img);
    markPrintBlocks(root);
    expect(img.classList.contains("print-tall")).toBe(true);
    Object.defineProperty(img, "getBoundingClientRect", {
      value: () => ({ height: 200 }),
      configurable: true,
    });
    expect(markPrintBlocks(root)).toEqual({ landscape: 0, squeeze: 0, tall: 0 });
    expect(img.classList.contains("print-tall")).toBe(false);
    expect(img.style.getPropertyValue("--print-fit")).toBe("");
  });
});
