/**
 * 编辑增强 A2 · Live Preview 实时渲染（tests/live-preview.spec.ts）：
 * - 非光标行渲染（隐标记 + 样式类）、光标行/选区覆盖行退场
 * - 代码块/表格/数学/图片零装饰；列表标记保留；任务勾选框（GFM 节点 + commonmark 回退）
 * - 源码保真（装饰前后 sliceDoc 逐字节不变）；IME 组词期不加新装饰
 * - 性能：装饰数随视口变化（窗口构建）、40 行窗口构建耗时、1MB 语料全量构建读数
 *
 * 节点名依据 src/editor/live-preview.ts 头注的 dump 探针确证（commonmark + GFM 双基座）。
 * ⚠ 本文件字符串一律用「」（AGENTS.md 教训：弯引号套娃会 SyntaxError）。
 */
import { markdown, markdownLanguage } from "@codemirror/lang-markdown";
import { ensureSyntaxTree } from "@codemirror/language";
import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  TaskCheckboxWidget,
  buildLivePreviewDecorations,
  livePreview,
  livePreviewPlugin,
} from "../src/editor/live-preview";

/* ---- 样例文档（commonmark base）：每行一类，便于行号定位 ---- */
const SAMPLE = [
  "# 标题甲",
  "## 标题乙",
  "段落 **加粗** 与 *斜体* 与 `行内码`。",
  "[链接](https://example.com) 与 ![图](i.png)。",
  "> 引用行甲",
  "> 引用行乙",
  "- 列表项 **粗**",
  "- [ ] 待办",
  "- [x] 已完",
  "1. 数字项",
  "```js",
  'const a = "*";',
  "```",
  "| 列甲 | 列乙 |",
  "| - | - |",
  "| 1 | 2 |",
  "",
  "$$",
  "a * b **x**",
  "$$",
  "",
  "金额 $1,000 与 $2,000。",
].join("\n");

/** GFM base 样例：Strikethrough / Task / Table 节点路径 */
const SAMPLE_GFM = [
  "# G标题",
  "~~删除~~ 与 **粗**",
  "- [ ] 未完",
  "- [x] 已完",
  "| 表头 |",
  "| - |",
  "| 单元格 |",
].join("\n");

interface DecoInfo {
  from: number;
  to: number;
  cls?: string;
  task?: { checked: boolean };
}

function decosOf(view: EditorView): DecoInfo[] {
  const plugin = view.plugin(livePreviewPlugin);
  const out: DecoInfo[] = [];
  plugin?.decorations.between(0, view.state.doc.length, (from, to, deco) => {
    const widget = deco.spec.widget;
    out.push({
      from,
      to,
      cls: deco.spec.class,
      task: widget instanceof TaskCheckboxWidget ? { checked: widget.checked } : undefined,
    });
  });
  return out;
}

let host: HTMLElement | null = null;

function makeView(doc: string, base?: typeof markdownLanguage): EditorView {
  host = document.createElement("div");
  document.body.append(host);
  return new EditorView({
    parent: host,
    state: EditorState.create({
      doc,
      extensions: [markdown(base === undefined ? {} : { base }), livePreview()],
    }),
  });
}

const inLine = (d: DecoInfo, line: { from: number; to: number }): boolean =>
  d.from >= line.from && d.to <= line.to;
const clsInLine = (decos: DecoInfo[], line: { from: number; to: number }, cls: string): boolean =>
  decos.some((d) => d.cls === cls && inLine(d, line));
const anyInLine = (decos: DecoInfo[], line: { from: number; to: number }): boolean =>
  decos.some((d) => inLine(d, line));
const hiddenAt = (decos: DecoInfo[], from: number, to: number): boolean =>
  decos.some((d) => d.from === from && d.to === to && d.cls === undefined && d.task === undefined);

beforeEach(() => {
  document.body.innerHTML = "";
});

afterEach(() => {
  host?.remove();
  host = null;
});

