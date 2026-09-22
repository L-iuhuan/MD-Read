/**
 * 中文两端对齐的「撑开守卫」（移植自 docs/demo/排版demo.html §修订一 guardJustify）。
 *
 * 实测（Chrome 138）：Blink 对 CJK 做 justify 加宽的是每个字的**步进宽度**，不是
 * 字间留空隙，量字间距测不出问题。省的等效判据：justify 不改变断行 → 候选块临时
 * 切 text-align:start（cjk.css 的 [data-justify-measure] 实测模式），start 下每行
 * 宽度即自然宽度；非末行自然亏空 >5% → 该块回退左对齐（data-justify="off"）。
 *
 * 预筛（工程新增，demo 遗留 #2 的优化）：块内不含 ≥8 字符的 [A-Za-z0-9_-] 连续串
 * 则跳过测量——纯 CJK 段断行机会遍布字间，一行必然填到离容器不到一个字，不可能
 * 触发 5% 亏空。省下 O(块数) 次 Range 测量。
 */

/** 亏空 > 5% 即回退左对齐；demo 实测依据：正常行亏空 0.8%~1.8%，被撑开行 33.8% */
const JUSTIFY_MAX_STRETCH = 0.05

/**
 * 测量上限（性能修复，2026-09-22 用户实测 1MB 文档 41 秒定罪）：
 * content-visibility:auto 会跳过视口外布局，但守卫逐块调 Range.getClientRects
 * 会把每个被跳过的块强行拉回布局 → O(n²)——8700 块实测 guardJustify 39.5s。
 * 候选超上限的病态长文整体跳过守卫（默认即全 justify，跳过=不标记=维持默认，
 * 无视觉损伤）；真实文档（几百段以内）完整保留守卫。
 */
export const JUSTIFY_MEASURE_CAP = 400

/** 预筛正则：≥8 字符的技术串（字母/数字/下划线/连字符） */
const RE_LONG_TOKEN = /[A-Za-z0-9_-]{8,}/

/** 预筛纯函数：文本里有无可能撑开两端对齐的长技术串 */
export function hasLongToken(text: string): boolean {
  return RE_LONG_TOKEN.test(text)
}

interface LineRun {
  top: number
  left: number
  right: number
}

/**
 * 一个块的自然行宽。rect 按行合并，容差取半个行高：<code> 内联盒的 padding 会让
 * rect 的 top 偏一两像素，容差太小会把同一行拆成两行从而误判。
 */
export function naturalLineWidths(el: Element): number[] {
  const range = document.createRange()
  range.selectNodeContents(el)
  const rects = range.getClientRects()
  const lh = Number.parseFloat(window.getComputedStyle(el).lineHeight)
  const tol = (lh > 0 ? lh : 24) / 2
  const lines: LineRun[] = []
  for (let i = 0; i < rects.length; i++) {
    const box = rects[i]
    if (box.width === 0 && box.height === 0) continue
    const hit = lines.find((l) => Math.abs(l.top - box.top) < tol)
    if (hit === undefined) {
      lines.push({ top: box.top, left: box.left, right: box.right })
    } else {
      hit.left = Math.min(hit.left, box.left)
      hit.right = Math.max(hit.right, box.right)
    }
  }
  lines.sort((a, b) => a.top - b.top)
  return lines.map((l) => l.right - l.left)
}

/** 可测块。排除：公式（.katex 的 MathML 绝对定位会污染分行）、Mermaid 图、表格、任务列表项 */
export function justifyCandidates(root: ParentNode): HTMLElement[] {
  return Array.from(root.querySelectorAll<HTMLElement>('p, li, blockquote p')).filter((el) => {
    if (el.closest('.katex') !== null || el.querySelector('.katex') !== null) return false
    if (el.closest('.math-block') !== null || el.querySelector('.mermaid') !== null) return false
    if (el.closest('.table-wrap, .diagram, .task-list') !== null) return false
    if (el.querySelector('input[type="checkbox"]') !== null) return false
    return (el.textContent ?? '').trim().length > 0
  })
}

/**
 * 逐段判定是否回退。写读顺序刻意分三段，全程只触发一次重排：
 * ① 清上一轮标记（纯写）② 开实测模式（纯写）③ 集中读测 ④ 关实测模式 ⑤ 落标记。
 * 返回值：被标记 data-justify="off" 的块数。
 */
export function guardJustify(root: HTMLElement): number {
  const blocks = justifyCandidates(root)
  const measure = blocks.filter((el) => hasLongToken(el.textContent ?? ''))
  if (measure.length === 0) return 0
  for (const el of blocks) el.removeAttribute('data-justify') // 预筛跳过的块也清残留
  if (measure.length > JUSTIFY_MEASURE_CAP) return 0 // 病态长文：守卫降级（见常量注释）
  root.setAttribute('data-justify-measure', '')
  const rows = measure.map((el) => ({ el, avail: el.clientWidth, ws: naturalLineWidths(el) }))
  root.removeAttribute('data-justify-measure')
  let flagged = 0
  for (const row of rows) {
    if (row.avail === 0 || row.ws.length < 2) continue // 单行块不存在撑开问题
    let worst = 0
    for (let i = 0; i < row.ws.length - 1; i++) { // 末行永远不拉伸，跳过
      worst = Math.max(worst, 1 - row.ws[i] / row.avail)
    }
    if (worst > JUSTIFY_MAX_STRETCH) {
      row.el.setAttribute('data-justify', 'off')
      flagged++
    }
  }
  return flagged
}
