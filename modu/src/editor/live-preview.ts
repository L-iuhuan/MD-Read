/**
 * 编辑增强 A2 · Live Preview 实时渲染（Typora 式）：
 * 非光标行渲染成阅读态——Markdown 标记隐藏、正文着样式类；光标行与选区覆盖行
 * 保持源码可编辑（装饰即时退场）。
 *
 * 节点名全部经 dump 探针确证（@codemirror/lang-markdown 6.5.2 / @lezer/markdown，
 * commonmark 与 GFM 两种 base 各跑一次，2026-10-12）：
 *   ATXHeading1..6 > HeaderMark · StrongEmphasis/Emphasis > EmphasisMark ·
 *   Strikethrough > StrikethroughMark（GFM）· InlineCode > CodeMark ·
 *   Link > LinkMark×4 + URL/LinkLabel · Blockquote > QuoteMark（逐行）·
 *   Task > TaskMarker（GFM）· FencedCode/HTMLBlock/Table（整体跳过）。
 * ⚠ markdown() 默认 base 是 commonmark（无 GFM）：任务列表在该形态下无 Task 节点，
 *   回退为 ListItem 首段的 `[ ]`/`[x]`/`[X]` 字面判定（与 TaskListExtension 同条件）。
 *
 * 红线：装饰只改「显示」，绝不改文档字节；IME 组词期（view.composing 或
 * input.type.compose）只映射旧装饰、不施加新装饰（CM 官方纪律，帖 8265）。
 * v1 不渲染：代码块内容、数学、mermaid、HTML 块、表格（表格编辑由另一包负责）。
 */
import { ensureSyntaxTree, syntaxTree } from "@codemirror/language";
import { EditorState, RangeSetBuilder, type Extension } from "@codemirror/state";
import {
  Decoration,
  EditorView,
  ViewPlugin,
  WidgetType,
  type DecorationSet,
  type ViewUpdate,
} from "@codemirror/view";

/** 视口外上下各多算的行数（预滚动渲染） */
const MARGIN_LINES = 10;

/** 隐藏标记的替换装饰（无样式，纯隐藏）；Decoration 不可变，全局复用 */
const HIDDEN = Decoration.replace({});

/** 任务勾选框（不可交互的纯展示件）：v1 不接管点击——编辑任务状态请移进行内改源码。
 *  导出供测试判型（widget instanceof）。 */
export class TaskCheckboxWidget extends WidgetType {
  constructor(readonly checked: boolean) {
    super();
  }
  override eq(other: TaskCheckboxWidget): boolean {
    return other.checked === this.checked;
  }
  toDOM(): HTMLElement {
    const box = document.createElement("span");
    box.className = this.checked ? "cm-lp-task cm-lp-task-on" : "cm-lp-task";
    if (this.checked) {
      box.textContent = "✓";
    }
    return box;
  }
  override ignoreEvent(): boolean {
    return true; // 纯装饰件，事件一律交还编辑器
  }
}

/** 渲染态样式：全走 tokens.css 的 CSS 变量（禁字面色值），随主题亮暗自动跟随。
 *  标题字号/字重呼应阅读态 cjk.css（h1 1.85em/700 … h4 .95em/600，h2-h4 着 --accent-ink）。 */
