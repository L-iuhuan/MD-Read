/**
 * 格式补全（fix-24）：上下文触发命中/不命中（含围栏内、行内码、链接目标、
 * 表格内不出——语法安全）、apply 骨架与光标位（CRLF 保真一例）、键位裁决
 * （Enter 先裁菜单接受、菜单关时空标记行退出原路放行、Escape 关闭）、
 * IME 组词期不弹。装配位次镜像 editor.ts：formatCompletions 在 markdownCommands 之前。
 * fix-26 增：validFor 快打稳定（零抖动）、退格重弹、emoji 菜单（触发/收窄/apply）、
 * 单字符触发前移（$ / 裸列表标记）、配对协同（apply 吃自动闭符）。
 * fix-27 增：裸标记前移回撤（行首 -/+/1./> 不弹）、$ 不再配对（平插触发）、
 * emoji 数据源对齐锚（编辑器候选键集 == 渲染 EMOJI_DEFS 键集）。
 */
import {
  CompletionContext,
  completionStatus,
  currentCompletions,
  startCompletion,
  type CompletionResult,
} from "@codemirror/autocomplete";
import { history, undo, undoDepth } from "@codemirror/commands";
import { markdown, markdownLanguage } from "@codemirror/lang-markdown";
import { EditorState, EditorSelection } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { markdownCommands } from "../src/editor/markdown-commands";
import { formatCompletionSource, formatCompletions } from "../src/editor/snippets";
import { EMOJI_ENTRIES } from "../src/editor/snippets-emoji";

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

let host: HTMLElement;
let view: EditorView | null = null;

/** 镜像 editor.ts 装配序（formatCompletions 在 markdownCommands 前——Enter 裁决被测对象） */
function makeView(doc: string, crlf = false): EditorView {
  view = new EditorView({
    parent: host,
    state: EditorState.create({
      doc,
      extensions: [
        crlf ? EditorState.lineSeparator.of("\r\n") : [],
        history(),
        formatCompletions(),
        markdownCommands(),
        markdown({ base: markdownLanguage }), // 镜像 editor.ts：GFM 基座（Table 等节点路径激活）
      ],
    }),
  });
  return view;
}

/** 直接查源（CompletionContext 官方测试通道；带 view 供 composing 判定） */
function query(v: EditorView, pos: number): CompletionResult | null {
  return formatCompletionSource(new CompletionContext(v.state, pos, false, v));
}

function labels(r: CompletionResult | null): string[] {
  return r === null ? [] : r.options.map((o) => o.label);
}

/** 应用指定 label 的补全项（函数 apply 直调；字符串 apply＝替换 from..to，emoji 用） */
function applyLabel(v: EditorView, pos: number, label?: string): void {
  const r = query(v, pos);
  const opt = r === null ? undefined : label === undefined ? r.options[0] : r.options.find((o) => o.label === label);
  if (r === null || opt === undefined) {
    throw new Error(`无补全项：${label ?? "(首个)"}`);
  }
  if (typeof opt.apply === "function") {
    opt.apply(v, opt, r.from, r.to ?? pos); // to 缺省回退光标位（CM applyCompletion 同口径；本源恒给出 to）
  } else if (typeof opt.apply === "string") {
    v.dispatch({ changes: { from: r.from, to: r.to ?? pos, insert: opt.apply }, userEvent: "input.complete" });
  } else {
    throw new Error(`apply 形态未识别：${label}`);
  }
}

/** 模拟打字：逐字符走 inputHandler facet（语境门禁→官方配对），全 false 再平插 */
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

function select(v: EditorView, head: number, anchor?: number): void {
  v.dispatch({ selection: EditorSelection.range(anchor ?? head, head) });
}

/** 向 contentDOM 派发真实 keydown（裁决顺序走真实键位表） */
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

afterEach(() => {
  view?.destroy();
  view = null;
  document.body.innerHTML = "";
});

