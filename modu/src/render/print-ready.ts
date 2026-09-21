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
 * - 超时（默认 10s）放行并返回 { timedOut: true }，由调用方在状态栏提示，
 *   不放行会把导出按钮卡死在极端文档上。
 */

export interface PrintReadyResult {
  timedOut: boolean
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

async function defaultRenderPending(el: HTMLElement): Promise<void> {
  const { renderMermaidEl } = await import('./mermaid')
  await renderMermaidEl(el)
}

/**
 * 等待容器渲染完备（Mermaid 全定稿 + KaTeX 布局两帧稳定）。
 * 超时放行：返回 { timedOut: true } 供调用方提示「按当前版式导出」。
 */
export async function awaitPrintReady(
  container: ParentNode,
  options: PrintReadyOptions = {},
): Promise<PrintReadyResult> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS
  const render = options.renderPending ?? defaultRenderPending
  // 先点火未定稿的懒加载图（fire-and-forget；失败占位也算定稿，卡死由超时兜底）
  void Promise.allSettled(pendingMermaid(container).map((el) => render(el)))
  await twoRafFrames()
  const deadline = Date.now() + timeoutMs
  while (pendingMermaid(container).length > 0) {
    if (Date.now() >= deadline) {
      return { timedOut: true }
    }
    await sleep(POLL_MS)
  }
  return { timedOut: false }
}
