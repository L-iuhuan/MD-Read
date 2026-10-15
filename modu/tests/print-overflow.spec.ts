/**
 * 宽表四档导出（2026-10-15 主人批准，业界调研背书；取代 2026-09-23 三档）。
 *
 * 四层（来历见 src/render/print-ready.ts 顶部注释；测量口径 = 表自身 min-content 宽 w）：
 *   T1 压列    w ≤ 830        竖版页内 fixed+100% 压列（print-wrap；830 ≈ 658×1.26）
 *   T2 缩放出  830 < w ≤ 1030 竖版页 zoom+出血（print-zoom+print-bleed；
 *                --print-zoom = clamp(0.75, 771/w, 1)，771 = (174+30)mm@96dpi；
 *                1030 ≈ 771/0.75。禁 transform——打印高度错算；zoom 参与重排已验证）
 *   T3 横排压  1030 < w ≤ 1400 横排页 261mm 压列（squeeze-page；1400 ≈ 987/0.705）
 *   T4 切片    w > 1400       横排页分栏切片（squeeze-page+table-sliced，见 table-slice.ts）
 * 旧 wide-page（658 < w ≤ 987 横排、不压列）无消费者退役：横排职责并入 squeeze-page
 * （`.mdc .squeeze-page { page: wide }`），锚随本批迁移。
 * 提醒：「可能被截」提示 2026-09-23 已撤（无真实触发条件），本批不复活。
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  LANDSCAPE_PRINTABLE_PX,
  PORTRAIT_PRINTABLE_PX,
  PRINT_SLICE_MIN_PX,
  PRINT_WRAP_MAX_PX,
  PRINT_ZOOM_FIT_PX,
  PRINT_ZOOM_MAX_PX,
  PRINT_ZOOM_MIN,
  blockContentWidth,
  markPrintBlocks,
  printFitScale,
  printTier,
  printZoomScale,
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

/** 造一张有真实列的表（切片路径需要列结构；空表会被切片器拒绝） */
function wrapWithRealTable(width: number, columns: number): HTMLElement {
  const wrap = document.createElement("div");
  wrap.className = "table-wrap";
  const table = document.createElement("table");
  const head = Array.from({ length: columns }, (_, i) => `<th>表头${i}</th>`).join("");
  const body = Array.from({ length: columns }, (_, i) => `<td>值${i}</td>`).join("");
  table.innerHTML = `<thead><tr>${head}</tr></thead><tbody><tr>${body}</tr></tbody>`;
  Object.defineProperty(table, "scrollWidth", { value: width, configurable: true });
  wrap.appendChild(table);
  Object.defineProperty(wrap, "scrollWidth", { value: 0, configurable: true });
  return wrap;
}

