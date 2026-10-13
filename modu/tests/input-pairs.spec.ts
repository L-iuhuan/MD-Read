/**
 * 输入配对（fix-27）：配对表收缩为 Typora「Auto pair brackets and quotes」档——
 * ( [ { " ' ` 成对（词边界）/ type-over 闭合 / 退格删整对 / ``` 三键围栏对 /
 * 代码语境禁配。$ * _ ~ 已移出配对表（金额红线 / 列表标记孤星 / ~~删除~~ 残留）：
 * 打键平插单字符、不改写正文。装配镜像 editor.ts（formatCompletions 内已并入
 * markdownInputPairs，editor.ts 零改动）；typeText 按真实 inputHandler facet 顺序
 * 走 CM 输入管线（语境门禁 → 官方 closeBrackets），全 false 时平插（原生兜底同构）。
 */
import { history } from "@codemirror/commands";
import { markdown, markdownLanguage } from "@codemirror/lang-markdown";
import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { markdownCommands } from "../src/editor/markdown-commands";
import { formatCompletions } from "../src/editor/snippets";

let host: HTMLElement;
let view: EditorView | null = null;

/** 镜像 editor.ts 装配序（formatCompletions 在 markdownCommands 前） */
function makeView(doc: string, head?: number): EditorView {
  view = new EditorView({
    parent: host,
    state: EditorState.create({
      doc,
      extensions: [
        history(),
        formatCompletions(),
        markdownCommands(),
        markdown({ base: markdownLanguage }), // 镜像 editor.ts：GFM 基座（Table 等节点路径激活）
      ],
      selection: head === undefined ? undefined : { anchor: head },
    }),
  });
  return view;
}

/** 模拟打字：逐字符走 inputHandler facet（高精度在先），全 false 再平插 */
function typeText(v: EditorView, text: string): void {
  for (const ch of text) {
    const pos = v.state.selection.main.head;
    const fallback = () => v.state.update({ changes: { from: pos, insert: ch } }); // 原生默认事务（兜底用）
    let handled = false;
    for (const handler of v.state.facet(EditorView.inputHandler)) {
      if (handler(v, pos, pos, ch, fallback)) {
        handled = true;
        break;
      }
    }
    if (!handled) {
      v.dispatch({
        changes: { from: pos, insert: ch },
        selection: { anchor: pos + ch.length },
        userEvent: "input.type",
      });
    }
  }
}

/** 向 contentDOM 派发真实 keydown（Backspace 走真实键位表 → deleteBracketPair） */
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

/** jsdom 的 Range 无 getClientRects：配对事务带 scrollIntoView → CM requestMeasure
 *  → rAF 里取 rect 抛未捕获错（vitest 记 error）。补空列表＝「量不到」，走 CM 降级路径。 */
(function polyfillRangeRects(): void {
  const proto = Range.prototype as Range & { getClientRects?: () => DOMRectList };
  if (typeof proto.getClientRects === "function") {
    return;
  }
  const emptyList = { length: 0, item: () => null } as unknown as DOMRectList;
  Object.defineProperty(proto, "getClientRects", { value: () => emptyList, configurable: true });
})();

afterEach(() => {
  view?.destroy();
  view = null;
  document.body.innerHTML = "";
});

describe("打字成对（词边界才配——括号引号档）", () => {
  it("[ ( \" → [|] (|) \"|\"（普通括号与引号配对）", () => {
    const v1 = makeView("");
    typeText(v1, "[");
    expect(v1.state.sliceDoc()).toBe("[]");
    expect(v1.state.selection.main.head).toBe(1);
    const v2 = makeView("");
    typeText(v2, "(");
    expect(v2.state.sliceDoc()).toBe("()");
    const v3 = makeView("");
    typeText(v3, '"');
    expect(v3.state.sliceDoc()).toBe('""');
  });

  it("` → `|`（行内码起手对）", () => {
    const v = makeView("");
    typeText(v, "`");
    expect(v.state.sliceDoc()).toBe("``");
    expect(v.state.selection.main.head).toBe(1);
  });

  it("``` 三键 → ```|```（官方 allowTriple 围栏对，光标在第三个反引号后）", () => {
    const v = makeView("");
    typeText(v, "```");
    expect(v.state.sliceDoc()).toBe("``````");
    expect(v.state.selection.main.head).toBe(3);
  });
});

