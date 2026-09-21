/**
 * Mermaid 懒加载渲染（§2.1 F2）。demo 是整页立即渲染；懒加载 + 主题重画是工程实现。
 *
 * - IntersectionObserver 观察 .mermaid，首次相交才 `import('mermaid')`——vite 把
 *   动态 import 打成独立 chunk，从应用自身源加载（CSP script-src 'self' 兼容，
 *   无 CDN 请求），模块级 promise 缓存避免重复加载；
 * - 失败路径不弹窗：el 落 data-mmd-error 属性并保留源码文本（占位提示由
 *   CSS/属性承载）；
 * - refreshMermaidTheme：已渲染节点移除 data-processed 与 svg 后按新主题重 run。
 */

type AppTheme = 'dark' | 'light'
type MermaidTheme = 'dark' | 'default'
/** mermaid 默认导出的实例类型（mermaid 自带 TS 类型，直接取 typeof） */
type MermaidApi = typeof import('mermaid').default

let mermaidPromise: Promise<MermaidApi> | null = null
/** 主题切换时由 refreshMermaidTheme 显式指定；未指定时读 html[data-theme] */
let themeOverride: AppTheme | null = null

/** 主题名映射（纯函数）：html[data-theme=dark] → 'dark'，否则 'default' */
export function mermaidThemeName(isDark: boolean): MermaidTheme {
  return isDark ? 'dark' : 'default'
}

function currentMermaidTheme(): MermaidTheme {
  const dark = themeOverride === 'dark' || document.documentElement.dataset.theme === 'dark'
  return mermaidThemeName(dark)
}

function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message
  return String(err)
}

/** 模块级 promise 缓存；失败时清缓存，后续相交/换主题仍可重试 */
function loadMermaid(): Promise<MermaidApi> {
  if (mermaidPromise === null) {
    mermaidPromise = import('mermaid')
      .then((m) => m.default)
      .catch((err: unknown) => {
        mermaidPromise = null
        throw new Error(`图表模块加载失败：${errorMessage(err)}`)
      })
  }
  return mermaidPromise
}

async function initMermaid(): Promise<MermaidApi> {
  const api = await loadMermaid()
  api.initialize({
    startOnLoad: false,
    theme: currentMermaidTheme(),
    securityLevel: 'strict', // 渲染层按「已被攻陷」设防，与 demo 同款
  })
  return api
}

/** 渲染单个 .mermaid 节点。源码先存 data-src（run 会覆写文本），失败保留源码文本 */
export async function renderMermaidEl(el: HTMLElement): Promise<void> {
  const src = el.dataset.src ?? el.textContent ?? ''
  el.dataset.src = src
  try {
    const api = await initMermaid()
    await api.run({ nodes: [el] })
    el.setAttribute('data-rendered', '1')
  } catch (err) {
    el.textContent = src // 保留源码文本，读者仍可看原始定义
    el.setAttribute('data-mmd-error', `图表渲染失败：${errorMessage(err)}`)
  }
}

/** 观察 container 内 .mermaid：首次相交才加载渲染，未相交的图不花任何成本 */
export function observeMermaid(container: HTMLElement): void {
  if (typeof IntersectionObserver === 'undefined') return // 测试环境（jsdom）无此 API
  const pending = Array.from(container.querySelectorAll<HTMLElement>('.mermaid')).filter(
    (el) => el.dataset.rendered === undefined && el.dataset.mmdError === undefined
  )
  if (pending.length === 0) return
  const io = new IntersectionObserver(
    (entries, obs) => {
      for (const entry of entries) {
        if (!entry.isIntersecting) continue
        obs.unobserve(entry.target)
        void renderMermaidEl(entry.target as HTMLElement)
      }
    },
    { rootMargin: '200px 0px' } // 提前 200px 预渲染，滚动到时图已就绪
  )
  for (const el of pending) io.observe(el)
}

async function rerenderNodes(nodes: HTMLElement[]): Promise<void> {
  for (const el of nodes) {
    el.removeAttribute('data-rendered')
    el.removeAttribute('data-processed') // mermaid.run 靠它识别已处理节点
    el.removeAttribute('data-mmd-error')
    el.textContent = el.dataset.src ?? '' // 恢复源码，交给 run 重画 svg
  }
  try {
    const api = await initMermaid()
    await api.run({ nodes })
    for (const el of nodes) el.setAttribute('data-rendered', '1')
  } catch (err) {
    for (const el of nodes) el.setAttribute('data-mmd-error', `图表渲染失败：${errorMessage(err)}`)
  }
}

/** 主题切换后重画：已渲染节点按新主题（dark/light）重 run */
export function refreshMermaidTheme(theme: AppTheme): void {
  themeOverride = theme
  const nodes = Array.from(document.querySelectorAll<HTMLElement>('.mermaid[data-rendered="1"]'))
  if (nodes.length === 0) return
  void rerenderNodes(nodes)
}
