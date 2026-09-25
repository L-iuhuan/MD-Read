/**
 * 导出前渲染完备性等待（D2 ⑤：打印前必须 await 渲染完全部懒加载块）。
 *
 * - Mermaid 懒加载按「相交才渲染」工作（见 mermaid.ts 的 IntersectionObserver）：
 *   视口外的图永远不会自己定稿。导出是全文档快照，所以先对未定稿节点主动触发
 *   一次渲染（renderMermaidEl），再等全部节点落在 data-rendered="1"（成功）或
 *   data-mmd-error（失败占位——源码文本仍在，PDF 按原文印出，不阻塞导出）。
 * - KaTeX 缩放（fitmath.ts）没有完成标志：fitMathBlocks 在 enhanceView 里同步执行，
 *   watchMathFit 只在容器 resize 时防抖重跑（导出前无 resize），故以「连续两帧
 *   rAF」近似布局稳定——第一帧触发样式回流，第二帧确认布局收尾（任务书裁定的近似法）。
 * - **字体与图片（P1-4 补齐，2026-09-23）**：此前只等 mermaid + 两帧，**没有**
 *   `document.fonts.ready`、**没有**任何图片等待 —— 实测代码里两处 0 命中。于是导出可能
 *   丢掉"晚加载的字形"（CJK/公式字体回退、方框）或印出"还没解码完的图"。
 *   现在补上：等 `fonts.ready`（到时限即放行，不会卡死）+ 逐张 `img.decode()`
 *   （成功/失败都算有结果；失败清单回传，供调用方提示）。
 * - 超时（默认 10s）放行并返回 `{ timedOut: true }`，由调用方在状态栏提示，
 *   不放行会把导出按钮卡死在极端文档上。
 */

export interface PrintReadyResult {
  timedOut: boolean
  /** 字体就绪等待是否到时限放行（超时仍继续导出，只由调用方提示） */
  fontsTimedOut: boolean
  /** 未能出结果的图片（缺失/解码失败）清单，供调用方提示；空数组表示全部就绪 */
  imageFailures: string[]
}

export interface PrintReadyOptions {
  timeoutMs?: number
  /** 强渲单个未定稿 .mermaid；默认动态加载 mermaid.ts 的 renderMermaidEl（测试注入替身） */
  renderPending?: (el: HTMLElement) => Promise<void>
}

const POLL_MS = 100
const DEFAULT_TIMEOUT_MS = 10_000

/** 纯判定：范围内所有 .mermaid 已定稿（渲染成功或失败占位） */
export function isMermaidSettled(container: ParentNode): boolean {
  return pendingMermaid(container).length === 0
}

/** 未定稿（既非 data-rendered="1" 也无 data-mmd-error）的 .mermaid 节点 */
export function pendingMermaid(container: ParentNode): HTMLElement[] {
  return Array.from(container.querySelectorAll<HTMLElement>('.mermaid')).filter(
    (el) => el.dataset.rendered !== '1' && !el.hasAttribute('data-mmd-error'),
  )
}

/** 还没出结果的 `<img>`：无 `src` 的（装饰占位）跳过。 */
export function pendingImages(container: ParentNode): HTMLImageElement[] {
  return Array.from(container.querySelectorAll<HTMLImageElement>('img')).filter(
    (img) => img.getAttribute('src') !== null && !img.complete,
  )
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function nextFrame(): Promise<void> {
  return new Promise((resolve) => {
    if (typeof requestAnimationFrame === 'function') {
      requestAnimationFrame(() => resolve())
    } else {
      setTimeout(resolve, 16) // jsdom（未开 pretendToBeVisual）无 rAF：退化为宏任务
    }
  })
}

async function twoRafFrames(): Promise<void> {
  await nextFrame()
  await nextFrame()
}

/** 等字体系统就绪。无 `document.fonts`（jsdom/老环境）视为已就绪；
 *  字体永远加载不上时也不能卡死导出 ⇒ 与时限赛跑，超时返回 false（调用方提示）。 */
async function fontsReady(deadline: number): Promise<boolean> {
  const fonts = typeof document === 'undefined' ? undefined : document.fonts
  if (fonts === undefined || typeof fonts.ready?.then !== 'function') {
    return true
  }
  return Promise.race([
    fonts.ready.then(() => true),
    sleep(Math.max(0, deadline - Date.now())).then(() => false),
  ])
}

/** 等图片出结果：`decode()` 成功/失败都算有结果（缺失/损坏的图不能阻塞导出），
 *  无 `decode`（jsdom）则退回 `complete` 轮询到时限。返回失败清单。 */
async function imagesSettled(container: ParentNode, deadline: number): Promise<string[]> {
  const failures: string[] = []
  for (const img of pendingImages(container)) {
    if (typeof img.decode !== 'function') {
      continue
    }
    try {
      await img.decode()
    } catch (error) {
      const name = img.getAttribute('src') ?? '(无 src)'
      failures.push(`${name}（${error instanceof Error ? error.message : '解码失败'}）`)
    }
  }
  while (pendingImages(container).length > 0 && Date.now() < deadline) {
    await sleep(POLL_MS)
  }
  return failures
}

async function defaultRenderPending(el: HTMLElement): Promise<void> {
  const { renderMermaidEl } = await import('./mermaid')
  await renderMermaidEl(el)
}

/**
 * 等待容器渲染完备（Mermaid 全定稿 + 字体/图片就绪 + KaTeX 布局两帧稳定）。
 * 超时放行：返回 `timedOut: true` 供调用方提示「按当前版式导出」。
 */
export async function awaitPrintReady(
  container: ParentNode,
  options: PrintReadyOptions = {},
): Promise<PrintReadyResult> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS
  const render = options.renderPending ?? defaultRenderPending
  const deadline = Date.now() + timeoutMs
  // 先点火未定稿的懒加载图（fire-and-forget；失败占位也算定稿，卡死由超时兜底）
  void Promise.allSettled(pendingMermaid(container).map((el) => render(el)))
  await twoRafFrames()
  const fontsOk = await fontsReady(deadline)
  const imageFailures = await imagesSettled(container, deadline)
  while (pendingMermaid(container).length > 0) {
    if (Date.now() >= deadline) {
      return { timedOut: true, fontsTimedOut: !fontsOk, imageFailures }
    }
    await sleep(POLL_MS)
  }
  return { timedOut: false, fontsTimedOut: !fontsOk, imageFailures }
}

