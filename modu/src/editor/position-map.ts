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
 */
export function firstVisibleLine(container: HTMLElement): number | null {
  const viewportTop = container.getBoundingClientRect().top;
  let lastAbove: number | null = null;
  for (const el of Array.from(container.querySelectorAll("[data-line]"))) {
    const line = lineOf(el);
    if (line === null) {
      continue;
    }
    if (el.getBoundingClientRect().top >= viewportTop) {
      return line; // querySelectorAll 按文档序，首个达标者即视口首块
    }
    lastAbove = line;
  }
  return lastAbove;
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
