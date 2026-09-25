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

import { renderMermaidEl } from './mermaid'

export interface PrintReadyResult {
  timedOut: boolean
  /** 字体就绪等待是否到时限放行（超时仍继续导出，只由调用方提示） */
  fontsTimedOut: boolean
  /** 未能出结果的图片（缺失/解码失败）清单，供调用方提示；空数组表示全部就绪 */
  imageFailures: string[]
}

export interface PrintReadyOptions {
  timeoutMs?: number
  /** 强渲单个未定稿 .mermaid；默认用 mermaid.ts 的 renderMermaidEl（**静态导入**：view.ts 已静态依赖它，动态导入拆不动包 —— 批次 3-6 实测）；本项是测试注入替身 */
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
  // ⚠ 这里原先是 `await import('./mermaid')`（**无效动态导入**，批次 3-6 实测）：
  //   `view.ts` 已静态导入 `./mermaid` ⇒ 该模块本就在首屏 chunk 里，动态导入拆不出任何东西，
  //   rolldown 会因此报 `INEFFECTIVE_DYNAMIC_IMPORT`。改成静态导入后**运行时零差异**。
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
 * 宽表横排 + 超宽表压列换行（2026-09-23 用户裁决：「宽表自动横向打印」+「④ 压列换行」；
 * 命名页机制写在 print.css）。
 *
 * **数值来历（不许当魔法数）**：
 * - `PORTRAIT_PRINTABLE_PX = 658`：A4 210mm − 2×18mm 边距 = 174mm，按 96dpi（3.7795px/mm）换算。
 *   纸型与边距是**实测/既定**的（`pdfinfo` 量到竖版 594.96×841.92pt = A4；18mm 来自 print.css 的
 *   `@page{margin:18mm}`）；**"174mm ⇒ 658px"这一步是推断**（按 CSS 96dpi 口径）。
 * - `LANDSCAPE_PRINTABLE_PX = 987`：297mm − 36mm = 261mm 同上换算（横版纸型实测 841.92×594.96pt）。
 * - 三层（实测支撑）：`w ≤ 658` 竖版自然宽；`658 < w ≤ 987` 横排即够（实测 734px 表横排后 6 列全印出）；
 *   `w > 987` 连横版都放不下（实测 1870px 表横排后仍丢列）⇒ 再叠加**压列换行**（`table-layout:fixed`）。
 * - `pre` **不进清单**：print.css 已让 pre 打印换行（P1-4(b)），长代码行不再被裁。
 * - **图片**也不需要：`.mdc img { max-inline-size: 100% }` 已存在（复核过）。
 * - 因此「可能被截」的提醒**已无真实触发条件**，于 2026-09-23 随本改动**删除**（不留会撒谎的提示）。
 */
export const PORTRAIT_PRINTABLE_PX = 658
export const LANDSCAPE_PRINTABLE_PX = 987

/**
 * 块的**内容宽**（CSS px，`w` 判据就靠它）：量**表自身的 `min-content` 宽**。
 *
 * 为什么必须是 min-content 而不是 scrollWidth：
 * - `.mdc table { inline-size: 100% }` ⇒ 任何表在屏显上都会被**撑到容器宽**（本机 ~734px），
 *   于是 `wrap.scrollWidth / table.scrollWidth` 对"小表"和"宽表"读数一样 —— 实测踩过：
 *   一张 3 列小表被测成 734px ⇒ 被判成宽表。
 * - 分页媒体按**纸宽重新排版**：只要表的 min-content ≤ 可印宽，auto 布局就能靠换行装下（不裁）；
 *   只有 min-content > 可印宽时才会真被裁 ⇒ min-content 才是"会不会裁"的机理量。
 * - 实现：临时把 `inline-size` 设成 `min-content` 并**同步**读回宽度后立刻还原（同一任务内完成，
 *   不产生可见重排/闪烁）；`position:absolute` 之类的克隆会让样式继承走样，故不采用。
 * - jsdom 无真实布局（`getBoundingClientRect().width` 恒 0）⇒ 回退到 `table.scrollWidth`（测试可桩）。
 */
export function blockContentWidth(container: Element): number {
  const table = container.querySelector('table')
  if (table === null) {
    return container instanceof HTMLElement ? container.scrollWidth : 0
  }
  const el = table as HTMLElement
  const previous = el.style.inlineSize
  el.style.inlineSize = 'min-content'
  const measured = el.getBoundingClientRect().width
  el.style.inlineSize = previous
  return measured > 0 ? measured : el.scrollWidth
}

/**
 * 导出前给表格打打印标记（幂等：按当前宽度重算并清掉旧标记；`page` 只作用于打印，屏显零影响）：
 * - `wide-page`（`w > 658`）：竖版放不下 → 走 `@page wide` 横排（横版可印宽 987）；
 * - `squeeze-page`（`w > 987`）：连横版都放不下 → 叠加 `table-layout:fixed` 压列换行，
 *   让整表收敛到可印宽内（用户裁决 ④「压列换行」）。
 * 返回计数 `{ landscape, squeeze }` 供对账。
 */
export function markPrintBlocks(root: ParentNode): { landscape: number; squeeze: number } {
  let landscape = 0
  let squeeze = 0
  for (const box of Array.from(root.querySelectorAll<HTMLElement>('.table-wrap'))) {
    const width = blockContentWidth(box)
    const needsLandscape = width > PORTRAIT_PRINTABLE_PX
    const needsSqueeze = width > LANDSCAPE_PRINTABLE_PX
    box.classList.toggle('wide-page', needsLandscape)
    box.classList.toggle('squeeze-page', needsSqueeze)
    if (needsLandscape) {
      landscape += 1
    }
    if (needsSqueeze) {
      squeeze += 1
    }
  }
  return { landscape, squeeze }
}
