/**
 * C1 · Markdown 格式检查——CM6 接线（规则见 lint-rules.ts 纯函数集）。
 * 契约：编辑态 only（挂 EditorView，阅读态零痕迹）；检测只读、无任何 fix 动作（IME 安全）。
 *  - error 波浪线＋悬停；warning 黄级波浪线＋徽标；info 只进徽标＋列表（CSS 去下划线）
 *  - 光标行静默（focusMode，VSCode 先例，fix-32 案2 收窄）：仅「最近 2 秒内有编辑」时，
 *    光标所在行的诊断暂不返回——打字期安静；停笔 2 秒后由到期定时器（relintNow 效果）
 *    补一次全量扫描恢复显示。2026-11-04 改造：原靠 needsRefresh 含 selectionSet 在下一次
 *    光标移动时补扫——但纯选区移动会触发 @codemirror/lint 6.9.7 run() 无条件重派发诊断，
 *    把问题面板选中重置回首条并整表重建（dist:101 selected=首条 / dist:319 无条件 dispatch
 *    / dist:547 面板按对象身份重建——用户实测「点击后跳回第一条」），
 *    故 needsRefresh 只认 docChanged 与 relintNow，纯选区移动零重扫。
 *  - 跳转高亮（2026-11-04 用户需求「位置相近分不清是哪一个」）：点击问题面板条目 →
 *    目标范围挂 .md-lint-flash（accent 软底，皮在 md-lint.css）。生命周期 = 光标停在该
 *    诊断上：选区/文档一变即摘——对照相邻报错需要常驻，不用闪烁。
 *  - 状态栏徽标 #st-lint（本模块动态建，壳层零接线）：显示当前诊断总数，点击
 *    openLintPanel 打开 CM 内置问题列表面板；0 诊断隐藏；阅读态随 #editor-pane
 *    显隐联动（MutationObserver）——toEdit/toRead 走 hidden 切换，徽标同步归零隐身
 */
import { linter, openLintPanel, type Diagnostic } from "@codemirror/lint";
import { StateEffect, StateField, type Extension, type Text } from "@codemirror/state";
import { Decoration, EditorView, ViewPlugin, type DecorationSet, type ViewUpdate } from "@codemirror/view";
import { lintLines, type LintIssue } from "./lint-rules";
import "./md-lint.css";

/** linter 防抖窗（fix-32 案1：500ms 偏慢，真机复验改 300ms） */
const LINT_DELAY_MS = 300;
/** 最近编辑窗口（fix-32 案2）：打字期安静；停笔 2 秒后纯光标移动不再静默 → 点击/悬停错误行时诊断稳定在位 */
const RECENT_EDIT_WINDOW_MS = 2000;
/** 到期补扫的裕量：保证补扫跑 linter 时静默窗已确定关闭（窗长+防抖+裕量后触发） */
const RELINT_GRACE_MS = 50;
/** 最近一次文档编辑时间戳（mdLint 的 updateListener 里写入，lintSource 读取判断静默窗口） */
let lastEditAt = 0;
/** 已挂显隐观察器的编辑器容器（换档 setState 会重跑 mdLint()，观察器只挂一次） */
const observedPanes = new WeakSet<HTMLElement>();
/** 到期补扫定时器句柄（每次编辑重排；单编辑器实例——本应用一个 EditorView 复用于所有标签页） */
let relintTimer: ReturnType<typeof setTimeout> | null = null;

/** 内部补扫触发标记：forceLinting 只能加速未决的 lint（plugin.force 看 this.set），静止期须自派发事务走 needsRefresh */
const relintNow = StateEffect.define<null>();

/** 停笔静默窗到期后补一次全量扫描：恢复打字期被光标行静默的诊断（原靠下一次选区移动，见头注） */
function scheduleMuteExpiryRelint(view: EditorView): void {
  if (relintTimer !== null) clearTimeout(relintTimer);
  const wait = RECENT_EDIT_WINDOW_MS + LINT_DELAY_MS + RELINT_GRACE_MS - (Date.now() - lastEditAt);
  relintTimer = setTimeout(() => {
    relintTimer = null;
    if (view.dom.isConnected) view.dispatch({ effects: relintNow.of(null) }); // 视图已销毁（DOM 已摘）则不再补扫
  }, Math.max(wait, 0));
}

/** 跳转高亮标记（皮见 md-lint.css .md-lint-flash） */
const flashMark = Decoration.mark({ class: "md-lint-flash" });
/** lintJumpFlash.of({from,to})=高亮该范围；.of(null)=清除 */
const lintJumpFlash = StateEffect.define<{ from: number; to: number } | null>();
/** 高亮生命周期 = 光标停在该诊断上：选区/文档一变即摘（flash 效果本事务优先，不吃自己的清除） */
const lintJumpFlashField = StateField.define<DecorationSet>({
  create: () => Decoration.none,
  update: (value, tr) => {
    let flash: { from: number; to: number } | null = null;
    let cleared = false;
    for (const e of tr.effects) {
      if (!e.is(lintJumpFlash)) continue;
      if (e.value === null) cleared = true;
      else flash = e.value;
    }
    if (flash !== null) return Decoration.set([flashMark.range(flash.from, flash.to)]);
    // ⚠ 选区判据用 tr.selection（Transaction 无 selectionSet 布尔——那是 ViewUpdate 的属性，
    //   2026-11-04 插桩实证写 tr.selectionSet 恒 undefined，纯选区事务摘不掉高亮）
    if (cleared || tr.selection !== undefined || tr.docChanged) return Decoration.none;
    return value.map(tr.changes);
  },
  provide: (f) => EditorView.decorations.from(f),
});

