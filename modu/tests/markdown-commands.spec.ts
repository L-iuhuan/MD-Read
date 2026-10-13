/**
 * Markdown 格式命令家族（编辑效率 2.0 · A1）：真实 EditorView 上的行为锚。
 * 覆盖：toggleBold 三态、标题 1→3→0 循环与多行统一、任务项插入/勾选/升级、
 * 链接模板光标位、CRLF 文档不破坏 \r\n（D7）、键位绑定（含 Ctrl-0 对
 * zoom.ts 复位缩放的截停——双动作回归锚）。
 */
import { defaultKeymap, history, historyKeymap, redo, undo, undoDepth } from "@codemirror/commands";
import { markdown } from "@codemirror/lang-markdown";
import { EditorState, EditorSelection } from "@codemirror/state";
import { EditorView, keymap } from "@codemirror/view";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { livePreview } from "../src/editor/live-preview";
import {
  exitEmptyMarkupLine,
  insertTableSkeleton,
  markdownCommands,
  moveBlockUp,
  tableNoopFilter,
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

describe("insertTableSkeleton 撤销粒度：让行+骨架+光标 = 一个事务，一次 Ctrl+Z 完整还原", () => {
  /** 镜像 editor.ts 的历史装配：history() + 命令族 + historyKeymap（真实 Ctrl-Z 通道） */
  function historyView(doc: string, crlf = false): EditorView {
    view = new EditorView({
      parent: host,
      state: EditorState.create({
        doc,
        extensions: [
          crlf ? EditorState.lineSeparator.of("\r\n") : [],
          history(),
          markdownCommands(),
          keymap.of(historyKeymap),
        ],
      }),
    });
    return view;
  }

  /** editor.ts 全栈镜像：markdown 语法 + livePreview + 命令族（fix-20 起表格包退役，
   *  装配不再含 markdownTables）——锁定扩展链不为骨架另立事务（任何追加变更即分裂撤销步）。
   *  含 tableNoopFilter（同文替换空步过滤），与 editor.ts 装配保持同形 */
  function fullStackView(doc: string, crlf = false): EditorView {
    view = new EditorView({
      parent: host,
      state: EditorState.create({
        doc,
        extensions: [
          crlf ? EditorState.lineSeparator.of("\r\n") : [],
          history(),
          tableNoopFilter(),
          markdownCommands(),
          keymap.of(historyKeymap),
          markdown(),
          livePreview(),
        ],
      }),
    });
    return view;
  }

  it("行中插表（前让行+骨架）：一次 undo 文档与插入前逐字相等", () => {
    const v = historyView("前文\n后文");
    select(v, 2); // 第 1 行行中 → 触发前让行
    insertTableSkeleton(v);
    const after = v.state.sliceDoc();
    expect(after.startsWith("前文\n| 表头1")).toBe(true); // 前置：确已插入（防「没插成功也绿」）
    expect(after).not.toBe("前文\n后文");
    expect(undo(v)).toBe(true);
    expect(v.state.sliceDoc()).toBe("前文\n后文");
  });

  it("CRLF 文档：一次 undo 逐字还原（含让行的 \\r\\n）", () => {
    const v = historyView("前文\r\n后文", true);
    select(v, 2);
    insertTableSkeleton(v);
    expect(v.state.sliceDoc()).toContain("\r\n| --- | --- | --- |"); // 前置：CRLF 档位确实生效
    expect(undo(v)).toBe(true);
    expect(v.state.sliceDoc()).toBe("前文\r\n后文");
  });

  it("真实 keydown Ctrl-Z：一次还原（点钮等价路径＝调命令）", () => {
    const v = historyView("前文");
    select(v, 2); // 行尾 → 前让行 + 骨架
    insertTableSkeleton(v);
    expect(v.state.sliceDoc().startsWith("前文\n| 表头1")).toBe(true);
    key(v, "z", { ctrlKey: true }); // 真实按键路径（historyKeymap → undo）
    expect(v.state.sliceDoc()).toBe("前文");
  });

  it("editor.ts 全栈镜像（markdown + livePreview，光标贴既有表格上方）：一次 undo 逐字还原", () => {
    const DOC = "前文\n| a | b |\n| --- | --- |\n| 1 | 2 |\n后文";
    const v = fullStackView(DOC);
    select(v, 2); // 「前文」行尾＝紧贴既有表格首行
    insertTableSkeleton(v);
    expect(v.state.sliceDoc()).toContain("| 表头1 |");
    expect(undo(v)).toBe(true);
    expect(v.state.sliceDoc()).toBe(DOC);
  });

  it("全栈镜像 CRLF：一次 undo 逐字还原（D7 与撤销粒度同时锁）", () => {
    const v = fullStackView("前文\r\n后文", true);
    select(v, 2);
    insertTableSkeleton(v);
    expect(undo(v)).toBe(true);
    expect(v.state.sliceDoc()).toBe("前文\r\n后文");
  });

  describe("fix-18：同文替换空事务过滤（tableNoopFilter 的 jsdom 等价锚）", () => {
    /** 无过滤负对照：全栈镜像去掉 tableNoopFilter——证明「同文替换」在裸 history 下
     *  确实入栈（历史缘起：真机空撤销污染源，包已随 fix-20 退役、过滤作通用守卫），
     *  锚红了才知道是过滤器没装/没生效 */
    function noFilterStackView(doc: string, crlf = false): EditorView {
      view = new EditorView({
        parent: host,
        state: EditorState.create({
          doc,
          extensions: [
            crlf ? EditorState.lineSeparator.of("\r\n") : [],
            history(),
            markdownCommands(),
            keymap.of(historyKeymap),
            markdown(),
            livePreview(),
          ],
        }),
      });
      return view;
    }

    it("负对照（无过滤）：同文替换事务照入历史（undoDepth +1）——锚真的在测过滤", () => {
      const v = noFilterStackView("| a |");
      const before = undoDepth(v.state);
      v.dispatch({ changes: { from: 0, to: 5, insert: "| a |" } }); // 同文替换：无标准 userEvent
      expect(v.state.sliceDoc()).toBe("| a |"); // 文档逐字节不动
      expect(undoDepth(v.state)).toBe(before + 1); // 但入了历史（真机 Ctrl+Z 空步的来源）
    });

    it("完整镜像（含 tableNoopFilter）：同文替换被过滤，history 不增步", () => {
      const v = fullStackView("| a | b |\n| --- | --- |\n| 1 | 2 |");
      const before = undoDepth(v.state);
      v.dispatch({ changes: { from: 0, to: 9, insert: "| a | b |" } }); // 同文替换（表头行）
      expect(v.state.sliceDoc()).toBe("| a | b |\n| --- | --- |\n| 1 | 2 |");
      expect(undoDepth(v.state)).toBe(before); // 被滤 ⇒ history 不增步
    });

    it("同形事务带选区变化：不拦（断光标红线）", () => {
      const v = fullStackView("abc");
      v.dispatch({ changes: { from: 0, to: 3, insert: "abc" }, selection: EditorSelection.cursor(1) });
      expect(v.state.selection.main.head).toBe(1); // 选区生效＝未被拦
    });

    it("同来源真实变更：不拦、照入历史（格式化真改动仍可撤销），undo 通道永不被拦", () => {
      const v = fullStackView("abc");
      const before = undoDepth(v.state);
      v.dispatch({ changes: { from: 0, to: 3, insert: "xyz" } }); // 无 userEvent 但有真实变更
      expect(v.state.sliceDoc()).toBe("xyz");
      expect(undoDepth(v.state)).toBe(before + 1);
      expect(undo(v)).toBe(true); // undo 派发带标准 userEvent "undo" ⇒ 永不入拦截面
      expect(v.state.sliceDoc()).toBe("abc");
    });

    it("端到端：插表 → 同文替换空步被滤 → 一次 Ctrl+Z 逐字还原", () => {
      const DOC = "前文\n| a | b |\n| --- | --- |\n| 1 | 2 |";
      const v = fullStackView(DOC);
      select(v, 2);
      insertTableSkeleton(v);
      const inserted = v.state.sliceDoc();
      expect(inserted).toContain("| 表头1 |");
      const depth = undoDepth(v.state);
      const head = inserted.slice(0, inserted.indexOf("\n")); // 当前文档首行（插入后坐标）
      v.dispatch({ changes: { from: 0, to: head.length, insert: head }, selection: EditorSelection.cursor(inserted.length) }); // 同文替换 + 同位选区
      expect(v.state.sliceDoc()).toBe(inserted);
      expect(undoDepth(v.state)).toBe(depth); // 空步被滤：栈里只剩真插入
      expect(undo(v)).toBe(true); // 一次即撤（修复前真机要先弹两个零效果步）
      expect(v.state.sliceDoc()).toBe(DOC);
    });
  });

  describe("撤销阶梯契约：插表后恰 1 步、一次还原（fix-17/19/19b 历史锚，fix-20 起纯自研口径）", () => {
    /* 历史：fix-17/19/19b 三轮补丁针对表格包 widget 镜像同步的撤销阶梯与行数漂移
     * （真机插表 +5/+6/+8——autoformat 暗改），均未根治；fix-20 整体移除该包与
     * 补丁，插表回归自有 insertTableSkeleton。本锚锁定无包干扰的干净链：
     * 插表＝单事务（undoDepth 恰 1）→ 单次 undo 逐字还原 → 栈清零 → redo 复架。
     * 若未来再引入会追加事务/变更的扩展，此锚即红。真机复验归主线程（净版协议）。 */
    const CASES: ReadonlyArray<{ name: string; doc: string; crlf: boolean; cursor: number }> = [
      { name: "空文档", doc: "", crlf: false, cursor: 0 },
      { name: "行中（前让行）", doc: "前文\n后文", crlf: false, cursor: 2 },
      { name: "贴既有表格上方", doc: "前文\n| a | b |\n| --- | --- |\n| 1 | 2 |\n后文", crlf: false, cursor: 2 },
      { name: "CRLF 行中（D7 同锁）", doc: "前文\r\n后文", crlf: true, cursor: 2 },
    ];

    it("4 组形态：插表后 undoDepth=1（无追加步），一次 undo 逐字还原，再按 3 次无可撤", () => {
      for (const c of CASES) {
        const v = fullStackView(c.doc, c.crlf);
        select(v, c.cursor);
        insertTableSkeleton(v);
        expect(v.state.sliceDoc()).toContain("| 表头1 |"); // 前置：确已插入（防「没插成功也绿」）
        expect(undoDepth(v.state)).toBe(1); // 恰一步：扩展链不得为插表追加任何历史事件
        expect(undo(v)).toBe(true);
        expect(v.state.sliceDoc()).toBe(c.doc); // 一次即逐字还原（阶梯形态＝连按 N 次都撤不掉）
        for (let i = 0; i < 3; i++) expect(undo(v)).toBe(false); // 栈已空：没有凭空多出的事件
        v.destroy();
        view = null;
      }
    });

    it("fix-19b 锚改写：插表 → 单次 undo 逐字还原且 undoDepth 归零（撤销不被吃掉），redo 复架骨架", () => {
      /* 纯自研干净链（fix-20 包退役后口径）：insertTableSkeleton 单事务入史 →
       * undo 一次逐字还原且栈即清零（无镜像回写的复活事件）→ redo 复架骨架。
       * 历史病形（undo 被包镜像回写吃掉 / 撤销阶梯）随包移除而不可复现，以行为锚长守。 */
      const DOC = "前文\n| a | b |\n| --- | --- |\n| 1 | 2 |\n后文";
      const v = fullStackView(DOC);
      select(v, 2);
      insertTableSkeleton(v);
      const inserted = v.state.sliceDoc();
      expect(undoDepth(v.state)).toBe(1);
      expect(undo(v)).toBe(true);
      expect(v.state.sliceDoc()).toBe(DOC);
      expect(undoDepth(v.state)).toBe(0); // 撤销真正落地：栈清空，没有镜像回写的复活事件
      expect(redo(v)).toBe(true); // redo 半边同守卫：恢复骨架不被镜像顶掉
      expect(v.state.sliceDoc()).toBe(inserted);
    });
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

describe("exitEmptyMarkupLine：空标记行 Enter 退出（编辑回归修复）", () => {
  /** 完整镜像：editor.ts 的装配位次（markdownCommands → defaultKeymap → markdown()）。
   *  真实 keydown 经此证明 Prec.high 的 Enter 先于 markdownKeymap 的续标记裁决。 */
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

  it("空「> 」行 Enter：整行清空、光标停行首（真实 keydown 过 markdownKeymap，Prec.high 生效）；再 Enter 普通断行", () => {
    const v = mirrorView("> 引用\n> ");
    select(v, 7); // 第 2 行（「> 」）行尾
    key(v, "Enter");
    expect(v.state.sliceDoc()).toBe("> 引用\n");
    expect(v.state.selection.main.head).toBe(5); // 清空后的第 2 行行首
    key(v, "Enter"); // 行已空：命令放行 → defaultKeymap 普通断行
    expect(v.state.sliceDoc()).toBe("> 引用\n\n");
    expect(v.state.doc.lines).toBe(3);
  });

  it("空列表行 Enter 同样退出：- / * / + / 1. / 23)", () => {
    for (const mark of ["-", "*", "+", "1.", "23)"]) {
      const v = makeView(`${mark}\n下文`);
      select(v, mark.length); // 标记行行尾
      key(v, "Enter");
      expect(v.state.sliceDoc()).toBe("\n下文");
      expect(v.state.selection.main.head).toBe(0);
      v.destroy();
      view = null;
    }
  });

  it("空任务项行 Enter 退出：- [ ] / - [x] / 大小写 [X]", () => {
    for (const mark of ["- [ ] ", "- [x]", "- [X] "]) {
      const v = makeView(`甲\n${mark}`);
      select(v, 2 + mark.length); // 第 2 行行尾
      expect(exitEmptyMarkupLine(v)).toBe(true);
      expect(v.state.sliceDoc()).toBe("甲\n");
      expect(v.state.selection.main.head).toBe(2);
      v.destroy();
      view = null;
    }
  });

  it("有内容行不误伤：返回 false 且真实 Enter 仍是续标记", () => {
    const v = mirrorView("> 引用");
    select(v, 4); // 行尾
    expect(exitEmptyMarkupLine(v)).toBe(false);
    expect(v.state.sliceDoc()).toBe("> 引用");
    key(v, "Enter");
    expect(v.state.sliceDoc()).toBe("> 引用\n> ");
    expect(v.state.selection.main.head).toBe(7); // 新行「> 」之后
  });

  it("CRLF 往返保真：清标记不动 \\r\\n、行数不变；再 Enter 按档位断行", () => {
    const v = mirrorView("> 甲\r\n> ", true);
    select(v, 6); // CRLF 档分隔符按 1 计位：「> 甲」0-2 + 断行 3 + 「> 」4-5，行尾 6
    key(v, "Enter");
    expect(v.state.sliceDoc()).toBe("> 甲\r\n");
    expect(v.state.selection.main.head).toBe(4);
    expect(v.state.doc.lines).toBe(2);
    key(v, "Enter"); // 空行放行 → defaultKeymap 按 lineBreak（\r\n）断行
    expect(v.state.sliceDoc()).toBe("> 甲\r\n\r\n");
    expect(v.state.doc.lines).toBe(3);
  });

  it("非匹配上下文放行：嵌套「> > 」、有选区、代码块内「- 」零干扰", () => {
    const v1 = makeView("> > ");
    select(v1, 4); // 嵌套空引用行行尾
    expect(exitEmptyMarkupLine(v1)).toBe(false);
    expect(v1.state.sliceDoc()).toBe("> > ");

    const v2 = makeView("> ");
    select(v2, 2, 0); // 有选区：Enter 走替换语义，本命令不接管
    expect(exitEmptyMarkupLine(v2)).toBe(false);
    expect(v2.state.sliceDoc()).toBe("> ");

    const v3 = mirrorView("```\n- \n```");
    select(v3, 6); // 代码块第 2 行（「- 」）行尾
    expect(exitEmptyMarkupLine(v3)).toBe(false); // 树守卫：代码块内不接管
    key(v3, "Enter"); // 放行后是普通断行（不是清标记）
    expect(v3.state.sliceDoc()).toBe("```\n- \n\n```");
    expect(v3.state.doc.lines).toBe(4);
  });
});
