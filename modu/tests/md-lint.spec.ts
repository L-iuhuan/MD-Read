/**
 * C1 · md-lint 接线行为（真 EditorView + jsdom + 假时钟，不 mock 生产代码）：
 *  - 案1（2026-11-04）：点击问题面板条目后不得重扫——@codemirror/lint 6.9.7 的 run()
 *    无条件重派发诊断，会把面板选中重置回首条并整表重建（dist:101/319/547），
 *    故 needsRefresh 只认 docChanged；「停笔 2s 恢复被静默诊断」改由到期定时器补扫。
 *  - 案2（2026-11-04）：点击面板条目 → 目标范围挂 .md-lint-flash 高亮，
 *    选区/文档一变即摘（对照相邻报错需要常驻，不用闪烁）。
 * 常量与 md-lint.ts 同步（测试锚：改那边须同步这里）。
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { openLintPanel } from "@codemirror/lint";
import { mdLint } from "../src/editor/md-lint";

/** jsdom 无布局引擎：CM 的 scrollIntoView/测量链会读 Range.getClientRects（本仓其他
 *  编辑器测试不走 scrollIntoView 路径故未踩到；本文件的真面板点击必经），补空矩形桩。 */
beforeAll(() => {
  Range.prototype.getClientRects = function stubRects(): DOMRectList {
    return [] as unknown as DOMRectList;
  };
  Range.prototype.getBoundingClientRect = function stubRect(): DOMRect {
    return { x: 0, y: 0, width: 0, height: 0, top: 0, right: 0, bottom: 0, left: 0, toJSON: () => ({}) } as DOMRect;
  };
});

const LINT_DELAY_MS = 300; // linter 防抖窗（md-lint.ts LINT_DELAY_MS）
const MUTE_WINDOW_MS = 2000; // 光标行静默窗（md-lint.ts RECENT_EDIT_WINDOW_MS）

function makeView(doc: string): EditorView {
  const host = document.createElement("div");
  document.body.appendChild(host);
  return new EditorView({ state: EditorState.create({ doc, extensions: [mdLint()] }), parent: host });
}

function makeStatusbar(): void {
  const bar = document.createElement("div");
  bar.className = "statusbar";
  const spacer = document.createElement("div");
  spacer.className = "statusbar-spacer";
  bar.appendChild(spacer);
  document.body.appendChild(bar);
}

function badgeText(): string {
  return document.querySelector<HTMLButtonElement>("#st-lint")?.textContent ?? "";
}

describe("md-lint 接线：面板点击与跳转高亮", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
    document.body.innerHTML = "";
  });

  it("点击面板第 2 条：高亮挂目标范围、选中停在第 2 条，推进时钟不回跳首条", async () => {
    const view = makeView("**坏加粗\n参见[文本] (https://example.com) 的行\n");
    // advanceTimersByTimeAsync：lint 源同步跑，但 setDiagnostics 走 Promise 微任务（batchResults），
    // 须在计时器回调间冲刷，面板才有真条目（同步 advance 只会看到「暂无诊断」占位条）
    await vi.advanceTimersByTimeAsync(LINT_DELAY_MS + 100); // 初次 lint：2 条 error 落面板源
    openLintPanel(view);
    const items = view.dom.querySelectorAll(".cm-panel-lint ul li.cm-diagnostic");
    expect(items.length).toBe(2);
    expect(items[0].hasAttribute("aria-selected")).toBe(true); // 初始选中 = 第一条

    items[1].dispatchEvent(new MouseEvent("click", { bubbles: true }));
    expect(view.dom.querySelector(".md-lint-flash")?.textContent).toBe("[文本]"); // 高亮=被点诊断的范围
    expect(items[1].hasAttribute("aria-selected")).toBe(true);

    await vi.advanceTimersByTimeAsync(1000); // 旧根因在此：+300ms 重扫 → 重建 → 选中跳回首条
    const after = view.dom.querySelectorAll(".cm-panel-lint ul li.cm-diagnostic");
    expect(after[1].hasAttribute("aria-selected")).toBe(true); // 回归锚：选中不回跳
    expect(view.dom.querySelector(".md-lint-flash")?.textContent).toBe("[文本]"); // 高亮不消失

    view.dispatch({ selection: { anchor: 0 } }); // 光标移走 → 高亮摘除（面板选中保留）
    expect(view.dom.querySelector(".md-lint-flash")).toBeNull();
    expect(after[1].hasAttribute("aria-selected")).toBe(true);
    view.destroy();
  });

  it("打字期光标行静默，停笔 2 秒后到期补扫恢复徽标计数（不再依赖下一次选区移动）", async () => {
    makeStatusbar();
    const view = makeView("**坏加粗\n第二行\n");
    await vi.advanceTimersByTimeAsync(LINT_DELAY_MS + 100);
    expect(badgeText()).toBe("问题 1");

    const line1 = view.state.doc.line(1);
    view.dispatch({ changes: { from: line1.to, insert: "字" }, selection: { anchor: line1.to + 1 } });
    await vi.advanceTimersByTimeAsync(LINT_DELAY_MS + 100); // 打字期重扫：光标行（第 1 行）静默
    expect(badgeText()).toBe("问题 0");

    await vi.advanceTimersByTimeAsync(MUTE_WINDOW_MS + 400); // 到期定时器 + 300ms 防抖补扫
    expect(badgeText()).toBe("问题 1"); // 回归锚：纯计时也能恢复被静默的诊断
    view.destroy();
  });
});