const livePreviewTheme = EditorView.theme({
  ".cm-lp-h1": { fontSize: "1.85em", fontWeight: "700", color: "var(--text)" },
  ".cm-lp-h2": { fontSize: "1.4em", fontWeight: "700", color: "var(--accent-ink)" },
  ".cm-lp-h3": { fontSize: "1.15em", fontWeight: "600", color: "var(--accent-ink)" },
  ".cm-lp-h4": { fontSize: ".95em", fontWeight: "600", color: "var(--accent-ink)" },
  ".cm-lp-h5": { fontSize: ".95em", fontWeight: "600", color: "var(--text)" },
  ".cm-lp-h6": { fontSize: ".95em", fontWeight: "600", color: "var(--text-muted)" },
  ".cm-lp-strong": { fontWeight: "700" },
  ".cm-lp-em": { fontStyle: "italic" },
  ".cm-lp-strike": { textDecoration: "line-through", color: "var(--text-muted)" },
  ".cm-lp-code": {
    fontFamily: "var(--font-mono)",
    fontSize: ".85em",
    color: "var(--accent-ink)",
    backgroundColor: "var(--bg-code-inline)",
    borderRadius: "var(--radius-1)",
    padding: "0.1em 0.35em",
  },
  ".cm-lp-link": { color: "var(--accent-ink)", textDecoration: "underline", textUnderlineOffset: "2px" },
  ".cm-lp-quote": {
    borderLeft: "3px solid var(--accent-solid)",
    paddingLeft: "0.75em",
    backgroundColor: "var(--tint-quote)",
  },
  ".cm-lp-task": {
    display: "inline-block",
    boxSizing: "border-box",
    width: "0.85em",
    height: "0.85em",
    marginRight: "0.35em",
    verticalAlign: "middle",
    border: "1px solid var(--border-strong)",
    borderRadius: "3px",
    fontSize: "0.8em",
    lineHeight: "1",
  },
  ".cm-lp-task.cm-lp-task-on": {
    backgroundColor: "var(--accent-solid)",
    borderColor: "var(--accent-solid)",
    color: "var(--bg-app)",
  },
});

interface PendingDeco {
  from: number;
  to: number;
  deco: Decoration;
}

/** 光标行＋选区覆盖行（按行展开为豁免区间） */
function exemptedRanges(state: EditorState): { from: number; to: number }[] {
  const ranges: { from: number; to: number }[] = [];
  for (const sel of state.selection.ranges) {
    const first = state.doc.lineAt(sel.from).number;
    const last = state.doc.lineAt(sel.to).number;
    for (let n = first; n <= last; n++) {
      const line = state.doc.line(n);
      ranges.push({ from: line.from, to: line.to });
    }
  }
  return ranges;
}

/** 计算范围 = 视口 ± MARGIN_LINES 行，相邻/重叠合并（iterate 各跑一次、去重靠 from 归属） */
function expandedRanges(
  doc: EditorState["doc"],
  visible: readonly { from: number; to: number }[],
): { from: number; to: number }[] {
  const out: { from: number; to: number }[] = [];
  for (const v of visible) {
    const fromLine = Math.max(1, doc.lineAt(v.from).number - MARGIN_LINES);
    const toLine = Math.min(doc.lines, doc.lineAt(v.to).number + MARGIN_LINES);
    const from = doc.line(fromLine).from;
    const to = doc.line(toLine).to;
    const prev = out[out.length - 1];
    if (prev !== undefined && from <= prev.to) {
      prev.to = Math.max(prev.to, to);
    } else {
      out.push({ from, to });
    }
  }
  return out;
}

/** display math 段守卫（fix-23 P2）：剥掉行首「引用栈 / 缩进 / 列表标记」后
 *  是否以 $$ 开头（项目禁裸 $，$$ 起段必为公式）——缩进与列表内的 `$$…$$` 段
 *  与列首形态同守卫（原来只认列首与引用内）。⚠ 手写单趟扫描、不用 `(?:\s*…)*`
 *  型正则：空白归两段共用会指数回溯（编辑热路径，「- - - - …」行能冻死渲染）。
 *  列表标记后必须跟空白（防把 `*b*` 的 `*` 当标记）。 */
