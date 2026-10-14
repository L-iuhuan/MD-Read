/**
 * 编辑态 Markdown 格式命令家族（编辑效率 2.0 · A1）。
 *
 * 契约（工具栏 lane 复用，API 稳定——改签名须过评审）：
 *  - markdownCommands(): Extension —— 全部命令 + 键位，直接进 baseExtensions 数组；
 *  - 每个命令独立导出。行内系签名统一 Command＝(view: EditorView) => boolean；
 *    带参的两个是工厂：toggleHeading(level)（0=清除）、wrapSelection(mark)。
 *
 * 实现口径：
 *  - 行内 toggle 家族（粗/斜/删/码/链接）用 state.changeByRange 逐选区
 *    「前缀后缀有则去、无则加」（社区标准模式，同 EasyMDE keymap）；
 *  - 标题/任务项是行级命令：对选区覆盖的行**整块统一**（标题：全部已是目标级
 *    才一并清除，否则一律设为目标级——逐行独立 toggle 会产出混合级别）；
 *  - moveBlock 系直接复用 @codemirror/commands 的 moveLineUp/Down
 *    （多选区与 CRLF 由其内部处理；defaultKeymap 同键同命令，这里显式绑上以自足）。
 *
 * CRLF 契约（D7 红线）：本文件所有插入文本一律不含换行——标记与前后缀都是
 * 行内文本，无需 state.lineBreak。
 *
 * 键位表（IME 红线：无 Ctrl+Alt / Alt+字母）：
 *  Ctrl-B 粗体｜Ctrl-I 斜体｜Ctrl-K 链接｜Ctrl-Shift-K 行内代码｜
 *  Ctrl-Shift-X 删除线｜Ctrl-1..6 标题｜Ctrl-0 清标题｜Ctrl-Enter 任务勾选｜
 *  Alt-↑/↓ 块移动｜Enter 空标记行退出（Prec.high，2026-10-13 编辑回归修复）｜
 *  Backspace 空标记行智能退出（Prec.high，fix-29——裁决链见 ./markup-exit.ts）。
 *  ⚠ 与任务书原键的两处偏差（2026-10-12 全仓核查）：
 *  ① 删除线 Ctrl-Shift-S：editor.ts 的 Ctrl+S 捕获层不看 shiftKey，
 *    Ctrl+Shift+S 在 document 捕获相即被截停成「保存」，CM 永远收不到
 *    ⇒ 改 Ctrl-Shift-X（Discord/Slack 同款）。
 *  ② Ctrl-0：zoom.ts 在 document 气泡相也绑 Ctrl+0（复位缩放，不看 shiftKey），
 *    keymap 命中只 preventDefault 不 stopPropagation ⇒ 走 keymap 会双动作。
 *    改走下方 domEventHandlers 截停通道；Ctrl-Shift-0 在多数布局下
 *    event.key 不是 "0"，不可用。
 */
import { moveLineDown, moveLineUp } from "@codemirror/commands";
import { EditorSelection, EditorState, Prec, Transaction, type Extension, type Line, type SelectionRange } from "@codemirror/state";
import { type Command, EditorView, keymap } from "@codemirror/view";
import { backspaceExitMarkupLine, exitEmptyMarkupLine } from "./markup-exit";

/* ---- 行内标记：toggle 家族 ---- */

/** 单选区的加/去标记计划（changeByRange 回调的返回形态；range 为**新文档**坐标） */
interface WrapPlan {
  changes: { from: number; to?: number; insert?: string }[];
  range: SelectionRange;
}

/** 「有则去、无则加」判定（EasyMDE 同款）：
 *  ① 选区文本自身首尾成对带 mark（如整个选中的 **粗体**）→ 整段替换为去壳文本；
 *  ② mark 恰成对夹在选区外侧（选区落在标记内部）→ 摘除外侧一对；
 *  ③ 否则加上：无选区插 mark×2、光标居中；有选区两端各插一个。 */
