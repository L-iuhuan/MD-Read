/**
 * P1-4(b)：导出前"可能被截"的检测与中文提醒（单测锚）。
 *
 * 判定口径：**可横向滚动的块**（`scrollWidth > clientWidth`）—— 它们正是"打印时按当前
 * 滚动位置出图、滚动外内容不可达"的那一类（真机 a4-wide 语料实锤：长代码行尾部丢失 +
 * 残留横向滚动条）。不直接拿"是否超过 A4 可印宽 658px"比，因为导出时是屏显版式。
 */
import { describe, expect, it } from "vitest";
import { overflowingBlocks, overflowWarning } from "../src/render/print-ready";

/** 造一个"可横向滚动"的块（jsdom 的 scrollWidth/clientWidth 恒 0，必须显式定义） */
function scroller(tag: string, className: string, scrollWidth: number, clientWidth: number): HTMLElement {
  const el = document.createElement(tag);
  el.className = className;
  Object.defineProperty(el, "scrollWidth", { value: scrollWidth, configurable: true });
  Object.defineProperty(el, "clientWidth", { value: clientWidth, configurable: true });
  return el;
}

describe("P1-4(b) · 导出前检测「可能被截」的块", () => {
  it("宽表格（.table-wrap 可横滚）与长代码行（pre 可横滚）分别标为「宽表格」「长代码行」", () => {
    const root = document.createElement("div");
    root.append(
      scroller("div", "table-wrap", 900, 700),
      scroller("pre", "", 1200, 700),
      scroller("div", "table-wrap", 700, 700), // 不滚 → 不计
    );
    expect(overflowingBlocks(root)).toEqual(["宽表格", "长代码行"]);
  });

  it("边界：只多 1px 不算（+1 容差），多 2px 才算", () => {
    const root = document.createElement("div");
    root.append(scroller("pre", "", 701, 700), scroller("pre", "", 702, 700));
    expect(overflowingBlocks(root)).toEqual(["长代码行"]);
  });

  it("正常文档（都装得下）→ 空列表，且 overflowWarning 返回 null（不打扰用户）", () => {
    const root = document.createElement("div");
    root.append(scroller("div", "table-wrap", 600, 700), scroller("pre", "", 500, 700));
    expect(overflowingBlocks(root)).toEqual([]);
    expect(overflowWarning([])).toBeNull();
  });

  it("提醒文案：中文、含处数与类别、不含技术黑话", () => {
    const note = overflowWarning(["宽表格", "宽表格", "长代码行"]);
    expect(note).toBe("本文档有 3 处内容超出 A4 可印宽（宽表格 / 长代码行），PDF 中可能被截断");
    expect(note).not.toMatch(/scrollWidth|overflow|scrollLeft|px/);
  });

  it("单类风险只报该类", () => {
    expect(overflowWarning(["宽表格"])).toBe("本文档有 1 处内容超出 A4 可印宽（宽表格），PDF 中可能被截断");
  });
});