export function startsDisplayMath(lineText: string): boolean {
  const s = lineText;
  const len = s.length;
  const isSpace = (c: string): boolean => c === " " || c === "\t" || c === "\u3000";
  let i = 0;
  for (;;) {
    while (i < len && isSpace(s[i])) {
      i++;
    }
    if (i >= len) {
      return false;
    }
    if (s[i] === ">") {
      i++;
      continue; // 引用栈：单枚 > 剥完回吃空白（> > 多级由此支持）
    }
    let marker = 0; // 列表标记长度：-/*/+ 一位，或 数字./)
    if (s[i] === "-" || s[i] === "+" || s[i] === "*") {
      marker = 1;
    } else {
      let d = i;
      while (d < len && s[d] >= "0" && s[d] <= "9") {
        d++;
      }
      if (d > i && d < len && (s[d] === "." || s[d] === ")")) {
        marker = d + 1 - i;
      }
    }
    if (marker > 0 && i + marker < len && isSpace(s[i + marker])) {
      i += marker + 1;
      continue;
    }
    return s.startsWith("$$", i);
  }
}

/** 整条引用行剥去 > 前缀与空白后无内容（空续行，如「> 」「> > 」）：QuoteMark
 *  隐藏的豁免形态（2026-10-13 编辑回归修复）——空续行显示源码「> 」，不再是
 *  视觉上的「自动插入空白行」；有内容的引用行照常隐藏渲染。 */
const EMPTY_QUOTE_LINE = /^(?:\s*>)+\s*$/;