function planWrap(state: EditorState, range: SelectionRange, mark: string): WrapPlan {
  const selected = state.sliceDoc(range.from, range.to);
  const inner = selected.slice(mark.length, selected.length - mark.length);
  if (selected.length >= mark.length * 2 && selected.startsWith(mark) && selected.endsWith(mark)) {
    return {
      changes: [{ from: range.from, to: range.to, insert: inner }],
      range: EditorSelection.range(range.from, range.from + inner.length),
    };
  }
  const before = state.sliceDoc(Math.max(0, range.from - mark.length), range.from);
  const after = state.sliceDoc(range.to, Math.min(state.doc.length, range.to + mark.length));
  if (before === mark && after === mark) {
    return {
      changes: [
        { from: range.from - mark.length, to: range.from },
        { from: range.to, to: range.to + mark.length },
      ],
      range: EditorSelection.range(range.from - mark.length, range.to - mark.length),
    };
  }
  if (range.empty) {
    return {
      changes: [{ from: range.from, insert: mark + mark }],
      range: EditorSelection.cursor(range.from + mark.length),
    };
  }
  return {
    changes: [
      { from: range.from, insert: mark },
      { from: range.to, insert: mark },
    ],
    range: EditorSelection.range(range.from + mark.length, range.to + mark.length),
  };
}

/** 包裹命令工厂（工具栏通用入口）：任意行内标记的 toggle 包裹 */
export function wrapSelection(mark: string): Command {
  return (view: EditorView): boolean => {
    view.dispatch(view.state.changeByRange((range) => planWrap(view.state, range, mark)));
    return true;
  };
}

export const toggleBold: Command = wrapSelection("**");
export const toggleItalic: Command = wrapSelection("*");
export const toggleStrikethrough: Command = wrapSelection("~~");
export const toggleInlineCode: Command = wrapSelection("`");

/* ---- 链接 ---- */

/** 链接 toggle：选区整体是 [文本](地址) → 剥壳取回文本；无选区 → 插 []()、
 *  光标在方括号内；有选区 → [选区]()、光标落在 url 待填处（“](”之后）。 */
function planLink(state: EditorState, range: SelectionRange): WrapPlan {
  const selected = state.sliceDoc(range.from, range.to);
  const split = selected.indexOf("](");
  if (selected.startsWith("[") && selected.endsWith(")") && split > 0) {
    return {
      changes: [{ from: range.from, to: range.to, insert: selected.slice(1, split) }],
      range: EditorSelection.range(range.from, range.from + split - 1),
    };
  }
  if (range.empty) {
    return {
      changes: [{ from: range.from, insert: "[]()" }],
      range: EditorSelection.cursor(range.from + 1),
    };
  }
  return {
    changes: [
      { from: range.from, insert: "[" },
      { from: range.to, insert: "]()" },
    ],
    range: EditorSelection.cursor(range.to + 3), // “](”之后＝url 待填处
  };
}

export function toggleLink(view: EditorView): boolean {
  view.dispatch(view.state.changeByRange((range) => planLink(view.state, range)));
  return true;
}

/* ---- 行级命令公共件 ---- */

