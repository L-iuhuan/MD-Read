/**
 * 离屏跳过（content-visibility）的分层判据 —— P1（2026-09-23）。
 *
 * 背景：`cjk.css` 里 `.mdc > * { content-visibility: auto }` 让视口外的块跳过渲染，
 * 代价是 Blink 每帧要算"哪些块可以跳过"（`IntersectionObserverController::computeIntersections`，
 * 实测 ≈0.205ms/候选块/6s，与候选块数**线性**）。两类文档的账正好相反：
 *
 * | 语料（`.verify/perf/drafts` 与 `.verify/phase2/p1-corpus`） | 候选块 | 开着：下行 FPS / 打开 | 关掉：下行 FPS / 打开 | 谁好 |
 * |---|---|---|---|---|
 * | 典型用户文档（433 节点） | 20 | 74.97 / 36ms | 74.97 / 37ms | 平 |
 * | Mermaid 密集（100 图） | 301 | 74.8 / 65ms | 74.97 / 59ms | 平 |
 * | 长段落（24.8K 节点） | 401 | 74.97 / 709ms | 74.97 / 732ms | 平 |
 * | 阶梯-05K（8.3K 节点） | 1,376 | 74.97 / 208ms | 74.97 / 236ms | 平 |
 * | 表格密集（37.9K 节点） | 2,353 | 42.48 / 558ms | **60.14** / 644ms | **关掉** |
 * | 阶梯-20K（31.2K 节点） | 5,326 | 34.67 / 577ms | **74.47** / 709ms | **关掉** |
 * | 代码密集（69.7K 节点） | 8,353 | 18.33 / 934ms | **34.65** / 1,412ms | **关掉** |
 * | 散文 1MB（28.5K 节点） | 9,429 | 18.37 / 724ms | **57.18** / 825ms | **关掉** |
 * | 阶梯-50K / 100K / 200K | 13.7K / 26.9K / 53.6K | 12.66 / 7.74 / 4.00 | **30.06 / 16.49 / 8.62** | **关掉** |
 * | **公式密集（129K 节点、8,582 个 KaTeX）** | 8,583 | 16.84 / **947ms** | 16.75 / 1,505ms | **开着**（打开 −558ms、p95 −17%） |
 *
 * 判据因此是两条：
 *   1. **含重块（KaTeX / Mermaid）→ 保留**：跳过它们的渲染省得比判定成本多（公式语料实测）。
 *   2. **纯轻块文档 → 只有块数 ≥ `LIGHT_BLOCKS_MAX` 才关**：块少时该机制的成本可忽略
 *      （≤1,376 块实测两态持平，开着甚至打开更快），此时保持现状。
 *
 * ⚠ 保守方向（硬要求）：**默认 = 开着（今天的行为）**。`#doc` 上不加 `.cv-off` 就是现状，
 * 所以"判据漏判/判错"最坏也只是回到今天的表现；只有两条都确信时才关。
 * 阈值 2,000 取自实测交叉点：1,376 块两态持平、2,353 块起关闭明显更快 ⇒ 取两者之间靠"保守侧"
 * 的整数（宁可对 1,999 块的文档保持现状，也不冒险关掉）。
 * ⚠ 未测边界：**KaTeX 密集 + 块数 ≥ 2 万**（重块收益与判定成本都很高）没有语料，
 * 现在按第 1 条一律保留；若以后出现这种文档要补测再收紧。
 */

/** 轻块文档的块数阈值：低于它保持现状（开着）；≥ 它且无重块 → 关掉离屏跳过 */
export const LIGHT_BLOCKS_MAX = 2000;

export interface DocShape {
  /** `#doc` 的直接子元素数 = content-visibility 的候选块数（O(1) 读） */
  blocks: number;
  /** 是否含 KaTeX / Mermaid —— 渲染代价高、跳过它们的收益大于每帧判定成本 */
  heavy: boolean;
}

/** 是否**保留**离屏跳过（true = 保持现状/挂着 content-visibility；false = 加 `.cv-off` 关掉） */
export function keepOffscreenSkipping(shape: DocShape): boolean {
  if (shape.heavy) {
    return true; // 重块文档：实测"开着"打开快 558ms、p95 低 17%
  }
  return shape.blocks < LIGHT_BLOCKS_MAX; // 轻块且块数不大：判定成本可忽略，保持现状
}

/** 量出判据输入（唯一做 DOM 查询的地方）。`querySelector` 带早退：重块文档命中的是第一个元素。 */
export function shapeOf(fragment: DocumentFragment): DocShape {
  return {
    blocks: fragment.childElementCount,
    heavy: fragment.querySelector(".katex, .mermaid") !== null,
  };
}
