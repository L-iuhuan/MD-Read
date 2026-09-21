/**
 * DOMPurify 消毒（D6：html:false 之外的第二道防线，渲染管线必过）。
 * USE_PROFILES 三套全开（html/svg/mathMl）+ KaTeX MathML 注记标签放行，
 * ADD_ATTR 放行 target/rel（外链在新窗口打开的后续需求），data-* 默认保留
 * （data-line / data-lang 依赖此默认行为）。
 */
import DOMPurify from 'dompurify'

const purifier = typeof window === 'undefined' ? null : DOMPurify(window)

/** 把 markdown-it 输出的 HTML 字符串消毒为安全 HTML 字符串 */
export function sanitizeHtml(html: string): string {
  if (purifier === null || !purifier.isSupported) {
    throw new Error('当前环境不支持 DOMPurify，为安全起见已中止文档渲染')
  }
  return purifier.sanitize(html, {
    USE_PROFILES: { html: true, svg: true, mathMl: true },
    ADD_TAGS: ['semantics', 'annotation'],
    ADD_ATTR: ['target', 'rel'],
  })
}
