/**
 * 空标记行退出家族（Enter · exitEmptyMarkupLine ＋ Backspace · backspaceExitMarkupLine）。
 * fix-29 起实现整体迁居本文件（markdown-commands.ts 保 400 行门），既有导出面
 * 经其再导出不变。
 *
 * 背景（fix-29，主人实测 UX）：列表项下无空行续行是 Markdown 惰性延续——删掉
 * 行首 `- ` 再打字，文本仍渲染进上一个 <li>（缩进），除非手动空一行。期望：
 * 退格删标记＝退出列表。Enter 侧（2026-10-13 编辑回归修复）已有「纯标记行清
 * 整行」；Backspace 侧补同一语义＋惰性延续防线（空行是惰性延续的唯一断点）。
 *
 * Backspace · backspaceExitMarkupLine 口径：
 *  - 触发：光标行是纯标记行（EMPTY_MARKUP_LINE，与 Enter 侧同一杆尺）且光标
 *    在标记尾（标记之后任意位——行尾或标记与尾随空白之间）；有选区/任一光标
 *    不匹配即整体放行（多光标不做混合行为，同 Enter 侧）。
 *  - 动作（一次事务）：删整行标记；上文（前一行）是列表/引用项（PREV_ITEM_LINE）
 *    ⇒ 额外插一条空行分离，后续输入自然成段；上文非列表/引用（文档首行/平段落/
 *    空行/标题）⇒ 只删标记不加行。
 *  - 嵌套口径照抄 Enter 侧（别两套）：嵌套空引用 `> > ` 算纯标记 → 清整行；
 *    缩进列表 `  - ` **不**匹配（Enter 侧本就不接管，续标记照旧）→ Backspace
 *    同样放行给 CM 原生 deleteMarkupBackward（逐级退缩进）。
 *
 * Backspace 裁决链（皆 Prec.high，扩展数组在前者先裁——editor.ts 装配位次）：
 *   formatCompletions()（input-pairs：deleteBracketPair，光标夹在配对符中间）
 *   → markdownCommands()（本家族：纯标记行标记尾）
 *   → markdown()（markdownKeymap：deleteMarkupBackward，CM 原生删标记/缩进）
 *   → defaultKeymap（deleteCharBackward）。触发面互不相交：无配对场景
 *   deleteBracketPair 返 false 落到本家族；非纯标记行本家族返 false 落给 CM 原生。
 *
 * CRLF 契约（D7）：分离断行取 state.lineBreak；插入量按 Text 计位（\r\n 在文档
 * 里只计 1 个行位，拿字符串 length 会越界——同 insertTableSkeleton 口径）。
 * 撤销粒度：删标记＋空行分离＋光标 = 单个 view.dispatch（一次 Ctrl+Z 整退）。
 */
import { ensureSyntaxTree, syntaxTree } from "@codemirror/language";
import { EditorSelection, type EditorState, type Line } from "@codemirror/state";
import { type Command, EditorView } from "@codemirror/view";

/** 标记前缀（含可选任务部）：纯标记行判定的核，也是 Backspace 侧量「标记尾」的
 *  尺——两命令共用一份，别再抄一份防漂移。口径（含 fix-23 P2 扩形，逐字迁自
 *  markdown-commands.ts）：块级标记（>、-、*、+、数字.、数字)、全角－）或其任务
 *  形态（标记 + [ ]/[x]/[X]，大小写归一）。引用栈 `(?:\s*>)+` 认多级嵌套与缩进。 */
const EMPTY_MARKUP_PREFIX = /^(?:(?:\s*>)+|[-*+]|－|\d+[.)])(?:[ \u3000]+\[(?: |x|X)\])?/;

/** 纯标记行：标记前缀＋可选空白（认全角）再无他物（行首到行尾仅前缀＋尾空白）。
 *  有内容行、表格/公式行在文本上即不匹配；代码块内的同形行由树守卫排除。
 *  仍不匹配：`> - `（引用套列表，非纯引用栈）、缩进列表 `  - `（同 Enter 侧）。 */
const EMPTY_MARKUP_LINE = new RegExp(`${EMPTY_MARKUP_PREFIX.source}[ \t\u3000]*$`);

/** 上文「列表/引用项」：缩进列表/任务/有序/全角列表行、引用行（含 `> - ` 引用
 *  套列表）都算——这些上文会让无空行续行惰性折进上一块；平段落/空行/标题/围栏
 *  不算（平段落续行只是同段落，无 <li> 缩进问题，不加空行免双空行）。 */
const PREV_ITEM_LINE = /^(?:\s*(?:[-*+]|－|\d+[.)])[ \t\u3000]|>)/;

