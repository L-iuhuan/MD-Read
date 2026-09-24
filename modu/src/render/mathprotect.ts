/**
 * 数学保护预处理（M1-E2 缺陷1 修复）。
 *
 * 缺陷根因：CommonMark 里 `(` 是可转义标点，markdown-it 会把 `\(` 吞成
 * `(`，KaTeX auto-render 从此找不到行内定界符（块级 `$$…$$` 无反斜杠，
 * 不受影响）。
 *
 * 机制：render 前按精确字符序列扫描源文，把 `\(...\)` 与 `\[...\]` 片段
 * 整体摘出、换成纯字母数字占位符；render 后在 HTML 字符串上还原为字面
 * 文本，交 math.ts 的 auto-render 正常接管。
 *
 * 与被禁的 protectMath 的区别（AGENTS.md 禁手写正则 hack 的尸检教训）：
 * 被禁方案是裸 `$` 模糊正则，会把「$1,000 与 $2,000」这类金额误判为
 * 公式；本模块只认 `\(` `\)` `\[` `\]` 四个精确字符序列，逐字符 indexOf
 * 确定性替换，无正则歧义、不触碰裸 `$`——D2 分隔符契约：仅 `$$…$$` /
 * `\(…\)` / `\[…\]` 三种，裸 `$` 一律纯文本（金额红线）。
 *
 * 占位符形如 `MoDuMathGuard<8位随机盐><6位序号>`，全字母数字：
 * - md 转义 / linkify / typographer / emoji 均不会改写；
 * - 随机盐 + 「原文不含该前缀」校验，双重防止与正文撞车；
 * - 定长 6 位序号配合定长正则，占位符后紧跟数字也不会误吞；
 * - 还原发生在 sanitize 之前（顺序约束见 pipeline.ts），还原文本先做
 *   HTML 实体转义，占位符与还原产物都不给 DOMPurify 开口子。
 */

/** 占位符固定前缀（渲染输出零残留的负向断言锚点） */
const GUARD_PREFIX = 'MoDuMathGuard'

/** 随机盐长度；序号定长宽度（同时是单篇公式数上限 10^6） */
const SALT_LENGTH = 8
const ID_WIDTH = 6
const MAX_SPANS = 10 ** ID_WIDTH

/** extractMath / restoreMath 的成对产物 */
export interface MathGuards {
  /** 替换掉数学片段后的源文（喂给 md.render） */
  readonly text: string
  /** 占位符 → 原始数学片段（含定界符原文） */
  readonly spans: Map<string, string>
  /** 还原用定长全局正则（源为 前缀+盐+定长序号，纯字母数字无转义歧义） */
  readonly pattern: RegExp
}

/** 随机字母数字盐（Math.random 足够：撞车由 includes 校验兜底，不承担安全职责） */
function randomSalt(): string {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789'
  let salt = ''
  for (let i = 0; i < SALT_LENGTH; i++) {
    salt += chars[Math.floor(Math.random() * chars.length)]
  }
  return salt
}

/** 生成原文中不存在的前缀（含 GUARD_PREFIX，杜绝与正文撞车） */
function makeBase(src: string): string {
  // P1-5 快路径：固定前缀本身就不在原文里时，任意盐都不可能撞车——
  // 省掉原来最多 16 次全文 includes（1.85MB 文档 = 最多 30MB 的无谓扫描）。
  if (!src.includes(GUARD_PREFIX)) return GUARD_PREFIX + randomSalt()
  for (let i = 0; i < 16; i++) {
    const base = GUARD_PREFIX + randomSalt()
    if (!src.includes(base)) return base
  }
  throw new Error('数学占位符前缀生成失败：文档疑似包含保留字串，无法安全保护公式')
}

/** 起始定界符位置及其配对结束符 */
interface OpenMark {
  at: number
  close: string
}

/**
 * 单遍扫出全部起始定界符位置并归并升序（O(n)）。
 *
 * P1-5 根因：原 `findOpen(src, from)` 每轮都要 `indexOf('\\(', from)` **和**
 * `indexOf('\\[', from)`。文档里只有 `\(` 而没有 `\[` 时，后一次搜索每轮都要从
 * from 一路扫到串尾才返回 -1 —— 于是整体退化成 O(k·n)。实测 1.85MB / 14317 个
 * 片段要 2096.7ms（评审侧 8582 个片段约 650ms；片段更多时单位成本反而更高，
 * 正是超线性特征）。先把位置各扫一遍再顺序推进，两处都回到线性。
 */
function openMarks(src: string): OpenMark[] {
  const marks: OpenMark[] = []
  for (let at = src.indexOf('\\('); at !== -1; at = src.indexOf('\\(', at + 1)) {
    marks.push({ at, close: '\\)' })
  }
  for (let at = src.indexOf('\\['); at !== -1; at = src.indexOf('\\[', at + 1)) {
    marks.push({ at, close: '\\]' })
  }
  marks.sort((a, b) => a.at - b.at)
  return marks
}

/**
 * render 前调用：摘出全部 `\(...\)` / `\[...\]` 换成占位符。
 * 未闭合的定界符不保护（保持 md 原有行为，不吞正文）。
 */
export function extractMath(src: string): MathGuards {
  const base = makeBase(src)
  const spans = new Map<string, string>()
  // P1-5：片段先收进数组、最后 join 一次（原 `text += …` 逐段累加会反复在长串上拼接）。
  const parts: string[] = []
  const marks = openMarks(src)
  let cursor = 0
  let id = 0
  for (const mark of marks) {
    if (id >= MAX_SPANS) break
    if (mark.at < cursor) continue // 已被前一个片段整体吞掉（如公式内部的定界符）
    const closeAt = src.indexOf(mark.close, mark.at + 2)
    if (closeAt === -1) break // 与原实现一致：最早的开定界符未闭合即停止保护
    const end = closeAt + mark.close.length
    const placeholder = base + String(id).padStart(ID_WIDTH, '0')
    spans.set(placeholder, src.slice(mark.at, end))
    parts.push(src.slice(cursor, mark.at), placeholder)
    cursor = end
    id += 1
  }
  parts.push(src.slice(cursor))
  return {
    text: parts.join(''),
    spans,
    pattern: new RegExp(`${base}\\d{${ID_WIDTH}}`, 'g'),
  }
}

/** HTML 实体转义：还原的数学原文可能含 & < >，注入 HTML 字符串前必须实体化 */
function escapeForHtml(text: string): string {
  const entities: Readonly<Record<string, string>> = { '&': '&amp;', '<': '&lt;', '>': '&gt;' }
  return text.replace(/[&<>]/g, (ch) => entities[ch] ?? ch)
}

/** render 之后、sanitize 之前调用：把占位符还原为字面 `\(…\)` / `\[…\]` 文本 */
export function restoreMath(html: string, guards: MathGuards): string {
  if (guards.spans.size === 0) return html
  return html.replace(guards.pattern, (match) => {
    const original = guards.spans.get(match)
    if (original === undefined) return match // 防御分支：前缀已校验不存在于原文，理论不可达
    return escapeForHtml(original)
  })
}
