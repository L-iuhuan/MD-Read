/**
 * 隔离表格评测集的配套断言（fix-31 任务二，2026-10-15）。
 *
 * 语料：tests/corpus/隔离表格评测集.md（T1–T9，九张表，覆盖普通表/对齐三式/无表体表/
 * 单元格特殊内容/列表后表/围栏邻接/宽表/超宽表/公式共存）。本 spec 三层：
 *   ① 渲染层 golden —— 逐表列数/表头/单元格文本比对（DOMParser 解析 renderDocument 产物）；
 *   ② 打印分类 —— markPrintBlocks 对渲染产物**桩宽**分类（jsdom 无真实布局，
 *      getBoundingClientRect/scrollWidth 恒 0，与 tests/print-overflow.spec.ts 同一口径：
 *      每表 defineProperty scrollWidth 为该档代表值，断言 wide-page/squeeze-page 落位）；
 *   ③ print.css 契约锚 —— 行级分页/表头跨页/命名页横排/压列物理宽/滚动容器还原。
 * 覆盖声明：①②为 jsdom 实测；**PDF 视觉层（横排真的横、压列真的换行）jsdom 不可验**，
 * 待真机导出复验（归主线程）。
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { renderDocument } from "../src/render/pipeline";
import { markPrintBlocks } from "../src/render/print-ready";

const corpus = readFileSync("tests/corpus/隔离表格评测集.md", "utf8").replace(/\r\n/g, "\n");
const doc = new DOMParser().parseFromString(renderDocument(corpus).html, "text/html");
const tables = [...doc.querySelectorAll("table")];
const wraps = [...doc.querySelectorAll(".table-wrap")];

/** 压平空白后比对（pangu 的 cjk-gap 空串 span 不影响 textContent，KaTeX 双层文本会带换行） */
function cellsOf(t: Element): string[] {
  return [...t.querySelectorAll("tbody tr")].map(
    (tr) => [...tr.querySelectorAll("td")].map((td) => (td.textContent ?? "").trim()).join("¦"),
  );
}
function headOf(t: Element): string[] {
  return [...t.querySelectorAll("thead th")].map((th) => (th.textContent ?? "").trim());
}

