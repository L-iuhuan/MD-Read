/**
 * 渲染管线断言（Lane A 验收语料：tests/corpus/语料.md）。
 * 断言组①-⑧ 与任务书逐条对应，金额红线为硬判据；
 * ⑧ 为 M1-E2 回归（mathprotect + emoji 扩词）。
 */
import { describe, expect, it } from 'vitest'
import { renderDocument } from '../src/render/pipeline'
// 语料经 Vite ?raw 内联为字符串（jsdom 环境下 import.meta.url 非 file 协议，不走 fs）
import corpusSrc from './corpus/语料.md?raw'

const src: string = corpusSrc

function parse(html: string): Document {
  return new DOMParser().parseFromString(html, 'text/html')
}

/** 标记串在语料中的 1-based 行号（与 data-line 同口径） */
function lineOf(marker: string): number {
  const idx = src.indexOf(marker)
  expect(idx, `语料应包含标记行：${marker}`).toBeGreaterThanOrEqual(0)
  return src.slice(0, idx).split('\n').length
}

const { html, outline } = renderDocument(src)
const doc = parse(html)

describe('① 金额红线（D2）', () => {
  it('金额三串不被 .tok-break 包裹', () => {
    const toks = [...doc.querySelectorAll('.tok-break')].map((e) => e.textContent ?? '')
    expect(toks.some((t) => t.includes('1,000'))).toBe(false)
    expect(toks.some((t) => t.includes('12,345'))).toBe(false)
    expect(toks.some((t) => t.includes('$'))).toBe(false)
  })

  it('金额串以纯文本完整存在', () => {
    const text = doc.body.textContent ?? ''
    expect(text).toContain('$1,000 与 $2,000')
    expect(text).toContain('¥12,345.67')
    expect(text).toContain('裸 $x$ 不是公式')
  })

  it('货币与数字之间没有 cjk-gap', () => {
    const currency = '$¥€£＄￥'
    for (const gap of doc.querySelectorAll('.cjk-gap')) {
      const prevSib = gap.previousSibling
      const nextSib = gap.nextSibling
      const prev = prevSib !== null && prevSib.nodeType === 3 ? (prevSib.textContent ?? '').slice(-1) : ''
      const next = nextSib !== null && nextSib.nodeType === 3 ? (nextSib.textContent ?? '')[0] ?? '' : ''
      const curThenDigit = currency.includes(prev) && /[0-9]/.test(next)
      const digitThenCur = /[0-9]/.test(prev) && currency.includes(next)
      expect(curThenDigit || digitThenCur, '货币与数字之间禁止插空').toBe(false)
    }
  })
})

describe('② 数学分隔符（D2：仅 $$ / \\( \\) / \\[ \\]）', () => {
  it('$$…$$ → .katex-display；\\(…\\) → .katex', () => {
    expect(doc.querySelectorAll('.katex-display').length).toBe(1)
    // 3 个行内（x_i、C_t、混排锚点 P）+ 块级内部的 1 个 .katex
    expect(doc.querySelectorAll('.katex').length).toBe(4)
  })

  it('裸 $x$ 保持纯文本', () => {
    const katexText = [...doc.querySelectorAll('.katex')].map((e) => e.textContent ?? '').join('')
    expect(katexText.includes('$x$')).toBe(false)
    expect(doc.body.textContent).toContain('裸 $x$ 不是公式')
  })
})

describe('③ 长技术串断行', () => {
  it('≥16 字符长 token 被 .tok-break 包裹', () => {
    const toks = [...doc.querySelectorAll('.tok-break')].map((e) => e.textContent ?? '')
    expect(toks).toContain('transform_request_id_20260921')
    expect(toks).toContain('fx_hedge_position_id_2026A')
  })

  it('行内 code 不跳过、块级 pre 跳过（幂等前提）', () => {
    expect(doc.querySelectorAll('code .tok-break').length).toBe(1)
    expect(doc.querySelectorAll('pre .tok-break').length).toBe(0)
  })
})

describe('④ pangu 非破坏', () => {
  it('开/关两次渲染 textContent 逐字节相同', () => {
    const on = renderDocument(src, { pangu: true })
    const off = renderDocument(src, { pangu: false })
    expect(parse(on.html).body.textContent).toBe(parse(off.html).body.textContent)
    expect(on.html).toBe(html) // 默认即开启，且渲染确定性
  })

  it('cjk-gap 存在且全部为空 span', () => {
    const gaps = doc.querySelectorAll('.cjk-gap')
    expect(gaps.length).toBeGreaterThan(0)
    for (const g of gaps) {
      expect(g.textContent).toBe('')
      expect(g.childNodes.length).toBe(0)
    }
  })
})

