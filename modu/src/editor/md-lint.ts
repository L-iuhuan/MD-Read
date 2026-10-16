/**
 * C1 · Markdown 格式检查——CM6 接线（规则见 lint-rules.ts 纯函数集）。
 * 契约：编辑态 only（挂 EditorView，阅读态零痕迹）；检测只读、无任何 fix 动作（IME 安全）。
 *  - error 波浪线＋悬停；warning 黄级波浪线＋徽标；info 只进徽标＋列表（CSS 去下划线）
 *  - 光标行静默（focusMode，VSCode 先例，fix-32 案2 收窄）：仅「最近 2 秒内有编辑」时，
 *    光标所在行的诊断暂不返回——打字期安静；停笔 2 秒后纯光标移动不再静默，点击/悬停
 *    错误行时诊断稳定在位；needsRefresh=docChanged||selectionSet 让 linter 相应重扫；
 *    linter() 自带 300ms 防抖（fix-32 案1：500ms 偏慢）
 *  - 状态栏徽标 #st-lint（本模块动态建，壳层零接线）：显示当前诊断总数，点击
 *    openLintPanel 打开 CM 内置问题列表面板；0 诊断隐藏；阅读态随 #editor-pane
 *    显隐联动（MutationObserver）——toEdit/toRead 走 hidden 切换，徽标同步归零隐身
 */
import { linter, openLintPanel, type Diagnostic } from "@codemirror/lint";
import type { Extension, Text } from "@codemirror/state";
import type { EditorView, ViewUpdate } from "@codemirror/view";
import { lintLines, type LintIssue } from "./lint-rules";
import "./md-lint.css";

/** linter 防抖窗（fix-32 案1：500ms 偏慢，真机复验改 300ms） */
const LINT_DELAY_MS = 300;
/** 最近编辑窗口（fix-32 案2）：打字期安静；停笔 2 秒后纯光标移动不再静默 → 点击/悬停错误行时诊断稳定在位 */
const RECENT_EDIT_WINDOW_MS = 2000;
/** 最近一次文档编辑时间戳（needsRefresh 里写入，lintSource 读取判断静默窗口） */
let lastEditAt = 0;
/** 已挂显隐观察器的编辑器容器（换档 setState 会重跑 mdLint()，观察器只挂一次） */
const observedPanes = new WeakSet<HTMLElement>();

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
  // 光标行静默仅限最近编辑窗口内（fix-32 案2）：停笔 2 秒后点击错误行不再触发消失
  const muteCursorLine = Date.now() - lastEditAt < RECENT_EDIT_WINDOW_MS;
  const issues = lintLines(lines).filter((d) => !muteCursorLine || d.line !== cursorLine);
  updateBadge(view, issues);
  return issues.map((d) => toDiagnostic(doc, d));
}

/** lint 扩展（editor.ts 接线）：规则 + 徽标 + 光标行静默全在此，检测只读不动文档 */
export function mdLint(): Extension {
  const needsRefresh = (u: ViewUpdate): boolean => {
    if (u.docChanged) lastEditAt = Date.now(); // 记录编辑时刻：静默窗口的起算点
    return u.docChanged || u.selectionSet; // refresh 语义保持 docChanged||selectionSet 不变
  };
  return linter(lintSource, { delay: LINT_DELAY_MS, needsRefresh });
}
