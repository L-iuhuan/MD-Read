/**
 * editor-audit · 标题命令（toggleHeading）的缩进/空标题口径。
 *
 * 阅读态（CommonMark）认「最多 3 个前导空格 + `#`」与「`#` 单独成行」为 ATX 标题；
 * Live Preview 同样把它们渲染成 h1-h6。旧 HEADING_PREFIX `^(#{1,6})\s+` 两者都不
 * 认，命令会在既有井号前再叠一层（`  # 甲` → `##   # 甲`、`#` → `# #`），与阅读态
 * 相悖。修法：`^( {0,3})(#{1,6})([ \t]+|$)`，只替换井号段、保留缩进。
 */
import { markdownCommands, toggleHeading } from "../src/editor/markdown-commands";
import { EditorState, EditorSelection } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { renderDocument } from "../src/render/pipeline";

let host: HTMLElement;
let view: EditorView | null = null;

function makeView(doc: string, head: number, anchor?: number): EditorView {
  view = new EditorView({
    parent: host,
    state: EditorState.create({ doc, extensions: [markdownCommands()] }),
  });
  view.dispatch({ selection: EditorSelection.range(anchor ?? head, head) });
  return view;
}

const firstTag = (html: string): string => html.match(/<(h[1-6])/)?.[1] ?? "无";

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

describe("editor-audit · 缩进 ATX 标题（阅读态已是标题，命令不得叠层）", () => {
  it("2/3 空格缩进标题：改级只换井号段、缩进保留，且改完仍是目标级标题", () => {
    for (const [doc, lvl, want] of [
      ["  # 甲", 2, "  ## 甲"],
      ["   # 甲", 3, "   ### 甲"],
      ["  ## 甲", 3, "  ### 甲"],
    ] as Array<[string, number, string]>) {
      const v = makeView(doc, doc.length);
      expect(toggleHeading(lvl)(v)).toBe(true);
      expect(v.state.sliceDoc()).toBe(want);
      expect(firstTag(renderDocument(want, { pangu: false }).html)).toBe(`h${lvl}`); // 产出确被阅读态认成目标级
      v.destroy();
      view = null;
    }
  });

  it("清除缩进标题：只去井号段、缩进保留（不残留空井号）", () => {
    const v = makeView("  # 甲", 5);
    toggleHeading(0)(v);
    expect(v.state.sliceDoc()).toBe("  甲"); // 两个空格缩进保留
    expect(renderDocument("  甲", { pangu: false }).html).toContain("<p");
  });
});

describe("editor-audit · 空 ATX 标题（`#`/`##` 单独成行，阅读态是空标题）", () => {
  it("`#` + Ctrl+1 = 清除（同级 toggle）；`#` + Ctrl+2 = `## `", () => {
    const v1 = makeView("#", 1);
    expect(toggleHeading(1)(v1)).toBe(true);
    expect(v1.state.sliceDoc()).toBe("");
    v1.destroy();
    const v2 = makeView("#", 1);
    expect(toggleHeading(2)(v2)).toBe(true);
    expect(v2.state.sliceDoc()).toBe("## ");
    v2.destroy();
    view = null;
  });

  it("`##` + Ctrl+3 → `### `；识别为空 h2 不是「无标题」", () => {
    const v = makeView("##", 2);
    expect(toggleHeading(3)(v)).toBe(true);
    expect(v.state.sliceDoc()).toBe("### ");
    v.destroy();
    view = null;
  });
});

describe("editor-audit · 非标题行不受缩进口径影响（负对照）", () => {
  it("`#甲`（井号后无空白）是段落：Ctrl+1 只做前缀包裹，不误判为已有标题", () => {
    const v = makeView("#甲", 2);
    expect(toggleHeading(1)(v)).toBe(true);
    expect(v.state.sliceDoc()).toBe("# #甲"); // 包裹成 `# ` + 原段落
    v.destroy();
    view = null;
  });
});
