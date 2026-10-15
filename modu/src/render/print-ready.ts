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
import { restoreSlicedTables, sliceTableWrap } from './table-slice'

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
 * 宽表四档导出（2026-10-15 主人批准，业界调研背书；取代 2026-09-23 三档——旧
 * wide-page 无消费者退役，横排职责并入 squeeze-page，机制注释与 mm 推导线写在 print.css）。
 *
 * **数值来历（不许当魔法数；与 print.css 的 mm 注释同源耦合，改任一边必须同步另一边）**：
 * - `PORTRAIT_PRINTABLE_PX = 658`：A4 210mm − 2×18mm = 174mm，按 96dpi（3.7795px/mm）换算。
 *   纸型与边距是**实测/既定**的（`pdfinfo` 量到竖版 594.96×841.92pt = A4；18mm 来自 print.css
 *   的 `@page{margin:18mm}`）；**"174mm ⇒ 658px"这一步是推断**（按 CSS 96dpi 口径）。
 * - `LANDSCAPE_PRINTABLE_PX = 987`：297mm − 36mm = 261mm 同上换算（横版纸型实测 841.92×594.96pt）。
 * - 四档判据（测量口径不变：表自身 min-content 宽 w，见 blockContentWidth）：
 *   T1 `w ≤ 830` 竖版页内压列（`print-wrap`）；T2 `830 < w ≤ 1030` 竖版缩放＋出血
 *   （`print-zoom`＋`print-bleed`）；T3 `1030 < w ≤ 1400` 横排压列（`squeeze-page`）；
 *   T4 `w > 1400` 横排分栏切片（`squeeze-page`＋`table-sliced`，切片器在 table-slice.ts）。
 * - 830 ≈ 658×1.26：压列后列宽损失容忍上限（fixed 等分布局把 1.26 倍以内的宽表压进
 *   658px 竖版可印宽仍可读）。
 * - 771 = (174+30)mm@96dpi：T2 出血后的有效宽（借 @page 18mm 边距两侧各 15mm ⇒ 204mm，
 *   余 3mm 安全边）。`--print-zoom = clamp(0.75, 771/w, 1)`；0.75 为可读下限 ⇒
 *   T2 上限 = 771/0.75 ≈ 1028 → 取 1030。
 * - 1400 ≈ 987/0.705：横排压列比（987/w）跌破 ~0.7 ⇒ 列过窄，改切片（每段目标
 *   ≤950px，见 table-slice.ts 的 SLICE_SEGMENT_BUDGET_PX）。
 * - **禁 transform 缩放**（调研源码级证据：打印高度错算）；zoom 参与重排、Chromium 打印
 *   验证有效（与 UX-9 的 .print-tall 同一工艺）。
 */
export const PORTRAIT_PRINTABLE_PX = 658
export const LANDSCAPE_PRINTABLE_PX = 987
/**
 * UX-9（des-5·P2-15）：A4 竖版**可印高**——297mm − 2×18mm = 261mm，按 96dpi
 * （3.7795px/mm）换算 ≈ 986px。与 LANDSCAPE_PRINTABLE_PX 是同一物理长度 261mm，
 * 只是那边量的是横版**宽**、这里量的是竖版**高**（纸型与边距均实测/既定，同顶部注释）。
 */
export const PORTRAIT_PRINTABLE_HEIGHT_PX = 986
/** 缩放下限：低于 0.4 字号不足 6.4pt，再小不可读——不如保持原尺寸让截断可见。 */
export const PRINT_FIT_MIN = 0.4
/** T1 上限：830 ≈ 658×1.26（压列后列宽损失容忍上限，推导见文件顶四档注释）。 */
export const PRINT_WRAP_MAX_PX = 830
/** T2 上限：1030 ≈ 771/0.75（zoom 可读下限对应的分母，771 为出血后有效宽）。 */
export const PRINT_ZOOM_MAX_PX = 1030
/** T3 上限 / T4 下限：1400 ≈ 987/0.705（横排压列比跌破 ~0.7 改切片）。 */
export const PRINT_SLICE_MIN_PX = 1400
/** T2 出血后有效宽：771px = (174+30)mm@96dpi（两侧各借 15mm，余 3mm 安全边）。 */
export const PRINT_ZOOM_FIT_PX = 771
/** T2 zoom 可读下限（再小不如换档）。 */
export const PRINT_ZOOM_MIN = 0.75

export type PrintTier = 1 | 2 | 3 | 4

