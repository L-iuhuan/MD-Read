/**
 * editor-audit · 任务项命令（Ctrl-Enter / 工具栏「任务项」）口径（task-4 Lead 定）：
 * 产出必须能被阅读态渲染成任务勾选框，且不破坏既有结构：
 *  - 围栏代码 / 缩进代码 / 表格 / HTML 块内 ⇒ no-op；
 *  - 引用行 ⇒ 插在引用标记之后（> 甲 → > - [ ] 甲），层级不变；
 *  - 有序项 ⇒ 保留有序标记（1. 甲 → 1. [ ] 甲；实测 @mdit/plugin-tasklist 认它）；
 *  - 普通段落 ⇒ 行首（缩进后）插 - [ ] ；
 *  - 已是任务项 ⇒ [ ]↔[x] 既有勾选语义（引用/有序形态一并支持）。
 * 每条都断言「LP 勾选框状态 == 阅读态勾选框状态」。
 */
import { markdown, markdownLanguage } from "@codemirror/lang-markdown";
import { ensureSyntaxTree } from "@codemirror/language";
import { EditorState, EditorSelection } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { TaskCheckboxWidget, buildLivePreviewDecorations } from "../src/editor/live-preview";
import { markdownCommands, toggleTaskItem } from "../src/editor/markdown-commands";
import { renderDocument } from "../src/render/pipeline";

let host: HTMLElement;
let view: EditorView | null = null;

/** 真实装配镜像：markdownCommands + GFM markdown（树守卫与 LP 节点路径都需要语言） */
function makeView(doc: string, head: number): EditorView {
  view = new EditorView({
    parent: host,
    state: EditorState.create({
      doc,
      extensions: [markdownCommands(), markdown({ base: markdownLanguage })],
    }),
  });
  view.dispatch({ selection: EditorSelection.cursor(head) });
  return view;
}

/** 跑一次命令并读回文本 */
function run(doc: string, head: number): { ret: boolean; out: string } {
  const v = makeView(doc, head);
  const ret = toggleTaskItem(v);
  return { ret, out: v.state.sliceDoc() };
}

/** LP 非光标行勾选框状态（追加控制行把光标移出被测内容） */
function lpTaskStates(src: string): boolean[] {
  const full = src + "\n\n控制行";
  const state = EditorState.create({
    doc: full,
    extensions: [markdown({ base: markdownLanguage })],
    selection: { anchor: full.length },
  });
  ensureSyntaxTree(state, full.length, 20000);
  const out: boolean[] = [];
  buildLivePreviewDecorations(state, [{ from: 0, to: full.length }]).between(
    0,
    src.length,
    (_from, _to, deco) => {
      const widget = deco.spec.widget;
      if (widget instanceof TaskCheckboxWidget) {
        out.push(widget.checked);
      }
    },
  );
  return out;
}

/** 阅读态勾选框状态 */
function readTaskStates(src: string): boolean[] {
  const fragment = renderDocument(src, { pangu: false }).fragment;
  return Array.from(fragment.querySelectorAll("input.task-list-item-checkbox")).map(
    (el) => (el as HTMLInputElement).checked,
  );
}

const hasReadTask = (src: string): boolean => readTaskStates(src).length > 0;

beforeEach(() => {
  document.body.innerHTML = "";
  host = document.createElement("div");
  document.body.append(host);
});
afterEach(() => {
  view?.destroy();
  view = null;
  document.body.innerHTML = "";
});

describe("editor-audit · 任务项命令产出可被阅读态渲染成勾选框", () => {
  const CASES: ReadonlyArray<{ name: string; doc: string; head: number; want: string }> = [
    { name: "普通段落", doc: "甲", head: 0, want: "- [ ] 甲" },
    { name: "缩进段落保留缩进", doc: "  甲", head: 2, want: "  - [ ] 甲" },
    { name: "引用行插在引用标记之后", doc: "> 甲", head: 2, want: "> - [ ] 甲" },
    { name: "引用无空格形态", doc: ">甲", head: 1, want: ">- [ ] 甲" },
    { name: "嵌套引用", doc: "> > 甲", head: 4, want: "> > - [ ] 甲" },
    { name: "无序列表升级", doc: "- 甲", head: 0, want: "- [ ] 甲" },
    { name: "有序列表保留标记（.）", doc: "1. 甲", head: 0, want: "1. [ ] 甲" },
    { name: "有序列表保留标记（)）", doc: "2) 甲", head: 0, want: "2) [ ] 甲" },
    { name: "引用内列表", doc: "> - 甲", head: 2, want: "> - [ ] 甲" },
  ];

  it.each(CASES)("$name：$doc → $want，且 LP==阅读态（未勾选）", ({ doc, head, want }) => {
    const { ret, out } = run(doc, head);
    expect(ret).toBe(true);
    expect(out).toBe(want);
    expect(hasReadTask(out)).toBe(true); // 前置：阅读态确实认它是任务
    expect(lpTaskStates(out)).toEqual(readTaskStates(out)); // 编辑态 ≡ 阅读态
    expect(lpTaskStates(out)).toEqual([false]); // 新插入的勾选框是未勾选
  });

  it("已有任务项：勾选切换，引用/有序形态一并支持（往返幂等）", () => {
    for (const [doc, head, checked, back] of [
      ["- [ ] 甲", 0, "- [x] 甲", "- [ ] 甲"],
      ["> - [ ] 甲", 4, "> - [x] 甲", "> - [ ] 甲"],
      ["1. [ ] 甲", 0, "1. [x] 甲", "1. [ ] 甲"],
      ["  - [x] 已办", 2, "  - [ ] 已办", "  - [x] 已办"],
    ] as Array<[string, number, string, string]>) {
      const first = run(doc, head);
      expect(first.ret).toBe(true);
      expect(first.out).toBe(checked);
      expect(lpTaskStates(checked)).toEqual(readTaskStates(checked));
      const second = run(checked, head);
      expect(second.ret).toBe(true);
      expect(second.out).toBe(back); // 再按一次回到原态
      expect(lpTaskStates(back)).toEqual(readTaskStates(back));
      view?.destroy();
      view = null;
    }
  });
});

describe("editor-audit · 任务项命令 no-op 语境（代码/表格/HTML）", () => {
  const NOOP: ReadonlyArray<{ name: string; doc: string; head: number }> = [
    { name: "围栏代码内", doc: "```\n- \n```", head: 6 },
    { name: "缩进代码内", doc: "    甲", head: 4 },
    { name: "制表符缩进代码内", doc: "\t甲", head: 1 },
    { name: "表格内", doc: "| a |\n| - |", head: 2 },
    { name: "HTML 块内", doc: "<div>\n甲\n</div>", head: 6 },
  ];

  it.each(NOOP)("$name：不接管、文档逐字不变、阅读态无勾选框", ({ doc, head }) => {
    const { ret, out } = run(doc, head);
    expect(ret).toBe(false);
    expect(out).toBe(doc);
    expect(readTaskStates(doc)).toEqual([]);
  });
});
