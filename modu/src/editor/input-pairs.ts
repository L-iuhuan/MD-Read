/**
 * 输入配对（fix-26 照抄成熟产品；fix-27 议会裁决收缩）：Typora「Auto pair
 * brackets and quotes」档——括号与引号才配对，markdown 语法档符号不裸配对。
 *
 *   开符 ( [ { " ' ` → 词边界处成对插入「开|闭」，光标居中
 *   同字符闭符（` " '）→ 光标在自配对中间时 type-over 跳过不重复
 *   `` ` ``×3 → 官方 allowTriple 路径（brackets 含 "```"）第三键成 `` ```|``` `` 围栏对
 *   退格 → deleteBracketPair（官方命令）：光标在配对中间删整对
 *
 *   fix-27 移出配对表的符号（打键平插单字符，不改写正文）：
 *   `$`——项目语法行内公式是 \(...\)、块级是 $$，单 $ 只可能是金额；官方
 *     handleSame 会成 $|$，行尾打 $1,000 终稿 $1,000$ 尾部残留（金额红线）；
 *   `~`——行中 ~~删除~~ 第 4 个 ~ 会再配对残留（Typora/Obsidian 本就不裸配对）；
 *   `*`/`_`——行首 * 是列表标记起手，配对后留孤星（BOL 无词边界守卫）。
 *   强调/删除线走工具栏/快捷键/补全菜单；$$ 块公式菜单路径不受影响。
 *
 * 语境禁用（MarkText isInCode 语义）：光标在 FencedCode/CodeBlock/InlineCode/
 *   HTMLBlock/Table/URL/LinkLabel 内不配对。官方 closeBrackets 的配置走
 *   languageDataAt 数据面，对无嵌套语言的纯围栏无法按语境关断；官方内部
 *   bracketState 亦未导出（discuss.codemirror.net/t/3711 拆分法无导出面可用），
 *   故自写 inputHandler（Prec.high，先于官方裁决）：代码语境吞掉配对符输入、
 *   按原生路径平插（userEvent=input.type）；正常语境返回 false 放行给官方
 *   closeBrackets——配对/type-over/删整对/triple 全部官方实现白送。
 *
 * 装配：并入 formatCompletions() 返回值（editor.ts 零改动）。
 * 另供 reopenCompletionOnDelete（删除后补全重弹，触发谓词由调用方注入）。
 */
import { closeBrackets, completionStatus, deleteBracketPair, startCompletion } from "@codemirror/autocomplete";
import { markdownLanguage } from "@codemirror/lang-markdown";
import { ensureSyntaxTree, syntaxTree } from "@codemirror/language";
import { EditorSelection, Prec, type EditorState, type Extension } from "@codemirror/state";
import { EditorView, ViewPlugin, keymap, type ViewUpdate } from "@codemirror/view";

/** 语法安全豁免名单（与补全源/格式命令同口径）：这些节点里是「内容区」不是「标记区」，
 *  URL/LinkLabel＝链接目标内（含图片，lezer 里同为 Link 系子节点名）。 */
const UNSAFE_NODES = new Set(["FencedCode", "CodeBlock", "InlineCode", "HTMLBlock", "Table", "URL", "LinkLabel"]);

/** 树守卫（原 snippets.ts 口径迁入，供配对门禁与补全源共用）：树不完整时同步补解析；
 *  resolveInner 取 pos-1 侧（覆盖光标前一个字符的节点——刚敲的触发符必在其中）。 */
export function syntaxSafe(state: EditorState, pos: number): boolean {
  const tree = ensureSyntaxTree(state, pos, 100) ?? syntaxTree(state);
  let node: ReturnType<typeof tree.resolveInner> | null = tree.resolveInner(pos, -1);
  while (node !== null) {
    if (UNSAFE_NODES.has(node.name)) {
      return false;
    }
    node = node.parent;
  }
  return true;
}

/** 单字符配对符（fix-27 收缩：$ * _ ~ 移出——不配对，语境门禁也无需拦；
 * ``` 经官方 allowTriple 由三键自然成对，不占输入面） */
const PAIR_CHARS = new Set(["(", "[", "{", '"', "'", "`"]);

/** 语境门禁：代码/链接目标内吞掉配对符（平插），正常语境放行给官方 closeBrackets。 */
const codeGate = EditorView.inputHandler.of((view, from, to, insert) => {
  if (view.compositionStarted || view.state.readOnly) {
    return false;
  }
  const sel = view.state.selection.main;
  if (!sel.empty || from !== sel.head || to !== sel.head || insert.length !== 1 || !PAIR_CHARS.has(insert)) {
    return false;
  }
  if (syntaxSafe(view.state, from)) {
    return false;
  }
  view.dispatch({
    changes: { from, to, insert },
    selection: EditorSelection.cursor(from + insert.length),
    scrollIntoView: true,
    userEvent: "input.type",
  });
  return true;
});

/**
 * 删除后补全重弹（fix-26）：input delete 事务后语境命中触发前缀 → startCompletion
 * （默认补全在回溯越过 from 时会关菜单，这里按新语境重开——「退格不重弹」的对症）。
 * shouldOpen 由调用方注入（snippets 传格式源命中判定），本扩展不依赖具体补全源。
 */
export function reopenCompletionOnDelete(shouldOpen: (view: EditorView) => boolean): Extension {
  return ViewPlugin.fromClass(
    class {
      update(u: ViewUpdate): void {
        if (!u.docChanged || !u.transactions.some((tr) => tr.isUserEvent("delete"))) {
          return;
        }
        if (u.view.compositionStarted || !shouldOpen(u.view)) {
          return;
        }
        // update 内不许 dispatch：微任务里再开菜单；已开（validFor 撑住了）则不重触发。
        // 视图存活判据用 dom.isConnected（本版 EditorView 无 isDestroyed 公开面）。
        queueMicrotask(() => {
          if (u.view.dom.isConnected && completionStatus(u.view.state) === null) {
            startCompletion(u.view);
          }
        });
      }
    },
  );
}

/**
 * Markdown 输入配对（导出供测试/装配；经 formatCompletions() 并入，editor.ts 零改动）。
 * brackets 清单含 "```"：官方 handleSame 据此开 allowTriple（第三键成围栏对）。
 * fix-27：配对表收缩为括号引号档（$ * _ ~ 已移出，见头注）。
 * before 沿用官方默认 ")]}:;>"（开符后跟这些字符/空白/行尾才配——词边界语义）。
 */
export function markdownInputPairs(): Extension {
  return [
    markdownLanguage.data.of({
      closeBrackets: { brackets: ["(", "[", "{", '"', "'", "`", "```"] },
    }),
    Prec.high(codeGate),
    closeBrackets(),
    Prec.high(keymap.of([{ key: "Backspace", run: deleteBracketPair }])),
  ];
}
