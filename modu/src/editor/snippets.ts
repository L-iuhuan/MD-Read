/**
 * 编辑态 Markdown 格式补全/提示（fix-24 起；fix-26 照抄成熟产品升级）。
 *
 * 触发表（上下文命中才出，光标前文本匹配；禁止无脑全局提示）：
 *   $ / $$     → 块公式    $$\n光标\n$$（fix-26 触发前移：单 $ 即出；行中触发先让行）
 *   :x（≥1字符）→ emoji 菜单（fix-26）：query 收窄、菜单保持（validFor 本地过滤）
 *   行首 |/|-  → 表格      3×3 表骨架
 *   行首 `≥2   → 围栏＋语言菜单七选（ts/json/python/rust/html/css/无语言——
 *               与 CODE_LANGUAGES 同源派生，import 复用、无第二份清单）
 *   - [ / 1. [ → 任务项    替换「[」为「[ ] 」，保留原列表标记
 *   [ / ![     → 链接/图片 [文字](地址) / ![题注](路径)，选中占位文字
 *
 *   fix-27 回撤裸标记前移：行首单字符 -/+ 与 1./> 不再弹菜单（alpha 实证：
 *   每个列表起手都闪，停顿后 Enter 被劫持接受候选；日期 2026. 同形误触）。
 *   任务只留全形 - [ / 1. [；引用走手打（> 后接空格本就顺手）。
 *
 * 稳定性机制（fix-26，官方 autocomplete 通路）：
 *   validFor——新输入若仍命中已返回结果的 validFor，补全插件本地过滤、不重查源
 *   （快打零抖动；围栏语言菜单例外：收窄靠重查，故意不给 validFor）。
 *   退格重弹——reopenCompletionOnDelete（input-pairs.ts，注入本源命中判定）：
 *   删除事务后语境命中触发前缀即 startCompletion 重开。
 *   activateOnTypingDelay 用默认 100ms（全同步本地源，防抖只该作用于异步重查）。
 *
 * 配对协同（fix-26，input-pairs.ts）：markdownInputPairs() 并入本装配（editor.ts
 * 零改动）；输入配对后光标左侧是开符、右侧是自动闭符——apply 范围只盖触发符会
 * 留下孤闭符，故 eatAutoClose 把紧邻闭符一并吃掉（$ 块公式 / [ 链接 / 任务）。
 *
 * 语法安全：光标在行内代码/围栏/缩进代码/HTML/表格块或链接目标内不出提示
 * （豁免名单守卫 syntaxSafe 迁至 input-pairs.ts，两文件同源共用）。
 * 未闭合围栏（``` 敲到第三键）已是 FencedCode——菜单在第二键收口，不打扰手写围栏；
 * 配对通路第三键成 ```|``` 围栏对（官方 allowTriple），菜单静默、互不打扰。
 *
 * 键位（lib-1 实证坑）：defaultKeymap:false 禁掉整张默认键位表——其 macOS
 * Alt-` / Alt-i 起 startCompletion 会吞 AltGr 可打印字符，Ctrl-Space 撞中文
 * IME 切换。自配表：Escape 关闭、Enter/Tab 接受、方向键菜单导航（七选菜单的
 * 键盘通路；无 Alt 系）。菜单未开时四个命令一律返回 false 放行，不抢既有键。
 * ⚠ Enter 裁决顺序：本扩展必须在 markdownCommands() **之前**装配（editor.ts
 * baseExtensions 位次）——两者同为 Prec.high，扩展数组在前者先裁：菜单开着
 * Enter＝接受；关着 acceptCompletion 返回 false，落给 exitEmptyMarkupLine /
 * insertNewlineContinueMarkup，原编辑行为零变化。
 * IME：autocomplete（6.20.3）无 activateOnComposition 开关，源入口以
 * context.view.compositionStarted 自守——覆盖整个组词窗口（composing 只在
 * 组词期发生 DOM 变更后翻真，起手未敲键的窗口会漏）；组词结束自然恢复。
 * filter:false——选项不按 query 对 label 做模糊过滤（否则中文 label「块公式」
 * 匹配不上「$$」会被滤空）；菜单序即 options 数组序。emoji 源例外 filter:true
 * （label 为 ASCII shortcode，query 收窄靠它）。
 */
import {
  acceptCompletion,
  autocompletion,
  closeCompletion,
  moveCompletionSelection,
  CompletionContext,
  type Completion,
  type CompletionResult,
} from "@codemirror/autocomplete";
import { EditorSelection, Prec, type Extension } from "@codemirror/state";
import { EditorView, keymap } from "@codemirror/view";
import { CODE_LANGUAGES } from "./code-langs";
import { markdownInputPairs, reopenCompletionOnDelete, syntaxSafe } from "./input-pairs";
import { EMOJI_ENTRIES } from "./snippets-emoji";

