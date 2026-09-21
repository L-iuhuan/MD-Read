/**
 * markdown-it 引擎装配（Lane A·渲染管线第一站）。
 *
 * 决策依据 docs/specs/2026-09-21-墨读设计规格.md §4：
 * - D6 安全红线：html:false —— 渲染层按“已被攻陷”设防，内联 HTML 一律转义；
 * - D1 台账显式决策：breaks:true —— 阅读器语义，软换行即换行；
 * - D4 性能红线：禁 highlightAuto —— 无语言标注纯转义，不做猜测式高亮；
 * - D5：fence 规则移植自 参考/md-print-studio-wip.html L962-980，
 *   剔除其中 highlightAuto 分支（性能第一杀手）。
 */
import MarkdownIt from 'markdown-it'
import anchor from 'markdown-it-anchor'
import footnote from 'markdown-it-footnote'
import emojiPlugin from 'markdown-it-emoji/lib/bare.mjs'
import { tasklist } from '@mdit/plugin-tasklist'
import cjkFriendly from 'markdown-it-cjk-friendly'
import hljs from 'highlight.js/lib/core'
import type { LanguageFn } from 'highlight.js'
import bash from 'highlight.js/lib/languages/bash'
import c from 'highlight.js/lib/languages/c'
import cpp from 'highlight.js/lib/languages/cpp'
import csharp from 'highlight.js/lib/languages/csharp'
import css from 'highlight.js/lib/languages/css'
import diff from 'highlight.js/lib/languages/diff'
import go from 'highlight.js/lib/languages/go'
import ini from 'highlight.js/lib/languages/ini'
import java from 'highlight.js/lib/languages/java'
import javascript from 'highlight.js/lib/languages/javascript'
import json from 'highlight.js/lib/languages/json'
import kotlin from 'highlight.js/lib/languages/kotlin'
import markdownLang from 'highlight.js/lib/languages/markdown'
import php from 'highlight.js/lib/languages/php'
import python from 'highlight.js/lib/languages/python'
import rust from 'highlight.js/lib/languages/rust'
import sql from 'highlight.js/lib/languages/sql'
import typescript from 'highlight.js/lib/languages/typescript'
import xml from 'highlight.js/lib/languages/xml'
import yaml from 'highlight.js/lib/languages/yaml'

/** hljs 精简语言集（D4：lib/core 按需注册 20 语言，控 8MB msi 门禁） */
const LANGUAGES: Readonly<Record<string, LanguageFn>> = {
  bash, c, cpp, csharp, css, diff, go, ini, java, javascript,
  json, kotlin, markdown: markdownLang, php, python, rust, sql,
  typescript, xml, yaml,
}
for (const [name, def] of Object.entries(LANGUAGES)) {
  hljs.registerLanguage(name, def)
}

/** 常见语言别名归一（fence 标注 → 注册名；data-lang 标签仍显示用户原标注） */
const LANG_ALIASES: Readonly<Record<string, string>> = {
  'c++': 'cpp', js: 'javascript', ts: 'typescript', py: 'python',
  sh: 'bash', shell: 'bash', zsh: 'bash', yml: 'yaml', cs: 'csharp',
  kt: 'kotlin', rs: 'rust', golang: 'go', md: 'markdown',
}

/** 常用 emoji 短码表（F2 仅短码子集；全量表在体积门禁削减顺序里排在 hljs 之后） */
const EMOJI_DEFS: Readonly<Record<string, string>> = {
  // 笑与哭
  smile: '😄', smiley: '😃', grin: '😁', joy: '😂', rofl: '🤣', laughing: '😆',
  wink: '😉', blush: '😊', heart_eyes: '😍', kiss: '😘', sweat_smile: '😅',
  cry: '😢', sob: '😭',
  // 情绪
  thinking: '🤔', neutral_face: '😐', expressionless: '😑', confused: '😕',
  angry: '😠', rage: '😡', scream: '😱', sleeping: '😴',
  // 手势
  '+1': '👍', thumbsup: '👍', '-1': '👎', thumbsdown: '👎', ok_hand: '👌',
  clap: '👏', pray: '🙏', muscle: '💪', wave: '👋', point_right: '👉', eyes: '👀',
  // 符号
  star: '⭐', sparkles: '✨', fire: '🔥', tada: '🎉', bulb: '💡', warning: '⚠️',
  question: '❓', white_check_mark: '✅', x: '❌', heart: '❤️', broken_heart: '💔',
  '100': '💯', rocket: '🚀',
  // 工作与生活
  coffee: '☕', cake: '🍰', calendar: '📅', memo: '📝', book: '📖', email: '📧',
  phone: '📱', computer: '💻', lock: '🔒', key: '🔑',
  chart_with_upwards_trend: '📈', chart_with_downwards_trend: '📉',
  money_with_wings: '💸', dollar: '💵', yen: '💴',
}