/** 装饰主构建：语法树 iterate（每个计算范围一次），一次 RangeSetBuilder 收口 */
export function buildLivePreviewDecorations(
  state: EditorState,
  visible: readonly { from: number; to: number }[],
): DecorationSet {
  const doc = state.doc;
  const ranges = expandedRanges(doc, visible);
  const exempt = exemptedRanges(state);
  /** 段落内 $$…$$ 实际跨度（task-4：只豁免公式本身，跨度外同段正文照常装饰）。
   *  迭代中由 Paragraph 分支推入；add() 据此过滤，避免「$$ 起段整段零装饰」过宽。 */
  const mathExempt: { from: number; to: number }[] = [];
  const pending: PendingDeco[] = [];
  const inCompute = (from: number): boolean =>
    ranges.some((r) => from >= r.from && from <= r.to);
  const add = (from: number, to: number, deco: Decoration): void => {
    if (to <= from || !inCompute(from)) {
      return;
    }
    if (exempt.some((e) => to > e.from && from <= e.to)) {
      return; // 光标/选区行：装饰退场
    }
    if (mathExempt.some((e) => to > e.from && from < e.to)) {
      return; // $$…$$ 实际跨度：公式体内不上装饰（同段跨度外照常）
    }
    pending.push({ from, to, deco });
  };
  const style = (from: number, to: number, cls: string): void => {
    add(from, to, Decoration.mark({ class: cls }));
  };
  const hide = (from: number, to: number): void => {
    add(from, to, HIDDEN);
  };
  /** 标记后紧跟一个空格则一并隐藏（`> ` / `# ` 的显示形态） */
  const markEnd = (pos: number): number => (doc.sliceString(pos, pos + 1) === " " ? pos + 1 : pos);
  const taskAt = (from: number, to: number, marker: string): void => {
    add(from, to, Decoration.replace({ widget: new TaskCheckboxWidget(marker !== " ") }));
  };
  /** 阅读侧 @mdit/plugin-tasklist 的识别条件比 lezer GFM 严格：「]」后必须是半角
   *  空格，且行内还要有非空白标签（空任务项「- [ ] 」「- [ ]」「- [x]已办」、
   *  tab 分隔在阅读态都只是字面文本）。两处任务分支都要过这道闸，否则编辑态
   *  显示勾选框、切阅读态变回字面（「编辑里看起来对了、切阅读却变了」）。
   *  对照锚：tests/editor-audit-live-preview.spec.ts。 */
  const taskRenderable = (markerFrom: number, markerTo: number): boolean => {
    if (doc.sliceString(markerTo, markerTo + 1) !== " ") {
      return false;
    }
    const line = doc.lineAt(markerFrom);
    return line.text.slice(markerTo - line.from + 1).trim() !== "";
  };

  /** 段落内「$$」…「$$」的实际跨度：从段首「$$」起找下一个「$$」（与 mathprotect 的
   *  indexOf(close) 同口径；多行块按整段源码跨度收）。找不到闭合返回 null。
   *  仅在同段内配对——跨段（空行后）闭合属边缘形态，阅读侧本身也走退化路径。 */
  const mathSpanOf = (paraFrom: number, paraTo: number): { from: number; to: number } | null => {
    const closeRel = doc.sliceString(paraFrom + 2, paraTo).indexOf("$$");
    return closeRel === -1 ? null : { from: paraFrom, to: paraFrom + 2 + closeRel + 2 };
  };

  // 树获取：优先 ensure（至多 100ms 同步补解析，CM forceParsing 同款预算）——
  // 视口边缘未解析时当场补齐；树已完整时零成本命中缓存；极端超时退回当前树，
  // 待后台解析推进触发 viewportChanged 重建。headless（无 view 刷新 field.tree）也拿得到完整树。
  const treeTop = ranges.reduce((max, r) => Math.max(max, r.to), 0);
  const tree = ensureSyntaxTree(state, treeTop, 100) ?? syntaxTree(state);
  for (const range of ranges) {
    tree.iterate({
      from: range.from,
      to: range.to,
      enter: (node) => {
        const name = node.name;
        const parent = node.node.parent?.name ?? "";
        switch (name) {
          case "FencedCode": // 代码块内容/围栏/语言标签一律保持源码
          case "HTMLBlock":
          case "Table": // 表格编辑由另一包负责，混渲染会打架
          case "Image": // 图片不在 v1 渲染范围（含其 LinkMark/URL 子节点）
          case "HorizontalRule":
          case "SetextHeading1":
          case "SetextHeading2":
            return false;
          case "Paragraph": {
            // 非 $$ 起段：正常装饰
            if (!startsDisplayMath(doc.lineAt(node.from).text)) {
              return true;
            }
            // $$ 起段（含引用/列表内）：豁免收敛到 $$…$$ 实际跨度（与 mathprotect「取下一个 $$」同口径）。
            // 未闭合 ⇒ 无跨度、不豁免（正文照常装饰，与阅读态一致）；
            // 整段就是一个 $$ 块 ⇒ 仍零装饰（既有设计意图，源码可编辑）。
            const span = mathSpanOf(node.from, node.to);
            if (span === null || span.to >= node.to) {
              return span === null; // 未闭合＝可装饰；整段公式＝零装饰
            }
            mathExempt.push(span);
            return true;
          }
          case "ATXHeading1":
          case "ATXHeading2":
          case "ATXHeading3":
          case "ATXHeading4":
          case "ATXHeading5":
          case "ATXHeading6":
            style(node.from, node.to, `cm-lp-h${name.slice(-1)}`);
            return true;
          case "StrongEmphasis":
            style(node.from, node.to, "cm-lp-strong");
            return true;
          case "Emphasis":
            style(node.from, node.to, "cm-lp-em");
            return true;
          case "Strikethrough":
            style(node.from, node.to, "cm-lp-strike");
            return true;
          case "InlineCode":
            style(node.from, node.to, "cm-lp-code");
            return true;
          case "Link": {
            // 有目标（URL/LinkLabel）才隐语法；无目标的快捷引用保持源码
            const detail = node.node;
            const hasTarget =
              detail.getChildren("URL").length > 0 || detail.getChildren("LinkLabel").length > 0;
            if (hasTarget) {
              style(node.from, node.to, "cm-lp-link");
              return true;
            }
            return false;
          }
          case "Blockquote": {
            // 引用逐行着色（左缘条 + 底 tint）；行首标记由 QuoteMark 分支隐藏
            const first = doc.lineAt(node.from).number;
            const last = doc.lineAt(node.to).number;
            for (let n = first; n <= last; n++) {
              const line = doc.line(n);
              style(line.from, line.to, "cm-lp-quote");
            }
            return true;
          }
          case "ListItem": {
            // commonmark base 无 Task 节点：任务形态字面回退（与 TaskListExtension 同条件）
            if (node.node.getChildren("Task").length === 0) {
              const para = node.node.getChildren("Paragraph")[0];
              const marker = para === undefined ? "" : doc.sliceString(para.from, para.from + 3);
              if (para !== undefined && (marker === "[ ]" || marker === "[x]" || marker === "[X]") && taskRenderable(para.from, para.from + 3)) {
                taskAt(para.from, para.from + 3, marker[1]);
              }
            }
            return true;
          }
          case "TaskMarker": // GFM base：Task > TaskMarker
            if (parent === "Task" && taskRenderable(node.from, node.to)) {
              taskAt(node.from, node.to, doc.sliceString(node.from + 1, node.to - 1));
            }
            return false;
          case "HeaderMark": // ATX 的 # 前缀（Setext 已整块跳过，不会到这）
            if (parent.startsWith("ATXHeading")) {
              hide(node.from, markEnd(node.to));
            }
            return true;
          case "EmphasisMark":
            hide(node.from, node.to);
            return true;
          case "StrikethroughMark":
            hide(node.from, node.to);
            return true;
          case "CodeMark": // 行内码反引号（FencedCode 已跳过，此处必为行内）
            if (parent === "InlineCode") {
              hide(node.from, node.to);
            }
            return true;
          case "QuoteMark": // 纯标记行豁免：空续行（「> 」「> > 」）不隐藏、显示源码
            if (!EMPTY_QUOTE_LINE.test(doc.lineAt(node.from).text)) {
              hide(node.from, markEnd(node.to));
            }
            return true;
          case "LinkMark":
          case "URL":
          case "LinkLabel": // Image 已剪枝；此处 parent 必为可渲染 Link
            if (parent === "Link") {
              hide(node.from, node.to);
            }
            return true;
          default:
            return true;
        }
      },
    });
  }
  pending.sort(
    (a, b) => a.from - b.from || a.deco.startSide - b.deco.startSide || a.to - b.to,
  );
  const builder = new RangeSetBuilder<Decoration>();
  for (const p of pending) {
    builder.add(p.from, p.to, p.deco);
  }
  return builder.finish();
}

