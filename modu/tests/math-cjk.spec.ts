/**
 * 中文伪公式降级（M2 波3，用户反馈：`某项成本单价 = 四舍五入(…)` 这类
 * 含 CJK 的伪公式 KaTeX 抛 ParseError，auto-render 把原文连 \( \) / $$
 * 定界符一起留在正文里——用户看到裸分隔符）。
 *
 * 断言（修复目标）：含 CJK 的公式 → 剥分隔符输出 .math-fallback
 * （块级加 --display 居中弱化），定界符零残留；拉丁公式仍走 KaTeX。
 */
import { describe, expect, it } from "vitest";
import { renderDocument } from "../src/render/pipeline";
import corpusSrc from "./corpus/语料.md?raw";

function parse(html: string): Document {
  return new DOMParser().parseFromString(html, "text/html");
}

const USER_FORMULA = "某项成本单价 = 四舍五入(该项金额合计 ÷ 该项数量合计, 保留 6 位小数)";

describe("中文公式降级（用户反馈 M2 波3）", () => {
  it("行内 \\(中文算式\\) → 行内 .math-fallback，定界符零残留", () => {
    const doc = parse(renderDocument(`成本口径 \\(${USER_FORMULA}\\) 按四舍五入执行。`).html);
    const fb = doc.querySelector("span.math-fallback");
    expect(fb).toBeTruthy();
    expect(fb?.classList.contains("math-fallback--display")).toBe(false);
    expect(fb?.textContent).toContain("某项成本单价");
    expect(doc.body.textContent).not.toContain("\\(");
    expect(doc.body.textContent).not.toContain("\\)");
    expect(doc.querySelectorAll(".katex").length).toBe(0);
  });

  it("块级 $$中文算式$$ → .math-fallback--display，无 $$ 残留", () => {
    const doc = parse(renderDocument(`$$${USER_FORMULA}$$`).html);
    const fb = doc.querySelector(".math-fallback--display");
    expect(fb?.textContent).toContain("四舍五入");
    expect(doc.body.textContent).not.toContain("$$");
    expect(doc.querySelectorAll(".katex-display").length).toBe(0);
  });

  it("拉丁公式不受影响（仍走 KaTeX，不产生 fallback）", () => {
    const doc = parse(renderDocument(`\\(x_i\\) 与 $$E=mc^2$$`).html);
    expect(doc.querySelectorAll(".katex").length).toBe(2);
    expect(doc.querySelector(".math-fallback")).toBe(null);
  });

  it("混排段：中文公式降级、同一篇拉丁公式与金额各安其位", () => {
    const src = `预算 \\(某项成本 = 金额合计 \\div 数量合计\\) 与权利金 $1,000，模型 \\(C_t\\) 照常渲染。`;
    const doc = parse(renderDocument(src).html);
    expect(doc.querySelector(".math-fallback")?.textContent).toContain("金额合计");
    expect(doc.querySelectorAll(".katex").length).toBe(1);
    expect(doc.body.textContent).toContain("$1,000");
  });

  it("语料两形态：各降级一次（1 行内 + 1 块级），拉丁公式计数不变", () => {
    const doc = parse(renderDocument(corpusSrc).html);
    const fbs = [...doc.querySelectorAll(".math-fallback")];
    expect(fbs.length).toBe(2);
    expect(fbs.filter((el) => el.classList.contains("math-fallback--display")).length).toBe(1);
    expect(doc.body.textContent).toContain("$1,000 与 $2,000"); // 金额红线不受影响
    expect(doc.querySelectorAll(".katex").length).toBe(4); // 拉丁公式原样（render.spec ② 同口径）
  });
});
