/**
 * P1-5：`extractMath` 在大文档上的耗时（1.87MB / 8582 个 `\(` 片段）。
 *
 * 评审结论：现实现实测约 650ms，而增量维护定界符位置的原型只要 5–8ms。
 * 本文件的**正确性**用例始终参与 `pnpm run check`；**耗时断言**默认跳过，
 * 以免在 CI/多任务机器上抖动导致红灯——需要取证时显式设预算：
 *
 *   $env:MODU_MATH_PERF_BOUND_MS = "150"; pnpm exec vitest run tests/mathprotect-perf.spec.ts
 *
 * 无论是否设预算，实测毫秒数都会打印出来，便于「修复前/修复后」对拍。
 */
import { describe, expect, it } from "vitest";
import { extractMath, restoreMath } from "../src/render/mathprotect";

/** 造一份与 `性能基线1MB.md` 同量级的源文（约 1.85MB）：每节含一个 `\(P\)` 拉丁公式 */
function buildSource(): { source: string; spans: number } {
  const filler =
    "本段为性能基线测试内容：中文与 English 混排，金额 $1,000 与 $2,345.67，" +
    "长标识符 performance_baseline_20260921_row，行内变量 \\(P\\) 与普通文本若干，用于填充体积。\n\n";
  const parts: string[] = [];
  let length = 0;
  let spans = 0;
  while (length < 1_850_000) {
    const section = `## 第 ${spans} 节\n\n${filler}`;
    parts.push(section);
    length += section.length;
    spans += 1;
  }
  return { source: parts.join(""), spans };
}

const { source, spans: expectedSpans } = buildSource();

const BOUND_MS = Number(process.env.MODU_MATH_PERF_BOUND_MS ?? "0");

describe("P1-5 extractMath 大文档", () => {
  it("源文规模符合评审口径（约 1.85MB，8000+ 个受保护片段）", () => {
    expect(source.length).toBeGreaterThan(1_700_000);
    expect(source.length).toBeLessThan(2_000_000);
    expect(expectedSpans).toBeGreaterThan(8000);
    expect(source.split("\\(").length - 1).toBe(expectedSpans);
  });

  it("全部片段被摘出，且 restoreMath 能逐字节还原原文", () => {
    const guards = extractMath(source);
    expect(guards.spans.size).toBe(expectedSpans);
    expect(guards.text.includes("\\(")).toBe(false);
    expect(guards.text.includes("\\[")).toBe(false);
    // 还原即原文（本用例源文不含 & < >，实体转义不介入）
    expect(restoreMath(guards.text, guards)).toBe(source);
  });

  it("未闭合定界符不被保护（不吞正文）", () => {
    const guards = extractMath("前 \\(未闭合 后 \\(也闭合不了 \\[ 同样");
    expect(guards.spans.size).toBe(0);
    expect(guards.text).toBe("前 \\(未闭合 后 \\(也闭合不了 \\[ 同样");
  });

  it.skipIf(BOUND_MS === 0)(
    `1.8MB 文档 extractMath 耗时 < ${BOUND_MS}ms（P1-5 预算）`,
    () => {
      const started = performance.now();
      const guards = extractMath(source);
      const elapsed = performance.now() - started;
      console.log(
        `[P1-5] extractMath: ${elapsed.toFixed(1)}ms（${source.length} 字节，${guards.spans.size} 个片段，预算 ${BOUND_MS}ms）`
      );
      expect(guards.spans.size).toBe(expectedSpans);
      expect(elapsed).toBeLessThan(BOUND_MS);
    }
  );
});