const HEADING_PREFIX = /^(#{1,6})\s+/;

/** 选区覆盖的全部行（升序去重；多光标同行只取一次——重叠 change 会被 CM 拒绝） */
function coveredLines(state: EditorState): Line[] {
  const seen = new Set<number>();
  const lines: Line[] = [];
  for (const range of state.selection.ranges) {
    const first = state.doc.lineAt(range.from).number;
    const last = state.doc.lineAt(range.to).number;
    for (let n = first; n <= last; n++) {
      if (!seen.has(n)) {
        seen.add(n);
        lines.push(state.doc.line(n));
      }
    }
  }
  return lines;
}

/** 行内某处的增删操作（用于选区平移） */
interface LineOp { at: number; delLen: number; insLen: number }

/** 行级命令统一收尾：应用变更并把选区按 ops 平移。CM 对「只给 changes」的派发
 *  会把恰在插入点的光标留在原地（续打字落进前缀之前 ✗），故自带映射：
 *  光标恰在操作点 → 移到新前缀之后；行内其余位置随增删量平移。 */
function dispatchLineOps(view: EditorView, changes: { from: number; to?: number; insert?: string }[], ops: LineOp[]): void {
  if (ops.length === 0) {
    view.dispatch({ changes });
    return;
  }
  const mapPos = (p: number): number => {
    let delta = 0;
    for (const op of ops) {
      if (p === op.at) {
        return p + delta + op.insLen;
      }
      if (p > op.at) {
        delta += op.insLen - op.delLen;
      }
    }
    return p + delta;
  };
  const sel = view.state.selection;
  view.dispatch({
    changes,
    selection: EditorSelection.create(
      sel.ranges.map((r) => EditorSelection.range(mapPos(r.from), mapPos(r.to))),
      sel.mainIndex,
    ),
  });
}

/* ---- 标题（行级）---- */

/** 标题 toggle：整块统一——覆盖行**全部**已是 level 级则一并清除（单行同此，
 *  toggle 语义），否则一律设为 level 级（异级替换、无级添加）；level=0 一律清除。 */
export function toggleHeading(level: number): Command {
  return (view: EditorView): boolean => {
    const lines = coveredLines(view.state);
    const levelOf = (text: string): number => HEADING_PREFIX.exec(text)?.[1].length ?? 0;
    const target = lines.every((l) => levelOf(l.text) === level) ? 0 : level;
    const desired = target > 0 ? `${"#".repeat(target)} ` : "";
    const changes: { from: number; to?: number; insert?: string }[] = [];
    const ops: LineOp[] = [];
    for (const line of lines) {
      const prefix = HEADING_PREFIX.exec(line.text)?.[0] ?? "";
      if (prefix === desired) {
        continue;
      }
      changes.push({ from: line.from, to: line.from + prefix.length, insert: desired });
      ops.push({ at: line.from, delLen: prefix.length, insLen: desired.length });
    }
    if (changes.length === 0) {
      return false;
    }
    dispatchLineOps(view, changes, ops);
    return true;
  };
}

/* ---- 任务项（行级）---- */

/** 任务项 toggle（Ctrl-Enter）：行首无任务标记 → 插 `- [ ] `（行首已有普通列表
 *  标记则地升级为任务项，不重复插列表符）；已有任务项 → `[ ]`↔`[x]` 勾选切换。 */
export function toggleTaskItem(view: EditorView): boolean {
  const changes: { from: number; to?: number; insert?: string }[] = [];
  const ops: LineOp[] = [];
  for (const line of coveredLines(view.state)) {
    const task = /^(\s*)([-*+]) \[( |x|X)\] /.exec(line.text);
    if (task !== null) {
      const box = line.from + task[1].length + task[2].length + 2; // 「[」之后一格＝勾选位
      changes.push({ from: box, to: box + 1, insert: task[3] === " " ? "x" : " " });
      continue;
    }
    const list = /^(\s*)([-*+]) /.exec(line.text);
    const at = list !== null
      ? line.from + list[0].length
      : line.from + (line.text.match(/^\s*/)?.[0] ?? "").length;
    const insert = list !== null ? "[ ] " : "- [ ] ";
    changes.push({ from: at, insert });
    ops.push({ at, delLen: 0, insLen: insert.length });
  }
  if (changes.length === 0) {
    return false;
  }
  dispatchLineOps(view, changes, ops);
  return true;
}

/* ---- 引用（行级）---- */

/** 引用前缀（P2，fix-23）：`> ` 与无空格形态 `>x` 都算已有引用（CommonMark 里
 *  `>x` 同样是引用）——判定漏掉它会把整块判成「未引用」，加前缀时叠成 `> >x`。 */
const QUOTE_PREFIX = /^> ?/;

/** 引用 toggle（C0）：整块统一——覆盖行**全部**已是 `> `/`>` 打头则一并清除，否则一律
 *  补齐到有（已有行不动，防叠成 `> > ` 二级）；嵌套引用不展开，只做一级 toggle。
 *  插入仅 `> ` 行内前缀、无换行（头注 CRLF 契约）；无默认键位，面在工具栏。 */
export const toggleBlockquote: Command = (view: EditorView): boolean => {
  const lines = coveredLines(view.state);
  const removing = lines.every((l) => QUOTE_PREFIX.test(l.text));
  const changes: { from: number; to?: number; insert?: string }[] = [];
  const ops: LineOp[] = [];
  for (const line of lines) {
    const prefix = QUOTE_PREFIX.exec(line.text)?.[0] ?? "";
    if (removing) {
      if (prefix !== "") {
        changes.push({ from: line.from, to: line.from + prefix.length, insert: "" });
        ops.push({ at: line.from, delLen: prefix.length, insLen: 0 });
      }
    } else if (prefix === "") {
      changes.push({ from: line.from, insert: "> " });
      ops.push({ at: line.from, delLen: 0, insLen: 2 });
    }
  }
  if (changes.length === 0) {
    return false;
  }
  dispatchLineOps(view, changes, ops);
  return true;
};

/* ---- 块移动 ---- */

/** 整块上移/下移：直接复用 @codemirror/commands 的整行移动命令 */
export const moveBlockUp: Command = moveLineUp;
export const moveBlockDown: Command = moveLineDown;

/* ---- 组装：键位 + Ctrl-0 截停 ---- */

/** 键位全家 + 命令扩展，进 baseExtensions。⚠ 必须排在 defaultKeymap 的 keymap
 *  之前：Ctrl-Enter 任务勾选要压过其 Mod-Enter→insertBlankLine。Enter（空标记
 *  行退出）必须 Prec.high：markdown() 在其后装配、其 markdownKeymap 绑 Enter=
 *  insertNewlineContinueMarkup——Prec.high 保证先裁决（返回 false 照常放行）。
 *  Backspace（空标记行智能退出，fix-29）同表 Prec.high：markdownKeymap 亦绑
 *  Backspace=deleteMarkupBackward；input-pairs 的 deleteBracketPair 在更前
 *  （同为 Prec.high，扩展数组在前者先裁）——触发面互不相交，见 markup-exit.ts。 */
export function markdownCommands(): Extension {
  return [
    Prec.high(keymap.of([
      { key: "Enter", run: exitEmptyMarkupLine },
      { key: "Backspace", run: backspaceExitMarkupLine }, // fix-29：退格整行退出＋惰性延续空行分离
    ])),
    keymap.of([
      { key: "Mod-b", run: toggleBold },
      { key: "Mod-i", run: toggleItalic },
      { key: "Mod-k", run: toggleLink },
      { key: "Shift-Mod-k", run: toggleInlineCode },
      { key: "Shift-Mod-x", run: toggleStrikethrough },
      { key: "Mod-1", run: toggleHeading(1) },
      { key: "Mod-2", run: toggleHeading(2) },
      { key: "Mod-3", run: toggleHeading(3) },
      { key: "Mod-4", run: toggleHeading(4) },
      { key: "Mod-5", run: toggleHeading(5) },
      { key: "Mod-6", run: toggleHeading(6) },
      { key: "Mod-Enter", run: toggleTaskItem },
      { key: "Alt-ArrowUp", run: moveBlockUp },
      { key: "Alt-ArrowDown", run: moveBlockDown },
    ]),
    // Ctrl-0 清标题的专属通道（偏差②）：zoom.ts 在 document 气泡相绑了同键的
    // 「复位缩放」。这里在编辑器 DOM 层截停传播——编辑态 Ctrl-0 归本命令（无论
    // 当前行是否真有标题可清），阅读态（事件不经编辑器 DOM）缩放复位照旧。
    EditorView.domEventHandlers({
      keydown(event: KeyboardEvent, view: EditorView): boolean {
        if (event.key !== "0" || !(event.ctrlKey || event.metaKey) || event.altKey || event.shiftKey) {
          return false;
        }
        event.stopPropagation();
        event.preventDefault();
        toggleHeading(0)(view);
        return true;
      },
    }),
  ];
}

/* ---- 追加导出（编辑增强 B1 · 2026-10-12）----
 * ⚠ insertTableSkeleton 是本文件**首个含换行**的插入命令：头注「插入文本一律
 * 不含换行」的口径自此按新规则执行——换行一律取 state.lineBreak（随文档档位
 * \n / \r\n），D7「保真」语义不变。 */

/** 中文整理（源码文本级 CJK↔拉丁补间距）：实现与豁免规则见 ./text-cleanup；
 *  键位 Ctrl-Shift-T 绑在 editor.ts 的 baseExtensions。再导出保工具栏 lane 的单一导入面。 */
export { tidyChineseText } from "./text-cleanup";

/** 空标记行退出家族（Enter · exitEmptyMarkupLine / Backspace · backspaceExitMarkupLine，
 *  fix-29 起实现迁 ./markup-exit）：再导出保既有导入面（tests 与键位同源）。 */
export { backspaceExitMarkupLine, exitEmptyMarkupLine } from "./markup-exit";

/** 3×3 表骨架（3 列：表头行 + 分隔行 + 两行空数据行）；行中插入时前后自动让行
 *  （防表格贴行被吞）。CRLF（D7）：换行取 state.lineBreak；光标长度取 toText 的
 *  Text 长度——\r\n 在文档里只计 1 个行位，拿字符串 length 会越界。
 *  非空选区（fix-23 P1-3）：以 from 为插入点，选区文本原样保留（表格插在其前、
 *  不再吞选区）；因选区文本紧跟表格之后，trail 必让行。
 *  撤销粒度契约（2026-10-13 审计定契）：让行 + 骨架 + 光标平移必须**一个
 *  view.dispatch 单事务**（一个 changes+selection 的 spec，userEvent 标成 input）
 *  ——拆成多次 dispatch 会立两个历史事件，一次 Ctrl+Z 撤不干净（残留让行空行/
 *  骨架尾巴）。回归锚：tests/markdown-commands.spec.ts「撤销粒度」describe
 *  （含 editor.ts 全栈镜像：markdownTables 不另立事务）。 */
export function insertTableSkeleton(view: EditorView): boolean {
  const state = view.state;
  const br = state.lineBreak;
  const rows = ["| 表头1 | 表头2 | 表头3 |", "| --- | --- | --- |", "|     |     |     |", "|     |     |     |"];
  const { from, to } = state.selection.main;
  const head = state.doc.lineAt(from);
  const tail = state.doc.lineAt(to);
  const lead = head.text.slice(0, from - head.from).trim() === "" ? "" : br;
  // trail：光标后（空选区）或选区尾之后（非空选区）还有内容 ⇒ 让行；非空选区
  // 本身就是紧跟表格的内容 ⇒ 必让行（否则末行数据格与保留文本挤进同一行）。
  const after = from === to ? tail.text.slice(to - tail.from).trim() : "选区";
  const trail = after === "" ? "" : br;
  const text = state.toText(lead + rows.join(br) + trail);
  view.dispatch({
    changes: { from, insert: text }, // 不带 to：非空选区不删除（P1-3）；空选区等价原行为
    selection: EditorSelection.cursor(from + text.length),
    userEvent: "input",
  });
  return true;
}

/* ---- fix-18：表格包「同文替换」事务过滤（真机 WebView2 插表后两步空撤销）----
 * 机理（包源码 + @codemirror/commands history 源码核实）：codemirror-markdown-tables
 *  的 table.format/table.correct 会派发格式化事务，其中「已是规范格式」的表产出
 *  同文替换——ChangeSet 非空（HistEvent.fromTransaction 只看 changes.empty，照栛建
 *  历史事件）但新文与旧文逐字节相同 ⇒ Ctrl+Z 先弹零效果步、文档纹丝不动。
 *  包的 userEvent 是**私有 Annotation**（Annotation.define()，未导出，不是
 *  Transaction.userEvent）且其派发点一律不带标准 userEvent ⇒ 从外部只能以
 *  「无标准 userEvent」近似圈定表格包来源（undo/redo/input 均带标准 userEvent，
 *  永不入拦截面——拦 undo 会卡死撤销栈）。
 *  红线：带选区变化的事务绝不拦（断光标）；带 effects 的事务不拦（副作用丢失）；
 *  真实变更的事务不拦（格式化真改动仍可撤销）。
 *  覆盖面：transactionFilter 只见 dispatch 级事务（table.format/table.edit 等）；
 *  transactionExtender 追加的 table.correct 事务不经此 facet（@codemirror/state
 *  实测：extender 输出直接 mergeTransaction，不再过滤）——属本过滤器盲区。
 *  回归锚：tests/markdown-commands.spec.ts「fix-18」describe（含无过滤负对照）。 */
export function tableNoopFilter(): Extension {
  return EditorState.transactionFilter.of(
    (tr) =>
      !tr.changes.empty &&
      tr.annotation(Transaction.userEvent) === undefined &&
      tr.effects.length === 0 &&
      (tr.selection === undefined || tr.startState.selection.eq(tr.selection)) &&
      tr.newDoc.eq(tr.startState.doc)
        ? []
        : tr,
  );
}