/** 单事务落盘（撤销粒度纪律：一次补全 = 一个历史事件，insertTableSkeleton 同款）。
 *  userEvent=input.complete 与 CM 原生接受路径同类（fix-18 过滤器只拦无 userEvent
 *  的同文替换，真实变更永放行）。cursorA/cursorB 为相对 from 的偏移，按插入串的
 *  Text 形态计——CRLF 档位 \r\n 只占 1 个行位，拿字符串 length 会算大一位；
 *  省略 cursorB＝纯光标，两者都给＝选中占位文字（敲字即替换）。 */
function dispatchInsert(
  view: EditorView,
  from: number,
  to: number,
  text: string,
  cursorA: number,
  cursorB?: number,
): void {
  view.dispatch({
    changes: { from, to, insert: view.state.toText(text) },
    selection:
      cursorB === undefined
        ? EditorSelection.cursor(from + cursorA)
        : EditorSelection.range(from + cursorA, from + cursorB),
    userEvent: "input.complete",
  });
}

/** 配对协同（fix-26）：apply 区间紧右侧若正好是自动闭合符，扩 to 连它一起替换
 *  （输入配对开启后 doc 形如「触发符|闭符」，不扩会留孤闭符）。 */
function eatAutoClose(view: EditorView, to: number, closer: string): number {
  return view.state.sliceDoc(to, to + closer.length) === closer ? to + closer.length : to;
}

/* ---- 各触发形态的补全项（label/detail 全中文，与 PHRASES_ZH 同语言纪律）---- */

const MATH_OPTION: Completion = {
  label: "块公式",
  detail: "插入 $$ 公式块",
  apply: (view, _completion, from, to) => {
    const br = view.state.lineBreak;
    const head = view.state.doc.lineAt(from);
    // 行中触发先让行（块公式起段才被渲染识别，startsDisplayMath 同口径）
    const lead = head.text.slice(0, from - head.from).trim() === "" ? "" : br;
    // fix-27 后 $ 不再自动配对，右侧永无闭符——eatAutoClose 自然 no-op，保留以自证
    const end = eatAutoClose(view, to, "$");
    dispatchInsert(view, from, end, `${lead}$$${br}${br}$$`, view.state.toText(`${lead}$$${br}`).length);
  },
};

const TABLE_OPTION: Completion = {
  label: "表格",
  detail: "插入 3×3 表格骨架",
  apply: (view, _completion, from, to) => {
    const br = view.state.lineBreak;
    const text = ["| 列1 | 列2 | 列3 |", "| --- | --- | --- |", "|  |  |  |"].join(br);
    dispatchInsert(view, from, to, text, view.state.toText(text).length);
  },
};

const TASK_OPTION: Completion = {
  label: "任务",
  detail: "插入任务项",
  // 触发形态（fix-27 后仅全形）：「- [」「1. [」——from..to 只盖「[」，apply 只换
  // 括号，列表标记（- / * / 1.）原样保留。配对开启时区间会扩到自动闭符（「[]」
  // 整体）——替换区间连它一起盖掉，不留孤 ]。
  apply: (view, _completion, from, to) => {
    const end = eatAutoClose(view, to, "]");
    dispatchInsert(view, from, end, "[ ] ", 4);
  },
};

const LINK_OPTION: Completion = {
  label: "链接",
  detail: "插入 [文字](地址)",
  apply: (view, _completion, from, to) =>
    dispatchInsert(view, from, eatAutoClose(view, to, "]"), "[文字](地址)", 1, 4),
};

const IMAGE_OPTION: Completion = {
  label: "图片",
  detail: "插入 ![题注](路径)",
  apply: (view, _completion, from, to) =>
    dispatchInsert(view, from, eatAutoClose(view, to, "]"), "![题注](路径)", 2, 4),
};

/** 围栏项工厂：apply 完整围栏 ```tag\n光标\n```；tag 空＝无语言纯围栏 */
function fenceOption(tag: string): Completion {
  return {
    label: tag === "" ? "无语言" : tag,
    detail: tag === "" ? "插入纯围栏代码块" : `插入 ${tag} 代码块`,
    apply: (view, _completion, from, to) => {
      const br = view.state.lineBreak;
      const open = "```" + tag + br;
      dispatchInsert(view, from, to, open + br + "```", view.state.toText(open).length);
    },
  };
}

/** 语言菜单前六项：与 CODE_LANGUAGES 同源派生——typescript 按其注册别名显示为
 *  ts；javascript 不单列（ts 围栏同走 lang-javascript 懒加载，评审菜单定为七选）。 */
const FENCE_LANG_OPTIONS: Completion[] = CODE_LANGUAGES
  .filter((d) => d.name !== "javascript")
  .map((d) => fenceOption(d.name === "typescript" ? "ts" : d.name));
const FENCE_PLAIN_OPTION: Completion = fenceOption("");

/** emoji 菜单项（fix-26）：label=`:code:`（ASCII，query 收窄过滤域），apply=emoji
 *  本体（字符串 apply＝替换 from..to），detail＝中文场景标注。序即 EMOJI_ENTRIES 序。 */
