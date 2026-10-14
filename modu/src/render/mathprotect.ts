/**
 * 数学保护预处理（M1-E2 缺陷1 修复；P1-1 批次 2 扩展）。
 *
 * 缺陷根因（两种定界符各一条）：
 * 1. `\(` `\[`：CommonMark 里 `(` 是可转义标点，markdown-it 会把 `\(` 吞成 `(`，
 *    KaTeX auto-render 从此找不到行内定界符。
 * 2. **`$$…$$`（P1-1 实测）**：原注释认为"块级 `$$…$$` 无反斜杠，不受影响" ——
 *    **实测不成立**：多行 `$$` 块内部的 `*b*` 会被 emphasis 拆成 `<em>`（KaTeX 无法跨元素匹配，
 *    整块退化成纯文本，`$$` 字面残留）；块内一行**孤立的 `=`** 更会被 markdown-it 的 setext
 *    规则把前几行变成 `<h1>`（源码里 `$$\nE = m c^2\n=\n…\n$$` → `<h1>$$\nE = m c^2</h1>`）。
 *    ⇒ 两种症状同源：**该块从未被收走**。现在三种定界符统一在 render 前摘下。
 *
 * 机制：render 前按精确字符序列扫描源文，把 `$$…$$` / `\(...\)` / `\[...\]` 片段
 * 整体摘出、换成纯字母数字占位符；render 后在 HTML 字符串上还原为字面文本，
 * 交 math.ts 的 auto-render 正常接管。
 *
 * 与被禁的 protectMath 的区别（AGENTS.md 禁手写正则 hack 的尸检教训）：
 * 被禁方案是裸 `$` 模糊正则，会把「$1,000 与 $2,000」这类金额误判为公式；
 * 本模块只认 `\\(` `\\)` `\\[` `\\]` 四个精确字符序列**与两个连续 `$`**，
 * 逐字符 indexOf 确定性替换，**单裸 `$` 永不参与匹配**——D2 分隔符契约：
 * 仅 `$$…$$` / `\(…\)` / `\[…\]` 三种，裸 `$` 一律纯文本（金额红线）。
 *
 * 占位符形如 `MoDuMathGuard<8位随机盐><6位序号>`，全字母数字：
 * - md 转义 / linkify / typographer / emoji 均不会改写；
 * - 随机盐 + 「原文不含该前缀」校验，双重防止与正文撞车；
 * - 定长 6 位序号配合定长正则，占位符后紧跟数字也不会误吞；
 * - 还原发生在 sanitize 之前（顺序约束见 pipeline.ts），还原文本先做
 *   HTML 实体转义，占位符与还原产物都不给 DOMPurify 开口子。
 * - 代码围栏内的 `$$`/`\(` 也会被摘出再原样还原（文本逐字不变，且 auto-render
 *   的 ignoredTags 含 pre/code，不会在代码里误渲公式）。
 * - fix-22 缺陷B：占位符后**补齐等量换行**（片段占 N 行就补 N 个 `\n`），喂给
 *   md.render 的文本行数与源文一致 ⇒ 后续块的 token.map / data-line / outline.line
 *   不再系统性偏小（多行 `$$` 块曾使之后所有行号偏小 N）。restoreMath 匹配
 *   「占位符+尾随换行串」并按补偿数回吐差额，故「restoreMath(text) === 原文」
 *   的逐字节往返（mathprotect-dollar 锚）继续成立；渲染 HTML 里补偿换行已被
 *   块级解析消费（或恰好多吞时按差额保留，如围栏内容的结构换行）。
 */

/** 占位符固定前缀（渲染输出零残留的负向断言锚点） */
const GUARD_PREFIX = 'MoDuMathGuard'

/** 随机盐长度；序号定长宽度（同时是单篇公式数上限 10^6） */
const SALT_LENGTH = 8
const ID_WIDTH = 6
const MAX_SPANS = 10 ** ID_WIDTH