/**
 * 宽表自动横排（2026-09-23 用户裁决「宽表自动横向打印」；命名页机制写在 print.css）。
 *
 * **数值来历（不许当魔法数）**：
 * - `PORTRAIT_PRINTABLE_PX = 658`：A4 210mm − 2×18mm 边距 = 174mm，按 96dpi（3.7795px/mm）换算。
 *   纸型与边距是**实测/既定**的（`pdfinfo` 量到竖版 594.96×841.92pt = A4；18mm 来自 print.css 的
 *   `@page{margin:18mm}`）；**"174mm ⇒ 658px"这一步是推断**（按 CSS 96dpi 口径）。
 * - `LANDSCAPE_PRINTABLE_PX = 987`：297mm − 36mm = 261mm 同上换算（横版纸型实测 841.92×594.96pt）。
 * - **实测边界事实**：内在宽 **1870px** 的 12 列表格**即便横排也印不全**（横排导出后文本层仍无 `列12`）
 *   ⇒ 横排只覆盖 `(658, 987]` 这一段；更宽的块**不横排、不缩放**，由 `overflowWarning` 提醒兜底
 *   （超宽表方案仍在用户裁决中，见 `docs/tasks/Phase3-决策台账-2026-09-23.md` D-P3-2）。
 * - `pre` **不进这两张清单**：print.css 已让 pre 打印换行（P1-4(b)），长代码行不再被裁。
 */
export const PORTRAIT_PRINTABLE_PX = 658
export const LANDSCAPE_PRINTABLE_PX = 987

/** 块的内容宽（CSS px）：优先量内部 `table` 的自然宽，回退到容器自身 scrollWidth。
 *  屏显时容器可能比表宽（`overflow-x:auto` 的 wrap），故不能只看容器 scrollWidth。 */
export function blockContentWidth(container: Element): number {
  const table = container.querySelector('table')
  const tableWidth = table === null ? 0 : table.scrollWidth
  const wrapWidth = container instanceof HTMLElement ? container.scrollWidth : 0
  return Math.max(tableWidth, wrapWidth)
}

/** 给"竖版放不下、横版放得下"的块打横排标记（`@page wide`）。幂等：每次按当前宽度重算并清掉不合格者。
 *  返回被标记数量（供对账）。`page` 属性只影响打印，屏显零影响。 */
export function markLandscapeBlocks(root: ParentNode): number {
  let marked = 0
  for (const box of Array.from(root.querySelectorAll<HTMLElement>('.table-wrap'))) {
    const width = blockContentWidth(box)
    const fits = width > PORTRAIT_PRINTABLE_PX && width <= LANDSCAPE_PRINTABLE_PX
    box.classList.toggle('wide-page', fits)
    if (fits) {
      marked += 1
    }
  }
  return marked
}

/** 横版也放不下的块（只能提醒、**不横排不缩放**）：返回面向使用者的中文标签。 */
export function tooWideBlocks(root: ParentNode): string[] {
  const labels: string[] = []
  for (const box of Array.from(root.querySelectorAll<HTMLElement>('.table-wrap'))) {
    if (blockContentWidth(box) > LANDSCAPE_PRINTABLE_PX) {
      labels.push('宽表格')
    }
  }
  return labels
}

/** 拼"可能被截"的中文提醒（无风险返回 null）。文案面向使用者、不露技术黑话。 */
export function overflowWarning(labels: string[]): string | null {
  if (labels.length === 0) {
    return null
  }
  const kinds = Array.from(new Set(labels)).join(' / ')
  return `本文档有 ${labels.length} 处表格比 A4 横版可印宽还宽（${kinds}），PDF 中可能被截断`
}