describe("① 渲染层 golden：九张表逐格比对", () => {
  it("表数与包裹层：9 张 table、9 个 .table-wrap、每表都在 wrap 内", () => {
    expect(tables.length).toBe(9);
    expect(wraps.length).toBe(9);
    for (const t of tables) expect(t.closest(".table-wrap")).toBeTruthy();
  });

  it("T1 普通 3 列表：表头与 3 行逐格一致", () => {
    expect(headOf(tables[0]!)).toEqual(["名称", "数量", "备注"]);
    expect(cellsOf(tables[0]!)).toEqual([
      "苹果¦3¦今日入库",
      "香蕉¦5¦昨日入库",
      "樱桃¦12¦库存紧张",
    ]);
  });

  it("T2 对齐三式：th/td 都带 left/center/right 行内样式", () => {
    const t = tables[1]!;
    expect(headOf(t)).toEqual(["左对齐列", "居中对齐列", "右对齐列"]);
    expect([...t.querySelectorAll("thead th")].map((th) => th.getAttribute("style")))
      .toEqual(["text-align:left", "text-align:center", "text-align:right"]);
    // 每行的 td 都继承对应列的对齐式（两行同式，取每行首列 + 全表清点）
    for (const tr of [...t.querySelectorAll("tbody tr")]) {
      expect([...tr.querySelectorAll("td")].map((td) => td.getAttribute("style")))
        .toEqual(["text-align:left", "text-align:center", "text-align:right"]);
    }
    expect(cellsOf(t)).toEqual(["甲¦乙¦123.45", "丙丁¦戊己¦67.89"]);
  });

  it("T3 无表体表：只有表头，不产生空 tbody", () => {
    const t = tables[2]!;
    expect(headOf(t)).toEqual(["只有表头甲", "只有表头乙", "只有表头丙"]);
    expect(t.querySelector("tbody")).toBeNull();
    expect(t.querySelectorAll("tr").length).toBe(1); // 仅表头行
  });

  it("T4 单元格特殊内容五连：转义管道/行内码/行内公式/链接/金额", () => {
    const t = tables[3]!;
    expect(headOf(t).length).toBe(5);
    const firstRow = [...t.querySelectorAll("tbody tr")[0]!.querySelectorAll("td")];
    // 管道转义：\| 是单元格里的字面管道，不得劈列
    expect(firstRow[0]!.textContent!.trim()).toBe("a|b");
    // 行内码：code 元素在场、文本原样
    expect(firstRow[1]!.querySelector("code")?.textContent).toBe("cell_code_42");
    // 行内公式：单元格内出 KaTeX，annotation 保留源式
    expect(firstRow[2]!.querySelector(".katex")).toBeTruthy();
    expect(firstRow[2]!.querySelector("annotation")?.textContent).toContain("E=mc^2");
    // 中文路径链接：空格已 %20、中文已百分号编码（encodeLinkDestSpaces + normalizeLink）
    const local = firstRow[3]!.querySelector("a");
    expect(local?.getAttribute("href")).toBe("%E5%AD%90%20%E6%96%87%E6%A1%A3.md");
    expect(local?.textContent!.trim()).toBe("子 文档");
    // 金额红线：单美元串是纯文本，绝不进 KaTeX
    expect(firstRow[4]!.textContent!.trim()).toBe("$1,000 与 $2,000");
    expect(firstRow[4]!.querySelector(".katex")).toBeNull();
    const secondRow = [...t.querySelectorAll("tbody tr")[1]!.querySelectorAll("td")];
    expect(secondRow[1]!.querySelector("code")?.textContent).toBe("cell_code_43");
    expect(secondRow[2]!.querySelector("annotation")?.textContent).toContain("a+b");
    expect(secondRow[3]!.querySelector("a")?.getAttribute("href")).toBe("https://example.com/%E8%A1%A8%E6%A0%BC");
    expect(secondRow[4]!.textContent!.trim()).toBe("¥12,345.67");
  });

  it("T5 嵌套列表后紧跟表格：表在列表**外**（不被吞进 li）", () => {
    const t = tables[4]!;
    expect(t.closest("li")).toBeNull();
    expect(headOf(t)).toEqual(["列表后表A", "列表后表B"]);
    expect(cellsOf(t)).toEqual(["值甲¦值乙"]);
    // 语料里的嵌套列表本身也完好
    expect(doc.querySelectorAll("ul ul li").length).toBe(2);
  });

  it("T6 表格紧跟围栏：围栏→表→围栏三块相邻、内容都不损", () => {
    const t = tables[5]!;
    expect(headOf(t)).toEqual(["围栏后表A", "围栏后表B"]);
    expect(cellsOf(t)).toEqual(["值丙¦值丁"]);
    const pres = [...doc.querySelectorAll("pre")].map((p) => p.textContent ?? "");
    expect(pres.some((p) => p.includes("fenceBeforeTable"))).toBe(true);
    expect(pres.some((p) => p.includes("fenceAfterTable"))).toBe(true);
  });

  it("T7 宽表：7 列 × 2 行逐格一致（表头是长 token）", () => {
    expect(headOf(tables[6]!)).toEqual([
      "request_id_0921a", "session_key_b2", "shard_part_c3", "region_ep_d4",
      "tenant_tag_e5", "stage_lbl_f6", "policy_g7",
    ]);
    expect(cellsOf(tables[6]!)).toEqual([
      "req_20260921_001¦sess_a1b2c3d4¦shard_04¦cn-east-7¦tnt_alpha_01¦stage_build¦rp_default_1",
      "req_20260921_002¦sess_e5f6g7h8¦shard_09¦cn-north-3¦tnt_beta_02¦stage_test¦rp_retry_2x",
    ]);
  });

  it("T8 超宽表：13 列 × 2 行逐格一致；单元格里的 URL 成链但文本不丢", () => {
    const t = tables[7]!;
    expect(headOf(t).length).toBe(13);
    expect(cellsOf(t).length).toBe(2);
    expect(t.querySelectorAll("tbody td").length).toBe(26);
    const urlCell = [...t.querySelectorAll("tbody td")].find((td) => (td.textContent ?? "").includes("api.example.cn"));
    expect(urlCell?.querySelector("a")?.getAttribute("href")).toBe("https://api.example.cn/v1");
    expect(urlCell?.textContent!.trim()).toBe("https://api.example.cn/v1");
  });

  it("T9 公式块与表格共存：display 公式在场、单元格行内公式成 KaTeX（mathprotect 收发不吞表）", () => {
    expect(doc.querySelectorAll(".katex-display").length).toBe(1);
    expect([...doc.querySelectorAll(".katex-display annotation")].map((a) => a.textContent ?? "").join(""))
      .toContain("E = mc^2");
    const t = tables[8]!;
    expect(headOf(t)).toEqual(["公式旁表A", "公式旁表B"]);
    const mathCell = t.querySelector("tbody td");
    expect(mathCell?.querySelector(".katex")).toBeTruthy();
    expect(mathCell?.querySelector("annotation")?.textContent).toContain("a \\times b");
    expect(t.querySelectorAll("tbody td")[1]!.textContent!.trim()).toBe("常规文本丙");
  });
});