/** 树守卫名单：这些节点里的行是内容不是标记（与 live-preview.ts 整块跳过名单同源） */
const NON_MARKUP_NODES = new Set(["FencedCode", "CodeBlock", "HTMLBlock", "Table"]);

/** 树守卫：行落在代码/HTML/表格块内则不接管——代码块里的「- 」是代码不是标记
 *  （CM 自带的续标记命令同样在代码区放行）。树不完整时同步补解析（同 live-preview 口径）。 */
export function markupLineEditable(state: EditorState, line: Line): boolean {
  const tree = ensureSyntaxTree(state, line.to, 100) ?? syntaxTree(state);
  // 探针取行内首个非空白字符：缩进代码块（CodeBlock）节点从内容起算、不覆盖行首缩进，
  // 用 line.from 会落在节点之外（resolveInner(line.from, 1) 得 Document）⇒ 守卫漏判。
  const indent = /^[ \t]*/.exec(line.text)?.[0].length ?? 0;
  const probe = line.from + indent;
  let node: ReturnType<typeof tree.resolveInner> | null = tree.resolveInner(probe < line.to ? probe : line.from, 1);
  while (node !== null) {
    if (NON_MARKUP_NODES.has(node.name)) return false;
    node = node.parent;
  }
  return true;
}

/** Enter · 空标记行退出：光标行是纯标记行（空引用/空列表/空任务项）→ 整行清除
 *  标记、光标停行首（Typora 惯例——CM 自带的 insertNewlineContinueMarkup 对首个
 *  空「> 」行会再续一个「> 」，视觉上「Enter 自动插空白行、永不退出」）。
 *  其余一律返回 false 放行，续标记行为零变化；纯删除不插入文本（CRLF 契约）。 */
export const exitEmptyMarkupLine: Command = (view: EditorView): boolean => {
  const { state } = view;
  if (!state.selection.ranges.every((r) => r.empty)) {
    return false; // 有选区：Enter 走默认的替换语义
  }
  const seen = new Set<number>();
  const changes: { from: number; to?: number; insert?: string }[] = [];
  for (const range of state.selection.ranges) {
    const line = state.doc.lineAt(range.head);
    if (!EMPTY_MARKUP_LINE.test(line.text) || !markupLineEditable(state, line)) {
      return false; // 任一光标不匹配即整体放行（多光标不做混合行为）
    }
    if (!seen.has(line.from)) { // 多光标同行只清一次（重叠 change 会被 CM 拒绝）
      seen.add(line.from);
      changes.push({ from: line.from, to: line.to });
    }
  }
  const sel = state.selection;
  view.dispatch({
    changes,
    selection: EditorSelection.create(changes.map((c) => EditorSelection.cursor(c.from)), Math.min(sel.mainIndex, changes.length - 1)),
  });
  return true;
};

/** Backspace · 空标记行智能退出（fix-29）：见文件头注——一次事务删整行标记，上文
 *  是列表/引用项时插空行分离（惰性延续防线），光标落退出行行首。 */
export const backspaceExitMarkupLine: Command = (view: EditorView): boolean => {
  const { state } = view;
  if (!state.selection.ranges.every((r) => r.empty)) {
    return false; // 有选区：Backspace 走默认的删除选区语义
  }
  const seen = new Set<number>();
  const exits: { from: number; to: number; separate: boolean }[] = [];
  for (const range of state.selection.ranges) {
    const line = state.doc.lineAt(range.head);
    const prefix = EMPTY_MARKUP_PREFIX.exec(line.text);
    if (prefix === null || !EMPTY_MARKUP_LINE.test(line.text) || range.head < line.from + prefix[0].length || !markupLineEditable(state, line)) {
      return false; // 非纯标记行（prefix 命中但行有内容）、光标不在标记尾、代码块内：整体放行
    }
    if (!seen.has(line.from)) { // 多光标同行只退一次（重叠 change 会被 CM 拒绝）
      seen.add(line.from);
      const prev = line.number > 1 ? state.doc.line(line.number - 1).text : "";
      exits.push({ from: line.from, to: line.to, separate: PREV_ITEM_LINE.test(prev) });
    }
  }
  const br = state.toText(state.lineBreak); // Text 计位：\r\n 只占 1 个行位（D7）
  const sel = state.selection;
  view.dispatch({
    changes: exits.map((e) => (e.separate ? { from: e.from, to: e.to, insert: br } : { from: e.from, to: e.to })),
    selection: EditorSelection.create(
      exits.map((e) => EditorSelection.cursor(e.separate ? e.from + br.length : e.from)),
      Math.min(sel.mainIndex, exits.length - 1),
    ),
    userEvent: "delete.backward",
  });
  return true;
};
