/**
 * DOMPurify 消毒（D6：html:false 之外的第二道防线，渲染管线必过）。
 * USE_PROFILES 三套全开（html/svg/mathMl）+ KaTeX MathML 注记标签放行，
 * ADD_ATTR 放行 target/rel（外链在新窗口打开的后续需求），data-* 默认保留
 * （data-line / data-lang 依赖此默认行为）。
 *
 * ALLOW_URI_REGEXP（2026-10-01 全形态链接排查）：在 DOMPurify 默认正则上放行
 * file: 协议——本地文件链接（file:/// 与盘符重写形态）需要它通过 href 属性。
 * 安全账：点击走 links.ts 自家拦截器 → openMd → openPath 受信校验（fail-closed，
 * 与相对链接同一安全面）；raw file: 导航被 nav-guard 拦（不在站点白名单）；
 * CSP（script-src 'self'）不因 file: 获得任何执行能力。放行的只是「href 属性存在」。
 */
import DOMPurify from 'dompurify'

const purifier = typeof window === 'undefined' ? null : DOMPurify(window)

/** DOMPurify 默认 URI 正则 + file:（其余保持原样，不放宽） */
const URI_WITH_FILE = /^(?:(?:(?:f|ht)tps?|mailto|tel|callto|sms|cid|xmpp|file):|[^a-z]|[a-z+.\-]+(?:[^a-z+.\-:]|$))/i

/** 把 markdown-it 输出的 HTML 字符串消毒为安全 HTML 字符串 */
export function sanitizeHtml(html: string): string {
  if (purifier === null || !purifier.isSupported) {
    throw new Error('当前环境不支持 DOMPurify，为安全起见已中止文档渲染')
  }
  return purifier.sanitize(html, {
    USE_PROFILES: { html: true, svg: true, mathMl: true },
    ADD_TAGS: ['semantics', 'annotation'],
    ADD_ATTR: ['target', 'rel'],
    ALLOWED_URI_REGEXP: URI_WITH_FILE,
  })
}
