/**
 * Markdown 格式命令家族（编辑效率 2.0 · A1）：真实 EditorView 上的行为锚。
 * 覆盖：toggleBold 三态、标题 1→3→0 循环与多行统一、任务项插入/勾选/升级、
 * 链接模板光标位、CRLF 文档不破坏 \r\n（D7）、键位绑定（含 Ctrl-0 对
 * zoom.ts 复位缩放的截停——双动作回归锚）。
 */
import { EditorState, EditorSelection } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  insertTableSkeleton,
  markdownCommands,
  moveBlockUp,
  tidyChineseText,
  toggleBold,
  toggleBlockquote,
  toggleHeading,
  toggleInlineCode,
  toggleLink,
  toggleStrikethrough,
  toggleTaskItem,
} from "../src/editor/markdown-commands";

let host: HTMLElement;
let view: EditorView | null = null;

/** 最小扩展集：被测命令 + 其键位（不带 defaultKeymap，键位断言只验自己的绑定） */
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

describe("toggleBold：无选区插入 / 有选区包裹 / 再按去除", () => {
  it("无选区：插 ****、光标居中", () => {
    const v = makeView("ab");
    select(v, 1);
    toggleBold(v);
    expect(v.state.sliceDoc()).toBe("a****b");
    expect(v.state.selection.main.head).toBe(3);
    expect(v.state.selection.main.empty).toBe(true);
  });

  it("有选区：两端包裹 **、选区随之扩张", () => {
    const v = makeView("hello");
    select(v, 5, 0);
    toggleBold(v);
    expect(v.state.sliceDoc()).toBe("**hello**");
    expect(v.state.selection.main.from).toBe(2);
    expect(v.state.selection.main.to).toBe(7);
  });

  it("选整个 **hello**：剥壳回原文", () => {
    const v = makeView("**hello**");
    select(v, 9, 0);
    toggleBold(v);
    expect(v.state.sliceDoc()).toBe("hello");
  });

  it("只选内部的 hello（标记在选区外侧成对）：同样摘除", () => {
    const v = makeView("**hello**");
    select(v, 7, 2);
    toggleBold(v);
    expect(v.state.sliceDoc()).toBe("hello");
  });
});

describe("标题：1→3→0 循环与行统一", () => {
  it("无前缀加、异级换、同级清（toggle 语义）", () => {
    const v = makeView("标题");
    select(v, 0);
    toggleHeading(1)(v);
    expect(v.state.sliceDoc()).toBe("# 标题");
    toggleHeading(3)(v);
    expect(v.state.sliceDoc()).toBe("### 标题");
    toggleHeading(3)(v); // 同级再按＝清除
    expect(v.state.sliceDoc()).toBe("标题");
  });

  it("toggleHeading(0)：一律清除（Ctrl-0 / 工具栏「正文」通道）", () => {
    const v = makeView("## 甲");
    select(v, 0);
    toggleHeading(0)(v);
    expect(v.state.sliceDoc()).toBe("甲");
  });

  it("多行选区：覆盖的行统一改级", () => {
    const v = makeView("# 甲\n## 乙\n正文");
    select(v, 6, 0); // 终点落在第 2 行内部，不含第 3 行
    toggleHeading(2)(v);
    expect(v.state.sliceDoc()).toBe("## 甲\n## 乙\n正文");
  });

  it("空行只加前缀，光标随前缀之后", () => {
    const v = makeView("");
    select(v, 0);
    toggleHeading(2)(v);
    expect(v.state.sliceDoc()).toBe("## ");
    expect(v.state.selection.main.head).toBe(3);
  });
});

