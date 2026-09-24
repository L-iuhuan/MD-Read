/**
 * KaTeX auto-render 包装（D2 数学分隔符策略——财务场景，不可协商）。
 *
 * 只允许三种分隔符：$$…$$(display) / \(…\)(inline) / \[…\](display)。
 * 裸 $…$ 一律纯文本：$1,000 与 $2,000 是金额，不是公式（金额红线）。
 *
 * 顺序约束（v1.3 定序）：在 sanitize 之后、pangu 之前执行；
 * 输出写入传入的 detached 文档（DOMParser 产物），不触碰主文档。
 *
 * CJK 伪公式降级（M2 波3 用户反馈）：用户真实文档里存在
 * `某项成本单价 = 四舍五入(该项金额合计 ÷ 该项数量合计, 保留 6 位小数)`
 * 这类含 CJK 的伪公式。实测 KaTeX 0.16 对 CJK 不抛 ParseError，而是走
 * strict:'warn'（unicodeTextInMathMode）+ cjk_fallback 数学排版——中文被
 * 按数学斜体间距拉扯、可读性差，用户观感即「渲染失败」。
 * 故在 auto-render 之前先把含任一 CJK 字符的公式片段剥掉定界符、
 * 包成 .math-fallback 弱化展示（块级加 --display 居中），
 * 绝不让定界符或 KaTeX 伪数学排版露在正文里。
 */
import renderMathInElement from 'katex/contrib/auto-render'

const DELIMITERS: Array<{ left: string; right: string; display: boolean }> = [
  { left: '$$', right: '$$', display: true },
  { left: '\\(', right: '\\)', display: false },
  { left: '\\[', right: '\\]', display: true },
]

/** CJK 判定：统一表意（含扩展A/兼容区）/ CJK 标点 / 全角形式——含任一即降级 */
const CJK_RE = /[\u3000-\u303f\u3400-\u9fff\uf900-\ufaff\uff01-\uff60]/

/** 与 auto-render 默认 ignoredTags 同步：源码态（pre/code）公式不参与降级 */
const IGNORED_TAGS = new Set(['script', 'noscript', 'style', 'textarea', 'pre', 'code'])

interface MathSpan {
  start: number
  end: number
  body: string
  display: boolean
}

/** text 内 from 起最早出现的成对定界符片段（无配对返回 null，与 auto-render 同语义） */
function findSpan(text: string, from: number): MathSpan | null {
  let best: MathSpan | null = null
  for (const d of DELIMITERS) {
    const at = text.indexOf(d.left, from)
    if (at === -1) continue
    const close = text.indexOf(d.right, at + d.left.length)
    if (close === -1) continue
    if (best === null || at < best.start) {
      best = {
        start: at,
        end: close + d.right.length,
        body: text.slice(at + d.left.length, close),
        display: d.display,
      }
    }
  }
  return best
}

/** 单文本节点降级：含 CJK 的公式片段剥定界符、包 .math-fallback；拉丁片段原样留给 auto-render */
function degradeNode(doc: Document, node: Text): void {
  const text = node.data
  let cursor = 0
  let frag: DocumentFragment | null = null
  for (;;) {
    const span = findSpan(text, cursor)
    if (span === null) break
    if (!CJK_RE.test(span.body)) {
      // 拉丁公式留给 auto-render：已开始拼装的部分把跳过区间照抄到该片段结尾
      //（定界符原样保留），否则这段文本会被静默丢弃
      if (frag !== null) frag.append(doc.createTextNode(text.slice(cursor, span.end)))
      cursor = span.end
      continue
    }
    if (frag === null) {
      // 首次建 fragment 时起点必须是**文本开头**，不能用 cursor（P0-1 修复）：
      // 此前可能已跳过若干个拉丁公式片段，而那时 frag 仍为 null、只推进了 cursor，
      // 于是 slice(cursor, …) 会把「开头 → 首个 CJK 公式」之间的正文连同拉丁公式
      // 一并静默删除（实测 '甲 \(x\) 乙 \(中文公式\) 丙' → " 乙 中文公式 丙"）。
      frag = doc.createDocumentFragment()
      frag.append(doc.createTextNode(text.slice(0, span.start)))
    } else {
      frag.append(doc.createTextNode(text.slice(cursor, span.start)))
    }
    const el = doc.createElement('span')
    // 块级用 span 而非 div：$$ 公式躺在 <p> 里，div 会在 innerHTML 重解析时劈开段落
    //（.math-fallback--display 由 app.css 置 display:block + 居中，视觉即块级）
    el.className = span.display ? 'math-fallback math-fallback--display' : 'math-fallback'
    el.textContent = span.body
    frag.append(el)
    cursor = span.end
  }
  if (frag !== null) {
    frag.append(doc.createTextNode(text.slice(cursor)))
    node.replaceWith(frag)
  }
}

/** 遍历 root 文本节点做 CJK 公式降级（先收集后改写，迭代器不被结构变更打断） */
function degradeCjkMath(doc: Document, root: Element): void {
  const walker = doc.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
    acceptNode(node: Node): number {
      const tag = node.parentElement?.tagName.toLowerCase() ?? ''
      return IGNORED_TAGS.has(tag) ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT
    },
  })
  const nodes: Text[] = []
  for (let n = walker.nextNode(); n !== null; n = walker.nextNode()) nodes.push(n as Text)
  for (const node of nodes) degradeNode(doc, node)
}

/** 对 detached 文档的 body 做公式渲染；CJK 伪公式先降级，真解析失败的单个公式保留原文 */
export function renderMath(doc: Document): void {
  // 性能早退（P3 基线诊断）：全文无任何定界符时跳过 CJK 预检与 auto-render
  // 两轮全树遍历（1MB 级无公式文档实测省约 0.5s；textContent 单遍原生扫描近乎零成本）
  const txt = doc.body.textContent ?? ""
  if (!txt.includes("$$") && !txt.includes("\\(") && !txt.includes("\\[")) {
    return
  }
  degradeCjkMath(doc, doc.body)
  renderMathInElement(doc.body, {
    delimiters: DELIMITERS,
    errorCallback: (msg, err) => {
      console.warn('公式渲染失败，已保留原文：', msg, err)
    },
  })
}
