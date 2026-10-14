/**
 * 空标记行退出家族（fix-29）：Backspace 智能退出锚＋与 Enter 侧同杆尺的嵌套口径锁。
 * 覆盖：五形态标记（- / * / + / 1. / > ＋任务/全角变体）×上文有/无列表两态、
 * 嵌套口径（引用栈清整行 / 缩进列表不接管）、CRLF 保真（分离断行 \r\n、Text 计位）、
 * 单步撤销、裁决链（deleteBracketPair → 本家族 → markdownKeymap.deleteMarkupBackward）。
 * Enter 侧既有锚在 markdown-commands.spec.ts（经再导出面），此处只锁 Backspace 侧
 * 与两侧口径一致性。
 */
import { defaultKeymap, history, historyKeymap, undo, undoDepth } from "@codemirror/commands";
import { markdown } from "@codemirror/lang-markdown";
import { EditorState, EditorSelection } from "@codemirror/state";
import { EditorView, keymap } from "@codemirror/view";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { markdownInputPairs } from "../src/editor/input-pairs";
import { markdownCommands } from "../src/editor/markdown-commands";
import { backspaceExitMarkupLine, exitEmptyMarkupLine } from "../src/editor/markup-exit";

let host: HTMLElement;
let view: EditorView | null = null;

/** 最小扩展集：markdownCommands()（含本家族 Prec.high 键位），不带 defaultKeymap——
 *  键位断言只验自己的绑定，负例不会被默认退格吃掉字符。 */
function makeView(doc: string, crlf = false): EditorView {
  view = new EditorView({
    parent: host,
    state: EditorState.create({
      doc,
      extensions: [crlf ? EditorState.lineSeparator.of("\r\n") : [], markdownCommands()],
    }),
  });
  return view;
}

/** editor.ts 装配位次镜像：markdownCommands → defaultKeymap → markdown()。
 *  markdownKeymap 同为 Prec.high 且在 markdownCommands 之后 ⇒ 本家族先裁——
 *  真实 keydown 经此证明 Backspace 不落给 deleteMarkupBackward。 */
function mirrorView(doc: string, crlf = false): EditorView {
  view = new EditorView({
    parent: host,
    state: EditorState.create({
      doc,
      extensions: [
        crlf ? EditorState.lineSeparator.of("\r\n") : [],
        markdownCommands(),
        keymap.of([...defaultKeymap]),
        markdown(),
      ],
    }),
  });
  return view;
}

/** editor.ts 输入配对位次镜像：markdownInputPairs（含 Prec.high 的
 *  deleteBracketPair）在 markdownCommands **之前**（同为 Prec.high，数组在前者
 *  先裁）——无配对场景其返 false 落到本家族；配对场景其先裁不受本家族干扰。 */
function pairsView(doc: string): EditorView {
  view = new EditorView({
    parent: host,
    state: EditorState.create({
      doc,
      extensions: [markdownInputPairs(), markdownCommands(), keymap.of([...defaultKeymap]), markdown()],
    }),
  });
  return view;
}

/** 撤销粒度装配：history + 命令族 + historyKeymap（真实 Ctrl-Z 通道） */
function historyView(doc: string): EditorView {
  view = new EditorView({
    parent: host,
    state: EditorState.create({
      doc,
      extensions: [history(), markdownCommands(), keymap.of(historyKeymap)],
    }),
  });
  return view;
}

/** 置光标/选区（anchor 缺省＝光标态） */
function select(v: EditorView, head: number, anchor?: number): void {
  v.dispatch({ selection: EditorSelection.range(anchor ?? head, head) });
}