describe("Live Preview · commonmark base（项目当前装配形态）", () => {
  it("非光标行：标题/粗/斜/行内码/链接/引用/任务各有对应装饰", () => {
    const view = makeView(SAMPLE);
    const L = (n: number) => view.state.doc.line(n);
    view.dispatch({ selection: { anchor: L(22).from } }); // 光标放到无标记的金额行
    const decos = decosOf(view);

    expect(clsInLine(decos, L(1), "cm-lp-h1")).toBe(true);
    expect(hiddenAt(decos, 0, 2)).toBe(true); // 行1 的「# 」前缀隐藏
    expect(clsInLine(decos, L(2), "cm-lp-h2")).toBe(true);
    expect(clsInLine(decos, L(3), "cm-lp-strong")).toBe(true);
    expect(clsInLine(decos, L(3), "cm-lp-em")).toBe(true);
    expect(clsInLine(decos, L(3), "cm-lp-code")).toBe(true);
    expect(clsInLine(decos, L(4), "cm-lp-link")).toBe(true);
    const urlAt = SAMPLE.indexOf("https://example.com");
    expect(hiddenAt(decos, urlAt, urlAt + "https://example.com".length)).toBe(true);
    expect(clsInLine(decos, L(5), "cm-lp-quote")).toBe(true);
    expect(clsInLine(decos, L(6), "cm-lp-quote")).toBe(true);
    expect(hiddenAt(decos, L(5).from, L(5).from + 2)).toBe(true); // 「> 」隐藏
    // 任务勾选（commonmark 回退：ListItem 首段字面形态）
    const todo = decos.find((d) => d.task !== undefined && inLine(d, L(8)));
    const done = decos.find((d) => d.task !== undefined && inLine(d, L(9)));
    expect(todo?.task?.checked).toBe(false);
    expect(done?.task?.checked).toBe(true);
    // 列表标记保留（行7 行首的「-」不被隐藏）
    expect(decos.some((d) => d.cls === undefined && d.task === undefined && d.from === L(7).from)).toBe(false);
  });

  it("代码块/表格/数学/图片零装饰", () => {
    const view = makeView(SAMPLE);
    const L = (n: number) => view.state.doc.line(n);
    view.dispatch({ selection: { anchor: L(22).from } });
    const decos = decosOf(view);

    expect(anyInLine(decos, L(11))).toBe(false); // ```js
    expect(anyInLine(decos, L(12))).toBe(false); // 代码内容（含字面 ** ）
    expect(anyInLine(decos, L(13))).toBe(false); // ```
    for (const n of [14, 15, 16]) {
      expect(anyInLine(decos, L(n))).toBe(false); // 表格三行
    }
    for (const n of [18, 19, 20]) {
      expect(anyInLine(decos, L(n))).toBe(false); // 数学段（含 **x**，段首 $$ 守卫）
    }
    const imgAt = SAMPLE.indexOf("![图](i.png)");
    expect(decos.some((d) => d.from >= imgAt && d.to <= imgAt + "![图](i.png)".length)).toBe(false);
  });

  it("光标行退场：移入即退、移出即回", () => {
    const view = makeView(SAMPLE);
    const L = (n: number) => view.state.doc.line(n);
    view.dispatch({ selection: { anchor: L(22).from } });
    expect(clsInLine(decosOf(view), L(3), "cm-lp-strong")).toBe(true); // 前置：行3 在渲染

    view.dispatch({ selection: { anchor: L(3).from } }); // 光标移入行3
    expect(anyInLine(decosOf(view), L(3))).toBe(false); // 行3 零装饰
    expect(clsInLine(decosOf(view), L(1), "cm-lp-h1")).toBe(true); // 其他行不受影响

    view.dispatch({ selection: { anchor: L(22).from } }); // 移出
    expect(clsInLine(decosOf(view), L(3), "cm-lp-strong")).toBe(true); // 即时恢复
  });

  it("选区跨行：覆盖行全豁免", () => {
    const view = makeView(SAMPLE);
    const L = (n: number) => view.state.doc.line(n);
    view.dispatch({ selection: { anchor: L(1).from, head: L(6).to } }); // 选区盖行1–6
    const decos = decosOf(view);
    for (const n of [1, 2, 3, 4, 5, 6]) {
      expect(anyInLine(decos, L(n))).toBe(false);
    }
    expect(clsInLine(decos, L(7), "cm-lp-strong")).toBe(true); // 行7 起照常渲染
  });

  it("源码保真：装饰存在时 sliceDoc 逐字节不变", () => {
    const view = makeView(SAMPLE);
    const L = (n: number) => view.state.doc.line(n);
    view.dispatch({ selection: { anchor: L(22).from } });
    expect(decosOf(view).length).toBeGreaterThan(0); // 前置：确有装饰
    expect(view.state.sliceDoc()).toBe(SAMPLE); // 装饰不改字节
    for (const n of [1, 5, 9, 14]) {
      view.dispatch({ selection: { anchor: L(n).from } }); // 纯光标移动
    }
    expect(view.state.sliceDoc()).toBe(SAMPLE); // 多轮移动仍零字节改动
  });

  it("IME 组词期不加新装饰；组词结束后恢复渲染", () => {
    const view = makeView(SAMPLE);
    const L = (n: number) => view.state.doc.line(n);
    view.dispatch({ selection: { anchor: L(22).from } });
    const before = decosOf(view);
    expect(before.length).toBeGreaterThan(0);

    // 组词事件：在行14（表格行，非光标行）尾插入「 **粗尾**」——正常解析应产出新装饰
    const insertAt = L(14).to; // 先落成 dispatch 前的位置，插入后行14 已变长
    view.dispatch({
      changes: { from: insertAt, insert: " **粗尾**" },
      userEvent: "input.type.compose",
    });
    const during = decosOf(view);
    expect(during.length).toBe(before.length); // 不加新
    expect(during).toEqual(before); // 旧装饰原位保持（插入点在全部装饰之后，map 后不变）
    expect(view.state.sliceDoc()).toBe(
      SAMPLE.slice(0, insertAt) + " **粗尾**" + SAMPLE.slice(insertAt),
    ); // 字节只含用户输入

    view.dispatch({ selection: { anchor: L(22).to } }); // 组词结束后的普通 update
    const after = decosOf(view);
    expect(after.length).toBeGreaterThan(during.length); // 补上渲染
    expect(clsInLine(after, view.state.doc.line(14), "cm-lp-strong")).toBe(true);
  });
});

