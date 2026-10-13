/**
 * 格式补全（fix-24）：上下文触发命中/不命中（含围栏内、行内码、链接目标、
 * 表格内不出——语法安全）、apply 骨架与光标位（CRLF 保真一例）、键位裁决
 * （Enter 先裁菜单接受、菜单关时空标记行退出原路放行、Escape 关闭）、
 * IME 组词期不弹。装配位次镜像 editor.ts：formatCompletions 在 markdownCommands 之前。
 */
import { CompletionContext, completionStatus, startCompletion, type CompletionResult } from "@codemirror/autocomplete";
import { history, undo, undoDepth } from "@codemirror/commands";
import { markdown, markdownLanguage } from "@codemirror/lang-markdown";
import { EditorState, EditorSelection } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { markdownCommands } from "../src/editor/markdown-commands";
import { formatCompletionSource, formatCompletions } from "../src/editor/snippets";

let host: HTMLElement;
let view: EditorView | null = null;

/** 镜像 editor.ts 装配序（formatCompletions 在 markdownCommands 前——Enter 裁决被测对象） */
function makeView(doc: string, crlf = false): EditorView {
  view = new EditorView({
    parent: host,
    state: EditorState.create({
      doc,
      extensions: [
        crlf ? EditorState.lineSeparator.of("\r\n") : [],
        history(),
        formatCompletions(),
        markdownCommands(),
        markdown({ base: markdownLanguage }), // 镜像 editor.ts：GFM 基座（Table 等节点路径激活）
      ],
    }),
  });
  return view;
}

/** 直接查源（CompletionContext 官方测试通道；带 view 供 composing 判定） */
function query(v: EditorView, pos: number): CompletionResult | null {
  return formatCompletionSource(new CompletionContext(v.state, pos, false, v));
}

function labels(r: CompletionResult | null): string[] {
  return r === null ? [] : r.options.map((o) => o.label);
}

/** 应用指定 label 的补全项（apply 为函数形态，本源全部如此） */
function applyLabel(v: EditorView, pos: number, label?: string): void {
  const r = query(v, pos);
  const opt = r === null ? undefined : label === undefined ? r.options[0] : r.options.find((o) => o.label === label);
  if (r === null || opt === undefined) {
    throw new Error(`无补全项：${label ?? "(首个)"}`);
  }
  if (typeof opt.apply !== "function") {
    throw new Error(`apply 非函数：${label}`);
  }
  opt.apply(v, opt, r.from, r.to ?? pos); // to 缺省回退光标位（CM applyCompletion 同口径；本源恒给出 to）
}

function select(v: EditorView, head: number, anchor?: number): void {
  v.dispatch({ selection: EditorSelection.range(anchor ?? head, head) });
}

/** 向 contentDOM 派发真实 keydown（裁决顺序走真实键位表） */
function key(v: EditorView, k: string): KeyboardEvent {
  const event = new KeyboardEvent("keydown", { key: k, bubbles: true, cancelable: true });
  v.contentDOM.dispatchEvent(event);
  return event;
}

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

describe("上下文触发命中", () => {
  it("$$ → 块公式（命中范围覆盖两个 $）", () => {
    const v = makeView("$$");
    const r = query(v, 2);
    expect(labels(r)).toEqual(["块公式"]);
    expect(r?.from).toBe(0);
    expect(r?.to).toBe(2);
  });

  it("行首 |、|-、|-- → 表格（from 均为真行首）", () => {
    for (const t of ["|", "|-", "|--", "| -"]) {
      const v = makeView(t);
      const r = query(v, t.length);
      expect(labels(r)).toEqual(["表格"]);
      expect(r?.from).toBe(0);
      v.destroy();
      view = null;
    }
  });

  it("行首 ``（第二键）→ 七选语言菜单；已键片段前缀收窄", () => {
    // 序与 CODE_LANGUAGES 同源派生（typescript→ts、javascript 不单列）
    expect(labels(query(makeView("``"), 2))).toEqual(["ts", "python", "json", "rust", "html", "css", "无语言"]);
    expect(labels(query(makeView("``t"), 3))).toEqual(["ts"]);
    expect(labels(query(makeView("``j"), 3))).toEqual(["json"]);
    expect(query(makeView("``z"), 3)).toBeNull(); // 无匹配语言：收窄到空即不出
  });

  it("- [ 与有序 1. [ → 任务（from 落在「[」上，列表标记留给 apply 保留）", () => {
    const r = query(makeView("- ["), 3);
    expect(labels(r)).toEqual(["任务"]);
    expect(r?.from).toBe(2);
    expect(labels(query(makeView("1. ["), 4))).toEqual(["任务"]);
  });

  it("[ 与 ![ 区分：链接/图片；行中 [ 仍可出（非行首限定）", () => {
    expect(labels(query(makeView("["), 1))).toEqual(["链接"]);
    expect(labels(query(makeView("!["), 2))).toEqual(["图片"]);
    expect(labels(query(makeView("x["), 2))).toEqual(["链接"]);
  });

  it("行首 > → 引用；行中 > 不出（typeahead 限行首）", () => {
    expect(labels(query(makeView(">"), 1))).toEqual(["引用"]);
    expect(query(makeView("正文 >"), 4)).toBeNull();
  });

  it("超长行尾 |- 不误中（matchBefore 的 ^ 锚在 pos-250，行首校验拦下）", () => {
    const doc = "字".repeat(300) + "|-";
    expect(query(makeView(doc), doc.length)).toBeNull();
  });
});

