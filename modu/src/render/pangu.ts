/**
 * pangu 中西文间距（§4 D3 定案：白名单元素 + span.cjk-gap 非破坏方案）。
 * 移植自 docs/demo/排版demo.html 的 isolateMath / panguNode / applyPangu。
 *
 * 与 demo 的差异：
 * - 所有节点/片段由传入的 Document 创建（detached 文档自洽，不碰全局 document）；
 * - 跳过名单在 demo 基础上按任务书补了 a（链接文本不插空，保持链接可读性）。
 *
 * 红线（D2 金额保真）：货币符号 $¥€£＄￥ 只在「CJK ↔ 货币」边界参与匹配，
 * 与「货币 ↔ 数字」永不相邻配对——$1,000 与 ¥12,345.67 全程贴紧。
 */
const SKIP_TAGS: ReadonlySet<string> = new Set([
  'PRE', 'CODE', 'SCRIPT', 'STYLE', 'KBD', 'SAMP', 'TEXTAREA', 'SVG', 'A',
])

/** 数学分隔符隔离：把含 $$…$$ / \(…\) / \[…\] 的文本节点切段，插空不碰公式段 */
const RE_MATH = /(\$\$[\s\S]*?\$\$|\\\([\s\S]*?\\\)|\\\[[\s\S]*?\\\])/g

/**
 * 中西文边界（demo 2026-09-21 修订：货币符号纳入插空）。
 * 字符零增零减：空 span 不贡献任何字符，textContent 与原文逐字节相等。
 */
const RE_BOUNDARY = /[\u2E80-\u9FFF\uF900-\uFAFF][A-Za-z0-9$¥€£\uFF04\uFFE5]|[A-Za-z0-9$¥€£\uFF04\uFFE5][\u2E80-\u9FFF\uF900-\uFAFF]/g

function shouldSkip(node: Node): boolean {
  for (let p = node.parentElement; p !== null; p = p.parentElement) {
    if (SKIP_TAGS.has(p.tagName)) return true
    if (
      p.classList.contains('katex') ||
      p.classList.contains('mermaid') ||
      p.hasAttribute('data-no-pangu')
    ) {
      return true
    }
  }
  return false
}

/** 收集 root 下未被跳过的文本节点（先收集后改写，避免遍历中失效） */
function collectTextNodes(doc: Document, root: Element): Text[] {
  const walker = doc.createTreeWalker(root, NodeFilter.SHOW_TEXT, null)
  const out: Text[] = []
  while (walker.nextNode() !== null) {
    const node = walker.currentNode as Text
    if (!shouldSkip(node)) out.push(node)
  }
  return out
}

function isolateMath(doc: Document, root: Element): void {
  for (const node of collectTextNodes(doc, root)) {
    const text = node.data
    if (text.search(RE_MATH) === -1) continue
    const parts = text.split(RE_MATH)
    const frag = doc.createDocumentFragment()
    for (const part of parts) {
      if (part !== '') frag.appendChild(doc.createTextNode(part))
    }
    node.parentElement?.replaceChild(frag, node)
  }
}

/** 单个文本节点 →「文本片段 / 空 span.cjk-gap」交替序列 */
function panguNode(doc: Document, node: Text): number {
  const text = node.data
  if (text.search(RE_BOUNDARY) === -1) return 0
  const boundary = new RegExp(RE_BOUNDARY.source, 'g') // 局部实例，避免 lastIndex 串扰
  const frag = doc.createDocumentFragment()
  let count = 0
  let last = 0
  let m: RegExpExecArray | null
  while ((m = boundary.exec(text)) !== null) {
    if (m.index + 1 > last) {
      frag.appendChild(doc.createTextNode(text.slice(last, m.index + 1)))
    }
    const span = doc.createElement('span')
    span.className = 'cjk-gap'
    span.setAttribute('aria-hidden', 'true') // 纯装饰：读屏与复制都不应感知
    frag.appendChild(span)
    count++
    last = m.index + 1
    boundary.lastIndex = m.index + 1 // 相邻边界重叠匹配：A中B 两侧都要插
  }
  if (last < text.length) {
    frag.appendChild(doc.createTextNode(text.slice(last)))
  }
  node.parentElement?.replaceChild(frag, node)
  return count
}

/** 对 root 应用中西文插空，返回插入的空 span 数（0 表示无边界命中） */
export function applyPangu(doc: Document, root: Element): number {
  isolateMath(doc, root)
  let count = 0
  for (const node of collectTextNodes(doc, root)) {
    count += panguNode(doc, node)
  }
  return count
}