describe("上下文触发命中", () => {
  it("$$ → 块公式（命中范围覆盖两个 $）", () => {
    const v = makeView("$$");
    const r = query(v, 2);
    expect(labels(r)).toEqual(["块公式"]);
    expect(r?.from).toBe(0);
    expect(r?.to).toBe(2);
  });

  it("行首 |、|-、|-- → 表格（from 均为真行首）", () => {
    for (const t of ["|", "|-", "|--", "| -"]) {
      const v = makeView(t);
      const r = query(v, t.length);
      expect(labels(r)).toEqual(["表格"]);
      expect(r?.from).toBe(0);
      v.destroy();
      view = null;
    }
  });

  it("行首 ``（第二键）→ 七选语言菜单；已键片段前缀收窄", () => {
    // 序与 CODE_LANGUAGES 同源派生（typescript→ts、javascript 不单列）
    expect(labels(query(makeView("``"), 2))).toEqual(["ts", "python", "json", "rust", "html", "css", "无语言"]);
    expect(labels(query(makeView("``t"), 3))).toEqual(["ts"]);
    expect(labels(query(makeView("``j"), 3))).toEqual(["json"]);
    expect(query(makeView("``z"), 3)).toBeNull(); // 无匹配语言：收窄到空即不出
  });

  it("- [ 与有序 1. [ → 任务（from 落在「[」上，列表标记留给 apply 保留）", () => {
    const r = query(makeView("- ["), 3);
    expect(labels(r)).toEqual(["任务"]);
    expect(r?.from).toBe(2);
    expect(labels(query(makeView("1. ["), 4))).toEqual(["任务"]);
  });

  it("[ 与 ![ 区分：链接/图片；行中 [ 仍可出（非行首限定）", () => {
    expect(labels(query(makeView("["), 1))).toEqual(["链接"]);
    expect(labels(query(makeView("!["), 2))).toEqual(["图片"]);
    expect(labels(query(makeView("x["), 2))).toEqual(["链接"]);
  });

  it("行首 > 不再弹引用菜单（fix-27 回撤单字符触发）；行中 > 同样不出", () => {
    expect(query(makeView(">"), 1)).toBeNull();
    expect(query(makeView("正文 >"), 4)).toBeNull();
  });

  it("超长行尾 |- 不误中（matchBefore 的 ^ 锚在 pos-250，行首校验拦下）", () => {
    const doc = "字".repeat(300) + "|-";
    expect(query(makeView(doc), doc.length)).toBeNull();
  });
});

describe("语法安全：这些上下文不出提示", () => {
  it("围栏内行首 `` 不出（含未闭合围栏——``` 敲到第三键即静默）", () => {
    expect(query(makeView("```"), 3)).toBeNull();
    const doc = "```\n``\n```";
    const v = makeView(doc);
    expect(query(v, v.state.doc.line(2).to)).toBeNull();
  });

  it("行内码内 $$ 不出（InlineCode 守卫）", () => {
    expect(query(makeView("`a$$`"), 4)).toBeNull();
  });

  it("链接目标内 $$ 不出（URL 守卫）", () => {
    const doc = "[文字](地址$$)";
    const v = makeView(doc);
    expect(query(v, doc.length - 1)).toBeNull();
  });

  it("表格内的分隔行行尾不出（Table 守卫——那是改表不是建表）", () => {
    const v = makeView("| a | b |\n| --- | --- |\n| 1 | 2 |");
    expect(query(v, v.state.doc.line(2).to)).toBeNull();
  });

  it("缩进代码块内 $$ 不出（CodeBlock 守卫）", () => {
    expect(query(makeView("    $$"), 6)).toBeNull();
  });

  it("IME 组词期不弹，组词结束恢复", () => {
    const v = makeView("$$");
    v.contentDOM.dispatchEvent(new CompositionEvent("compositionstart"));
    expect(query(v, 2)).toBeNull();
    v.contentDOM.dispatchEvent(new CompositionEvent("compositionend"));
    expect(labels(query(v, 2))).toEqual(["块公式"]);
  });
});

