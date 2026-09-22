/**
 * 视图增强纯逻辑断言（M1 批2）。jsdom 无布局测量，不测 fitMathBlock/guardJustify
 * 的几何路径，只测：mermaid 主题名映射、justify 预筛与候选排除、mermaid 的
 * 错误路径 catch 行为与主题重画（动态 chunk 用 vi.mock 顶替，不打真实包）。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  mermaidThemeName,
  observeMermaid,
  refreshMermaidTheme,
  renderMermaidEl,
} from '../src/render/mermaid'
import { hasLongToken, justifyCandidates } from '../src/render/justify'

const mocks = vi.hoisted(() => ({
  initialize: vi.fn(),
  run: vi.fn((): Promise<void> => Promise.resolve()),
}))
vi.mock('mermaid', () => ({ default: mocks }))

function flush(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0))
}

describe('mermaid 主题名映射', () => {
  it('html[data-theme=dark] → dark，否则 default', () => {
    expect(mermaidThemeName(true)).toBe('dark')
    expect(mermaidThemeName(false)).toBe('default')
  })
})

describe('justify 预筛（≥8 字符 [A-Za-z0-9_-] 连续串）', () => {
  it('长技术串命中', () => {
    expect(hasLongToken('transform_request_id_20260921')).toBe(true)
    expect(hasLongToken('abcdefgh')).toBe(true) // 恰好 8 字符阈值
  })
  it('纯 CJK 与金额串不命中', () => {
    expect(hasLongToken('纯中文段落，标点与汉字之间断行机会遍布。')).toBe(false)
    expect(hasLongToken('$1,000 与 $2,000 共 ¥12,345.67')).toBe(false) // 最长连续段仅 3 字符
    expect(hasLongToken('abcdefg')).toBe(false) // 7 字符不命中
  })
})

describe('justify 候选块排除表', () => {
  it('普通段落入选；公式/任务列表/表格内块被排除', () => {
    const root = document.createElement('div')
    root.innerHTML = [
      '<p id="plain">普通段落</p>',
      '<p id="math"><span class="katex">x</span></p>',
      '<ul class="task-list"><li><input type="checkbox">待办</li></ul>',
      '<div class="table-wrap"><table><tr><td><p id="cell">格内</p></td></tr></table></div>',
      '<li id="li">列表项</li>',
    ].join('')
    const ids = justifyCandidates(root).map((el) => el.id)
    expect(ids).toContain('plain')
    expect(ids).toContain('li')
    expect(ids).not.toContain('math')
    expect(ids).not.toContain('cell')
    expect(ids.some((id) => id === '')).toBe(false) // 任务列表 li 无 id 且被排除
  })
})

describe('mermaid 渲染路径', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.run.mockImplementation((): Promise<void> => Promise.resolve())
    document.body.innerHTML = ''
  })

  it('渲染成功：落 data-rendered 并以 strict + 当前主题初始化', async () => {
    const el = document.createElement('div')
    el.className = 'mermaid'
    el.textContent = 'flowchart TD\nA-->B'
    document.body.appendChild(el)
    await renderMermaidEl(el)
    expect(el.getAttribute('data-rendered')).toBe('1')
    expect(el.getAttribute('data-mmd-error')).toBeNull()
    expect(mocks.initialize).toHaveBeenCalledWith(
      expect.objectContaining({ startOnLoad: false, securityLevel: 'strict' })
    )
  })

  it('渲染失败：catch 具体错误 → data-mmd-error 且保留源码文本', async () => {
    mocks.run.mockImplementation(() => Promise.reject(new Error('图语法有误')))
    const el = document.createElement('div')
    el.className = 'mermaid'
    el.textContent = 'flowchart TD\nA-->'
    document.body.appendChild(el)
    await renderMermaidEl(el)
    expect(el.getAttribute('data-mmd-error')).toBe('图表渲染失败：图语法有误')
    expect(el.textContent).toBe('flowchart TD\nA-->') // 源码文本不丢
    expect(el.getAttribute('data-rendered')).toBeNull()
  })

  it('refreshMermaidTheme：已渲染节点清 data-processed 后按新主题重 run', async () => {
    const el = document.createElement('div')
    el.className = 'mermaid'
    el.textContent = 'flowchart TD\nA-->B'
    document.body.appendChild(el)
    await renderMermaidEl(el)
    el.setAttribute('data-processed', 'true') // 模拟 mermaid.run 的落痕
    refreshMermaidTheme('dark')
    await flush()
    expect(mocks.initialize).toHaveBeenLastCalledWith(
      expect.objectContaining({ theme: 'dark' })
    )
    expect(mocks.run).toHaveBeenLastCalledWith(expect.objectContaining({ nodes: [el] }))
    expect(el.getAttribute('data-processed')).toBeNull()
    expect(el.getAttribute('data-rendered')).toBe('1')
  })
})

/* ---- 懒加载观察器（用户反馈批次·切标签后渲染失败修复）：
 *      单例 IO + 回调时 pending 复核 + renderMermaidEl 在途去重。
 *      jsdom 无 IntersectionObserver，测试用可驱动的假实现顶替。 ---- */

