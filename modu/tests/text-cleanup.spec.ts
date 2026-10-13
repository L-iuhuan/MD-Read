/**
 * 中文文本整理（编辑增强 B1）：间距补全 / 语法豁免（围栏、行内码、链接目标、
 * 公式、引用定义）/ 选区范围 / CRLF 保真（D7）/ 幂等 / Ctrl-Shift-T 键位
 * （经 createDocState 的真实装配路径，绑定点在 editor.ts baseExtensions）。
 * 判定锚：与 render/pangu.ts 的 RE_BOUNDARY 同源（货币符号参与 CJK 边界）。
 */
import { EditorSelection } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createDocState } from "../src/editor/editor";
import { tidyChineseText } from "../src/editor/text-cleanup";

let host: HTMLElement;
let view: EditorView | null = null;

/** 走真实装配路径（createDocState 含 baseExtensions 全家）：键位断言与命令行为同源 */
function makeView(doc: string, crlf = false): EditorView {
  view = new EditorView({ parent: host, state: createDocState(doc, crlf) });
  return view;
}
function select(v: EditorView, head: number, anchor?: number): void {
  v.dispatch({ selection: EditorSelection.range(anchor ?? head, head) });
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

describe("间距补全（CJK ↔ 拉丁/数字/货币，与阅读侧同源）", () => {
  it("双向补单空格：中文English混合 → 中文 English 混合；数字同理", () => {
    const v = makeView("中文English混合第2章");
    expect(tidyChineseText(v)).toBe(true);
    expect(v.state.sliceDoc()).toBe("中文 English 混合第 2 章");
  });

  it("货币符号参与 CJK 边界，但金额内部贴紧（D2：$1,000 不拆）", () => {
    const v = makeView("总价$1,000元");
    expect(tidyChineseText(v)).toBe(true);
    expect(v.state.sliceDoc()).toBe("总价 $1,000 元");
  });

  it("已是间距形态则幂等：第二次运行返回 false（无空事务）", () => {
    const v = makeView("中文 English");
    expect(tidyChineseText(v)).toBe(false);
    expect(v.state.sliceDoc()).toBe("中文 English");
  });
});

describe("语法豁免（宁漏勿错）", () => {
  it("围栏代码块内整行不动（含围栏行），块外照常整理", () => {
    const v = makeView("前文abc\n```js\n中文abc不整理\n```\n后文def");
    tidyChineseText(v);
    expect(v.state.sliceDoc()).toBe("前文 abc\n```js\n中文abc不整理\n```\n后文 def");
  });

  it("行内代码（反引号区间）不动，区间外照常", () => {
    const v = makeView("前abc`中文abc`后");
    tidyChineseText(v);
    expect(v.state.sliceDoc()).toBe("前 abc`中文abc`后");
  });

  it("链接目标括号区间不动（URL 含大小写与路径），链接文字仍整理", () => {
    const v = makeView("[中文abc](https://example.com/A/b)尾注xyz");
    tidyChineseText(v);
    expect(v.state.sliceDoc()).toBe("[中文 abc](https://example.com/A/b)尾注 xyz");
  });

  it("$$ 公式行与行内 \\(…\\) 区间不动", () => {
    const v = makeView("$$中文abc$$\n说明x\\(中文abc\\)结束");
    tidyChineseText(v);
    expect(v.state.sliceDoc()).toBe("$$中文abc$$\n说明 x\\(中文abc\\)结束");
  });

  it("链接引用定义行（[label]: url）整行跳过——插空会破坏引用匹配", () => {
    const v = makeView("[标签A]: https://example.com/x\n正文标签B");
    tidyChineseText(v);
    expect(v.state.sliceDoc()).toBe("[标签A]: https://example.com/x\n正文标签 B");
  });
});

describe("范围与保真", () => {
  it("有选区只整理选区（含边界成对字符全在选区内才动）", () => {
    const v = makeView("一aaa 二bbb 三ccc");
    select(v, 7, 0); // 选区恰含「一aaa 二」：一|a 与 二|b 都在界内，bbb 之后的整理不发生
    tidyChineseText(v);
    expect(v.state.sliceDoc()).toBe("一 aaa 二 bbb 三ccc");
  });

  it("CRLF 文档（D7）：只插空格，\\r\\n 全程保真", () => {
    const v = makeView("中文abc\r\n第二行def\r\n尾行", true);
    tidyChineseText(v);
    expect(v.state.sliceDoc()).toBe("中文 abc\r\n第二行 def\r\n尾行");
    expect(v.state.doc.lines).toBe(3);
  });
});

describe("键位：Ctrl-Shift-T（真实装配路径 createDocState）", () => {
  it("keydown 命中整理命令（与工具栏 tidySpacing 同一入口）", () => {
    const v = makeView("中文english");
    select(v, 3);
    const ev = new KeyboardEvent("keydown", {
      key: "T",
      ctrlKey: true,
      shiftKey: true,
      keyCode: 84,
      bubbles: true,
      cancelable: true,
    });
    v.contentDOM.dispatchEvent(ev);
    expect(v.state.sliceDoc()).toBe("中文 english");
  });
});