describe("fix-27：$ * _ ~ 移出配对表（平插单字符，不改写正文）", () => {
  it("$ 空文档打单键不成 $|$（平插一个 $）", () => {
    const v = makeView("");
    typeText(v, "$");
    expect(v.state.sliceDoc()).toBe("$");
    expect(v.state.selection.main.head).toBe(1);
  });

  it("[P0 金额锚] 预算 $1,000 完整键序：终稿无残留 $（单 $、尾部无自动闭符）", () => {
    const v = makeView("预算 ", 3);
    typeText(v, "$");
    typeText(v, "1,000");
    expect(v.state.sliceDoc()).toBe("预算 $1,000");
    expect(v.state.selection.main.head).toBe(9);
  });

  it("* 行首（BOL 列表标记起手）平插：不成 *|*、后续不孤星", () => {
    const v = makeView("");
    typeText(v, "*");
    expect(v.state.sliceDoc()).toBe("*");
    expect(v.state.selection.main.head).toBe(1);
    typeText(v, " ");
    expect(v.state.sliceDoc()).toBe("* "); // 列表标记正常成形
  });

  it("_ 与 ~ 平插（强调/删除线不裸配对，Typora/Obsidian 同款）", () => {
    const v1 = makeView("");
    typeText(v1, "_");
    expect(v1.state.sliceDoc()).toBe("_");
    const v2 = makeView("");
    typeText(v2, "~");
    expect(v2.state.sliceDoc()).toBe("~");
  });

  it("*x* 手打斜体完整键序：终稿恰三个字符位、无配对残留", () => {
    const v = makeView("");
    typeText(v, "*x*");
    expect(v.state.sliceDoc()).toBe("*x*");
    expect(v.state.selection.main.head).toBe(3);
  });

  it("~~删除~~ 手打删除线：第 4 个 ~ 不再配对，终稿无残留", () => {
    const v = makeView("");
    typeText(v, "~~删除~~");
    expect(v.state.sliceDoc()).toBe("~~删除~~");
    expect(v.state.selection.main.head).toBe(6);
  });
});

describe("type-over 闭合（跳过不重复）", () => {
  it("] 直接跳过自动闭括号", () => {
    const v = makeView("");
    typeText(v, "[");
    typeText(v, "]");
    expect(v.state.sliceDoc()).toBe("[]");
    expect(v.state.selection.main.head).toBe(2);
  });

  it("` 第二键作闭合（成 ``，围栏菜单位）", () => {
    const v = makeView("");
    typeText(v, "`");
    typeText(v, "`");
    expect(v.state.sliceDoc()).toBe("``");
    expect(v.state.selection.main.head).toBe(2);
  });

  it("$ 第二键平插成 $$（块公式触发位——fix-27 后不走 type-over，结果同形）", () => {
    const v = makeView("");
    typeText(v, "$");
    typeText(v, "$");
    expect(v.state.sliceDoc()).toBe("$$");
    expect(v.state.selection.main.head).toBe(2);
  });
});

describe("退格删整对", () => {
  it("[|] 一次退格删两个（deleteBracketPair）", () => {
    const v = makeView("");
    typeText(v, "[");
    expect(v.state.sliceDoc()).toBe("[]");
    key(v, "Backspace");
    expect(v.state.sliceDoc()).toBe("");
    expect(v.state.selection.main.head).toBe(0);
  });

  it("`|` 同字符对同语义删整对", () => {
    const v = makeView("");
    typeText(v, "`");
    expect(v.state.sliceDoc()).toBe("``");
    key(v, "Backspace");
    expect(v.state.sliceDoc()).toBe("");
  });
});

describe("代码语境禁配（语境门禁吞输入平插）", () => {
  it("围栏内 [ 平插不成对（门禁用活配对符自证）", () => {
    const doc = "```\nabc\n```";
    const v = makeView(doc, 7); // 第 2 行行尾
    typeText(v, "[");
    expect(v.state.sliceDoc()).toBe("```\nabc[\n```");
    expect(v.state.selection.main.head).toBe(8);
  });

  it("行内码内 $ 平插不成对（$ 已全局不配对，此处仍平插）", () => {
    const v = makeView("`ab`", 2);
    typeText(v, "$");
    expect(v.state.sliceDoc()).toBe("`a$b`");
    expect(v.state.selection.main.head).toBe(3);
  });
});