/** IME 组词豁免：组词期只 map 旧装饰不加新装饰；组词结束后首个 update 强制重建 */
class LivePreviewViewPlugin {
  decorations: DecorationSet;
  private composeGated = false;

  constructor(view: EditorView) {
    this.decorations = buildLivePreviewDecorations(view.state, view.visibleRanges);
  }

  update(update: ViewUpdate): void {
    const composing =
      update.view.composing ||
      update.transactions.some((tr) => tr.isUserEvent("input.type.compose"));
    if (composing) {
      this.composeGated = true;
      this.decorations = this.decorations.map(update.changes);
      return;
    }
    if (this.composeGated || update.docChanged || update.viewportChanged || update.selectionSet) {
      this.composeGated = false;
      this.decorations = buildLivePreviewDecorations(update.view.state, update.view.visibleRanges);
    }
  }
}

/** 导出插件实例：测试可用 view.plugin(livePreviewPlugin) 读取装饰集 */
export const livePreviewPlugin = ViewPlugin.fromClass(LivePreviewViewPlugin, {
  decorations: (view: LivePreviewViewPlugin): DecorationSet => view.decorations,
});

/** Live Preview 扩展：直接加入 baseExtensions 即生效（总装接线在 B 批）。
 *  建议装配位次：markdown() 语言之后，与 syntaxHighlighting 并列。 */
export function livePreview(): Extension {
  return [livePreviewPlugin, livePreviewTheme];
}