describe("apply 骨架与光标位", () => {
  it("块公式：$$\\n光标\\n$$；行中触发先让行", () => {
    const v = makeView("甲乙$$");
    applyLabel(v, 4);
    expect(v.state.sliceDoc()).toBe("甲乙\n$$\n\n$$");
    expect(v.state.selection.main.head).toBe(6); // 中空行行首
  });

  it("表格：3 行骨架、光标末尾", () => {
    const v = makeView("|");
    applyLabel(v, 1);
    expect(v.state.sliceDoc()).toBe("| 列1 | 列2 | 列3 |\n| --- | --- | --- |\n|  |  |  |");
    expect(v.state.selection.main.head).toBe(v.state.doc.length);
  });

  it("任务：保留列表标记（无序与有序）", () => {
    const v1 = makeView("- [");
    applyLabel(v1, 3);
    expect(v1.state.sliceDoc()).toBe("- [ ] ");
    const v2 = makeView("1. [");
    applyLabel(v2, 4);
    expect(v2.state.sliceDoc()).toBe("1. [ ] ");
  });

  it("链接/图片：占位文字被选中且不含 `]`；直接敲字替换后仍是合法链接", () => {
    const v1 = makeView("[");
    applyLabel(v1, 1);
    expect(v1.state.sliceDoc()).toBe("[文字](地址)");
    // 新锚①：选区逐字等于占位片段「文字」（半开区间 [1,3)），不含 `]`
    expect(v1.state.selection.main.from).toBe(1);
    expect(v1.state.selection.main.to).toBe(3);
    expect(v1.state.sliceDoc(v1.state.selection.main.from, v1.state.selection.main.to)).toBe("文字");
    expect(v1.state.sliceDoc(v1.state.selection.main.from, v1.state.selection.main.to)).not.toContain("]");
    // 新锚②（原锚的失败条件）：接受补全后直接打字 —— 旧锚 range(1,4) 会连 `]` 选中，
    // 打字得 `[新(地址)`（没有 `]` 的坏链）；修后占位整段被替换 ⇒ `[新](地址)`。
    const sel = v1.state.selection.main;
    v1.dispatch({
      changes: { from: sel.from, to: sel.to, insert: "新" },
      selection: { anchor: sel.from + 1 },
    });
    expect(v1.state.sliceDoc()).toBe("[新](地址)"); // 设计值：占位「文字」被整段替换
    expect(v1.state.sliceDoc()).not.toBe("[新(地址)");
    // 图片分支保持正确：占位「题注」被选中、不含 `]`
    const v2 = makeView("![");
    applyLabel(v2, 2);
    expect(v2.state.sliceDoc()).toBe("![题注](路径)");
    expect(v2.state.selection.main.from).toBe(2);
    expect(v2.state.selection.main.to).toBe(4);
    expect(v2.state.sliceDoc(v2.state.selection.main.from, v2.state.selection.main.to)).toBe("题注");
    expect(v2.state.sliceDoc(v2.state.selection.main.from, v2.state.selection.main.to)).not.toContain("]");
  });

  it("围栏：ts / 无语言，光标落围栏内空行", () => {
    const v1 = makeView("``");
    applyLabel(v1, 2, "ts");
    expect(v1.state.sliceDoc()).toBe("```ts\n\n```");
    expect(v1.state.selection.main.head).toBe(6);
    const v2 = makeView("``");
    applyLabel(v2, 2, "无语言");
    expect(v2.state.sliceDoc()).toBe("```\n\n```");
    expect(v2.state.selection.main.head).toBe(4);
  });

  it("缩进行 > 也不弹（原 ^\\s*>$ 缩进形态随 fix-27 一并回撤）", () => {
    expect(query(makeView("  >"), 3)).toBeNull();
  });

  it("撤销粒度：一次补全 = 一个历史事件，Ctrl+Z 一步撤净", () => {
    const v = makeView("- [");
    applyLabel(v, 3);
    expect(v.state.sliceDoc()).toBe("- [ ] ");
    expect(undoDepth(v.state)).toBe(1);
    undo(v);
    expect(v.state.sliceDoc()).toBe("- [");
  });

  it("CRLF 保真：块公式按档位断行，sliceDoc 读回 \\r\\n、光标按档内位计", () => {
    const v = makeView("$$", true);
    applyLabel(v, 2);
    expect(v.state.sliceDoc()).toBe("$$\r\n\r\n$$");
    expect(v.state.doc.lines).toBe(3);
    expect(v.state.selection.main.head).toBe(3); // 「$$＋换行」档内 3 位（\r\n 只计 1）
  });
});

