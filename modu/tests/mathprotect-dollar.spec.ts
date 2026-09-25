/**
 * P1-1（批次 2）：`$$…$$` 数学保护的单测锚。
 *
 * 背景（真机复现，见 docs/tasks/Phase3-批次2-复现报告-2026-09-23.md）：
 * 原实现只摘 `\(`/`\[`，注释里断言"块级 `$$…$$` 无反斜杠、不受影响"——**实测不成立**：
 *   · 多行 `$$` 块里的 `*b*` 被 emphasis 拆成 `<em>` ⇒ KaTeX 无法跨元素匹配，整块退化成纯文本；
 *   · 块内一行孤立的 `=` 被 markdown-it 的 setext 规则把前几行变成 `<h1>`。
 * 两种症状同源：**该块从未被收走**。本组锁住"收走"这一层（真机渲染另见报告 §8/对拍数据）。
 *
 * 红线：只认两个连续 `$`，**单裸 `$` 永不参与**（金额串 `$1,000 与 $2,000` 必须仍是纯文本）。
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { extractMath, restoreMath } from "../src/render/mathprotect";

/** extract → restore 的往返（这些片段不含 & < >，应逐字一致） */
function roundTrip(src: string): { text: string; spanCount: number; restored: string } {
  const guards = extractMath(src);
  return { text: guards.text, spanCount: guards.spans.size, restored: restoreMath(guards.text, guards) };
}

describe("P1-1 · $$…$$ 收进数学管线", () => {
  it("行内 $$a *b* c$$ 被整段收走（emphasis 无从拆它）", () => {
    const r = roundTrip("行内：$$a *b* c$$ 结束。");
    expect(r.spanCount).toBe(1);
    expect(r.text).not.toContain("$$");
    expect(r.text).not.toContain("*b*"); // 星号也一起藏起来了
    expect(r.restored).toBe("行内：$$a *b* c$$ 结束。");
  });

  it("多行 $$ 块被整段收走（块内 *b* 不参与 emphasis）", () => {
    const src = "$$\na *b* c\n$$";
    const r = roundTrip(src);
    expect(r.spanCount).toBe(1);
    expect(r.text).not.toContain("$$");
    expect(r.restored).toBe(src);
  });

  it("块内一行孤立的 = 不会被 markdown-it 当 setext 下划线（整块已藏起来）", () => {
    const src = "$$\nE = m c^2\n=\n\\text{孤立等号下的一行}\n$$";
    const r = roundTrip(src);
    expect(r.spanCount).toBe(1);
    // 关键：喂给 md 的文本里既没有 `$$` 也没有那行孤立的 `=`
    expect(r.text).not.toContain("$$");
    expect(r.text.split("\n").some((line) => line.trim() === "=")).toBe(false);
    expect(r.restored).toBe(src);
  });

  it("多段混排：$$ 块 + \\(…\\) + \\[…\\] 各自成段、顺序不乱", () => {
    const src = "A $$x$$ B \\( y \\) C \\[ z \\] D\n\n$$\nq\n$$\n";
    const r = roundTrip(src);
    expect(r.spanCount).toBe(4);
    expect(r.restored).toBe(src);
  });

  it("代码围栏内的 $$ 也被摘出再原样还原（文本逐字不变 ⇒ 不误渲）", () => {
    const src = "```text\n$$\nnot math\n$$\n```\n";
    const r = roundTrip(src);
    expect(r.restored).toBe(src);
  });

  it("`$$$` 不会把同一个 `$$` 重复登记（步长 2）", () => {
    const r = roundTrip("$$$");
    expect(r.spanCount).toBe(0); // 只有一个 `$$`（外加一个 `$`），无闭合对
    expect(r.restored).toBe("$$$");
  });

  it("未闭合的 $$ 不保护（保持 md 原有行为，不吞正文）", () => {
    const src = "开头 $$没有闭合的一行\n下一行";
    const guards = extractMath(src);
    expect(guards.spans.size).toBe(0);
    expect(guards.text).toBe(src);
  });
});

describe("P1-1 · 金额串红线（裸 $ 永不参与匹配）", () => {
  it("「$1,000 与 $2,000」不产生任何占位符", () => {
    const src = "金额：$1,000 与 $2,000，还有 $2,345.67 与 $9.9 混排。";
    const guards = extractMath(src);
    expect(guards.spans.size).toBe(0);
    expect(guards.text).toBe(src);
  });

  it("单个裸 $ 与 `$…$` 结构都不被当成公式", () => {
    for (const src of ["单价 $100 与 $200", "$a$", "a $ b $ c", "$$$1,000"] ) {
      expect(extractMath(src).spans.size, src).toBe(0);
    }
  });

  it("金额串与真公式混排时只收公式、金额原样", () => {
    const src = "金额 $1,000 与 $2,000；公式 $$a *b* c$$ 与 \\( x \\)。";
    const guards = extractMath(src);
    expect(guards.spans.size).toBe(2);
    expect(restoreMath(guards.text, guards)).toBe(src);
    expect(guards.text).toContain("$1,000 与 $2,000");
  });

  it("golden 语料（tests/corpus/语料.md）：往返无损，且每个被收片段都以合法定界符开头", () => {
    const golden = readFileSync("tests/corpus/语料.md", "utf8");
    const guards = extractMath(golden);
    // golden 里本来就有真公式（`$$`/`\(`/`\[`），所以不假设 span 数；锁"红线"：
    // ① 往返逐字无损 ② 没有任何一个片段是"裸 $ 金额串"（必须由 $$ / \( / \[ 开头）
    expect(restoreMath(guards.text, guards)).toBe(golden);
    for (const [placeholder, span] of guards.spans) {
      expect(
        span.startsWith("$$") || span.startsWith("\\(") || span.startsWith("\\["),
        `${placeholder} 捕获了非合法定界符片段：${span.slice(0, 40)}`,
      ).toBe(true);
      expect(span.startsWith("$") && !span.startsWith("$$")).toBe(false);
    }
  });
});
