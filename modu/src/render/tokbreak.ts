/**
 * 长技术串智能断行（M1 工程规则：渲染管线后处理）。
 * 移植自 docs/demo/排版demo.html 的 wrapLongTokens。
 *
 * ≥16 字符的连续 [A-Za-z0-9_-] 视为「无语义断点的技术串」（如
 * transform_request_id_20260921），包一层 span.tok-break 允许任意字符处断行。
 * 金额天然安全：逗号与小数点把数字切成 ≤3 字符短段，永远不会命中。
 *
 * 必须在 pangu 之后跑（demo 踩坑结论）：pangu 先把「号|t」边界切开插空，
 * 长串成为独立文本节点后再包裹；反序会让那处插空丢失。
 *
 * 幂等：跳过已有 .tok-break 的祖先，重复调用不二次包裹。
 * 行内 <code> 不跳过——正文里的标识符正是要断的对象。
 */
const TOK_SKIP_TAGS: ReadonlySet<string> = new Set([
  'PRE', 'SCRIPT', 'STYLE', 'TEXTAREA', 'SVG',
])

const RE_LONG_TOKEN = /[A-Za-z0-9_-]{16,}/g

function tokSkip(node: Node): boolean {
  for (let p = node.parentElement; p !== null; p = p.parentElement) {
    if (TOK_SKIP_TAGS.has(p.tagName)) return true
    if (
      p.classList.contains('katex') ||
      p.classList.contains('mermaid') ||
      p.classList.contains('tok-break') ||
      p.hasAttribute('data-no-tok-break')
    ) {
      return true
    }
  }
  return false
}

/** 把命中长串的文本节点切成「普通文本 / span.tok-break」交替序列，返回包裹数 */
export function wrapLongTokens(doc: Document, root: Element): number {
  const walker = doc.createTreeWalker(root, NodeFilter.SHOW_TEXT, null)
  const nodes: Text[] = []
  while (walker.nextNode() !== null) {
    const node = walker.currentNode as Text
    if (!tokSkip(node)) nodes.push(node)
  }
  let count = 0
  for (const node of nodes) {
    const text = node.data
    if (text.search(RE_LONG_TOKEN) === -1) continue
    const token = new RegExp(RE_LONG_TOKEN.source, 'g') // 局部实例，幂等且无状态串扰
    const frag = doc.createDocumentFragment()
    let last = 0
    let m: RegExpExecArray | null
    while ((m = token.exec(text)) !== null) {
      if (m.index > last) {
        frag.appendChild(doc.createTextNode(text.slice(last, m.index)))
      }
      const span = doc.createElement('span')
      span.className = 'tok-break'
      span.textContent = m[0]
      frag.appendChild(span)
      last = m.index + m[0].length
      count++
    }
    if (last < text.length) {
      frag.appendChild(doc.createTextNode(text.slice(last)))
    }
    node.parentElement?.replaceChild(frag, node)
  }
  return count
}