describe("键位裁决（真实键派发）", () => {
  it("Enter 先裁菜单接受：- [ 开菜单后 Enter → 落成任务项（不是续行）", async () => {
    const v = makeView("- [");
    select(v, 3);
    startCompletion(v);
    await vi.waitFor(() => expect(completionStatus(v.state)).toBe("active"));
    await new Promise((r) => setTimeout(r, 100)); // 过 interactionDelay（75ms）保护窗
    key(v, "Enter");
    expect(v.state.sliceDoc()).toBe("- [ ] ");
  });

  it("菜单关闭时 Enter 原路放行：空标记行退出（exitEmptyMarkupLine）不受影响", () => {
    const v = makeView("> ");
    select(v, 2);
    key(v, "Enter");
    expect(v.state.sliceDoc()).toBe("");
    expect(completionStatus(v.state)).toBeNull();
  });

  it("Escape 关闭菜单（无菜单时不吞 Escape——留给查找面板等既有键）", async () => {
    const v = makeView("$$");
    select(v, 2);
    startCompletion(v);
    await vi.waitFor(() => expect(completionStatus(v.state)).toBe("active"));
    key(v, "Escape");
    expect(completionStatus(v.state)).toBeNull();
  });
});

describe("fix-26：validFor 快打稳定（零抖动，本地过滤不重查）", () => {
  it("$ → $ 续打：菜单不关，选项不变（不重查源）", async () => {
    const v = makeView("");
    select(v, 0);
    typeText(v, "$"); // fix-27 后 $ 平插单字符（光标 1）；单 $ 前移触发菜单
    await vi.waitFor(() => expect(completionStatus(v.state)).toBe("active"));
    typeText(v, "$"); // 第二键平插成 $$（光标 2）——文本自 from 起仍命中 /^\$+$/
    await new Promise((r) => setTimeout(r, 100)); // 过 interactionDelay（75ms）保护窗
    expect(completionStatus(v.state)).toBe("active");
    expect((currentCompletions(v.state) ?? []).map((c) => c.label)).toEqual(["块公式"]);
  });

  it(":t 续打 ada：菜单保持并收窄到唯一（emoji filter:true）", async () => {
    const v = makeView("");
    select(v, 0);
    typeText(v, ":t");
    await vi.waitFor(() => expect(completionStatus(v.state)).toBe("active"));
    expect((currentCompletions(v.state) ?? []).map((c) => c.label)).toContain(":tada:");
    typeText(v, "ada");
    await new Promise((r) => setTimeout(r, 100));
    expect(completionStatus(v.state)).toBe("active"); // 不重查不关
    expect((currentCompletions(v.state) ?? []).map((c) => c.label)).toEqual([":tada:"]);
  });
});

describe("fix-26：退格重弹（delete 事务后语境命中即重开）", () => {
  it("$$ 退一格回 $：菜单重开，块公式候选仍在", async () => {
    const v = makeView("");
    select(v, 0);
    typeText(v, "$$");
    await vi.waitFor(() => expect(completionStatus(v.state)).toBe("active"));
    key(v, "Escape");
    expect(completionStatus(v.state)).toBeNull();
    v.dispatch({ changes: { from: 1, to: 2 }, selection: { anchor: 1 }, userEvent: "delete.backward" });
    await vi.waitFor(() => expect(completionStatus(v.state)).toBe("active"));
    expect((currentCompletions(v.state) ?? []).map((c) => c.label)).toEqual(["块公式"]);
  });

  it("- [ 逐步退回：全程不弹（「- 」与裸「-」均非触发位——fix-27 回撤后）", async () => {
    const v = makeView("- [");
    select(v, 3);
    startCompletion(v);
    await vi.waitFor(() => expect(completionStatus(v.state)).toBe("active"));
    key(v, "Escape");
    v.dispatch({ changes: { from: 2, to: 3 }, selection: { anchor: 2 }, userEvent: "delete.backward" });
    await new Promise((r) => setTimeout(r, 50));
    expect(completionStatus(v.state)).toBeNull(); // 「- 」非触发位：不弹
    v.dispatch({ changes: { from: 1, to: 2 }, selection: { anchor: 1 }, userEvent: "delete.backward" });
    await new Promise((r) => setTimeout(r, 50));
    expect(completionStatus(v.state)).toBeNull(); // 裸「-」也非触发位（回撤后不再重弹）
  });
});