describe("语法安全：这些上下文不出提示", () => {
  it("围栏内行首 `` 不出（含未闭合围栏——``` 敲到第三键即静默）", () => {
    expect(query(makeView("```"), 3)).toBeNull();
    const doc = "```\n``\n```";
    const v = makeView(doc);
    expect(query(v, v.state.doc.line(2).to)).toBeNull();
  });

  it("行内码内 $$ 不出（InlineCode 守卫）", () => {
    expect(query(makeView("`a$$`"), 4)).toBeNull();
  });

  it("链接目标内 $$ 不出（URL 守卫）", () => {
    const doc = "[文字](地址$$)";
    const v = makeView(doc);
    expect(query(v, doc.length - 1)).toBeNull();
  });

  it("表格内的分隔行行尾不出（Table 守卫——那是改表不是建表）", () => {
    const v = makeView("| a | b |\n| --- | --- |\n| 1 | 2 |");
    expect(query(v, v.state.doc.line(2).to)).toBeNull();
  });

  it("缩进代码块内 $$ 不出（CodeBlock 守卫）", () => {
    expect(query(makeView("    $$"), 6)).toBeNull();
  });

  it("IME 组词期不弹，组词结束恢复", () => {
    const v = makeView("$$");
    v.contentDOM.dispatchEvent(new CompositionEvent("compositionstart"));
    expect(query(v, 2)).toBeNull();
    v.contentDOM.dispatchEvent(new CompositionEvent("compositionend"));
    expect(labels(query(v, 2))).toEqual(["块公式"]);
  });
});

describe("apply 骨架与光标位", () => {
  it("块公式：$$\\n光标\\n$$；行中触发先让行", () => {
    const v = makeView("甲乙$$");
    applyLabel(v, 4);
    expect(v.state.sliceDoc()).toBe("甲乙\n$$\n\n$$");
    expect(v.state.selection.main.head).toBe(6); // 中空行行首
  });

  it("表格：3 行骨架、光标末尾", () => {
    const v = makeView("|");
    applyLabel(v, 1);
    expect(v.state.sliceDoc()).toBe("| 列1 | 列2 | 列3 |\n| --- | --- | --- |\n|  |  |  |");
    expect(v.state.selection.main.head).toBe(v.state.doc.length);
  });

  it("任务：保留列表标记（无序与有序）", () => {
    const v1 = makeView("- [");
    applyLabel(v1, 3);
    expect(v1.state.sliceDoc()).toBe("- [ ] ");
    const v2 = makeView("1. [");
    applyLabel(v2, 4);
    expect(v2.state.sliceDoc()).toBe("1. [ ] ");
  });

  it("链接/图片：占位文字被选中（直接敲字即替换）", () => {
    const v1 = makeView("[");
    applyLabel(v1, 1);
    expect(v1.state.sliceDoc()).toBe("[文字](地址)");
    expect(EditorSelection.range(1, 4).eq(v1.state.selection.main)).toBe(true);
    const v2 = makeView("![");
    applyLabel(v2, 2);
    expect(v2.state.sliceDoc()).toBe("![题注](路径)");
    expect(EditorSelection.range(2, 4).eq(v2.state.selection.main)).toBe(true);
  });

  it("围栏：ts / 无语言，光标落围栏内空行", () => {
    const v1 = makeView("``");
    applyLabel(v1, 2, "ts");
    expect(v1.state.sliceDoc()).toBe("```ts\n\n```");
    expect(v1.state.selection.main.head).toBe(6);
    const v2 = makeView("``");
    applyLabel(v2, 2, "无语言");
    expect(v2.state.sliceDoc()).toBe("```\n\n```");
    expect(v2.state.selection.main.head).toBe(4);
  });

  it("引用：> 后补空格、光标行尾", () => {
    const v = makeView(">");
    applyLabel(v, 1);
    expect(v.state.sliceDoc()).toBe("> ");
    expect(v.state.selection.main.head).toBe(2);
  });

  it("撤销粒度：一次补全 = 一个历史事件，Ctrl+Z 一步撤净", () => {
    const v = makeView("- [");
    applyLabel(v, 3);
    expect(v.state.sliceDoc()).toBe("- [ ] ");
    expect(undoDepth(v.state)).toBe(1);
    undo(v);
    expect(v.state.sliceDoc()).toBe("- [");
  });

  it("CRLF 保真：块公式按档位断行，sliceDoc 读回 \\r\\n、光标按档内位计", () => {
    const v = makeView("$$", true);
    applyLabel(v, 2);
    expect(v.state.sliceDoc()).toBe("$$\r\n\r\n$$");
    expect(v.state.doc.lines).toBe(3);
    expect(v.state.selection.main.head).toBe(3); // 「$$＋换行」档内 3 位（\r\n 只计 1）
  });
});

describe("键位裁决（真实键派发）", () => {
  it("Enter 先裁菜单接受：- [ 开菜单后 Enter → 落成任务项（不是续行）", async () => {
    const v = makeView("- [");
    select(v, 3);
    startCompletion(v);
    await vi.waitFor(() => expect(completionStatus(v.state)).toBe("active"));
    await new Promise((r) => setTimeout(r, 100)); // 过 interactionDelay（75ms）保护窗
    key(v, "Enter");
    expect(v.state.sliceDoc()).toBe("- [ ] ");
  });

  it("菜单关闭时 Enter 原路放行：空标记行退出（exitEmptyMarkupLine）不受影响", () => {
    const v = makeView("> ");
    select(v, 2);
    key(v, "Enter");
    expect(v.state.sliceDoc()).toBe("");
    expect(completionStatus(v.state)).toBeNull();
  });

  it("Escape 关闭菜单（无菜单时不吞 Escape——留给查找面板等既有键）", async () => {
    const v = makeView("$$");
    select(v, 2);
    startCompletion(v);
    await vi.waitFor(() => expect(completionStatus(v.state)).toBe("active"));
    key(v, "Escape");
    expect(completionStatus(v.state)).toBeNull();
  });
});
