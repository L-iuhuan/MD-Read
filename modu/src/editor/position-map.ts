/**
 * 阅读态 ⇄ 编辑态的块级保位映射（F7 / 规格 D1：块级定位，行内偏移不做）。
 * 纯 DOM 查询、无 CM6 依赖——jsdom 里 mock getBoundingClientRect 即可测。
 * data-line 由渲染管线打在带 map 的块级元素上（1-based，对齐编辑器行号）。
 */

/** 解析块的 data-line；缺失/非法（非正整数）返回 null */
function lineOf(el: Element): number | null {
  const raw = el.getAttribute("data-line");
  if (raw === null) {
    return null;
  }
  const line = Number.parseInt(raw, 10);
  return Number.isFinite(line) && line >= 1 ? line : null;
}

/**
 * 视口内首个 [data-line] 块的行号（阅读→编辑的定位依据）。
 * 判定：块顶 ≥ 滚动容器顶即视为进入视口；全部滚过视口时回退最后一个块。
 *
 * ⭐ 2026-09-27 改为**二分**：旧实现逐块读 `getBoundingClientRect`，每帧最多 **9,429 次**
 * （1MB 文档实测滚动掉到 **12 FPS** ✗；`outline-follow.ts` 头注也把它记为占滚动墙钟 8.6~12.5% 的旧路径）。
 * 依据与 `outline-follow` 同一套推论：`[data-line]` 块按文档序排列、且块级盒不重叠
 * ⇒ **`top` 沿数组单调不减** ⇒ 「首个 `top ≥ viewportTop`」可用二分定位，与逐块扫描**逐点等价**
 * （含"全部滚过 ⇒ 回退最后一块"这条尾巴：旧实现的 `lastAbove` 就是最后一个有效块）。
 * 每帧 rect 次数由 O(n) 降到 **log₂(n) ≈ 13**。
 * ⚠ `querySelectorAll` 仍是 O(n) 次 DOM 遍历，但**它不触发布局**；真正的开销是 rect（强制 layout）✗。
 */
export function firstVisibleLine(container: HTMLElement): number | null {
  const viewportTop = container.getBoundingClientRect().top;
  const blocks: { el: Element; line: number }[] = [];
  for (const el of Array.from(container.querySelectorAll("[data-line]"))) {
    const line = lineOf(el);
    if (line !== null) {
      blocks.push({ el, line });
    }
  }
  if (blocks.length === 0) {
    return null;
  }
  let lo = 0;
  let hi = blocks.length - 1;
  let found = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (blocks[mid].el.getBoundingClientRect().top >= viewportTop) {
      found = mid; // 达标 ⇒ 记下并继续往左找更靠前的
      hi = mid - 1;
    } else {
      lo = mid + 1;
    }
  }
  return found >= 0 ? blocks[found].line : blocks[blocks.length - 1].line;
}

/**
 * 离 fromLine 最近的上方（或相等）块的行号（编辑→阅读的落点）。
 * D1 裁决：map 是块级的，行号落回「最近上方块」；fromLine 在首块之前回退首块。
 */
export function nearestBlockLine(container: HTMLElement, fromLine: number): number | null {
  let best: number | null = null;
  let first: number | null = null;
  for (const el of Array.from(container.querySelectorAll("[data-line]"))) {
    const line = lineOf(el);
    if (line === null) {
      continue;
    }
    if (first === null || line < first) {
      first = line;
    }
    if (line <= fromLine && (best === null || line > best)) {
      best = line;
    }
  }
  return best ?? first;
}
