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
  chart_with_upwards_trend: '📈', chart_with_downwards_trend: '📉', dart: '🎯',
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
 * 表格包裹层（P0-5）：给每个 table 套 <div class="table-wrap">。
 *
 * 为什么必须由渲染层生成：cjk.css §4 的 .table-wrap 承担「超宽表在容器内横向滚动
 * 且不撑破纸面」的职责，而 markdown-it 直出裸 <table>，那条规则从未匹配到任何元素
 * ——7 列财务表实测溢出纸面 91px，#content 被撑出横向滚动条。
 *
 * 走 table_open/table_close 渲染规则而不是字符串后处理：token 流天然覆盖
 * 多表 / 单元格内嵌内容 / 引用块与列表内的表格，且不再动任何正则。
 * table_open 上的 data-line（installDataLineRule 落的块级定位）经 renderToken
 * 原样输出，包裹层不吃掉它。
 */
function installTableWrapRule(engine: MarkdownIt): void {
  engine.renderer.rules.table_open = (tokens, idx, options, _env, self) =>
    `<div class="table-wrap">${self.renderToken(tokens, idx, options)}`
  engine.renderer.rules.table_close = (tokens, idx, options, _env, self) =>
    `${self.renderToken(tokens, idx, options)}</div>`
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

/**
 * B3 · GitHub Alert（**我们自己的扩展**：规格 F2 只承诺 GFM+脚注+KaTeX+hljs+Mermaid，**不含 Alert**）。
 *
 * 保守识别：只有引用块**首个段落的内容以** `[!TYPE]`（**大写**，5 类白名单）开头才识别 —— 其余引用块**一字不改** ✓
 * 命中后：
 *  · 给 `blockquote` 加 `alert alert-<type>` 类 + `data-alert="<type>"`（**非颜色通道**：CSS 据此出中文标签）；
 *  · **剥掉**标记本身（首行只剩标题/正文）；
 *  · 标记独占一行（无标题无正文）时**连空段落一起删**，避免留下空 `<p>`。
 */
const ALERT_TYPES = ['NOTE', 'TIP', 'IMPORTANT', 'WARNING', 'CAUTION'] as const
type AlertType = (typeof ALERT_TYPES)[number]

function installAlertRule(engine: MarkdownIt): void {
  engine.core.ruler.push('github_alerts', (state) => {
    const tokens = state.tokens
    for (let i = 0; i < tokens.length; i += 1) {
      if (tokens[i].type !== 'blockquote_open') continue
      // 找块内**第一层**的第一个 inline（= 首个段落）
      let inlineIdx = -1
      let depth = 0
      for (let j = i + 1; j < tokens.length; j += 1) {
        if (tokens[j].type === 'blockquote_open') depth += 1
        if (tokens[j].type === 'blockquote_close') {
          if (depth === 0) break
          depth -= 1
        }
        if (tokens[j].type === 'inline' && depth === 0) {
          inlineIdx = j
          break
        }
      }
      if (inlineIdx === -1) continue
      const marker = /^\[!([A-Z]+)\]/.exec(tokens[inlineIdx].content)
      if (marker === null) continue
      const kind = marker[1] as AlertType
      if (!ALERT_TYPES.includes(kind)) continue
      const children = tokens[inlineIdx].children
      const head = children?.[0]
      if (head === undefined || head.type !== 'text') continue // 结构不熟就**不动手**（保守）
      if (!head.content.startsWith(marker[0])) continue
      head.content = head.content.slice(marker[0].length).replace(/^\s+/, '')
      tokens[i].attrJoin('class', `alert alert-${kind.toLowerCase()}`)
      tokens[i].attrSet('data-alert', kind.toLowerCase())
      if (head.content === '') {
        // ⚠ 第一版在这里"空内容就删整段"，而 `> [!NOTE]\n> 正文` 是**同一段**（text + softbreak + text）
        //   ⇒ 把 alert 正文一起删掉了 ✗（`tests/alert.spec.ts` 的锚当场抓到）。
        //   正确做法：只删**空的 text** 与**紧随的 softbreak**，段落保留 ✓
        const kids = children ?? []
        kids.splice(0, kids[1]?.type === 'softbreak' ? 2 : 1)
        if (kids.length === 0) {
          // 标记独占整段（无标题无正文）⇒ 才连空段落三件套一起删，避免留空 <p>
          if (tokens[inlineIdx - 1]?.type === 'paragraph_open' && tokens[inlineIdx + 1]?.type === 'paragraph_close') {
            tokens.splice(inlineIdx - 1, 3)
          }
        }
      }
    }
  })
}
/**
 * 未引用的脚注定义不再整行消失（2026-10-13 审查 D3）。
 *
 * markdown-it-footnote 的 `footnote_tail` 会把**所有** `[^a]: …` 区块的 token 从正文里摘走，
 * 只有被 `[^a]` 引用过的才重新拼到文末脚注区 —— 没引用的那份**直接丢弃**（GFM 同行为）。
 * 对「阅读器」来说这是实害：用户写的整行不见了。
 *
 * 本规则插在 `footnote_tail` **之前**：此时 inline 解析已完成，`env.footnotes.refs[label]`
 * 为 `-1` 就是「定义了但没被引用」。把这类定义的 `footnote_reference_open/close`
 * **拆掉**（只去标记、内容块留在原 token 流里）⇒ 它按作者写的位置渲染成普通块；
 * 被引用的定义一律不动，照旧进文末脚注区。
 * 口径：与其它块级标记一致（`#`、`-`、`>` 也不显示），保留的是**内容与位置**。
 */
function installFootnoteKeepRule(engine: MarkdownIt): void {
  engine.core.ruler.before('footnote_tail', 'modu_keep_unreferenced_footnotes', (state) => {
    const refs = (state.env as { footnotes?: { refs?: Record<string, number> } }).footnotes?.refs
    if (refs === undefined) return
    const kept: typeof state.tokens = []
    let unwrapDepth = 0
    for (const token of state.tokens) {
      if (token.type === 'footnote_reference_open') {
        const label = (token.meta as { label?: string } | null)?.label ?? ''
        if (refs[`:${label}`] === -1) {
          unwrapDepth += 1
          continue // 去掉开标记；定义内容留在原位
        }
      } else if (token.type === 'footnote_reference_close' && unwrapDepth > 0) {
        unwrapDepth -= 1
        continue // 去掉闭标记
      }
      kept.push(token)
    }
    state.tokens = kept
  })
}

/**
 * `www.` 前缀自动成链（2026-10-13 审查新增）。
 *
 * 为什么必须单独一条规则：原注释写「scheme/www 前缀仍自动成链」，**实测不成立** ——
 * linkify-it 的 `www.` 匹配与裸域名同属 **fuzzyLink 路径**（`re.host_fuzzy_test` =
 * `localhost|www\.|\.\d{1,3}\.|\....TLD`），所以 2026-10-01 关掉 fuzzyLink 时把 `www.`
 * 一起关掉了：`www.example.com` 在正文里一直是字面文本（render 侧证据见测试锚）。
 *
 * 口径（用户 2026-10-01 裁决不复活）：**只收 `www.` 前缀**，裸域名
 * （`笔记.md` → `http://xn--….md` punycode 实害）仍然不成链。做法是另起一个
 * LinkifyIt 实例（构造器从现成实例上取，不引新依赖）并临时开 fuzzyLink，
 * 复用它的 TLD 表与校验，再按 `www.` 前缀过滤。
 *
 * 挂在 core 的 `linkify` 之后：此时 markdown-it 已把 `https://…` 等成链，
 * 剩下的 text token 里带 `www.` 的就是漏网的；`link_open` 之后的内容整段跳过，
 * 不会在链接里套链接（行内码 token 是 code_inline，本就不在 text 分支）。
 */
function installWwwAutolink(engine: MarkdownIt): void {
  const LinkifyItCtor = engine.linkify.constructor as unknown as new () => typeof engine.linkify
  const matcher = new LinkifyItCtor()
  matcher.set({ fuzzyLink: true, fuzzyEmail: false, fuzzyIP: false })
  engine.core.ruler.after('linkify', 'www_autolink', (state) => {
    for (const blockToken of state.tokens) {
      if (blockToken.type !== 'inline' || blockToken.children === null) continue
      const tokens: NonNullable<typeof blockToken.children> = blockToken.children
      if (!tokens.some((t) => t.type === 'text' && t.content.includes('www.'))) continue
      const out: NonNullable<typeof blockToken.children> = []
      let linkDepth = 0
      for (const token of tokens) {
        if (token.type === 'link_open') {
          linkDepth += 1
          out.push(token)
          continue
        }
        if (token.type === 'link_close') {
          if (linkDepth > 0) linkDepth -= 1
          out.push(token)
          continue
        }
        if (token.type !== 'text' || linkDepth > 0) {
          out.push(token)
          continue
        }
        const text = token.content
        if (!text.includes('www.')) {
          out.push(token)
          continue
        }
        const hits = (matcher.match(text) ?? []).filter((m) => /^www\./i.test(m.text))
        if (hits.length === 0) {
          out.push(token)
          continue
        }
        let lastPos = 0
        let emitted = false
        for (const hit of hits) {
          const fullUrl = engine.normalizeLink(hit.url)
          if (!engine.validateLink(fullUrl)) continue
          if (hit.index > lastPos) {
            const before = new state.Token('text', '', 0)
            before.content = text.slice(lastPos, hit.index)
            before.level = token.level
            out.push(before)
          }
          const open = new state.Token('link_open', 'a', 1)
          open.attrs = [['href', fullUrl]]
          open.level = token.level
          open.markup = 'linkify'
          open.info = 'auto'
          out.push(open)
          const label = new state.Token('text', '', 0)
          label.content = engine.normalizeLinkText(hit.text)
          label.level = token.level + 1
          out.push(label)
          const close = new state.Token('link_close', 'a', -1)
          close.level = token.level
          close.markup = 'linkify'
          close.info = 'auto'
          out.push(close)
          lastPos = hit.lastIndex
          emitted = true
        }
        if (!emitted) {
          out.push(token)
          continue
        }
        if (lastPos < text.length) {
          const after = new state.Token('text', '', 0)
          after.content = text.slice(lastPos)
          after.level = token.level
          out.push(after)
        }
      }
      blockToken.children = out
    }
  })
}

export const md: MarkdownIt = new MarkdownIt({
  html: false, // D6 红线：禁止内联 HTML 直通
  // linkify 开（2026-10-01 全形态链接排查修正）：裸 URL（https://… 与 www.…）自动成链
  // 是 GFM 习惯、用户预期「网页链接要能打开」；但 **fuzzyLink/fuzzyEmail 关闭**（紧随
  // 构造之后的 set 调用）——fuzzy 形态会把正文里的 `xxx.md` 当「域名.md」补链成
  // http://xn--….md（punycode），点击跳浏览器（2026-10-01 用户反馈实害）。
  // ⚠ 但 linkify-it 的 `www.` 规则本身就在 fuzzy 路径里 ⇒ 关掉 fuzzyLink 会把 www 一起关掉
  // （2026-10-13 审查实测：原注释「scheme/www 前缀仍自动成链」是错的，www 一直是字面文本）。
  // 现在由 installWwwAutolink 单独把 www 一种补回；裸域名（含 .md TLD）仍然不成链——两头都要。
  linkify: true,
  // 用户裁决（2026-09-23，规格级）：**关掉 typographer** —— 不静默改掉有字面含义的文本。
  // 与"禁裸 `$…$`（防 `$1,000` 被当公式）"同源：`--flag`、`1--2`、"key": value 都必须与源码一致；
  // 中文破折号本是 `——`，自动变西文 en dash 既非原样也非中文化。
  // ⚠️ 别改回 true（golden-HTML 对拍与 AGENTS.md 均锁这条）。
  typographer: false,
  breaks: true, // D1 台账显式决策：软换行即 <br>
})
  .use(anchor, { slugify: cjkSlugify })
  .use(footnote)
  .use(emojiPlugin, { defs: EMOJI_DEFS, shortcuts: EMOJI_SHORTCUTS })
  .use(tasklist)
  .use(cjkFriendly)
  .use((engine) => installAlertRule(engine))

// linkify 的 fuzzy 口子必须在实例上关（markdown-it 不透传 linkify-it 选项）：
// 关掉后「笔记.md」这类裸域名不成链；https:// 与 www. 前缀不受影响
md.linkify.set({ fuzzyLink: false, fuzzyEmail: false })

// validateLink 放行 file:///（2026-10-01 全形态链接排查）：markdown-it 默认只认
// http(s)/ftp/mailto/tel/data:image 等白名单，file: 一律不成链（锚点整体消失，
// 实测矩阵里 file:/// 与盘符重写形态全丢）。点击侧安全由 links.ts 拦截器 +
// openPath 受信校验（fail-closed）+ nav-guard 三层兜底，渲染层放行只管「成链」。
{
  const defaultValidateLink = md.validateLink;
  md.validateLink = (url: string): boolean => defaultValidateLink(url) || /^file:\/\//i.test(url);
}

installFenceRule(md)
installTableWrapRule(md)
installDataLineRule(md)
installWwwAutolink(md)
installFootnoteKeepRule(md)
