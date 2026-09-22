/**
 * 渲染管线总装（Lane A 唯一入口，main.ts 只认这里的 renderDocument）。
 *
 * 顺序写死（v1.3 定序约束，不得调整）：
 *   mathprotect.extract → md.render → mathprotect.restore → DOMPurify
 *   → DOMParser → KaTeX auto-render → pangu(默认开) → tok-break
 *   → outline 提取 → fragment 搬运（P5 批3：html 字段改惰性，挂载走 fragment）
 *
 * 为什么是这个顺序：
 * - cjk-gap / tok-break 的空 span 必须在 sanitize 之后插入，消毒配置无需
 *   为排版产物开口子；
 * - KaTeX 的 MathML 输出（semantics/annotation）不回炉消毒，避免被剥；
 * - pangu 必须先于 tok-break（demo 踩坑：反序丢「号|t」处插空）；
 * - outline 在全部后处理之后提取，id/data-line 已就位，文本即所见。
 */
import { md } from './markdown'
import { sanitizeHtml } from './sanitize'
import { renderMath } from './math'
import { extractMath, restoreMath } from './mathprotect'
import { applyPangu } from './pangu'
import { wrapLongTokens } from './tokbreak'

/** 大纲条目：level=1..6；line 为 1-based 源码行号（data-line） */
export interface OutlineItem {
  level: number
  text: string
  id: string
  line: number
}

export interface RenderResult {
  /** 安全 HTML（P5 批3 起惰性求值：生产挂载只走 fragment，零序列化成本；
 *  既有测试与 A/B 对照访问 .html 时才从 fragment 克隆序列化并缓存） */
  readonly html: string
  outline: OutlineItem[]
  /** 渲染完成的正文节点（全链处理已就位），挂载方 adoptNode 直挂——
 *  摘掉了「serialize ~59ms + main.ts innerHTML 对 124K 节点二次 parse」双重解析 */
  readonly fragment: DocumentFragment
}

export interface RenderOptions {
  /** 中西文插空开关，默认 true（false 供 A/B 对照与排查） */
  pangu?: boolean
}

/** 从最终 DOM 提取 h1-h6 大纲（level/文本/锚点 id/源码行号） */
function extractOutline(root: Element): OutlineItem[] {
  const out: OutlineItem[] = []
  for (const el of Array.from(root.querySelectorAll('h1, h2, h3, h4, h5, h6'))) {
    const lineAttr = el.getAttribute('data-line')
    const item: OutlineItem = {
      level: Number.parseInt(el.tagName.slice(1), 10),
      text: (el.textContent ?? '').trim(),
      id: el.id,
      line: lineAttr === null ? 0 : Number.parseInt(lineAttr, 10),
    }
    out.push(item)
  }
  return out
}

/** 渲染一篇 Markdown 源文：返回正文 fragment、惰性安全 HTML 与大纲。
 *  各阶段耗时挂 window.__renderProfile（性能基线诊断用，CDP/控制台可读）。 */
export function renderDocument(src: string, opts?: RenderOptions): RenderResult {
  const t: Record<string, number> = {};
  let s = performance.now();
  // 性能早退（P3 基线诊断）：源文无 \( 与 \[ 时跳过保护（$$ 无反斜杠不需保护）
  // ——1MB 级无公式文档实测 extract 约 0.9s，indexOf 预检近乎零成本
  const needGuard = src.includes("\\(") || src.includes("\\[");
  const guards = needGuard ? extractMath(src) : null;
  t.extract = Math.round(performance.now() - s); s = performance.now();
  const rendered = md.render(guards !== null ? guards.text : src);
  t.mdRender = Math.round(performance.now() - s); s = performance.now();
  const raw = guards !== null ? restoreMath(rendered, guards) : rendered;
  t.restore = Math.round(performance.now() - s); s = performance.now();
  const clean = sanitizeHtml(raw);
  t.sanitize = Math.round(performance.now() - s); s = performance.now();
  const doc = new DOMParser().parseFromString(clean, 'text/html');
  t.parse = Math.round(performance.now() - s); s = performance.now();
  renderMath(doc);
  t.math = Math.round(performance.now() - s);
  if (opts?.pangu !== false) {
    s = performance.now();
    applyPangu(doc, doc.body);
    t.pangu = Math.round(performance.now() - s);
  }
  s = performance.now();
  wrapLongTokens(doc, doc.body);
  t.tokbreak = Math.round(performance.now() - s); s = performance.now();
  const outline = extractOutline(doc.body);
  // P5 批3·摘双重解析：正文节点一次搬运进 fragment（appendChild 跨文档即收养，
  // 零拷贝零字符串化）。html 字段改惰性——生产路径不触碰即零序列化成本，
  // 访问时从 fragment 克隆序列化（与旧 body.innerHTML 逐字节等价）。
  const fragment = document.createDocumentFragment();
  fragment.append(...Array.from(doc.body.childNodes));
  t.fragment = Math.round(performance.now() - s);
  let htmlCache: string | null = null;
  const result: RenderResult = {
    get html(): string {
      if (htmlCache === null) {
        const box = document.createElement("div");
        box.append(...Array.from(fragment.childNodes).map((node) => node.cloneNode(true)));
        htmlCache = box.innerHTML;
      }
      return htmlCache;
    },
    outline,
    fragment,
  };
  (window as unknown as Record<string, unknown>).__renderProfile = t;
  return result;
}
