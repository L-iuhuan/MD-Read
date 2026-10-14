/**
 * 语料审查 · GFM 矩阵（语料：tests/corpus/gfm-矩阵.md）。
 * 断言 = 设计值（markdown-it 14 + GFM 表格/任务/删除线/自动链接口径）。
 * 注：表格内 code span 的 `|` 按 GFM 规则仍需 `\|` 转义（语料已按设计写）。
 */
import { describe, expect, it } from "vitest";
import { renderDocument } from "../src/render/pipeline";
import corpusSrc from "./corpus/gfm-矩阵.md?raw";

const src = corpusSrc.replace(/\r\n/g, "\n");
const doc = new DOMParser().parseFromString(renderDocument(src).html, "text/html");
const q = (sel: string): Element[] => [...doc.querySelectorAll(sel)];
const text = (): string => doc.body.textContent ?? "";

describe("GFM 表格", () => {
  it("10 表全部落 .table-wrap；表头 10、表体 9（仅表头表无 tbody）", () => {
    expect(q("table").length).toBe(10);
    expect(q(".table-wrap").length).toBe(10);
    expect(q("thead").length).toBe(10);
    expect(q("tbody").length).toBe(9);
    expect(q("table").every((t) => t.parentElement?.classList.contains("table-wrap"))).toBe(true);
  });

  it("对齐三式 → 单元格 style=text-align:left/center/right", () => {
    const aligned = q("th,td").filter((c) => c.hasAttribute("style"));
    expect(aligned.length).toBe(9);
    expect(aligned.filter((c) => c.getAttribute("style") === "text-align:left").length).toBe(3);
    expect(aligned.filter((c) => c.getAttribute("style") === "text-align:center").length).toBe(3);
    expect(aligned.filter((c) => c.getAttribute("style") === "text-align:right").length).toBe(3);
  });

  it("管道转义：`\\|` 在表头/单元格/行内码内均出字面单竖线", () => {
    expect(q("th").some((th) => th.textContent === "名称 | 别名")).toBe(true);
    expect(q("td").some((td) => td.textContent === "含 | 竖线")).toBe(true);
    const codes = q("code").map((c) => c.textContent);
    expect(codes).toContain("a|b");
  });

  it("空表头与单元格数量不等：缺格补空 td，多余格截断", () => {
    const emptyHeaderTable = q("table").find((t) => t.querySelectorAll("th").length === 2
      && [...t.querySelectorAll("th")].every((th) => th.textContent === ""));
    expect(emptyHeaderTable).toBeTruthy();
    const rows = q("tr").filter((r) => r.querySelectorAll("td").length === 3);
    expect(rows.length).toBeGreaterThanOrEqual(1); // 1 格行被补齐到 3 列
  });

  it("仅表头表：有 thead 无 tbody", () => {
    const headerOnly = q("table").filter((t) => t.querySelector("thead") !== null && t.querySelector("tbody") === null);
    expect(headerOnly.length).toBe(1);
  });

  it("段落紧邻表格：markdown-it 让表格打断段落（p + table-wrap 相邻）", () => {
    const p = q("p").find((el) => el.textContent === "段落一行");
    expect(p).toBeTruthy();
    expect(p?.nextElementSibling?.classList.contains("table-wrap")).toBe(true);
  });

  it("引用内 / 列表内表格仍生成 .table-wrap", () => {
    expect(q("blockquote .table-wrap").length).toBe(1);
    expect(q("li .table-wrap").length).toBe(1);
  });
});

describe("GFM 任务列表 / 删除线 / 自动链接", () => {
  it("任务列表：6 checkbox，3 勾选；无序/有序两个 task-list-container", () => {
    expect(q("input[type=checkbox]").length).toBe(6);
    expect(q("input[type=checkbox][checked]").length).toBe(3);
    expect(q(".task-list-container").length).toBe(2);
    expect(q(".task-list-item").length).toBe(6);
  });

  it("删除线：~~ 成 s；单波浪与空格式保持字面", () => {
    expect(q("s").length).toBe(4);
    expect(text()).toContain("~单波浪不是删除~");
    expect(text()).toContain("~~ 两侧空格 ~~");
  });

  it("自动链接：https/www/尖括号/邮箱/file 全部成链；裸 example.com 与 笔记.md 不成链", () => {
    const links = q("a");
    expect(links.length).toBe(9);
    const hrefs = links.map((a) => a.getAttribute("href"));
    expect(hrefs).toContain("http://www.example.com");
    expect(hrefs).toContain("mailto:me@example.com");
    expect(hrefs).toContain("file:///C:/tmp/a.md"); // validateLink 放行 file:///
    expect(hrefs).toContain("https://gfm.example.com/end"); // 尾随句点不进 href
    expect(links.some((a) => a.textContent === "example.com")).toBe(false);
    expect(links.some((a) => a.textContent === "笔记.md")).toBe(false);
    expect(text()).toContain("笔记.md");
  });
});