describe('⑤ 安全（D6：html:false + DOMPurify）', () => {
  it('输出无 script 标签', () => {
    expect(doc.querySelectorAll('script').length).toBe(0)
    expect(html.toLowerCase()).not.toContain('<script')
  })
})

describe('⑥ 标题锚点与块级定位（D1）', () => {
  it('所有标题都有 id + data-line', () => {
    const hs = doc.querySelectorAll('h1, h2, h3, h4, h5, h6')
    expect(hs.length).toBeGreaterThanOrEqual(5)
    for (const h of hs) {
      expect(h.id, '标题应有 CJK-safe 锚点 id').not.toBe('')
      expect(h.hasAttribute('data-line'), '标题应有块级 data-line').toBe(true)
    }
  })

  it('outline 的 level/id/line 与 DOM 及源码一致', () => {
    const line = lineOf('## 数据表')
    const item = outline.find((o) => o.text === '数据表')
    expect(item).toBeDefined()
    expect(item?.level).toBe(2)
    expect(item?.line).toBe(line)
    const dom = doc.querySelector(`h2[data-line="${line}"]`)
    expect(dom?.id).toBe(item?.id)
    expect(outline[0]?.text).toBe('墨读渲染管线语料')
    expect(outline[0]?.level).toBe(1)
    expect(outline[0]?.line).toBe(1)
  })
})

describe('⑦ GFM 结构件', () => {
  it('表格：thead + 2 行 tbody', () => {
    expect(doc.querySelector('table thead')).toBeTruthy()
    expect(doc.querySelectorAll('tbody tr').length).toBe(2)
  })

  it('任务列表：2 个 disabled checkbox', () => {
    expect(doc.querySelectorAll('input[type="checkbox"][disabled]').length).toBe(2)
  })

  it('脚注：引用 + 落地区', () => {
    expect(doc.querySelector('.footnote-ref')).toBeTruthy()
    expect(doc.querySelector('section.footnotes')).toBeTruthy()
  })

  it('emoji 短码：:) 与 :fire:', () => {
    expect(doc.body.textContent).toContain('😄')
    expect(doc.body.textContent).toContain('🔥')
  })

  it('typographer：直引号转中文弯引号', () => {
    expect(html).toContain('“')
    expect(html).toContain('”')
  })

  it('代码块：ts 定向高亮、无语言纯转义、mermaid 图占位', () => {
    const tsPre = doc.querySelector('pre[data-lang="ts"]')
    expect(tsPre?.querySelector('code.language-ts.hljs')).toBeTruthy()
    expect(tsPre?.querySelectorAll('[class^="hljs-"]').length).toBeGreaterThan(0)
    const plain = [...doc.querySelectorAll('pre:not([data-lang])')]
    expect(plain.length).toBe(1)
    expect(plain[0].querySelectorAll('[class^="hljs-"]').length).toBe(0)
    expect(doc.querySelector('div.mermaid')?.textContent).toContain('graph TD')
  })
})

describe('⑧ M1-E2 回归（mathprotect + emoji 扩词）', () => {
  it('单反斜杠 \\(x_i\\) 渲染为 .katex（真实语法回归，双反斜杠旧写法已废）', () => {
    const katexText = [...doc.querySelectorAll('.katex')].map((e) => e.textContent ?? '').join('')
    expect(katexText).toContain('x_i')
    expect(katexText).toContain('C_t')
    // 若保护失效，markdown-it 会把 \( 转义吃掉，正文露出 (x_i)
    expect(doc.body.textContent).not.toContain('(x_i)')
  })

  it('混排行：\\(P\\) 渲染、$1,000 仍纯文本（金额不误伤）', () => {
    expect(doc.body.textContent).toContain('权利金 $1,000')
    const katexText = [...doc.querySelectorAll('.katex')].map((e) => e.textContent ?? '').join('')
    expect(katexText.includes('$1,000')).toBe(false)
  })

  it(':dart: → 🎯（短码表扩词）', () => {
    const dart = parse(renderDocument('目标 :dart: 达成').html)
    expect(dart.body.textContent).toContain('🎯')
  })

  it('MoDuMathGuard 占位符零残留（还原完整性，pangu 开/关双路径）', () => {
    expect(html).not.toContain('MoDuMathGuard')
    expect(renderDocument(src, { pangu: false }).html).not.toContain('MoDuMathGuard')
  })
})

