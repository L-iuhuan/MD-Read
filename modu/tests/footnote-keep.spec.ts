/**
 * 未引用的脚注定义不再整行消失（2026-10-13 审查 D3 的回归锚）。
 *
 * 修前：markdown-it-footnote 的 `footnote_tail` 把所有 `[^a]: …` 区块的 token 从正文摘走，
 * 只有被引用过的才拼回文末脚注区 ⇒ **没引用的整行丢弃**（用户写的行凭空不见）。
 * 修后：未引用的定义只被拆掉 footnote 标记、内容按作者写的位置渲染成普通块；
 * 被引用的一律不动，照旧进文末脚注区。
 */
import { describe, expect, it } from "vitest";
import { renderDocument } from "../src/render/pipeline";

function dom(src: string): Document {
  return new DOMParser().parseFromString(renderDocument(src).html, "text/html");
}
/** 正文段落：排除文末脚注区里的 <p>（否则脚注体也被算进来） */
function paras(doc: Document): Element[] {
  return [...doc.querySelectorAll("p")].filter((p) => p.closest("section.footnotes") === null);
}

describe("未引用脚注定义：内容留在原位", () => {
  it("空行分隔的未引用定义渲染成段落（位置与 data-line 都保留）", () => {
    const doc = dom("正文一段。\n\n[^a]: 未被引用的脚注定义。\n\n末尾一段。\n");
    const ps = paras(doc);
    expect(ps.map((p) => p.textContent)).toEqual(["正文一段。", "未被引用的脚注定义。", "末尾一段。"]);
    expect(ps[1]?.getAttribute("data-line")).toBe("3");
    expect(doc.querySelectorAll("section.footnotes").length).toBe(0);
  });

  it("紧跟段落（无空行）的未引用定义同样保留", () => {
    const doc = dom("正文一段。\n[^a]: 未被引用的脚注定义。\n");
    expect(paras(doc).map((p) => p.textContent)).toEqual(["正文一段。", "未被引用的脚注定义。"]);
  });

  it("多行体（缩进续行）两行都在", () => {
    const doc = dom("正文。\n\n[^b]: 多行脚注乙首行\n    缩进续行属于脚注乙。\n\n末尾。\n");
    const text = doc.body.textContent ?? "";
    expect(text).toContain("多行脚注乙首行");
    expect(text).toContain("缩进续行属于脚注乙。");
  });

  it("定义里的块级内容（列表）照样渲染", () => {
    const doc = dom("正文。\n\n[^c]: 定义里带列表：\n    - 列表甲\n    - 列表乙\n\n末尾。\n");
    expect([...doc.querySelectorAll("li")].map((li) => li.textContent)).toEqual(["列表甲", "列表乙"]);
    expect(doc.body.textContent ?? "").toContain("定义里带列表：");
  });

  it("多个未引用定义各自保留", () => {
    const doc = dom("正文。\n\n[^x]: 定义甲。\n[^y]: 定义乙。\n\n末尾。\n");
    const text = doc.body.textContent ?? "";
    expect(text).toContain("定义甲。");
    expect(text).toContain("定义乙。");
    expect(doc.querySelectorAll("section.footnotes").length).toBe(0);
  });
});

describe("被引用的脚注：行为不变（不许回退）", () => {
  it("正常引用 ⇒ 定义进文末脚注区，正文不重复出现", () => {
    const doc = dom("正文一段[^a]引用在此。\n\n[^a]: 被引用的脚注定义。\n\n末尾一段。\n");
    expect(doc.querySelectorAll(".footnote-ref").length).toBe(1);
    expect(doc.querySelectorAll("section.footnotes .footnote-item").length).toBe(1);
    expect(doc.querySelector(".footnote-item")?.textContent).toContain("被引用的脚注定义。");
    // 正文里只有「正文一段」「末尾一段」两段 —— 定义没有留在原位
    expect(paras(doc).length).toBe(2);
  });

  it("混合形态：引用的进脚注区、未引用的留原位（各一份，不重复）", () => {
    const doc = dom("正文一段[^a]与未引用的都在。\n\n[^a]: 被引用的脚注甲。\n\n[^b]: 未被引用的脚注乙。\n\n末尾段落。\n");
    expect(doc.querySelectorAll("section.footnotes .footnote-item").length).toBe(1);
    expect(doc.querySelector(".footnote-item")?.textContent).toContain("被引用的脚注甲。");
    const bodyText = doc.body.textContent ?? "";
    expect(bodyText).toContain("未被引用的脚注乙。");
    expect(bodyText.indexOf("未被引用的脚注乙。")).toBeLessThan(bodyText.indexOf("末尾段落。"));
    // 被引用的定义不得在正文再出现一次（只应出现在脚注区）
    expect([...paras(doc)].some((p) => p.textContent === "被引用的脚注甲。")).toBe(false);
  });

  it("定义在引用之前：仍进脚注区（判定必须在 inline 解析之后做）", () => {
    const doc = dom("[^a]: 定义在前。\n\n正文引用[^a]在后方。\n");
    expect(doc.querySelectorAll("section.footnotes .footnote-item").length).toBe(1);
    expect([...paras(doc)].map((p) => p.textContent)).toEqual(["正文引用[1]在后方。"]);
  });
  it("复引仍计多次回链（原插件语义不动）", () => {
    const doc = dom("甲[^a]乙[^a]。\n\n[^a]: 定义。\n");
    expect(doc.querySelectorAll(".footnote-ref").length).toBe(2);
    expect(doc.querySelectorAll(".footnote-item .footnote-backref").length).toBe(2);
  });
});