/**
 * editor-audit · 中文整理（Ctrl-Shift-T）不得改写显示态公式。
 *
 * 阅读态把 `$$…$$` 交给 KaTeX（CJK 体走 .math-fallback），Live Preview 的
 * startsDisplayMath 也把「剥掉引用栈/缩进/列表标记后以 $$ 起段」整段豁免。
 * 但旧 text-cleanup 的 isMathFenceLine 只认 trimStart 后的列首形态 ⇒ 引用/列表里
 * 的 `$$` 段没被跳过，命令会往公式体插空格（切阅读态公式已被改写）。修法：与
 * live-preview 共用 startsDisplayMath 同一守卫。
 */
import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { tidyChineseText } from "../src/editor/text-cleanup";

let host: HTMLElement;
let view: EditorView | null = null;

function tidy(doc: string): string {
  view = new EditorView({ parent: host, state: EditorState.create({ doc }) });
  const changed = tidyChineseText(view);
  const out = view.state.sliceDoc();
  expect(changed).toBe(false); // 全豁免语料：命令应无命中、不产生空事务
  return out;
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

describe("editor-audit · $$ 公式体（引用/列表/缩进/列首）零改写", () => {
  const MATH_BLOCKS: readonly string[] = [
    "> $$\n> a中b\n> $$",
    "- $$\n  a中b\n  $$",
    "1. $$\n   a中b\n   $$",
    "  $$\n  a中b\n  $$",
    "$$中a$$",
    "> $$中a$$x",
  ];
  it.each(MATH_BLOCKS)("「%s」逐字节不变", (doc) => {
    expect(tidy(doc)).toBe(doc);
  });
});

describe("editor-audit · 负对照：非公式文本照常整理（守卫不误伤）", () => {
  it("引用行/平段落仍补 CJK-拉丁间距", () => {
    const v1 = new EditorView({ parent: host, state: EditorState.create({ doc: "> 中文abc" }) });
    expect(tidyChineseText(v1)).toBe(true);
    expect(v1.state.sliceDoc()).toBe("> 中文 abc");
    v1.destroy();
    const v2 = new EditorView({ parent: host, state: EditorState.create({ doc: "普通段中文abc" }) });
    expect(tidyChineseText(v2)).toBe(true);
    expect(v2.state.sliceDoc()).toBe("普通段中文 abc");
    v2.destroy();
    view = null;
  });

  it("列首 $$ 单行公式仍豁免（原有口径回归）", () => {
    const v = new EditorView({ parent: host, state: EditorState.create({ doc: "前文中文abc\n$$中a$$" }) });
    expect(tidyChineseText(v)).toBe(true);
    expect(v.state.sliceDoc()).toBe("前文中文 abc\n$$中a$$");
    v.destroy();
    view = null;
  });
});