describe('⑨ P5 批3 fragment 路径（摘双重解析）', () => {
  it('fragment 与 html 等价：fragment 克隆序列化 === html 字段（逐字节）', () => {
    const r = renderDocument(src)
    const box = document.createElement('div')
    box.append(...Array.from(r.fragment.childNodes).map((n) => n.cloneNode(true)))
    expect(box.innerHTML).toBe(r.html)
    expect(box.querySelectorAll('*').length)
      .toBe(parse(r.html).body.querySelectorAll('*').length)
  })

  it('html 惰性但确定：先取 fragment 后取 html 仍与模块级基准一致', () => {
    const r = renderDocument(src)
    expect(r.fragment.children.length).toBeGreaterThan(0) // 未访问 html 前 fragment 完整
    expect(r.html).toBe(html) // 渲染确定性 + 惰性序列化与旧 body.innerHTML 等价
  })

  it('fragment 已含全部后处理产物（cjk-gap / tok-break / katex / 标题锚点）', () => {
    const r = renderDocument(src)
    expect(r.fragment.querySelectorAll('.cjk-gap').length).toBeGreaterThan(0)
    expect(r.fragment.querySelectorAll('.tok-break').length).toBeGreaterThan(0)
    expect(r.fragment.querySelectorAll('.katex').length).toBe(4)
    const h1 = r.fragment.querySelector('h1')
    expect(h1?.getAttribute('data-line')).toBe('1')
    expect(h1?.id).toBe(outline[0]?.id)
  })
})

/* P0-5：宽表/大图撑破纸面。CSS（cjk.css 的 .table-wrap 横向滚动）只有在渲染层
   真的生成包裹层时才生效——本组就是「包裹层由管线产出」的正向锚。 */
describe('⑩ 表格包裹层（P0-5）', () => {
  it('语料表格：每个 table 都有 .table-wrap 父层（无裸 table 漏网）', () => {
    const tables = [...doc.querySelectorAll('table')]
    expect(tables.length).toBeGreaterThan(0)
    for (const table of tables) {
      expect(table.parentElement?.classList.contains('table-wrap')).toBe(true)
    }
    expect(doc.querySelectorAll('.table-wrap').length).toBe(tables.length)
    expect(doc.querySelector('.table-wrap > table thead')).toBeTruthy()
  })

  it('HTML 字符串（挂载方实际拿到的形态）里 wrap 与 table 首尾相接', () => {
    const wraps = doc.querySelectorAll('.table-wrap').length
    expect(html).toMatch(/<div class="table-wrap"><table[\s>]/)
    expect((html.match(/<div class="table-wrap"><table[\s>]/g) ?? []).length).toBe(wraps)
    expect((html.match(/<\/table>\s*<\/div>/g) ?? []).length).toBe(wraps)
    expect(html).not.toMatch(/<div class="table-wrap"><div class="table-wrap">/)
  })

  it('包裹层不吃掉块级定位：table 仍带 data-line', () => {
    const table = doc.querySelector('.table-wrap > table')
    const line = lineOf('| 科目 |')
    expect(table?.getAttribute('data-line')).toBe(String(line))
  })

  it('多表：每张表各自成 wrap（不是只包第一张）', () => {
    const multi = renderDocument(
      [
        '| A | B |', '| --- | --- |', '| 1 | 2 |',
        '',
        '中间段落。',
        '',
        '| C | D |', '| --- | --- |', '| 3 | 4 |',
      ].join('\n'),
    )
    const box = parse(multi.html)
    expect(box.querySelectorAll('table').length).toBe(2)
    expect(box.querySelectorAll('.table-wrap').length).toBe(2)
    for (const wrap of box.querySelectorAll('.table-wrap')) {
      expect(wrap.querySelector('table')?.parentElement).toBe(wrap)
      expect(wrap.querySelectorAll('table').length).toBe(1)
    }
  })

  it('嵌套场景：引用块 / 列表内的表格同样被包裹（token 规则，非字符串 hack）', () => {
    const nested = renderDocument(
      [
        '> | 引用列 | 值 |',
        '> | --- | --- |',
        '> | 甲 | 1 |',
        '',
        '- 列表项：',
        '',
        '  | 列表列 | 值 |',
        '  | --- | --- |',
        '  | 乙 | 2 |',
      ].join('\n'),
    )
    const box = parse(nested.html)
    expect(box.querySelectorAll('table').length).toBe(2)
    expect(box.querySelector('blockquote .table-wrap > table')).toBeTruthy()
    expect(box.querySelector('li .table-wrap > table')).toBeTruthy()
    expect(box.querySelectorAll('blockquote table, li table').length).toBe(2)
  })

  it('fragment 路径同源：包裹层在挂载用的 fragment 里就已就位', () => {
    const r = renderDocument('| A | B |\n| --- | --- |\n| 1 | 2 |')
    expect(r.fragment.querySelectorAll('.table-wrap > table').length).toBe(1)
  })
})