const EMOJI_OPTIONS: Completion[] = EMOJI_ENTRIES.map((e) => ({
  label: `:${e.code}:`,
  detail: e.zh,
  type: "text",
  apply: e.emoji,
}));

/**
 * 格式补全源（导出供测试直接验证命中/不命中；装配走 formatCompletions）。
 * 判定顺序：围栏 → 块公式 → emoji → 图片 → 任务 → 链接 → 表格（前缀更具体者
 * 先判，防止 `![`/`- [` 被裸 `[` 抢走）。行首系触发额外校验
 * match.from 落在真行首——matchBefore 的 ^ 锚在 pos-250 处，超长行尾部同形文本
 * 会被误当中途行首。validFor 见头注「稳定性机制」。
 */
export function formatCompletionSource(context: CompletionContext): CompletionResult | null {
  if (context.view?.compositionStarted === true) {
    return null; // IME 组词期不弹（autocomplete 无该开关，源侧自守）
  }
  const state = context.state;
  if (!syntaxSafe(state, context.pos)) {
    return null;
  }
  const line = state.doc.lineAt(context.pos);
  const atLineStart = (m: { from: number }): boolean => m.from === line.from;

  // 行首反引号 ≥2（含 3 空格缩进余量，CommonMark 围栏口径）＋可选语言片段。
  // 收窄靠重查源（无 validFor）：菜单序与过滤随片段实时更新。
  const fence = context.matchBefore(/^[ \t]{0,3}`{2,}[ \t]*\w*$/);
  if (fence !== null && atLineStart(fence)) {
    const frag = fence.text.replace(/^[ \t]*`+[ \t]*/, "");
    const options =
      frag === ""
        ? [...FENCE_LANG_OPTIONS, FENCE_PLAIN_OPTION]
        : FENCE_LANG_OPTIONS.filter((o) => o.label.startsWith(frag));
    return options.length > 0 ? { from: fence.from, to: fence.to, options, filter: false } : null;
  }
  // 块公式（fix-26 前移：单 $ 即出候选，双 $ 同此源。fix-27 后 $ 不配对，平插直达）
  const math = context.matchBefore(/\$+/);
  if (math !== null) {
    return { from: math.from, to: math.to, options: [MATH_OPTION], validFor: /^\$+$/, filter: false };
  }
  // emoji（fix-26）：冒号＋≥1 个词字符触发；filter:true——query 收窄；validFor 保住
  // 菜单不因快打/退格重查（本地过滤，时间 10:30 类文本过滤为空自然不出）。
  const emoji = context.matchBefore(/:[\w+-]+$/);
  if (emoji !== null) {
    return { from: emoji.from, to: emoji.to, options: EMOJI_OPTIONS, validFor: /^:[\w+-]*$/, filter: true };
  }
  const image = context.matchBefore(/!\[$/);
  if (image !== null) {
    return { from: image.from, to: image.to, options: [IMAGE_OPTION], validFor: /!?\[$/, filter: false };
  }
  const task = context.matchBefore(/(?:[-*+]|\d+[.)]) \[$/);
  if (task !== null) {
    // from 落在最后一个「[」上：apply 只换括号，列表标记（- / * / 1.）不动
    return {
      from: task.from + task.text.length - 1,
      to: task.to,
      options: [TASK_OPTION],
      validFor: /\[$/,
      filter: false,
    };
  }
  const link = context.matchBefore(/\[$/);
  if (link !== null) {
    return { from: link.from, to: link.to, options: [LINK_OPTION], validFor: /\[$/, filter: false };
  }
  const table = context.matchBefore(/^\|[-| ]*$/);
  if (table !== null && atLineStart(table)) {
    return { from: table.from, to: table.to, options: [TABLE_OPTION], validFor: /^\|[-| ]*$/, filter: false };
  }
  return null;
}

/** 装配入口：autocompletion（override 单源替换 markdown 自带的 languageData
 *  补全，杜绝全局提示噪声）＋ 自配键位（Prec.high，头注裁决顺序）＋ 输入配对
 *  （fix-26，input-pairs.ts，官方 closeBrackets＋语境门禁＋删整对）＋ 删除重弹
 *  （fix-26：谓词＝本源在光标新位命中触发前缀）。 */
export function formatCompletions(): Extension {
  return [
    autocompletion({
      override: [formatCompletionSource],
      defaultKeymap: false,
      icons: false,
      activateOnTyping: true,
    }),
    Prec.high(
      keymap.of([
        { key: "Escape", run: closeCompletion },
        { key: "ArrowDown", run: moveCompletionSelection(true) },
        { key: "ArrowUp", run: moveCompletionSelection(false) },
        { key: "Enter", run: acceptCompletion },
        { key: "Tab", run: acceptCompletion },
      ]),
    ),
    markdownInputPairs(),
    reopenCompletionOnDelete(
      (view) =>
        formatCompletionSource(
          new CompletionContext(view.state, view.state.selection.main.head, false, view),
        ) !== null,
    ),
  ];
}