describe("任务项：插入、勾选切换、普通列表升级", () => {
  it("无标记行首插 - [ ] ；再按切 [x]；三按切回 [ ]", () => {
    const v = makeView("买菜");
    select(v, 0);
    toggleTaskItem(v);
    expect(v.state.sliceDoc()).toBe("- [ ] 买菜");
    toggleTaskItem(v);
    expect(v.state.sliceDoc()).toBe("- [x] 买菜");
    toggleTaskItem(v);
    expect(v.state.sliceDoc()).toBe("- [ ] 买菜");
  });

  it("已有普通列表标记（- ）：升级为任务项，不重复插列表符", () => {
    const v = makeView("- 水果");
    select(v, 0);
    toggleTaskItem(v);
    expect(v.state.sliceDoc()).toBe("- [ ] 水果");
  });

  it("缩进的任务项照常勾选（行首文本判定，不依赖语法树）", () => {
    const v = makeView("  - [x] 已办");
    select(v, 2);
    toggleTaskItem(v);
    expect(v.state.sliceDoc()).toBe("  - [ ] 已办");
  });
});

describe("链接：模板与光标落点", () => {
  it("无选区：插 []()、光标在方括号内", () => {
    const v = makeView("ab");
    select(v, 1);
    toggleLink(v);
    expect(v.state.sliceDoc()).toBe("a[]()b");
    expect(v.state.selection.main.head).toBe(2);
  });

  it("有选区：[选区]()、光标落在 url 待填处", () => {
    const v = makeView("点这里");
    select(v, 3, 0);
    toggleLink(v);
    expect(v.state.sliceDoc()).toBe("[点这里]()");
    expect(v.state.selection.main.head).toBe(6);
  });

  it("选区整体是 [文本](地址)：剥壳取回文本", () => {
    const v = makeView("[文本](地址)");
    select(v, 8, 0);
    toggleLink(v);
    expect(v.state.sliceDoc()).toBe("文本");
  });
});

describe("其余行内标记与块移动", () => {
  it("删除线与行内代码同走包裹工厂", () => {
    const v = makeView("hi");
    select(v, 2, 0);
    toggleStrikethrough(v);
    expect(v.state.sliceDoc()).toBe("~~hi~~");
    select(v, 4, 2); // 内层 hi（~~hi~~ 中 2..4）
    toggleInlineCode(v);
    expect(v.state.sliceDoc()).toBe("~~`hi`~~");
  });

  it("moveBlockUp：整行上移（复用 moveLineUp）", () => {
    const v = makeView("一\n二\n三");
    select(v, 2);
    moveBlockUp(v);
    expect(v.state.sliceDoc()).toBe("二\n一\n三");
  });
});

describe("键位绑定（真实 keydown 路径）", () => {
  it("Ctrl-B 走 keymap 加粗", () => {
    const v = makeView("ab");
    select(v, 1);
    key(v, "b", { ctrlKey: true });
    expect(v.state.sliceDoc()).toBe("a****b");
  });

  it("Ctrl-Shift-X 删除线（Shift 变体键名可命中：真实键事件的 keyCode 基表回退路径）", () => {
    const v = makeView("hi");
    select(v, 2, 0);
    key(v, "X", { ctrlKey: true, shiftKey: true, keyCode: 88 });
    expect(v.state.sliceDoc()).toBe("~~hi~~");
  });

  it("Alt-↑ 走键位移块", () => {
    const v = makeView("一\n二\n三");
    select(v, 2);
    key(v, "ArrowUp", { altKey: true });
    expect(v.state.sliceDoc()).toBe("二\n一\n三");
  });

  it("Ctrl-Enter 走键位勾选任务", () => {
    const v = makeView("- [ ] 买菜");
    select(v, 0);
    key(v, "Enter", { ctrlKey: true });
    expect(v.state.sliceDoc()).toBe("- [x] 买菜");
  });

  it("Ctrl-0 清标题，且截停 document 气泡相（zoom.ts 复位缩放不再双动作）", () => {
    const v = makeView("## 标题\n正文");
    select(v, 0);
    const zoomLike = vi.fn();
    document.addEventListener("keydown", zoomLike); // 模拟 zoom.ts 的 document 键盘监听
    const event = key(v, "0", { ctrlKey: true });
    document.removeEventListener("keydown", zoomLike);
    expect(v.state.sliceDoc()).toBe("标题\n正文");
    expect(zoomLike).not.toHaveBeenCalled(); // stopPropagation 生效
    expect(event.defaultPrevented).toBe(true);
  });
});

