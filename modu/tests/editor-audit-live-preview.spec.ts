/**
 * editor-audit · 任务勾选框：编辑态（Live Preview）与阅读态（renderDocument）同判。
 *
 * 用户原话：「有的内容需要空行才能完整渲染相应格式，感觉不够准确」+「编辑里看起来
 * 对了、切到阅读却变了」。本锚钉住其中最典型的一类：lezer GFM 的 Task 条件比阅读侧
 * @mdit/plugin-tasklist 宽——空标签 / `[x]` 后无空格 / tab 分隔在编辑态曾显示勾选框，
 * 切阅读态却变回字面 `[ ]`。修法（live-preview.ts 的 taskRenderable）：两处任务分支
 * 都要求 `]` 后是半角空格且行内还有非空白标签，与阅读侧同条件。
 *
 * 断言方式：同一份源码分别取「阅读态是否有勾选框/勾选态」与「LP 是否产出
 * TaskCheckboxWidget/勾选态」，逐字比较——这是最强的一致性锚。
 */
import { markdown, markdownLanguage } from "@codemirror/lang-markdown";
import { ensureSyntaxTree } from "@codemirror/language";
import { EditorState } from "@codemirror/state";
import { describe, expect, it } from "vitest";
import { TaskCheckboxWidget, buildLivePreviewDecorations } from "../src/editor/live-preview";
import { renderDocument } from "../src/render/pipeline";

/** LP 非光标行的勾选框状态（追加控制行把光标移出被测内容） */
function lpTasks(src: string): boolean[] {
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

/** 阅读态勾选框状态（markdown-it + @mdit/plugin-tasklist 的真实管线） */
function readTasks(src: string): boolean[] {
  const fragment = renderDocument(src, { pangu: false }).fragment;
  return Array.from(fragment.querySelectorAll("input.task-list-item-checkbox")).map(
    (el) => (el as HTMLInputElement).checked,
  );
}

const FORMS: readonly string[] = [
  "- [ ] 待办", // 标准未完成
  "- [x] 已办", // 标准已完成
  "- [X] 已办", // 大写 X
  "* [ ] 待办", // * 列表符
  "1. [ ] 待办", // 有序列表
  "> - [ ] 待办", // 引用套任务
  "- [ ]", // 空任务项（阅读态不是任务）——用户最常见「刚敲出勾选框就切阅读」
  "- [x]",
  "- [ ] ", // 空格但空标签
  "- [x] ",
  "- [ ]\t待办", // tab 分隔
  "- [x]已办", // ] 后无空格
  "- [ ]x",
];

describe("editor-audit · 任务勾选框 编辑态 ≡ 阅读态", () => {
  it.each(FORMS)("「%s」：LP 勾选框状态与阅读态逐字相同", (src) => {
    expect(lpTasks(src)).toEqual(readTasks(src)); // 核心一致性
  });

  it("语料双向覆盖：既有阅读态认任务的行，也有不认的行（防恒空比较）", () => {
    const recognized = FORMS.filter((s) => readTasks(s).length > 0);
    const rejected = FORMS.filter((s) => readTasks(s).length === 0);
    expect(recognized.length).toBeGreaterThan(0);
    expect(rejected.length).toBeGreaterThan(0);
  });

  it("勾选态/未勾选态在两侧都对得上（不是只剩「有没有」）", () => {
    expect(lpTasks("- [ ] 待办")).toEqual([false]);
    expect(lpTasks("- [x] 已办")).toEqual([true]);
    expect(readTasks("- [ ] 待办")).toEqual([false]);
    expect(readTasks("- [x] 已办")).toEqual([true]);
  });
});

/* ---- task-4：$$ 段豁免收敛到实际跨度（编辑态与阅读态对齐） ---- */

interface LpDeco {
  from: number;
  to: number;
  cls?: string;
  task: boolean;
}

/** LP 非光标行装饰（追加控制行把光标移出被测内容） */
function lpDecos(src: string): LpDeco[] {
  const full = src + "\n\n控制行";
  const state = EditorState.create({
    doc: full,
    extensions: [markdown({ base: markdownLanguage })],
    selection: { anchor: full.length },
  });
  ensureSyntaxTree(state, full.length, 20000);
  const out: LpDeco[] = [];
  buildLivePreviewDecorations(state, [{ from: 0, to: full.length }]).between(
    0,
    src.length,
    (from, to, deco) => {
      out.push({
        from,
        to,
        cls: deco.spec.class,
        task: deco.spec.widget instanceof TaskCheckboxWidget,
      });
    },
  );
  return out;
}

const readHasStrong = (src: string): boolean =>
  renderDocument(src, { pangu: false }).html.includes("<strong>");

describe("editor-audit · LP $$ 段豁免收敛到实际跨度（task-4）", () => {
  // 同一段：$$…$$ 跨度外的正文照常装饰，与阅读态同判
  const SPAN_OUTSIDE: readonly string[] = [
    "$$x$$ 与 **粗体**",
    "$$x$$与**粗**",
    "$$重要**粗**", // 未闭合：无跨度，整段照常装饰（阅读态也渲染粗体）
    "$$a * b$$ **粗**",
    "$$\na * b\n$$\n**粗**",
  ];

  it.each(SPAN_OUTSIDE)("「%s」：跨度外粗体照常装饰，LP 与阅读态同判", (src) => {
    const decos = lpDecos(src);
    expect(decos.some((d) => d.cls === "cm-lp-strong")).toBe(true); // 前置：确有粗体装饰
    expect(decos.some((d) => d.cls === "cm-lp-strong")).toBe(readHasStrong(src)); // 编辑态可见粗体 == 阅读态
    expect(decos.some((d) => d.cls === "cm-lp-em")).toBe(false); // 公式体内的 `*` 不上斜体装饰
  });

  // 硬约束（既有设计意图）：整段就是一个 $$ 块 ⇒ 装饰集仍为空，源码可编辑
  const WHOLE_BLOCK: readonly string[] = [
    "$$x$$",
    "$$\na * b\n$$",
    "- $$\n  a * b\n  $$",
    "1. $$\n   a * b\n   $$",
    "  $$\n  a * b\n  $$",
  ];

  it.each(WHOLE_BLOCK)("「%s」：整段 $$ 块，装饰集为空（源码可编辑）", (src) => {
    expect(lpDecos(src)).toEqual([]);
    // 前置：阅读态确实当公式/降级公式处理（katex 或 CJK fallback），不是字面源码
    expect(renderDocument(src, { pangu: false }).html).toMatch(/katex|math-fallback/);
  });

  it("引用内 $$ 块：公式体零内联装饰，引用 chrome（既有结构样式）保留", () => {
    const decos = lpDecos("> $$\n> a * b\n> $$");
    expect(decos.some((d) => d.cls === "cm-lp-strong" || d.cls === "cm-lp-em")).toBe(false);
    expect(decos.some((d) => d.cls === "cm-lp-quote")).toBe(true);
    expect(readHasStrong("> $$\n> a * b\n> $$")).toBe(false);
  });
});