interface FakeEntry {
  target: HTMLElement
  isIntersecting: boolean
}

class FakeIO {
  static instances: FakeIO[] = []
  observe = vi.fn()
  unobserve = vi.fn()
  disconnect = vi.fn()
  callback: (entries: FakeEntry[], obs: FakeIO) => void
  constructor(cb: (entries: FakeEntry[], obs: FakeIO) => void) {
    this.callback = cb
    FakeIO.instances.push(this)
  }
  fire(entries: FakeEntry[]): void {
    this.callback(entries, this)
  }
}

describe('懒加载观察器（单例 + pending 复核 + 在途去重）', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.run.mockImplementation((): Promise<void> => Promise.resolve())
    vi.stubGlobal('IntersectionObserver', FakeIO as unknown as typeof IntersectionObserver)
    document.body.innerHTML = ''
  })

  /** 模块级单例：首次 observeMermaid 起一直复用同一实例（本文件内不自增） */
  function theObserver(): FakeIO {
    expect(FakeIO.instances.length).toBe(1)
    return FakeIO.instances[0] as FakeIO
  }

  it('observeMermaid：只观察未定稿节点，已渲染/已失败者不进观察名单', () => {
    const box = document.createElement('div')
    const pending = document.createElement('div')
    pending.className = 'mermaid'
    const done = document.createElement('div')
    done.className = 'mermaid'
    done.setAttribute('data-rendered', '1')
    const failed = document.createElement('div')
    failed.className = 'mermaid'
    failed.setAttribute('data-mmd-error', 'x')
    box.append(pending, done, failed)
    observeMermaid(box)
    const io = theObserver()
    expect(io.observe).toHaveBeenCalledTimes(1)
    expect(io.observe).toHaveBeenCalledWith(pending)
  })

  it('两次挂载共用同一单例（缓存重挂不再累积观察器）', () => {
    const box = document.createElement('div')
    const a = document.createElement('div')
    a.className = 'mermaid'
    box.appendChild(a)
    observeMermaid(box)
    observeMermaid(box)
    const io = theObserver()
    expect(io.observe).toHaveBeenCalledTimes(2) // 重复 observe 同节点幂等
  })

  it('相交回调：pending 节点触发渲染并 unobserve；已定稿节点的迟到回调不再渲染', async () => {
    const pending = document.createElement('div')
    pending.className = 'mermaid'
    pending.textContent = 'flowchart TD\nA-->B'
    document.body.appendChild(pending)
    const done = document.createElement('div')
    done.className = 'mermaid'
    done.setAttribute('data-rendered', '1')
    document.body.appendChild(done)
    observeMermaid(document.body)
    const io = theObserver()
    io.fire([
      { target: pending, isIntersecting: true },
      { target: done, isIntersecting: true }, // 陈旧观察器对已渲染节点的迟到回调
    ])
    expect(io.unobserve).toHaveBeenCalledWith(pending)
    expect(io.unobserve).toHaveBeenCalledWith(done)
    await flush()
    expect(mocks.run).toHaveBeenCalledTimes(1)
    expect(mocks.run).toHaveBeenCalledWith(expect.objectContaining({ nodes: [pending] }))
  })

  it('renderMermaidEl 在途去重：同节点并发两支只跑一次 run', async () => {
    let release: (() => void) | null = null
    mocks.run.mockImplementation(
      (): Promise<void> => new Promise((resolve) => { release = resolve })
    )
    const el = document.createElement('div')
    el.className = 'mermaid'
    el.textContent = 'flowchart TD\nA-->B'
    const p1 = renderMermaidEl(el)
    const p2 = renderMermaidEl(el) // 第二支（另一观察器的迟到回调）
    await flush() // initMermaid 是异步：让第一支走到 run 并挂起，第二支已确认走缓存
    expect(mocks.run).toHaveBeenCalledTimes(1)
    ;(release as unknown as () => void)()
    await Promise.all([p1, p2])
    expect(el.getAttribute('data-rendered')).toBe('1')
  })
})