describe("打印标记 · 四档边界", () => {
  it("阈值常量来历固定：658/987（推导基线）+ 830/1030/1400（四档）+ 771/0.75（T2）", () => {
    expect([PORTRAIT_PRINTABLE_PX, LANDSCAPE_PRINTABLE_PX]).toEqual([658, 987]);
    expect([PRINT_WRAP_MAX_PX, PRINT_ZOOM_MAX_PX, PRINT_SLICE_MIN_PX]).toEqual([830, 1030, 1400]);
    expect([PRINT_ZOOM_FIT_PX, PRINT_ZOOM_MIN]).toEqual([771, 0.75]);
  });

  it("判据纯函数 printTier：600/850/1000/1200/1500/1900 → T1/T2/T2/T3/T4/T4（任务书写死）", () => {
    expect([600, 850, 1000, 1200, 1500, 1900].map(printTier)).toEqual([1, 2, 2, 3, 4, 4]);
  });

  it("档位沿线逐像素：830→T1、831→T2；1030→T2、1031→T3；1400→T3、1401→T4", () => {
    expect(printTier(830)).toBe(1);
    expect(printTier(831)).toBe(2);
    expect(printTier(1030)).toBe(2);
    expect(printTier(1031)).toBe(3);
    expect(printTier(1400)).toBe(3);
    expect(printTier(1401)).toBe(4);
  });

  it("printZoomScale = clamp(0.75, 771/w, 1)：恰满出血宽 1、超宽压到下限、绝不放大", () => {
    expect(printZoomScale(771)).toBe(1);
    expect(printZoomScale(600)).toBe(1); // 已比有效宽窄：不放大
    expect(printZoomScale(830)).toBeCloseTo(771 / 830, 10);
    expect(printZoomScale(1030)).toBe(0.75); // 771/1030 ≈ 0.7485 → clamp 到可读下限
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

  it("markPrintBlocks 落类：600→print-wrap；850/1000→print-zoom+print-bleed＋内联比例；1200+→squeeze-page", () => {
    const root = document.createElement("div");
    const cases = [600, 850, 1000, 1200, 1500, 1900].map((w) => {
      const box = wrapWithTable(w); // 空表：切片器拒绝（列数 <2）⇒ 落类断言不受切片干扰
      root.appendChild(box);
      return { w, box };
    });
    expect(markPrintBlocks(root)).toEqual({ wrap: 1, zoom: 2, squeeze: 3, slice: 0, tall: 0 });
    for (const { w, box } of cases) {
      const zoomExpected = w === 850 || w === 1000;
      expect(box.classList.contains("print-wrap"), `${w} print-wrap`).toBe(w === 600);
      expect(box.classList.contains("print-zoom"), `${w} print-zoom`).toBe(zoomExpected);
      expect(box.classList.contains("print-bleed"), `${w} print-bleed`).toBe(zoomExpected);
      expect(box.classList.contains("squeeze-page"), `${w} squeeze-page`).toBe(w >= 1200);
      expect(box.style.getPropertyValue("--print-zoom"), `${w} --print-zoom`).toBe(
        zoomExpected ? String(printZoomScale(w)) : "",
      );
    }
  });

  it("幂等且能清掉旧标记（重复调用 / 变窄后不残留；T4 切片同步还原）", () => {
    const root = document.createElement("div");
    const box = wrapWithRealTable(1900, 3); // 3 列等宽 ≈ 633/列 ⇒ 3 段
    root.appendChild(box);
    expect(markPrintBlocks(root)).toEqual({ wrap: 0, zoom: 0, squeeze: 1, slice: 1, tall: 0 });
    expect(markPrintBlocks(root)).toEqual({ wrap: 0, zoom: 0, squeeze: 1, slice: 1, tall: 0 }); // 重跑不叠加
    expect(root.querySelectorAll(".slice-stack").length).toBe(1);
    const table = box.querySelector("table") as HTMLTableElement;
    Object.defineProperty(table, "scrollWidth", { value: 600, configurable: true });
    expect(markPrintBlocks(root)).toEqual({ wrap: 1, zoom: 0, squeeze: 0, slice: 0, tall: 0 });
    expect(root.querySelectorAll(".slice-stack").length).toBe(0); // 切片已还原
    expect(box.className).toBe("table-wrap print-wrap");
  });

  it("混合文档：常规表 / 中等宽表 / 超宽空表 各归其位", () => {
    const root = document.createElement("div");
    const normal = wrapWithTable(600);
    const medium = wrapWithTable(1000);
    const huge = wrapWithTable(1900);
    root.append(normal, medium, huge);
    expect(markPrintBlocks(root)).toEqual({ wrap: 1, zoom: 1, squeeze: 1, slice: 0, tall: 0 });
    expect(normal.className).toBe("table-wrap print-wrap");
    expect(medium.classList.contains("print-zoom")).toBe(true);
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

describe("print.css 打印契约锚（四档 + 红线同层）", () => {
  const css = readFileSync("src/typography/print.css", "utf8");

  it("横排命名页仍在：@page wide（A4 landscape）；page:wide 已迁入 .squeeze-page（T3/T4）", () => {
    expect(css).toMatch(/@page wide\s*\{[^}]*size:\s*A4 landscape/);
    expect(css).toMatch(/\.mdc \.squeeze-page\s*\{[^}]*page:\s*wide/);
  });

  it("旧 .wide-page 已退役：print.css 无该选择器、标记器不再产生它", () => {
    expect(css).not.toMatch(/\.mdc \.wide-page\s*\{/);
    const src = readFileSync("src/render/print-ready.ts", "utf8");
    expect(src).not.toMatch(/classList\.toggle\('wide-page'/);
  });

  it("T1 压列：print-wrap 竖版 fixed + 100% + 单元格换行", () => {
    expect(css).toMatch(/\.mdc \.print-wrap table\s*\{[^}]*table-layout:\s*fixed/);
    expect(css).toMatch(/\.mdc \.print-wrap table\s*\{[^}]*inline-size:\s*100%/);
    expect(css).toMatch(/\.mdc \.print-wrap th,\s*\.mdc \.print-wrap td\s*\{[^}]*overflow-wrap:\s*anywhere/);
  });

  it("T2 缩放＋出血：print-bleed 两侧各借 15mm；表格 zoom 走 --print-zoom", () => {
    expect(css).toMatch(/\.mdc \.print-bleed\s*\{[^}]*margin-inline:\s*-15mm/);
    expect(css).toMatch(/\.mdc \.print-zoom table\s*\{[^}]*zoom:\s*var\(--print-zoom/);
  });

  it("UX-9：超页高单体走 .print-tall + zoom: var(--print-fit)（markPrintBlocks 内联比例）", () => {
    expect(css).toMatch(/\.print-tall\s*\{[^}]*zoom:\s*var\(--print-fit/);
  });

  it("T3/T4 压列用**物理宽**（禁止回退成百分比）+ fixed + 单元格换行；无 transform", () => {
    expect(css).toMatch(/\.mdc \.squeeze-page table\s*\{[^}]*table-layout:\s*fixed/);
    // 用户裁决 C（2026-09-23）：横排命名页的排版内容盒仍是竖版 174mm ⇒ 写 % 拿不到 261mm（归因轮实测）
    expect(css).toMatch(/\.mdc \.squeeze-page table\s*\{[^}]*inline-size:\s*calc\(261mm - 2mm\)/);
    expect(css).not.toMatch(/\.mdc \.squeeze-page table\s*\{[^}]*inline-size:\s*100%\s*;/);
    expect(css).toMatch(/\.mdc \.squeeze-page th,\s*\.mdc \.squeeze-page td\s*\{[^}]*overflow-wrap:\s*anywhere/);
    expect(css).toMatch(/\.mdc \.squeeze-page th,\s*\.mdc \.squeeze-page td\s*\{[^}]*white-space:\s*normal/);
    expect(css).not.toMatch(/transform:\s*scale/);
  });

  it("T4 切片段：原表退场、stack 打印显现（!important 加固，真机「一根线」轮）、段标题不孤悬页尾", () => {
    expect(css).toMatch(/\.mdc \.table-sliced > table:not\(\.slice-seg\)\s*\{[^}]*display:\s*none/);
    expect(css).toMatch(/\.mdc \.slice-stack\[hidden\]\s*\{[^}]*display:\s*block\s*!important/);
    expect(css).toMatch(/\.mdc \.slice-caption\s*\{[^}]*break-after:\s*avoid/);
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
    expect(markPrintBlocks(root)).toEqual({ wrap: 0, zoom: 0, squeeze: 0, slice: 0, tall: 1 });
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
    root.appendChild(img);
    markPrintBlocks(root);
    expect(img.classList.contains("print-tall")).toBe(true);
    Object.defineProperty(img, "getBoundingClientRect", {
      value: () => ({ height: 200 }),
      configurable: true,
    });
    expect(markPrintBlocks(root)).toEqual({ wrap: 0, zoom: 0, squeeze: 0, slice: 0, tall: 0 });
    expect(img.classList.contains("print-tall")).toBe(false);
    expect(img.style.getPropertyValue("--print-fit")).toBe("");
  });
});
