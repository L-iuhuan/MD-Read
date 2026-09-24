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

/**
 * P0-1 回归（WSL 评审实测）：
 *   renderDocument('甲 \\(x\\) 乙 \\(中文公式\\) 丙') 实测 textContent 只剩 " 乙 中文公式 丙"
 *   —— 拉丁公式**先于** CJK 公式出现时，`甲` 与 `\\(x\\)` 被静默删除。
 *
 * 根因：math.ts 的 degradeNode 里 frag 延迟创建；未建 frag 时跳过拉丁片段只推进
 * cursor，等遇到 CJK 片段才建 frag，此时 slice(cursor, …) 的起点已越过被跳过的正文。
 *
 * 上面既有用例全是「CJK 先、拉丁后」顺序（frag 在第一个 span 就建好），因此漏测；
 * 本组补齐「拉丁→CJK」「CJK→拉丁」「拉丁→拉丁→CJK」三种顺序，并在 pangu 开/关两态下验证。
 */
describe("P0-1 混合公式顺序回归（正文零丢失）", () => {
  /** 断言正文片段齐全且顺序正确；公式各归其位 */
  function expectPreserved(html: string, prose: string[], fallbackText: string, katexCount: number): void {
    const doc = parse(html);
    const text = doc.body.textContent ?? "";

    // 每个正文片段都必须留下，且相对顺序不变（修复前会缺失 `甲`）
    let cursor = -1;
    for (const piece of prose) {
      const at = text.indexOf(piece);
      expect(at, `正文片段 "${piece}" 丢失（实际文本：${JSON.stringify(text)}）`).toBeGreaterThanOrEqual(0);
      expect(at, `正文片段 "${piece}" 顺序错乱`).toBeGreaterThan(cursor);
      cursor = at;
    }

    // CJK 伪公式走降级，定界符零残留
    expect(doc.querySelector(".math-fallback")?.textContent).toBe(fallbackText);
    expect(text).not.toContain("\\(");
    expect(text).not.toContain("\\)");
    expect(text).not.toContain("$$");

    // 拉丁公式仍交给 KaTeX
    expect(doc.querySelectorAll(".katex").length).toBe(katexCount);
  }

  const CASES: Array<{ name: string; src: string; prose: string[]; fallback: string; katex: number }> = [
    {
      name: "拉丁→CJK（P0-1 原始复现）",
      src: "甲 \\(x\\) 乙 \\(中文公式\\) 丙",
      prose: ["甲", "乙", "丙"],
      fallback: "中文公式",
      katex: 1,
    },
    {
      name: "CJK→拉丁（原本正常的顺序，防回归）",
      src: "甲 \\(中文公式\\) 乙 \\(x\\) 丙",
      prose: ["甲", "乙", "丙"],
      fallback: "中文公式",
      katex: 1,
    },
    {
      name: "拉丁→拉丁→CJK",
      src: "甲 \\(x\\) 乙 \\(y\\) 丙 \\(中文公式\\) 丁",
      prose: ["甲", "乙", "丙", "丁"],
      fallback: "中文公式",
      katex: 2,
    },
    {
      name: "CJK→拉丁→CJK",
      src: "甲 \\(中文一\\) 乙 \\(x\\) 丙 \\(中文二\\) 丁",
      prose: ["甲", "乙", "丙", "丁"],
      fallback: "中文一",
      katex: 1,
    },
  ];

  for (const c of CASES) {
    it(`${c.name}：pangu 开（默认）`, () => {
      expectPreserved(renderDocument(c.src).html, c.prose, c.fallback, c.katex);
    });

    it(`${c.name}：pangu 关`, () => {
      expectPreserved(renderDocument(c.src, { pangu: false }).html, c.prose, c.fallback, c.katex);
    });
  }

  it("块级混排：$$拉丁$$ 与 $$中文$$ 交替时正文不丢", () => {
    const doc = parse(renderDocument("前段\n\n$$E=mc^2$$\n\n中段\n\n$$中文块公式$$\n\n后段").html);
    const text = doc.body.textContent ?? "";
    expect(text).toContain("前段");
    expect(text).toContain("中段");
    expect(text).toContain("后段");
    expect(doc.querySelector(".math-fallback--display")?.textContent).toBe("中文块公式");
    expect(doc.querySelectorAll(".katex-display").length).toBe(1);
  });
});