/** 纯判据：min-content 宽 → 四档（阈值写死于主人批准的四档规格，推导见文件顶注释）。 */
export function printTier(width: number): PrintTier {
  if (width <= PRINT_WRAP_MAX_PX) {
    return 1
  }
  if (width <= PRINT_ZOOM_MAX_PX) {
    return 2
  }
  if (width <= PRINT_SLICE_MIN_PX) {
    return 3
  }
  return 4
}

/** T2 缩放比 = clamp(0.75, 771/w, 1)：恰好放进出血后 771px 有效宽；下限可读、上限不放大。 */
export function printZoomScale(naturalWidth: number): number {
  return Math.min(1, Math.max(PRINT_ZOOM_MIN, PRINT_ZOOM_FIT_PX / naturalWidth))
}

/**
 * UX-9（des-5·P2-15）·纯函数：超页高单体的打印缩放比。
 * `break-inside: avoid` 对**超过一页高**的单体（大 mermaid / 长图）无效——Chromium
 * 会硬裁。这里按「恰好放满可印高」算缩放比并 clamp 到下限 0.4；不超高返回 null
 * （不打标记、不缩放）。测量由 markPrintBlocks 负责（jsdom 布局恒 0 ⇒ 天然不触发）。
 */
export function printFitScale(height: number, printableHeight: number): number | null {
  if (height <= printableHeight) {
    return null
  }
  return Math.max(PRINT_FIT_MIN, printableHeight / height)
}

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

export interface PrintBlockCounts {
  /** T1 压列（print-wrap）表数 */
  wrap: number
  /** T2 缩放＋出血（print-zoom＋print-bleed）表数 */
  zoom: number
  /** T3/T4 横排压列（squeeze-page）表数 */
  squeeze: number
  /** T4 切片成功（≥2 段）的表数 */
  slice: number
  /** UX-9 超页高单体（print-tall）数 */
  tall: number
}

/**
 * 导出前按四档给表格打打印标记（幂等：每轮先还原上轮切片、摘掉全部档类，再按当前
 * 宽度重判；`page`/`zoom` 只作用于打印，屏显零影响）。UX-9（des-5·P2-15）追加不变：
 * `.mermaid svg` 与 `img` 超竖版可印高（986px）打 `print-tall` 并内联 `--print-fit`。
 * 返回计数供对账。最终 PDF 效果需人工验证（jsdom 无打印排版）。
 */
export function markPrintBlocks(root: ParentNode): PrintBlockCounts {
  restoreSlicedTables(root) // 幂等前置：还原上轮 T4 切片（原表一直在 DOM，重测口径不变）
  const counts: PrintBlockCounts = { wrap: 0, zoom: 0, squeeze: 0, slice: 0, tall: 0 }
  for (const box of Array.from(root.querySelectorAll<HTMLElement>('.table-wrap'))) {
    applyTableTier(box, blockContentWidth(box), counts)
  }
  for (const el of Array.from(root.querySelectorAll<HTMLElement>('.mermaid svg, img'))) {
    const fit = printFitScale(el.getBoundingClientRect().height, PORTRAIT_PRINTABLE_HEIGHT_PX)
    el.classList.toggle('print-tall', fit !== null)
    if (fit === null) {
      el.style.removeProperty('--print-fit')
    } else {
      el.style.setProperty('--print-fit', String(fit))
      counts.tall += 1
    }
  }
  return counts
}

/** 单表落档：四类互斥；先摘全部档类与内联变量再落新档（换档/变窄不残留）。 */
function applyTableTier(box: HTMLElement, width: number, counts: PrintBlockCounts): void {
  const tier = printTier(width)
  // 'wide-page' 是三档时代遗产类，这里顺带摘除以防旧标记残留（本函数不再产生它）
  box.classList.remove('print-wrap', 'print-zoom', 'print-bleed', 'squeeze-page', 'wide-page')
  box.style.removeProperty('--print-zoom')
  if (tier === 1) {
    box.classList.add('print-wrap')
    counts.wrap += 1
    return
  }
  if (tier === 2) {
    box.classList.add('print-zoom', 'print-bleed')
    box.style.setProperty('--print-zoom', String(printZoomScale(width)))
    counts.zoom += 1
    return
  }
  // T3/T4 共用 squeeze-page：page:wide（自 wide-page 迁移）+ 261mm 压列
  box.classList.add('squeeze-page')
  counts.squeeze += 1
  if (tier === 4 && sliceTableWrap(box, width) > 0) {
    counts.slice += 1
  }
}