describe("CRLF 契约（D7）：命令不破坏 \\r\\n", () => {
  it("标题/任务项/行内标记在 CRLF 文档下均保真（sliceDoc 往返）", () => {
    const v = makeView("一\r\n二\r\n三", true);
    select(v, 3); // 第 2 行行首（避开 \r\n 分隔符内部）
    toggleHeading(2)(v);
    expect(v.state.sliceDoc()).toBe("一\r\n## 二\r\n三");
    toggleTaskItem(v);
    expect(v.state.sliceDoc()).toBe("一\r\n- [ ] ## 二\r\n三");
    select(v, 1); // 第 1 行行尾（同上，光标不进分隔符）
    toggleBold(v);
    expect(v.state.sliceDoc()).toBe("一****\r\n- [ ] ## 二\r\n三");
    expect(v.state.doc.lines).toBe(3); // 没有引入新行
  });
});

describe("B1 追加导出：insertTableSkeleton / tidyChineseText", () => {
  it("表格骨架：3 列 = 表头 + 分隔行 + 两行数据，共 4 行", () => {
    const v = makeView("");
    select(v, 0);
    insertTableSkeleton(v);
    const doc = v.state.sliceDoc();
    expect(doc).toContain("| 表头1 | 表头2 | 表头3 |");
    expect(doc).toContain("| --- | --- | --- |");
    expect(doc.split("\n").filter((l) => l !== "")).toHaveLength(4);
  });

  it("CRLF 文档插表：换行随 state.lineBreak 保真（D7）", () => {
    const v = makeView("", true);
    select(v, 0);
    insertTableSkeleton(v);
    expect(v.state.sliceDoc()).toContain("\r\n| --- | --- | --- |");
    expect(v.state.doc.lines).toBe(4);
  });

  it("行中插表：光标前有文字则先让一行（防表格贴行被吞）", () => {
    const v = makeView("前文");
    select(v, 2); // 行尾
    insertTableSkeleton(v);
    expect(v.state.sliceDoc().startsWith("前文\n| 表头1")).toBe(true);
  });

  it("tidyChineseText 经本模块再导出可用（工具栏/键位同一入口）", () => {
    const v = makeView("中文english");
    select(v, 3);
    expect(tidyChineseText(v)).toBe(true);
    expect(v.state.sliceDoc()).toBe("中文 english");
  });
});

describe("C0 toggleBlockquote：行级统一加/清", () => {
  it("无前缀：行首加 `> `，光标落新前缀之后", () => {
    const v = makeView("引文");
    select(v, 0);
    toggleBlockquote(v);
    expect(v.state.sliceDoc()).toBe("> 引文");
    expect(v.state.selection.main.head).toBe(2);
  });

  it("全部已有：一并清除（toggle 语义）", () => {
    const v = makeView("> 甲\n> 乙");
    select(v, 7, 0); // 覆盖两行
    toggleBlockquote(v);
    expect(v.state.sliceDoc()).toBe("甲\n乙");
  });

  it("多行混合：缺的补齐、已有的不叠级（整块统一到有）", () => {
    const v = makeView("> 甲\n乙\n丙");
    select(v, 6, 0); // 覆盖三行
    toggleBlockquote(v);
    expect(v.state.sliceDoc()).toBe("> 甲\n> 乙\n> 丙");
  });

  it("CRLF 文档：只插行内前缀，\\r\\n 保真（D7）", () => {
    const v = makeView("甲\r\n乙", true);
    select(v, 3, 0); // 覆盖两行（CRLF 档内部按 \n 计位：全长 3）
    toggleBlockquote(v);
    expect(v.state.sliceDoc()).toBe("> 甲\r\n> 乙");
    expect(v.state.doc.lines).toBe(2); // 没有引入新行
  });
});
