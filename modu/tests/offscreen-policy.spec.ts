/**
 * P1 分层判据（render/offscreen-policy.ts）的单测：
 * 纯函数的边界 + shapeOf 的 DOM 查询口径（jsdom 里用合成 fragment）。
 */
import { describe, expect, it } from "vitest";
import { LIGHT_BLOCKS_MAX, keepOffscreenSkipping, shapeOf } from "../src/render/offscreen-policy";

function frag(build: (root: DocumentFragment) => void): DocumentFragment {
  const f = document.createDocumentFragment();
  build(f);
  return f;
}

describe("P1 离屏跳过判据", () => {
  it("含重块（KaTeX / Mermaid）→ 一律保留（实测公式文档开着打开快 558ms、p95 低 17%）", () => {
    expect(keepOffscreenSkipping({ blocks: 0, heavy: true })).toBe(true);
    expect(keepOffscreenSkipping({ blocks: 20, heavy: true })).toBe(true);
    expect(keepOffscreenSkipping({ blocks: 8_583, heavy: true })).toBe(true);
    expect(keepOffscreenSkipping({ blocks: 500_000, heavy: true })).toBe(true);
  });

  it("轻块 + 块数 < 阈值 → 保留（保持现状；块少时判定成本可忽略）", () => {
    for (const blocks of [0, 1, 20, 401, 1_376, LIGHT_BLOCKS_MAX - 1]) {
      expect(keepOffscreenSkipping({ blocks, heavy: false }), `blocks=${blocks}`).toBe(true);
    }
  });

  it("轻块 + 块数 ≥ 阈值 → 关掉（实测 2,353 块起关闭明显更快）", () => {
    for (const blocks of [LIGHT_BLOCKS_MAX, 2_353, 8_353, 9_429, 53_635]) {
      expect(keepOffscreenSkipping({ blocks, heavy: false }), `blocks=${blocks}`).toBe(false);
    }
  });

  it("阈值恰好 2000：1999 保留 / 2000 关掉（保守方向：边界内侧留在现状）", () => {
    expect(LIGHT_BLOCKS_MAX).toBe(2000);
    expect(keepOffscreenSkipping({ blocks: LIGHT_BLOCKS_MAX - 1, heavy: false })).toBe(true);
    expect(keepOffscreenSkipping({ blocks: LIGHT_BLOCKS_MAX, heavy: false })).toBe(false);
  });

  it("shapeOf：blocks = 直接子元素数（不含孙辈），heavy 只看 .katex / .mermaid", () => {
    const plain = frag((f) => {
      for (let i = 0; i < 5; i += 1) {
        const p = document.createElement("p");
        p.appendChild(document.createElement("span")); // 孙辈不进 blocks
        f.appendChild(p);
      }
    });
    expect(shapeOf(plain)).toEqual({ blocks: 5, heavy: false });

    const withMath = frag((f) => {
      const p = document.createElement("p");
      p.innerHTML = '<span class="katex"><span class="katex-mathml"></span></span>';
      f.appendChild(p);
      f.appendChild(document.createElement("p"));
    });
    expect(shapeOf(withMath)).toEqual({ blocks: 2, heavy: true });

    const withMermaid = frag((f) => {
      const div = document.createElement("div");
      div.className = "mermaid";
      f.appendChild(div);
    });
    expect(shapeOf(withMermaid)).toEqual({ blocks: 1, heavy: true });
  });

  it("shapeOf：空 fragment → 0 块且不重（空态/空文档不会误判成要关）", () => {
    expect(shapeOf(document.createDocumentFragment())).toEqual({ blocks: 0, heavy: false });
    expect(keepOffscreenSkipping(shapeOf(document.createDocumentFragment()))).toBe(true);
  });

  it("shapeOf：`.math-fallback`（含 CJK 的公式按设计退化成纯文本）不算重块", () => {
    const f = frag((root) => {
      const p = document.createElement("p");
      p.innerHTML = '<span class="math-fallback">\\text{含税}</span>';
      root.appendChild(p);
    });
    expect(shapeOf(f)).toEqual({ blocks: 1, heavy: false });
  });
});