/** 表情快捷写法（插件要求前后是空格/标点，避免吞掉 URL 片段） */
const EMOJI_SHORTCUTS: Readonly<Record<string, string | string[]>> = {
  smile: [':)', ':-)'],
  wink: ';)',
  cry: ":'(",
  sweat_smile: ":')",
  confused: [':/', ':-/'],
  neutral_face: ':|',
  laughing: ['xD', 'XD'],
  heart: '<3',
}

/** CJK-safe slugify：anchor 默认 slugify 会剥掉全部中日文字符导致 id 落空，这里保留 CJK（不引依赖） */
function cjkSlugify(raw: string): string {
  const slug = raw
    .replace(/[^\w\u4e00-\u9fff\u3400-\u4dbf\u3040-\u30ff\s-]/g, '')
    .trim()
    .replace(/\s+/g, '-')
    .toLowerCase()
    .slice(0, 60)
  return slug !== '' ? slug : 'h'
}

const HTML_ESCAPES: Readonly<Record<string, string>> = {
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;',
}

function escapeHtml(text: string): string {
  return text.replace(/[&<>"]/g, (ch) => HTML_ESCAPES[ch] ?? ch)
}

/**
 * fence 渲染规则（移植 Print Studio L962-980，剔除 highlightAuto 分支）：
 * - mermaid → <div class="mermaid">，内容转义，Mermaid 懒加载阶段再读文本；
 * - 已注册语言 → hljs.highlight 定向高亮，pre 带 data-lang 标签 + code.hljs 包裹；
 * - 未知/无语言标注 → 纯转义不高亮（D4 红线，不做任何猜测）。
 */
function installFenceRule(engine: MarkdownIt): void {
  engine.renderer.rules.fence = (tokens, idx) => {
    const token = tokens[idx]
    const lang = token.info.trim().split(/\s+/)[0] ?? ''
    const lineAttr = token.map !== null ? ` data-line="${token.map[0] + 1}"` : ''
    if (lang === 'mermaid') {
      return `<div class="mermaid"${lineAttr}>${escapeHtml(token.content)}</div>`
    }
    const canonical = LANG_ALIASES[lang] ?? lang
    let highlighted: string
    if (canonical !== '' && hljs.getLanguage(canonical) !== undefined) {
      try {
        highlighted = hljs.highlight(token.content, { language: canonical, ignoreIllegals: true }).value
      } catch {
        // hljs 对个别畸形输入会抛语言内部错误：降级为纯转义，不让单个代码块炸掉整篇渲染
        highlighted = escapeHtml(token.content)
      }
    } else {
      highlighted = escapeHtml(token.content)
    }
    const langLabel = lang !== '' ? ` data-lang="${escapeHtml(lang)}"` : ''
    const codeClass = lang !== '' ? ` class="language-${escapeHtml(lang)} hljs"` : ' class="hljs"'
    return `<pre${langLabel}${lineAttr}><code${codeClass}>${highlighted}</code></pre>`
  }
}

/**
 * 块级 data-line（D1 块级定位）：遍历顶层 token，给带 map 的 open token
 * 打上 1-based data-line（对齐编辑器行号），供大纲跳转与编辑切换定位。
 */
function installDataLineRule(engine: MarkdownIt): void {
  engine.core.ruler.push('assign_block_lines', (state) => {
    for (const token of state.tokens) {
      if (token.nesting === 1 && token.map !== null) {
        token.attrSet('data-line', String(token.map[0] + 1))
      }
    }
  })
}

export const md: MarkdownIt = new MarkdownIt({
  html: false, // D6 红线：禁止内联 HTML 直通
  linkify: true,
  typographer: true,
  breaks: true, // D1 台账显式决策：软换行即 <br>
})
  .use(anchor, { slugify: cjkSlugify })
  .use(footnote)
  .use(emojiPlugin, { defs: EMOJI_DEFS, shortcuts: EMOJI_SHORTCUTS })
  .use(tasklist)
  .use(cjkFriendly)

installFenceRule(md)
installDataLineRule(md)
