/**
 * 块级公式自动缩放适配（移植自 docs/demo/排版demo.html §修订三 fitMathBlock）。
 *
 * M1 工程规则（规格 v1.2/v1.3）：禁横向滚动条——KaTeX 的 .katex-html 是 nowrap，
 * 宽公式原本靠 overflow-x 出横向滚动条（默认没人拖，等于被裁一截）。改为等比缩放进栏：
 * 只有自然宽度超出容器才缩，不超宽一律 1:1；下限 0.75——缩到 0.75 仍放不下就停在
 * 0.75，宁可略超栏宽也不压到读不清（.katex 基础字号 1.04em × 0.75 ≈ 正文 78%，
 * 仍在验收线 ≥75% 之上）。
 */

const MATH_MIN_SCALE = 0.75
/** 容器 resize 防抖上限（任务书：≤150ms） */
const REFIT_DEBOUNCE_MS = 120

/** 单个 .katex-display 的缩放适配。幂等：每轮先清上一轮缩放再量自然宽度。 */
export function fitMathBlock(disp: HTMLElement): void {
  const inner = disp.querySelector<HTMLElement>('.katex')
  if (inner === null) return
  // 先清掉上一轮的缩放与占位高度再量，否则量到的是缩放后的尺寸
  inner.style.transform = ''
  disp.style.height = ''
  disp.removeAttribute('data-math-scale')
  // 量自然宽度：KaTeX 的 .katex 是块级（宽度恒等于容器宽），临时改成
  // width:max-content 的 inline-block，shrink-to-fit 得到公式真实宽度，
  // 不依赖 KaTeX 的内部类名
  inner.style.display = 'inline-block'
  inner.style.width = 'max-content'
  const natural = inner.getBoundingClientRect().width
  inner.style.display = ''
  inner.style.width = ''
  const avail = disp.clientWidth
  if (natural === 0 || avail === 0 || natural <= avail) return // 不超宽：保持 1:1 不动
  const scale = Math.max(MATH_MIN_SCALE, avail / natural)
  // origin: center top——缩放围绕上边中点，外层高度才压得准（transform 不改变
  // 布局高度，外层不按缩放后高度定死就会多留空白或塌陷）
  inner.style.transformOrigin = 'center top'
  inner.style.transform = `scale(${scale.toFixed(4)})`
  disp.style.height = `${Math.round(inner.offsetHeight * scale * 100) / 100}px`
  disp.setAttribute('data-math-scale', scale.toFixed(3))
}

/** 范围内全部块级公式适配 */
export function fitMathBlocks(scope: ParentNode): void {
  for (const disp of Array.from(scope.querySelectorAll<HTMLElement>('.katex-display'))) {
    fitMathBlock(disp)
  }
}

let resizeObserver: ResizeObserver | null = null
let watched: HTMLElement | null = null
let lastWidth = -1
let debounceTimer: number | undefined

/**
 * 容器尺寸变化后防抖（≤150ms）重跑缩放。只盯宽度：块级公式占位高度是本模块
 * 自己写的，高度回环会自我触发；宽度变了断行才真的失效。
 */
export function watchMathFit(container: HTMLElement): void {
  if (typeof ResizeObserver === 'undefined') return // 测试环境（jsdom）无此 API
  if (watched === container) return // 同一容器只挂一次
  watched = container
  lastWidth = -1
  if (resizeObserver !== null) resizeObserver.disconnect()
  resizeObserver = new ResizeObserver((entries) => {
    const width = entries[0] === undefined ? -1 : entries[0].contentRect.width
    if (width === lastWidth) return
    lastWidth = width
    window.clearTimeout(debounceTimer)
    debounceTimer = window.setTimeout(() => fitMathBlocks(container), REFIT_DEBOUNCE_MS)
  })
  resizeObserver.observe(container)
}
