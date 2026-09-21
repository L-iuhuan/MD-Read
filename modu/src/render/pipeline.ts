/**
 * 渲染管线总装（Lane A 唯一入口，main.ts 只认这里的 renderDocument）。
 *
 * 顺序写死（v1.3 定序约束，不得调整）：
 *   mathprotect.extract → md.render → mathprotect.restore → DOMPurify
 *   → DOMParser → KaTeX auto-render → pangu(默认开) → tok-break
 *   → outline 提取 → body.innerHTML
 *
 * 为什么是这个顺序：
 * - cjk-gap / tok-break 的空 span 必须在 sanitize 之后插入，消毒配置无需
 *   为排版产物开口子；
 * - KaTeX 的 MathML 输出（semantics/annotation）不回炉消毒，避免被剥；
 * - pangu 必须先于 tok-break（demo 踩坑：反序丢「号|t」处插空）；
 * - outline 在全部后处理之后提取，id/data-line 已就位，文本即所见。
 */
import { md } from './markdown'
import { sanitizeHtml } from './sanitize'
import { renderMath } from './math'
import { extractMath, restoreMath } from './mathprotect'
import { applyPangu } from './pangu'
import { wrapLongTokens } from './tokbreak'

/** 大纲条目：level=1..6；line 为 1-based 源码行号（data-line） */
export interface OutlineItem {
  level: number
  text: string
  id: string
  line: number
}

export interface RenderResult {
  html: string
  outline: OutlineItem[]
}

export interface RenderOptions {
  /** 中西文插空开关，默认 true（false 供 A/B 对照与排查） */
  pangu?: boolean
}

/** 从最终 DOM 提取 h1-h6 大纲（level/文本/锚点 id/源码行号） */
function extractOutline(root: Element): OutlineItem[] {
  const out: OutlineItem[] = []
  for (const el of Array.from(root.querySelectorAll('h1, h2, h3, h4, h5, h6'))) {
    const lineAttr = el.getAttribute('data-line')
    const item: OutlineItem = {
      level: Number.parseInt(el.tagName.slice(1), 10),
      text: (el.textContent ?? '').trim(),
      id: el.id,
      line: lineAttr === null ? 0 : Number.parseInt(lineAttr, 10),
    }
    out.push(item)
  }
  return out
}

/** 渲染一篇 Markdown 源文：返回安全 HTML 与大纲 */
export function renderDocument(src: string, opts?: RenderOptions): RenderResult {
  // M1-E2 数学保护（顺序写死，不得调整）：extract 必须在 md.render 之前
  // （否则 \( 被 markdown-it 反斜杠转义吃掉）；restore 必须在 render 之后、
  // sanitize 之前——占位符是纯字母数字，还原文本已做 HTML 实体转义，
  // 两者都 sanitize 安全，不给 DOMPurify 开口子。
  const guards = extractMath(src)
  const raw = restoreMath(md.render(guards.text), guards)
  const clean = sanitizeHtml(raw)
  const doc = new DOMParser().parseFromString(clean, 'text/html')
  renderMath(doc)
  if (opts?.pangu !== false) {
    applyPangu(doc, doc.body)
  }
  wrapLongTokens(doc, doc.body)
  return { html: doc.body.innerHTML, outline: extractOutline(doc.body) }
}
