/**
 * KaTeX auto-render 包装（D2 数学分隔符策略——财务场景，不可协商）。
 *
 * 只允许三种分隔符：$$…$$(display) / \(…\)(inline) / \[…\](display)。
 * 裸 $…$ 一律纯文本：$1,000 与 $2,000 是金额，不是公式（金额红线）。
 *
 * 顺序约束（v1.3 定序）：在 sanitize 之后、pangu 之前执行；
 * 输出写入传入的 detached 文档（DOMParser 产物），不触碰主文档。
 */
import renderMathInElement from 'katex/contrib/auto-render'

const DELIMITERS: Array<{ left: string; right: string; display: boolean }> = [
  { left: '$$', right: '$$', display: true },
  { left: '\\(', right: '\\)', display: false },
  { left: '\\[', right: '\\]', display: true },
]

/** 对 detached 文档的 body 做公式渲染；解析失败的单个公式保留原文，不中断整篇 */
export function renderMath(doc: Document): void {
  renderMathInElement(doc.body, {
    delimiters: DELIMITERS,
    errorCallback: (msg, err) => {
      console.warn('公式渲染失败，已保留原文：', msg, err)
    },
  })
}