describe("fix-26：emoji 菜单", () => {
  it("冒号＋≥1 字符触发：from 落在冒号，选项含 :smile:", () => {
    const r = query(makeView(":s"), 2);
    expect(r).not.toBeNull();
    expect(r?.from).toBe(0);
    expect(labels(r)).toContain(":smile:");
  });

  it("裸冒号不触发；filter:true＋validFor 配置在位（收窄交给插件）", () => {
    expect(query(makeView(":"), 1)).toBeNull();
    const r = query(makeView(":smile"), 6);
    expect(r?.filter).toBe(true);
    expect(r?.validFor).toEqual(/^:[\w+-]*$/);
  });

  it("apply：:smile 整段替换为 emoji 本体", () => {
    const v = makeView(":smile");
    applyLabel(v, 6, ":smile:");
    expect(v.state.sliceDoc()).toBe("😄");
  });
});

describe("fix-27：裸标记前移回撤（行首单字符不弹菜单）", () => {
  it("$ 单字符 → 块公式（from 盖 $）——唯一保留的前移路径", () => {
    const r = query(makeView("$"), 1);
    expect(labels(r)).toEqual(["块公式"]);
    expect(r?.from).toBe(0);
    expect(r?.to).toBe(1);
  });

  it("行首 - / + / 1. / > 不再弹菜单（列表起手不闪、Enter 不被劫持）", () => {
    expect(query(makeView("-"), 1)).toBeNull();
    expect(query(makeView("+"), 1)).toBeNull();
    expect(query(makeView("1."), 2)).toBeNull();
    expect(query(makeView(">"), 1)).toBeNull();
  });

  it("日期起手 2026. 同形不弹；行中 - 同样不出", () => {
    expect(query(makeView("2026."), 5)).toBeNull();
    expect(query(makeView("正文 -"), 4)).toBeNull();
  });

  it("全形 - [ / 1. [ 仍出任务（apply 保留有序/无序标记）", () => {
    expect(labels(query(makeView("- ["), 3))).toEqual(["任务"]);
    expect(labels(query(makeView("1. ["), 4))).toEqual(["任务"]);
  });
});

describe("fix-26：配对协同（apply 吃掉自动闭符，不留孤符）", () => {
  it("- [ 打下成 - [|]：接受任务后无孤 ]", () => {
    const v = makeView("");
    select(v, 0);
    typeText(v, "- [");
    expect(v.state.sliceDoc()).toBe("- []"); // 输入配对在位
    expect(labels(query(v, 3))).toEqual(["任务"]);
    applyLabel(v, 3);
    expect(v.state.sliceDoc()).toBe("- [ ] ");
  });

  it("$ 单键接受块公式：平插 $ → $$ 公式块（fix-27 后 $ 不配对）", () => {
    const v = makeView("");
    select(v, 0);
    typeText(v, "$");
    expect(v.state.sliceDoc()).toBe("$"); // $ 已移出配对表：平插单字符
    applyLabel(v, 1);
    expect(v.state.sliceDoc()).toBe("$$\n\n$$");
  });
});

describe("fix-27：emoji 数据源对齐锚（编辑器候选 = 渲染白名单）", () => {
  /** 从渲染侧源码抄录 EMOJI_DEFS（markdown.ts 不在本批可改清单，无法 export，
   *  以源码文本解析作对齐面——正则见下方自证用例，防「解析失明假绿」） */
  const markdownSource = readFileSync(
    path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "src", "render", "markdown.ts"),
    "utf8",
  );
  const defsBlock = /const EMOJI_DEFS[^{]*\{([\s\S]*?)\}/.exec(markdownSource)?.[1] ?? "";
  const renderDefs = new Map<string, string>(
    [...defsBlock.matchAll(/(?:'([^']+)'|"([^"]+)"|([A-Za-z_$][\w$]*))\s*:\s*'([^']*)'/g)].map(
      (m): [string, string] => [m[1] ?? m[2] ?? m[3] ?? "", m[4] ?? ""],
    ),
  );

  it("解析自证：渲染侧 EMOJI_DEFS 抽出键非空（正则失明即红，不假绿）", () => {
    expect(defsBlock).not.toBe("");
    expect(renderDefs.size).toBeGreaterThan(50);
  });

  it("编辑器候选键集 == 渲染 EMOJI_DEFS 键集（补得出 ⇔ 渲染得出，防漂移）", () => {
    expect(new Set(EMOJI_ENTRIES.map((e) => e.code))).toEqual(new Set(renderDefs.keys()));
  });

  it("emoji 本体逐键一致（编辑器插入的字形与渲染替换的字形相同）", () => {
    for (const e of EMOJI_ENTRIES) {
      expect(e.emoji).toBe(renderDefs.get(e.code));
    }
  });
});