/** 给 view.dom 挂面板条目点击监听（CM 的 domEventHandlers 只挂 contentDOM，面板够不着）。
 *  CM 面板 ul 的 click（moveSelection：选区=诊断范围）先于本监听执行（更深节点先收冒泡），
 *  故读 view.state.selection 即刚落位的目标范围。 */
function wireLintJumpFlash(view: EditorView): () => void {
  const onClick = (event: MouseEvent): void => {
    const target = event.target;
    if (!(target instanceof Element)) return;
    if (target.closest(".cm-panel-lint li.cm-diagnostic") === null) return;
    const sel = view.state.selection.main;
    if (sel.from >= sel.to) return; // 空选区无可高亮范围（如「暂无诊断」占位条）
    view.dispatch({ effects: lintJumpFlash.of({ from: sel.from, to: sel.to }) });
  };
  view.dom.addEventListener("click", onClick);
  return () => view.dom.removeEventListener("click", onClick);
}

class LintJumpFlashPlugin {
  private readonly off: () => void;
  public constructor(view: EditorView) {
    this.off = wireLintJumpFlash(view);
  }
  public destroy(): void {
    this.off();
  }
}

function topSeverity(issues: readonly LintIssue[]): string {
  if (issues.some((d) => d.severity === "error")) return "error";
  if (issues.some((d) => d.severity === "warning")) return "warning";
  return "info";
}

/** 纯规则诊断 → CM 诊断（位置钳进行内，防越界） */
function toDiagnostic(doc: Text, issue: LintIssue): Diagnostic {
  const line = doc.line(Math.min(issue.line, doc.lines));
  const from = Math.min(line.from + issue.colStart, line.to);
  return { from, to: Math.min(from + issue.len, line.to), severity: issue.severity, message: issue.message };
}

function createBadge(view: EditorView, bar: Element): HTMLButtonElement {
  const btn = document.createElement("button");
  btn.id = "st-lint";
  btn.type = "button";
  btn.title = "Markdown 格式检查：点击查看问题列表";
  btn.addEventListener("click", () => openLintPanel(view));
  bar.insertBefore(btn, bar.querySelector(".statusbar-spacer")); // 徽标排在右侧进度条之前
  return btn;
}

/** 徽标显隐/文案：状态存 dataset（显隐观察器回调复用同一入口） */
function syncBadge(btn: HTMLButtonElement, pane: HTMLElement): void {
  const count = Number(btn.dataset.count ?? "0");
  btn.textContent = `问题 ${count}`;
  btn.hidden = count === 0 || pane.hidden; // 0 诊断隐藏；阅读态零痕迹
}

function updateBadge(view: EditorView, issues: readonly LintIssue[]): void {
  const bar = document.querySelector(".statusbar");
  const pane = view.dom.parentElement;
  if (bar === null || pane === null) return; // 纯建态测试/无壳层 DOM：静默跳过
  const existing = bar.querySelector("#st-lint");
  const btn = existing instanceof HTMLButtonElement ? existing : createBadge(view, bar);
  btn.dataset.count = String(issues.length);
  btn.dataset.severity = topSeverity(issues);
  syncBadge(btn, pane);
  if (!observedPanes.has(pane)) {
    observedPanes.add(pane);
    new MutationObserver(() => syncBadge(btn, pane)).observe(pane, {
      attributes: true,
      attributeFilter: ["hidden"],
    });
  }
}

function lintSource(view: EditorView): Diagnostic[] {
  const doc = view.state.doc;
  const lines: string[] = [];
  for (let i = 1; i <= doc.lines; i++) lines.push(doc.line(i).text);
  const cursorLine = doc.lineAt(view.state.selection.main.head).number;
  // 光标行静默仅限最近编辑窗口内（fix-32 案2）：停笔 2 秒后点击错误行不再触发消失；
  // 窗口到期后的恢复显示由 scheduleMuteExpiryRelint 的补扫完成
  const muteCursorLine = Date.now() - lastEditAt < RECENT_EDIT_WINDOW_MS;
  const issues = lintLines(lines).filter((d) => !muteCursorLine || d.line !== cursorLine);
  updateBadge(view, issues);
  return issues.map((d) => toDiagnostic(doc, d));
}

/** lint 扩展（editor.ts 接线）：规则 + 徽标 + 光标行静默 + 跳转高亮，检测只读不动文档。
 *  ⚠ 编辑追踪走 updateListener 而非 needsRefresh：@codemirror/lint 的 lintPlugin.update
 *  对 docChanged 短路（dist:325 `update.docChanged || …`），needsRefresh 在编辑事务上
 *  根本不被调用——旧版把 lastEditAt 写在 needsRefresh 里是死代码（静默从未真正生效，
 *  2026-11-04 插桩实证），现由 updateListener 承担。 */
export function mdLint(): Extension {
  const trackEdits = (u: ViewUpdate): void => {
    if (!u.docChanged) return;
    lastEditAt = Date.now(); // 记录编辑时刻：静默窗口的起算点
    scheduleMuteExpiryRelint(u.view);
  };
  const needsRefresh = (u: ViewUpdate): boolean =>
    // 纯选区移动不重扫（面板选中重置根因，见头注）；docChanged 由 lintPlugin 自身处理；只认内部补扫标记
    u.transactions.some((tr) => tr.effects.some((e) => e.is(relintNow)));
  return [
    linter(lintSource, { delay: LINT_DELAY_MS, needsRefresh }),
    EditorView.updateListener.of(trackEdits),
    lintJumpFlashField,
    ViewPlugin.fromClass(LintJumpFlashPlugin),
  ];
}
