/**
 * T4 分栏切片器单元断言（四档宽表导出策略，2026-10-15 主人批准）。
 *
 * - groupColumns 纯函数：贪心分组 / 标识列占宽计入预算 / 单列超预算仍独立成段（保证推进）；
 * - sliceTableWrap DOM 断言：colspan/rowspan 拆平（内容复制到占位格 + data-slice-flatten）、
 *   每段完整 thead、第 2 段起标识列重复（data-slice-repeat）、段前小标题、
 *   自幂等（重跑不叠加）与 restoreSlicedTables 还原（原表跨格属性原样保留）。
 * 覆盖声明：jsdom 无布局 ⇒ measureColumnWidths 走等宽回退（每列 = 自然宽/列数，确定性），
 * 真机逐列量宽与 PDF 视觉效果归主线程复验；GFM 渲染产物表达不了跨格 ⇒ 跨格用例为
 * DOM 手工造表（切片器输入契约就是 DOM 表，与来源无关）。
 */
import { describe, expect, it } from "vitest";
import {
  SLICE_SEGMENT_BUDGET_PX,
  groupColumns,
  restoreSlicedTables,
  sliceTableWrap,
} from "../src/render/table-slice";

/** 手工造含 colspan/rowspan 的表（GFM 产不出跨格；切片器输入契约是 DOM 表）。
 *  网格（3 列 3 行）：head[合并A(colspan2), B]；body r1[锚(rowspan2), x, y]；r2[锚复制, z, w] */
function spannedWrap(): HTMLElement {
  const wrap = document.createElement("div");
  wrap.className = "table-wrap";
  const table = document.createElement("table");
  const thead = document.createElement("thead");
  const htr = document.createElement("tr");
  const thA = document.createElement("th");
  thA.textContent = "合并A";
  thA.colSpan = 2;
  const thB = document.createElement("th");
  thB.textContent = "B";
  htr.append(thA, thB);
  thead.appendChild(htr);
  const tbody = document.createElement("tbody");
  const r1 = document.createElement("tr");
  const tdA = document.createElement("td");
  tdA.textContent = "锚";
  tdA.rowSpan = 2;
  const tdX = document.createElement("td");
  tdX.textContent = "x";
  const tdY = document.createElement("td");
  tdY.textContent = "y";
  r1.append(tdA, tdX, tdY);
  const r2 = document.createElement("tr");
  const tdZ = document.createElement("td");
  tdZ.textContent = "z";
  const tdW = document.createElement("td");
  tdW.textContent = "w";
  r2.append(tdZ, tdW);
  tbody.append(r1, r2);
  table.append(thead, tbody);
  wrap.appendChild(table);
  return wrap;
}

describe("groupColumns 纯函数（贪心列分组）", () => {
  it("装得下就一段；超预算贪心切段；第 2 段起标识列占宽计入预算", () => {
    expect(groupColumns([100, 300, 400], 950, 100)).toEqual([[0, 1, 2]]);
    expect(groupColumns([100, 400, 400, 400], 950, 100)).toEqual([
      [0, 1, 2],
      [3],
    ]);
    // 重复列 200 + 单列 780 已 980 > 950 ⇒ 每列独立成段（推进性优先于装得下）
    expect(groupColumns([200, 780, 780], 950, 200)).toEqual([[0], [1], [2]]);
  });

  it("单列自身超预算也独立成段（不吞列、保证每段至少一列）", () => {
    expect(groupColumns([100, 2000], 950, 100)).toEqual([[0], [1]]);
  });

  it("段目标预算常量 = 950（261mm≈987px 留余，与 print.css calc(261mm-2mm) 同源）", () => {
    expect(SLICE_SEGMENT_BUDGET_PX).toBe(950);
  });
});