describe("Live Preview · GFM base（Strikethrough/Task/Table 节点名路径）", () => {
  it("删除线与任务节点渲染、表格零装饰", () => {
    const view = makeView(SAMPLE_GFM, markdownLanguage);
    const L = (n: number) => view.state.doc.line(n);
    view.dispatch({ selection: { anchor: L(1).from } }); // 光标行1：GFM 断言集中在行2–4
    const decos = decosOf(view);

    expect(clsInLine(decos, L(2), "cm-lp-strike")).toBe(true);
    const tildeAt = SAMPLE_GFM.indexOf("~~");
    expect(hiddenAt(decos, tildeAt, tildeAt + 2)).toBe(true); // StrikethroughMark 隐藏
    const todo = decos.find((d) => d.task !== undefined && inLine(d, L(3)));
    const done = decos.find((d) => d.task !== undefined && inLine(d, L(4)));
    expect(todo?.task?.checked).toBe(false);
    expect(done?.task?.checked).toBe(true);
    expect(L(3).from + 2).toBe(todo?.from); // TaskMarker 紧跟 ListMark 之后
    for (const n of [5, 6, 7]) {
      expect(anyInLine(decos, L(n))).toBe(false); // Table 节点整体剪枝
    }
  });
});

/* ---- 性能：装饰数随视口变化 + 窗口构建耗时（jsdom 无布局，无法真滚动，
      故以 buildLivePreviewDecorations + 人工窗口替代，方法见返回注明） ---- */
function syntheticDoc(cycles: number): string {
  const block = [
    "## 小节标题",
    "正文 **加粗** 与 `行内码` 与 [链](https://example.com)。",
    "> 引用一句",
    "- [ ] 待办与 **粗**",
  ].join("\n");
  return Array.from({ length: cycles }, () => block).join("\n\n"); // 周期 5 行
}

describe("Live Preview · 性能", () => {
  it("装饰数随视口变化；40 行窗口构建远快于全量", () => {
    const doc = syntheticDoc(1200); // 6000 行，周期 5 行
    const state = EditorState.create({ doc, extensions: [markdown()] });
    ensureSyntaxTree(state, doc.length, 20000); // headless 逼出完整树

    const line = (n: number) => state.doc.line(n);
    const window40 = (start: number) => [{ from: line(start).from, to: line(start + 39).to }];
    const count = (visible: readonly { from: number; to: number }[]): number => {
      const out: number[] = [];
      buildLivePreviewDecorations(state, visible).between(0, doc.length, () => { out.push(0); });
      return out.length;
    };

    const nA = count(window40(2001)); // 相位对齐（2001 % 5 === 3001 % 5 === 1）
    const nB = count(window40(3001));
    const nFull = count([{ from: 0, to: doc.length }]);
    expect(nA).toBeGreaterThan(0);
    expect(nA).toBe(nB); // 同密度窗口装饰数一致：装饰 ∝ 视口而非文档
    expect(nFull).toBeGreaterThan(nA * 20); // 全量（≈1200 周期）≫ 窗口（8 周期）

    const t0 = performance.now();
    const rounds = 50;
    for (let i = 0; i < rounds; i++) {
      buildLivePreviewDecorations(state, window40(2001 + (i % 5) * 5));
    }
    const avgMs = (performance.now() - t0) / rounds;
    console.log(`[live-preview 性能] 40 行窗口 ×${rounds}：均值 ${avgMs.toFixed(2)}ms；装饰数 窗口=${nA} / 全量=${nFull}`);
    expect(avgMs).toBeLessThan(20); // 预算：60fps 帧预算 16ms，含 10x CI 余量
  }, 30000);

  it("1MB 真实语料全量构建读数（防退化锚）", () => {
    const corpus = readFileSync("tests/corpus/性能无公式1MB.md", "utf8");
    const state = EditorState.create({ doc: corpus, extensions: [markdown()] });
    const docLen = state.doc.length; // CRLF 语料：Text 分行吞 \r，长度 ≠ 字符串长度
    ensureSyntaxTree(state, docLen, 60000);
    const t0 = performance.now();
    const out: number[] = [];
    buildLivePreviewDecorations(state, [{ from: 0, to: docLen }]).between(
      0,
      docLen,
      () => { out.push(0); },
    );
    const ms = performance.now() - t0;
    console.log(`[live-preview 性能] 1MB 语料全量：${ms.toFixed(1)}ms，装饰 ${out.length} 条`);
    expect(ms).toBeLessThan(800); // 全量是极端上界（滚动只算窗口）；防退化锚
  }, 90000);
});