/** 向 contentDOM 派发真实 keydown（bubbles+cancelable，模拟用户按键） */
function key(v: EditorView, k: string, init: KeyboardEventInit = {}): KeyboardEvent {
  const event = new KeyboardEvent("keydown", { key: k, bubbles: true, cancelable: true, ...init });
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

describe("fix-29：上文是列表/引用项 ⇒ 删整行标记＋空行分离（惰性延续防线）", () => {
  it("主场景：`- aa` 下空 `- ` 行尾退格 → `- aa\\n\\n`、光标落分离后行首；续打文本成段不进 <li>", () => {
    const v = mirrorView("- aa\n- ");
    select(v, 7); // 第 2 行（「- 」）行尾
    key(v, "Backspace");
    expect(v.state.sliceDoc()).toBe("- aa\n\n");
    expect(v.state.selection.main.head).toBe(6); // 分离后行首（行位计 \n=1）
    expect(v.state.doc.lines).toBe(3);
    v.dispatch({ changes: { from: v.state.selection.main.head, insert: "bb" } }); // 主人实测动作：退标记后打字
    expect(v.state.sliceDoc()).toBe("- aa\n\nbb"); // 空行断开惰性延续——不再是 `- aa\nbb` 折进列表项
  });

  it("五形态代表 ×有序/无序/引用混排：* / + / 1. / 23) / > 各自分离退出", () => {
    for (const doc of ["- aa\n* ", "1. 甲\n+ ", "- 甲\n1. ", "- 甲\n23) ", "> 甲\n> ", "- 甲\n> "]) {
      const v = makeView(doc);
      const prev = doc.slice(0, doc.indexOf("\n"));
      select(v, doc.length);
      key(v, "Backspace");
      expect(v.state.sliceDoc()).toBe(`${prev}\n\n`);
      expect(v.state.selection.main.head).toBe(prev.length + 2); // 上一行行尾(＋1 断行)再＋1＝新空行行首
      v.destroy();
      view = null;
    }
  });

  it("任务项与全角变体：- [ ] / - [x] / 1. [ ] / － 同享（口径同 Enter 侧 P2-7）", () => {
    for (const doc of ["- [x] 甲\n- [ ] ", "- [ ] 甲\n- [x] ", "1. 甲\n1. [ ] ", "－ 甲\n－ "]) {
      const v = makeView(doc);
      const prev = doc.slice(0, doc.indexOf("\n"));
      select(v, doc.length);
      key(v, "Backspace");
      expect(v.state.sliceDoc()).toBe(`${prev}\n\n`);
      v.destroy();
      view = null;
    }
  });
});

describe("fix-29：上文非列表/引用 ⇒ 只删标记不加空行", () => {
  it("文档首行 `- `/`> `/`1. `/`- [ ] `：清成空文档，光标 0，不添空行", () => {
    for (const doc of ["- ", "> ", "1. ", "- [ ] "]) {
      const v = makeView(doc);
      select(v, doc.length);
      key(v, "Backspace");
      expect(v.state.sliceDoc()).toBe("");
      expect(v.state.selection.main.head).toBe(0);
      expect(v.state.doc.lines).toBe(1); // 不添空行：首行无惰性延续对象
      v.destroy();
      view = null;
    }
  });

  it("上文平段落：`甲\\n- ` → `甲\\n`（平段落续行只是同段落、无 <li> 缩进，不加行）", () => {
    const v = makeView("甲\n- ");
    select(v, 4);
    key(v, "Backspace");
    expect(v.state.sliceDoc()).toBe("甲\n");
    expect(v.state.doc.lines).toBe(2);
  });

  it("上文已是空行（已隔离）：删标记不再加第二空行", () => {
    const v = makeView("- aa\n\n- ");
    select(v, 8); // 第 3 行（「- 」）行尾
    key(v, "Backspace");
    expect(v.state.sliceDoc()).toBe("- aa\n\n"); // 不是 `- aa\n\n\n`
    expect(v.state.doc.lines).toBe(3);
    expect(v.state.selection.main.head).toBe(6);
  });
});

describe("fix-29：触发边界——非标记尾/有内容/代码块/有选区 → 放行", () => {
  it("光标在标记内部（`- [ ] ` 的 `[` 之后）与行首：不接管，返回 false", () => {
    const v1 = makeView("- [ ] ");
    select(v1, 3); // `[` 与其内空格之间——标记中部，非标记尾
    expect(backspaceExitMarkupLine(v1)).toBe(false);
    expect(v1.state.sliceDoc()).toBe("- [ ] ");
    const v2 = makeView("- 甲\n- ");
    select(v2, 4); // 标记行行首（默认退格＝并上一行，不接管）
    expect(backspaceExitMarkupLine(v2)).toBe(false);
  });

  it("有内容行 `- aa` 行尾、以及有选区：均放行（默认删除语义不受影响——prefix 虽命中 `-`，整行非纯标记）", () => {
    const v1 = makeView("- aa");
    select(v1, 4);
    expect(backspaceExitMarkupLine(v1)).toBe(false);
    expect(v1.state.sliceDoc()).toBe("- aa");
    const v2 = makeView("- ");
    select(v2, 2, 0); // 选区 [0,2)
    expect(backspaceExitMarkupLine(v2)).toBe(false);
    expect(v2.state.sliceDoc()).toBe("- ");
  });

  it("代码块内 `- `：树守卫放行（代码不是标记，同 Enter 侧）", () => {
    const v = mirrorView("```\n- \n```");
    select(v, 6);
    expect(backspaceExitMarkupLine(v)).toBe(false);
    expect(v.state.sliceDoc()).toBe("```\n- \n```");
  });
});

describe("fix-29：嵌套口径与 Enter 侧同杆尺（别两套）", () => {
  it("嵌套空引用 `> > `：Backspace 同样清整行＋上文引用 ⇒ 分离（Enter 侧清整行的口径）", () => {
    const v = makeView("> 甲\n> > ");
    select(v, 8);
    key(v, "Backspace");
    expect(v.state.sliceDoc()).toBe("> 甲\n\n");
    expect(v.state.selection.main.head).toBe(5);
    // 对拍：Enter 侧同杆尺——同为纯标记行，两侧判定一致
    const v2 = makeView("> 甲\n> > ");
    select(v2, 8);
    expect(exitEmptyMarkupLine(v2)).toBe(true);
  });

  it("缩进列表 `  - `：Backspace 与 Enter 同样不接管（留给 CM 原生逐级退缩进）", () => {
    const v = makeView("- 甲\n  - ");
    select(v, 8);
    expect(backspaceExitMarkupLine(v)).toBe(false);
    expect(exitEmptyMarkupLine(v)).toBe(false); // 两侧同一杆尺：都不认缩进列表
    expect(v.state.sliceDoc()).toBe("- 甲\n  - ");
  });
});

describe("fix-29：CRLF 保真（D7）——分离断行随档位、Text 计位", () => {
  it("`- aa\\r\\n- ` 行尾退格 → `- aa\\r\\n\\r\\n`（插入 \\r\\n 且光标不越界）", () => {
    const v = makeView("- aa\r\n- ", true);
    select(v, 7); // CRLF 档分隔符按 1 计位：第 2 行行尾
    key(v, "Backspace");
    expect(v.state.sliceDoc()).toBe("- aa\r\n\r\n");
    expect(v.state.doc.lines).toBe(3);
    expect(v.state.selection.main.head).toBe(6); // 5(行首)+断行 Text 长度 1
  });

  it("CRLF 无上文：`> ` 首行清空成空文档（不残留 \\r）", () => {
    const v = makeView("> ", true);
    select(v, 2);
    key(v, "Backspace");
    expect(v.state.sliceDoc()).toBe("");
    expect(v.state.doc.lines).toBe(1);
  });
});

describe("fix-29：撤销粒度——删标记＋空行分离＋光标＝一个事务", () => {
  it("`- aa\\n- ` 退格 → undoDepth 恰 1，一次 undo 逐字还原", () => {
    const v = historyView("- aa\n- ");
    select(v, 7);
    expect(backspaceExitMarkupLine(v)).toBe(true);
    expect(v.state.sliceDoc()).toBe("- aa\n\n");
    expect(undoDepth(v.state)).toBe(1); // 单事务：不是「删标记一步＋空行一步」
    expect(undo(v)).toBe(true);
    expect(v.state.sliceDoc()).toBe("- aa\n- ");
    expect(undoDepth(v.state)).toBe(0);
  });
});

describe("fix-29：裁决链（Prec.high 位次，editor.ts 装配序）", () => {
  it("先于 markdownKeymap 的 deleteMarkupBackward：真实 keydown（mirrorView）落空 `- ` 行尾 → 分离形态（CM 原生只会平删标记、无空行防线）", () => {
    const v = mirrorView("- aa\n- ");
    select(v, 7);
    key(v, "Backspace");
    expect(v.state.sliceDoc()).toBe("- aa\n\n"); // 若落给 deleteMarkupBackward 只会得到 `- aa\n`（惰性延续坑仍在）
  });

  it("配对场景 deleteBracketPair 先裁（在更前）：`- ()` 光标夹中间退格 → 删整对成 `- `（本家族不误伤）", () => {
    const v = pairsView("- ()");
    select(v, 3); // `(` 与 `)` 之间
    key(v, "Backspace");
    expect(v.state.sliceDoc()).toBe("- ");
  });

  it("无配对场景落到本家族：pairsView `- [x] 甲\\n- [ ] ` 行尾退格 → 分离退出（deleteBracketPair 返 false）", () => {
    const v = pairsView("- [x] 甲\n- [ ] ");
    select(v, 14);
    key(v, "Backspace");
    expect(v.state.sliceDoc()).toBe("- [x] 甲\n\n");
  });
});