describe("② markPrintBlocks 分类（jsdom 桩宽；真实阈值落点见语料头注）", () => {
  /** 按档位给每张渲染产物桩 scrollWidth（同 print-overflow.spec.ts 口径），再整档分类 */
  function classifiedDoc(): Document {
    const d = new DOMParser().parseFromString(renderDocument(corpus).html, "text/html");
    //                    T1  T2  T3  T4  T5  T6   T7   T8   T9
    const widths = [600, 600, 600, 600, 600, 600, 800, 1870, 600];
    d.querySelectorAll("table").forEach((t, i) => {
      Object.defineProperty(t, "scrollWidth", { value: widths[i], configurable: true });
    });
    return d;
  }

  it("九张表分三档：竖版 7 张、横排 2 张（T7/T8）、压列 1 张（T8）", () => {
    const d = classifiedDoc();
    expect(markPrintBlocks(d)).toEqual({ landscape: 2, squeeze: 1, tall: 0 });
    const ws = [...d.querySelectorAll(".table-wrap")];
    for (const i of [0, 1, 2, 3, 4, 5, 8]) {
      expect(ws[i]!.classList.contains("wide-page"), `#${i} 不应横排`).toBe(false);
      expect(ws[i]!.classList.contains("squeeze-page"), `#${i} 不应压列`).toBe(false);
    }
    expect(ws[6]!.classList.contains("wide-page")).toBe(true); // T7：658 < 800 ≤ 987
    expect(ws[6]!.classList.contains("squeeze-page")).toBe(false);
    expect(ws[7]!.classList.contains("wide-page")).toBe(true); // T8：1870 > 987 两类叠加
    expect(ws[7]!.classList.contains("squeeze-page")).toBe(true);
  });
});

describe("③ print.css 打印链路契约锚（表格专线）", () => {
  const css = readFileSync("src/typography/print.css", "utf8");

  it("行级分页：tr 不腰斩、thead 跨页重复", () => {
    expect(css).toMatch(/tr\s*\{[^}]*break-inside:\s*avoid/);
    expect(css).toMatch(/thead\s*\{[^}]*display:\s*table-header-group/);
    // 整表 avoid 是毒规则（长表必须允许跨页）——表格不得出现在块级防腰斩清单里
    expect(css).not.toMatch(/pre,\s*table,\s*figure[^{]*\{[^}]*break-inside/);
  });

  it("宽表横排：@page wide（A4 landscape）+ .wide-page 挂命名页", () => {
    expect(css).toMatch(/@page wide\s*\{[^}]*size:\s*A4 landscape/);
    expect(css).toMatch(/\.mdc \.wide-page\s*\{[^}]*page:\s*wide/);
  });

  it("压列物理宽：fixed + calc(261mm - 2mm)（禁百分比回退）+ 单元格换行", () => {
    expect(css).toMatch(/\.mdc \.squeeze-page table\s*\{[^}]*table-layout:\s*fixed/);
    expect(css).toMatch(/\.mdc \.squeeze-page table\s*\{[^}]*inline-size:\s*calc\(261mm - 2mm\)/);
    expect(css).not.toMatch(/\.mdc \.squeeze-page table\s*\{[^}]*inline-size:\s*100%/);
    expect(css).toMatch(/\.mdc \.squeeze-page th,\s*\.mdc \.squeeze-page td\s*\{[^}]*overflow-wrap:\s*anywhere/);
  });

  it("打印链路还原：.table-wrap 滚动容器回到分页流（overflow visible + 限宽清零）", () => {
    expect(css).toMatch(/\.mdc \.table-wrap\s*\{[^}]*overflow:\s*visible/);
    expect(css).toMatch(/\.mdc \.table-wrap\s*\{[^}]*max-inline-size:\s*none/);
  });
});
