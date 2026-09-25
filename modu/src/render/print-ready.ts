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