describe("sliceTableWrap DOM 变换（跨格拆平 / thead 克隆 / 标识列重复 / 段标题）", () => {
  it("3 列等宽（自然宽 1900 ⇒ 每列 ~633）切 3 段：stack hidden、原表保留、段数与小标题齐备", () => {
    const wrap = spannedWrap();
    expect(sliceTableWrap(wrap, 1900)).toBe(3);
    expect(wrap.classList.contains("table-sliced")).toBe(true);
    const stack = wrap.querySelector(".slice-stack") as HTMLElement;
    expect(stack.hidden).toBe(true);
    expect(stack.querySelectorAll("table.slice-seg").length).toBe(3);
    expect([...stack.querySelectorAll(".slice-caption")].map((c) => c.textContent)).toEqual([
      "续表 2/3",
      "续表 3/3",
    ]);
    // 原表未被摘除、跨格属性原样（屏显零影响）
    const original = wrap.querySelector("table:not(.slice-seg)") as HTMLTableElement;
    expect(original.querySelector("th")!.colSpan).toBe(2);
    expect(original.querySelectorAll("td")[0]!.rowSpan).toBe(2);
  });

  it("跨格拆平：colspan/rowspan 占位格拿到内容复制件并标 data-slice-flatten", () => {
    const wrap = spannedWrap();
    sliceTableWrap(wrap, 1900);
    const segs = [...wrap.querySelectorAll("table.slice-seg")];
    // 第 1 段（列 0）：thead=[合并A]；tbody r2 首格 = 「锚」的 rowspan 复制（flatten）
    expect(segs[0]!.querySelectorAll("thead th").length).toBe(1);
    const bodyRows1 = [...segs[0]!.querySelectorAll("tbody tr")];
    expect(bodyRows1[0]!.querySelector("td")!.textContent).toBe("锚");
    expect(bodyRows1[0]!.querySelector("td")!.hasAttribute("data-slice-flatten")).toBe(false);
    expect(bodyRows1[1]!.querySelector("td")!.textContent).toBe("锚");
    expect(bodyRows1[1]!.querySelector("td")!.hasAttribute("data-slice-flatten")).toBe(true);
    // 第 2 段（列 1 前置标识列 0）：thead=[合并A(重复), 合并A(拆平复制)]
    const head2 = [...segs[1]!.querySelectorAll("thead th")];
    expect(head2.map((c) => c.textContent)).toEqual(["合并A", "合并A"]);
    expect(head2[0]!.hasAttribute("data-slice-repeat")).toBe(true);
    expect(head2[1]!.hasAttribute("data-slice-flatten")).toBe(true);
    // 第 2 段 tbody r2 首格：rowspan 复制 + 标识列重复 ⇒ 双标记
    const bodyRows2 = [...segs[1]!.querySelectorAll("tbody tr")];
    const r2First = bodyRows2[1]!.querySelector("td")!;
    expect(r2First.textContent).toBe("锚");
    expect(r2First.hasAttribute("data-slice-flatten")).toBe(true);
    expect(r2First.hasAttribute("data-slice-repeat")).toBe(true);
  });

  it("第 3 段（末段）：thead=[合并A(重复), B]；tbody r1 标识列重复", () => {
    const wrap = spannedWrap();
    sliceTableWrap(wrap, 1900);
    const seg3 = [...wrap.querySelectorAll("table.slice-seg")][2]!;
    const head3 = [...seg3.querySelectorAll("thead th")];
    expect(head3.map((c) => c.textContent)).toEqual(["合并A", "B"]);
    expect(head3[0]!.hasAttribute("data-slice-repeat")).toBe(true);
    expect(head3[1]!.hasAttribute("data-slice-repeat")).toBe(false);
    const row1 = [...seg3.querySelectorAll("tbody tr")][0]!;
    expect([...row1.querySelectorAll("td")].map((c) => c.textContent)).toEqual(["锚", "y"]);
    expect(row1.querySelector("td")!.hasAttribute("data-slice-repeat")).toBe(true);
  });

  it("自幂等：同 wrap 重切不叠加（入口先清旧产物）；restoreSlicedTables 还原原表跨格", () => {
    const wrap = spannedWrap();
    expect(sliceTableWrap(wrap, 1900)).toBe(3);
    expect(sliceTableWrap(wrap, 1900)).toBe(3);
    expect(wrap.querySelectorAll(".slice-stack").length).toBe(1);
    expect(wrap.querySelectorAll("table.slice-seg").length).toBe(3);
    restoreSlicedTables(wrap);
    expect(wrap.querySelector(".slice-stack")).toBeNull();
    expect(wrap.classList.contains("table-sliced")).toBe(false);
    const original = wrap.querySelector("table") as HTMLTableElement;
    expect(original.querySelector("th")!.colSpan).toBe(2); // 跨格原样保留
    expect(original.querySelectorAll("td")[0]!.rowSpan).toBe(2);
  });

  it("列数 <2 或一段装得下时拒绝切片（退回 T3 压列形态）", () => {
    const wrap = spannedWrap();
    // 自然宽 1000（每列 ~333）：3 列 + 无重复 → 999 ≈ 1000 仍超预算吗？用 900 保证单段
    expect(sliceTableWrap(wrap, 900)).toBe(0);
    expect(wrap.querySelector(".slice-stack")).toBeNull();
    expect(wrap.classList.contains("table-sliced")).toBe(false);
  });
});