/** extractMath / restoreMath 的成对产物 */
export interface MathGuards {
  /** 替换掉数学片段后的源文（喂给 md.render；占位符后带等量补偿换行，行数与原文一致） */
  readonly text: string
  /** 占位符 → 原始数学片段（含定界符原文） */
  readonly spans: Map<string, string>
  /** 占位符 → 替换时补偿的换行数（restoreMath 据此回吐差额；缺项按 0） */
  readonly newlines: ReadonlyMap<string, number>
  /** 还原用全局正则（捕获组=占位符本体，其后吞可选换行串；源为 前缀+盐+定长序号，纯字母数字无转义歧义） */
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
 *
 * P1-1 扩展第三类：`$$`（两个连续美元，**不是**裸 `$`）。步长取 2 以免 `$$$` 里
 * 同一个 `$$` 被重复登记；开/闭都用 `$$`，中间允许换行（多行块级公式）。
 */
function openMarks(src: string): OpenMark[] {
  const marks: OpenMark[] = []
  for (let at = src.indexOf('\\('); at !== -1; at = src.indexOf('\\(', at + 1)) {
    marks.push({ at, close: '\\)' })
  }
  for (let at = src.indexOf('\\['); at !== -1; at = src.indexOf('\\[', at + 1)) {
    marks.push({ at, close: '\\]' })
  }
  for (let at = src.indexOf('$$'); at !== -1; at = src.indexOf('$$', at + 2)) {
    marks.push({ at, close: '$$' })
  }
  marks.sort((a, b) => a.at - b.at)
  return marks
}

/** 串内换行计数（fix-22 缺陷B：决定占位符要补偿的换行数） */
function countNewlines(s: string): number {
  let n = 0;
  for (let i = s.indexOf('\n'); i !== -1; i = s.indexOf('\n', i + 1)) n += 1;
  return n;
}

/** ── 配对安全网（2026-10-13 审查新增）───────────────────────────────────────
 * 为什么需要：本模块按**精确字符序列**在原始源文上扫描，原本不区分「正文」与
 * 「代码」。实测两种实害（mathprotect-overcapture 锚）：
 *  · 两个 bash 围栏各含 `echo $$`（shell 的 PID 变量）⇒ 两个 `$$` 跨块配对，
 *    两块之间的**整篇文档**被当作公式正文原样还原 ⇒ 第二个围栏之后的全文被吞进
 *    第一个代码块，标题/段落/列表全部退化成字面文本；
 *  · 行内码 `` `echo $$` `` 与 `` `$$` `` 被跨片段配对 ⇒ 反引号配对被劈开，
 *    行内码结构坏掉。
 * 因此：**围栏代码块与行内码区间内的定界符一律不参与配对**。 */
function codeIntervals(src: string): ReadonlyArray<readonly [number, number]> {
  const out: Array<[number, number]> = []
  const n = src.length
  // 粘性正则直接在原文上匹配行首围栏，避免为每一行 slice 出一个字符串
  //（1.85MB / 5 万行档：P1-5 性能预算下实测省掉大部分开销）
  const FENCE = / {0,3}(`{3,}|~{3,})([^\n]*)/y
  let fence: { char: string; len: number } | null = null
  let fenceStart = 0
  let gapStart = 0
  let start = 0
  for (;;) {
    const nl = src.indexOf('\n', start)
    const end = nl === -1 ? n : nl
    FENCE.lastIndex = start
    const m = FENCE.exec(src)
    const mark = m !== null && m.index === start && start + m[0].length <= end ? m : null
    if (fence === null) {
      if (mark !== null) {
        scanInlineCode(src, gapStart, start, out)
        fence = { char: mark[1][0], len: mark[1].length }
        fenceStart = start
      }
    } else if (mark !== null && mark[1][0] === fence.char && mark[1].length >= fence.len && mark[2].trim() === '') {
      out.push([fenceStart, nl === -1 ? n : nl + 1])
      fence = null
      gapStart = nl === -1 ? n : nl + 1
    }
    if (nl === -1) break
    start = nl + 1
  }
  if (fence !== null) out.push([fenceStart, n])
  else scanInlineCode(src, gapStart, n, out)
  out.sort((a, b) => a[0] - b[0])
  const merged: Array<[number, number]> = []
  for (const iv of out) {
    const last = merged[merged.length - 1]
    if (last !== undefined && iv[0] <= last[1]) last[1] = Math.max(last[1], iv[1])
    else merged.push([iv[0], iv[1]])
  }
  return merged
}
/** `from` 所在**段落的结束位置**（空行前 / 文末）：行内码不能跨空行成对
 *  —— 空行断段，跨段的两个孤立反引号不是代码片段（2026-10-13 审查 M2：
 *  原先在「整段非围栏区」里配对，两处游离单反引号会把中间整块区间误判成代码，
 *  区间里的 `\(…\)`/`\[…\]` 随后被 inCodeIntervals 跳过 ⇒ 行内公式退化成普通括号）。 */
function paragraphEnd(src: string, from: number): number {
  for (let i = src.indexOf('\n', from); i !== -1; i = src.indexOf('\n', i + 1)) {
    let j = i + 1
    while (j < src.length && (src[j] === ' ' || src[j] === '\t' || src[j] === '\u3000')) j += 1
    if (j >= src.length) return src.length
    if (src[j] === '\n') return i
    if (src[j] === '\r' && src[j + 1] === '\n') return i
  }
  return src.length
}
/** 非围栏区里的行内码片段（等长反引号串配对；未闭合的反引号是字面量，不成片段） */
function scanInlineCode(src: string, from: number, to: number, out: Array<[number, number]>): void {
  let i = from
  for (;;) {
    const bt = src.indexOf('`', i)
    if (bt === -1 || bt >= to) return
    let run = 0
    while (bt + run < to && src[bt + run] === '`') run += 1
    // 闭合跑必须落在**同一段**内（空行断段）：跨空行配对会把中间整块内容误判成代码
    const limit = Math.min(to, paragraphEnd(src, bt))
    let j = bt + run
    let close = -1
    while (j < limit) {
      const c = src.indexOf('`', j)
      if (c === -1 || c >= limit) break
      let r2 = 0
      while (c + r2 < limit && src[c + r2] === '`') r2 += 1
      if (r2 === run) { close = c; break }
      j = c + r2
    }
    if (close === -1) { i = bt + run; continue }
    out.push([bt, close + run])
    i = close + run
  }
}
/** 位置是否落在任一代码区间内（区间已升序合并 ⇒ 二分） */
function inCodeIntervals(ranges: ReadonlyArray<readonly [number, number]>, pos: number): boolean {
  let lo = 0
  let hi = ranges.length - 1
  while (lo <= hi) {
    const mid = (lo + hi) >> 1
    const iv = ranges[mid]
    if (pos < iv[0]) hi = mid - 1
    else if (pos >= iv[1]) lo = mid + 1
    else return true
  }
  return false
}

/** 行首前缀是否只由「缩进 + 引用栈 + 列表标记」构成 */
function onlyBlockMarkers(prefix: string): boolean {
  const isBlank = (c: string): boolean => c === ' ' || c === '\t' || c === '\u3000'
  let i = 0
  for (;;) {
    while (i < prefix.length && isBlank(prefix[i])) i += 1
    if (i >= prefix.length) return true
    if (prefix[i] === '>') { i += 1; continue }
    let marker = 0
    if (prefix[i] === '-' || prefix[i] === '+' || prefix[i] === '*') {
      marker = 1
    } else {
      let d = i
      while (d < prefix.length && prefix[d] >= '0' && prefix[d] <= '9') d += 1
      if (d > i && d < prefix.length && (prefix[d] === '.' || prefix[d] === ')')) marker = d + 1 - i
    }
    if (marker > 0 && i + marker < prefix.length && isBlank(prefix[i + marker])) {
      i += marker + 1
      continue
    }
    return false
  }
}

/** 定界符是否「行级独占」：前面只有块级标记/空白，后面只有空白。
 *  多行 `$$…$$` 只在两端都行级独占时才收 —— 否则正文里两个裸 `$$`
 *  （如「价格 $$ 折扣」出现两次）会把中间整篇文档吞成公式正文。 */
function isLineOwned(src: string, at: number, len: number): boolean {
  const lineStart = src.lastIndexOf('\n', at - 1) + 1
  const lineEnd = src.indexOf('\n', at)
  const prefix = src.slice(lineStart, at)
  const suffix = src.slice(at + len, lineEnd === -1 ? src.length : lineEnd)
  return onlyBlockMarkers(prefix) && /^\s*$/.test(suffix)
}

/** 两个位置是否在同一行 */
function sameLine(src: string, a: number, b: number): boolean {
  return src.lastIndexOf('\n', a) === src.lastIndexOf('\n', b)
}
/**
 * render 前调用：摘出全部 `$$…$$` / `\(...\)` / `\[...\]` 换成占位符。
 * 未闭合的定界符不保护（保持 md 原有行为，不吞正文）；
 * 闭定界符从开定界符**之后**开始找（`$$` 时要跳过开头那两个字符，否则自配对成空片段）。
 * 占位符后补齐片段内的等量换行（fix-22 缺陷B：md 渲染文本行数与源文一致，data-line 不漂移）。
 */
export function extractMath(src: string): MathGuards {
  const base = makeBase(src)
  const spans = new Map<string, string>()
  const nlMap = new Map<string, number>()
  // P1-5：片段先收进数组、最后 join 一次（原 `text += …` 逐段累加会反复在长串上拼接）。
  const parts: string[] = []
  const marks = openMarks(src)
  // 配对安全网（2026-10-13 审查新增）：代码/行内码里的定界符不参与配对；多行 $$ 必须两端行级独占。
  const code = codeIntervals(src)
  let cursor = 0
  let id = 0
  for (const mark of marks) {
    if (id >= MAX_SPANS) break
    if (mark.at < cursor) continue // 已被前一个片段整体吞掉（如公式内部的定界符）
    if (inCodeIntervals(code, mark.at)) continue // 开定界符在代码里 ⇒ 不是公式
    const closeAt = src.indexOf(mark.close, mark.at + mark.close.length)
    if (closeAt === -1) continue // 未闭合的开定界符只跳过它自己：否则它后面所有独立成对的公式一起失保护
    if (inCodeIntervals(code, closeAt)) continue // 闭定界符在代码里 ⇒ 不是公式
    if (mark.close === '$$' && !sameLine(src, mark.at, closeAt)
      && !(isLineOwned(src, mark.at, 2) && isLineOwned(src, closeAt, 2))) {
      continue // 多行 $$ 两端不都是行级独占 ⇒ 视为正文裸 $$，不收（否则会吞掉中间整篇文档）
    }
    const end = closeAt + mark.close.length
    const span = src.slice(mark.at, end)
    const placeholder = base + String(id).padStart(ID_WIDTH, '0')
    const compensated = countNewlines(span)
    spans.set(placeholder, span)
    nlMap.set(placeholder, compensated)
    parts.push(src.slice(cursor, mark.at), placeholder + '\n'.repeat(compensated))
    cursor = end
    id += 1
  }
  parts.push(src.slice(cursor))
  return {
    text: parts.join(''),
    spans,
    newlines: nlMap,
    pattern: new RegExp(`(${base}\\d{${ID_WIDTH}})\\n*`, 'g'),
  }
}

/** HTML 实体转义：还原的数学原文可能含 & < >，注入 HTML 字符串前必须实体化 */
function escapeForHtml(text: string): string {
  const entities: Readonly<Record<string, string>> = { '&': '&amp;', '<': '&lt;', '>': '&gt;' }
  return text.replace(/[&<>]/g, (ch) => entities[ch] ?? ch)
}

/** render 之后、sanitize 之前调用：把占位符还原为字面 `\(…\)` / `\[…\]` 文本。
 *  正则连占位符后的换行串一起吞：换行串 = 渲染 HTML 里残存的补偿换行 + 原文换行
 *  （围栏内容的结构换行），按「吞到的 − 补偿的」差额回吐 ⇒ 往返逐字节一致，
 *  且补偿换行不会作为多余空行落进还原产物。 */
export function restoreMath(html: string, guards: MathGuards): string {
  if (guards.spans.size === 0) return html;
  return html.replace(guards.pattern, (match, placeholder: string) => {
    const original = guards.spans.get(placeholder);
    if (original === undefined) return match; // 防御分支：前缀已校验不存在于原文，理论不可达
    const compensated = guards.newlines.get(placeholder) ?? 0;
    const trailing = match.length - placeholder.length;
    return escapeForHtml(original) + '\n'.repeat(Math.max(0, trailing - compensated));
  });
}
