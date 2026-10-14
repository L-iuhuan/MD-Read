/**
 * fix-21 · 全格式渲染回归金样板（语料：tests/corpus/全格式矩阵.md，锚 <!-- M## -->）。
 * 断言值 = 语料设计值（探针定数后锁定）。
 * fix-22 两缺陷已修（断言已翻严）：
 *  A. `](dest "title")` 带题注的行内链接/图片：encodeLinkDestSpaces 按 CommonMark
 *     链接定义语义剥离题注（M07 带题注链接 / M08 带题注图 + 空格题注组合），title 属性如实断言。
 *  B. 多行 $$ 块：mathprotect 占位符后补等量换行，渲染文本行数与源一致，
 *     M09 之后 data-line/outline.line 不再漂移（== 真源行号）。
 * ⚠ 本文件字符串一律用「」（AGENTS.md 教训：弯引号套娃会 SyntaxError）。
 */
import { markdown } from "@codemirror/lang-markdown";
import { ensureSyntaxTree } from "@codemirror/language";
import { EditorState } from "@codemirror/state";
import { describe, expect, it } from "vitest";
import {
  TaskCheckboxWidget,
  buildLivePreviewDecorations,
  livePreview,
} from "../src/editor/live-preview";
import { renderDocument } from "../src/render/pipeline";
import corpusSrc from "./corpus/全格式矩阵.md?raw";

// fix-28：语料读入即归一 LF——检出形态随平台/core.autocrlf 漂移（autocrlf 检出 CRLF 时曾三红：
// 含 \n 的 lineOf 标记查不到 / src.indexOf 偏移 ≠ CM6 位置 / doc.toString() ≠ src）。
// 此后一切断言与定位（lineOf 标记、indexOf 偏移、LP doc 对拍）只认 LF；.gitattributes 已钉语料 LF 检出。
const src: string = corpusSrc.replace(/\r\n/g, "\n");

function parse(html: string): Document {
  return new DOMParser().parseFromString(html, "text/html");
}

/** 标记串在语料中的 1-based 真源行号（LP/编辑侧/data-line/outline.line 同口径） */
function lineOf(marker: string): number {
  const idx = src.indexOf(marker);
  expect(idx, `语料应包含标记：${marker}`).toBeGreaterThanOrEqual(0);
  return src.slice(0, idx).split("\n").length;
}

/** 按文本找段落（多匹配面下最稳的定位法，不依赖 data-line） */
function paraByText(text: string): Element {
  const el = [...doc.querySelectorAll("p")].find((p) => (p.textContent ?? "").includes(text));
  if (el === undefined) throw new Error(`语料段落缺失：${text}`);
  return el;
}

const { html, outline, fragment } = renderDocument(src);
const doc = parse(html);

describe("① 标题矩阵（M01/M02）", () => {
  it("h1-h6 计数精确等于设计值，全部带 id 与 data-line，outline 与 DOM 同源", () => {
    expect(doc.querySelectorAll("h1").length).toBe(2);
    expect(doc.querySelectorAll("h2").length).toBe(3);
    expect(doc.querySelectorAll("h3").length).toBe(2);
    expect(doc.querySelectorAll("h4").length).toBe(2);
    expect(doc.querySelectorAll("h5").length).toBe(1);
    expect(doc.querySelectorAll("h6").length).toBe(1);
    const hs = doc.querySelectorAll("h1,h2,h3,h4,h5,h6");
    expect(hs.length).toBe(11);
    for (const h of hs) {
      expect(h.id, "标题应有 CJK-safe 锚点 id").not.toBe("");
      expect(h.hasAttribute("data-line")).toBe(true);
    }
    expect(outline.length).toBe(11);
    expect(outline[0]?.level).toBe(1);
    expect(outline[0]?.text).toBe("一级标题甲");
    expect(outline[0]?.line).toBe(lineOf("# 一级标题甲"));
  });

  it("七井号成段；Setext 两式；闭合井号（空格式剥离、无空格式保留）", () => {
    expect(doc.body.textContent).toContain("####### 七个井号不是标题而是段落");
    expect([...doc.querySelectorAll("h1")].map((h) => h.textContent)).toContain("Setext 一级下划标题");
    expect([...doc.querySelectorAll("h2")].map((h) => h.textContent)).toContain("Setext 二级横线标题");
    expect([...doc.querySelectorAll("h2")].map((h) => h.textContent)).toContain("闭合井号二级");
    // 闭合 # 未前置空格 → 不是闭合序列，进正文（CommonMark 边角）
    expect([...doc.querySelectorAll("h3")].map((h) => h.textContent)).toContain("闭合井号三级无空格###");
  });
});

describe("② 段落换行三式（M03，breaks:true）", () => {
  it("软换行/双空格/反斜杠续行各产 1 个 <br>（按 data-line 定位）", () => {
    const soft = doc.querySelector(`p[data-line="${lineOf("软换行首行")}"]`);
    const hard = doc.querySelector(`p[data-line="${lineOf("双空格硬换行首行")}"]`);
    const slash = doc.querySelector(`p[data-line="${lineOf("反斜杠续行首行")}"]`);
    expect(soft?.querySelectorAll("br").length).toBe(1);
    expect(hard?.querySelectorAll("br").length).toBe(1);
    expect(slash?.querySelectorAll("br").length).toBe(1);
    expect(doc.querySelectorAll("br").length).toBe(5); // M03×3 + 懒延续×1 + 多行脚注×1
  });
});

describe("③ 强调矩阵（M04）", () => {
  it("粗/斜/粗斜/嵌套计数与字面保持", () => {
    const p1 = doc.querySelector(`p[data-line="${lineOf("**粗体样本**")}"]`);
    expect(p1?.querySelectorAll("strong").length).toBe(3); // 粗体/粗斜/粗中
    expect(p1?.querySelectorAll("em").length).toBe(3); // 斜体/粗斜外壳/嵌斜
    expect(p1?.textContent).toContain("粗中嵌斜收尾");
    const p2 = doc.querySelector(`p[data-line="${lineOf("星号字内式")}"]`);
    // 星号字内式是合法 CommonMark（下划线字内式才禁）
    expect(p2?.querySelectorAll("strong").length).toBe(1);
    expect(p2?.querySelectorAll("em").length).toBe(1);
    expect(p2?.textContent).toContain("** 前后空格 **"); // 空格式才是非法
    const p3 = doc.querySelector(`p[data-line="${lineOf("转义星号")}"]`);
    expect(p3?.textContent).toContain("*不是强调*");
    const p4 = doc.querySelector(`p[data-line="${lineOf("下划线独立式")}"]`);
    expect(p4?.querySelectorAll("em").length).toBe(1); // _单_ 独立式合法
    expect(p4?.querySelectorAll("strong").length).toBe(1); // __双__ 独立式合法
    expect(p4?.textContent).toContain("snake_case_word"); // 字内下划线保持字面
    expect(doc.querySelectorAll("strong").length).toBe(6);
    expect(doc.querySelectorAll("em").length).toBe(5);
  });
});

describe("④ 删除线（M05，markdown-it 输出 s 标签）", () => {
  it("s×2（含粗内嵌删）；空格式保持字面", () => {
    const sList = [...doc.querySelectorAll("s")];
    expect(sList.length).toBe(2);
    expect(sList[0]?.textContent).toBe("删除线文本");
    const strong = [...doc.querySelectorAll("strong")].find((e) => e.textContent?.includes("嵌删"));
    expect(strong?.querySelector("s")?.textContent).toBe("嵌删");
    expect(paraByText("空格删除").textContent).toContain("~~ 空格删除 ~~");
  });
});

describe("⑤ 行内码四式（M06）", () => {
  it("单/双/三反引号与中文，内容逐字符保持", () => {
    const p = doc.querySelector(`p[data-line="${lineOf("`单反引号`")}"]`);
    const codes = [...(p?.querySelectorAll("code") ?? [])].map((c) => c.textContent);
    expect(codes).toEqual(["单反引号", "双反引号`内嵌`双", "三反格``内嵌", "中文行内码"]);
  });
});

describe("⑥ 链接矩阵（M07）", () => {
  it("行内/引用/自动/空/中文锚/带题注（fix-22 缺陷A：题注出 title 属性）", () => {
    const links = [...doc.querySelectorAll("a")];
    expect(links.length).toBe(14); // 正文 7 + 脚注引用 3 + 脚注区回链 4
    expect(links.find((a) => a.textContent === "行内链接")?.getAttribute("href")).toBe("https://inline.example.com/docs");
    expect(links.find((a) => a.textContent === "引用式链接")?.getAttribute("href")).toBe("https://ref.example.com");
    const auto = links.find((a) => a.textContent === "https://angle.example.com");
    expect(auto?.getAttribute("href")).toBe("https://angle.example.com");
    expect(links.find((a) => a.textContent === "空链接")?.getAttribute("href")).toBe("");
    expect(links.find((a) => a.textContent === "中文锚链接")?.getAttribute("href")).toBe("#%E4%B8%AD%E6%96%87%E9%94%9A%E7%82%B9");
    const titled = links.find((a) => a.textContent === "带题注链接");
    expect(titled?.getAttribute("href")).toBe("https://title.example.com"); // 题注不再编进 href
    expect(titled?.getAttribute("title")).toBe("题注甲"); // 题注如实出 title 属性
  });
});

describe("⑦ 图片矩阵（M08）", () => {
  it("行内/引用/空格路径/嵌套；带题注与空格+题注组合（fix-22 缺陷A）", () => {
    const imgs = [...doc.querySelectorAll("img")];
    expect(imgs.length).toBe(6);
    expect(imgs[0]?.getAttribute("alt")).toBe("行内图片");
    expect(imgs[0]?.getAttribute("src")).toBe("./assets/pic-01.png");
    expect(imgs[1]?.getAttribute("src")).toBe("./assets/pic-02.png");
    expect(imgs[1]?.getAttribute("title")).toBe("引用图片题注"); // 引用定义的题注不受缺陷 A 影响
    expect(imgs[2]?.getAttribute("src")).toBe("./res/%E5%9B%BE%20%E7%94%B2.png"); // 空格→%20
    expect(imgs[3]?.getAttribute("src")).toBe("./assets/titled.png"); // 题注不再编进 src
    expect(imgs[3]?.getAttribute("title")).toBe("题注丙");
    expect(imgs[4]?.getAttribute("src")).toBe("./res/%E9%A2%98%20%E6%B3%A8.png"); // 空格路径+题注：只编码路径
    expect(imgs[4]?.getAttribute("title")).toBe("题注丁");
    const nested = imgs.find((i) => i.getAttribute("alt") === "嵌套图片ALT");
    expect(nested?.closest("a")?.getAttribute("href")).toBe("https://nested.example.com");
  });
});

describe("⑧ 代码围栏七式（M16/M24/M25/M30）", () => {
  it("pre 计数按语言精确；高亮/纯转义/缩进/嵌套/未闭合各归其位", () => {
    expect(doc.querySelectorAll("pre").length).toBe(9);
    expect(doc.querySelectorAll('pre[data-lang="ts"]').length).toBe(2);
    expect(doc.querySelectorAll('pre[data-lang="json"]').length).toBe(1);
    expect(doc.querySelectorAll('pre[data-lang="markdown"]').length).toBe(1);
    expect(doc.querySelectorAll("pre:not([data-lang])").length).toBe(4); // 无语言/波浪/引用内/制表符缩进
    expect(doc.querySelectorAll("code.hljs").length).toBe(8); // 制表符缩进块无 class
    const ts = doc.querySelector('pre[data-lang="ts"]');
    expect(ts?.querySelector("code.language-ts.hljs")).toBeTruthy();
    expect(ts?.querySelectorAll('[class^="hljs-"]').length).toBeGreaterThan(0);
    expect(ts?.textContent).toContain("**星号**"); // 围栏内标记逐字保持
    expect(ts?.textContent).toContain("$1,000");
    const plain = [...doc.querySelectorAll("pre:not([data-lang]")].find((p) => p.textContent?.includes("无语言标注"));
    expect(plain?.querySelectorAll('[class^="hljs-"]').length).toBe(0);
    const tabBlock = [...doc.querySelectorAll("pre")].find((p) => p.textContent?.includes("制表符缩进"));
    expect(tabBlock?.querySelector("code")?.getAttribute("class")).toBe(null); // 缩进代码块零 class
    expect(doc.querySelectorAll("blockquote pre").length).toBe(1); // 引用内围栏
    const md = doc.querySelector('pre[data-lang="markdown"]');
    expect(md?.textContent).toContain("```嵌套内层围栏"); // 四反引号嵌套三反引号
    const unclosed = doc.querySelector('pre[data-lang="末行无闭合"]');
    expect(unclosed?.textContent).toBe("未闭合围栏内容甲\n未闭合围栏内容乙\n");
  });
});

describe("⑨ 数学九变体（M09）", () => {
  it("display×6 / inline×3 / CJK 降级×2，零裸 $$ 零裸 \\[", () => {
    expect(doc.querySelectorAll(".katex-display").length).toBe(6);
    expect(doc.querySelectorAll(".katex").length).toBe(9);
    expect(doc.querySelectorAll(".katex-display .katex").length).toBe(6);
    expect(doc.querySelectorAll(".math-fallback").length).toBe(2);
    expect(doc.querySelectorAll(".math-fallback--display").length).toBe(1);
    const katexText = [...doc.querySelectorAll(".katex")].map((e) => e.textContent ?? "").join("");
    for (const probe of ["E = m c^2", "s = ut", "aligned", "dfrac", "x_i^2", "a^{n}_{m}", "Q = P", "int_0^1", "blank line upper", "blank line lower"]) {
      expect(katexText.includes(probe), `KaTeX 应含 ${probe}`).toBe(true);
    }
    const fallbackText = [...doc.querySelectorAll(".math-fallback")].map((e) => e.textContent ?? "").join("");
    expect(fallbackText).toContain("中文混排总量");
    expect(fallbackText).toContain("行内中文伪公式");
    // 零裸定界符：pre/code 与 katex/math-fallback 之外的文本节点不得残留 $$ 与 \[
    const walker = doc.createTreeWalker(doc.body, NodeFilter.SHOW_TEXT, {
      acceptNode(node: Node): number {
        for (let el = node.parentElement; el !== null; el = el.parentElement) {
          const tag = el.tagName.toLowerCase();
          if (tag === "pre" || tag === "code") return NodeFilter.FILTER_REJECT;
          if (el.classList.contains("katex") || el.classList.contains("math-fallback")) return NodeFilter.FILTER_REJECT;
        }
        return NodeFilter.FILTER_ACCEPT;
      },
    });
    let visible = "";
    for (let n = walker.nextNode(); n !== null; n = walker.nextNode()) visible += n.textContent ?? "";
    expect(visible.includes("$$"), "正文不得残留裸 $$").toBe(false);
    expect(visible.includes("\\["), "正文不得残留裸 \\[").toBe(false);
  });
});

describe("⑩ 金额红线（M10）", () => {
  it("金额串全字面；不进 katex；货币与数字间无 cjk-gap", () => {
    const p = paraByText("12,345.67");
    expect(p.textContent).toContain("$1,000 与 $2,000");
    expect(p.textContent).toContain("¥12,345.67");
    expect(p.textContent).toContain("裸 $x$ 与 $ y $ 都不是公式");
    const katexText = [...doc.querySelectorAll(".katex")].map((e) => e.textContent ?? "").join("");
    expect(katexText.includes("$1,000")).toBe(false);
    expect(katexText.includes("12,345")).toBe(false);
    const currency = "$¥€£＄￥";
    for (const gap of doc.querySelectorAll(".cjk-gap")) {
      const prevSib = gap.previousSibling;
      const nextSib = gap.nextSibling;
      const prev = prevSib !== null && prevSib.nodeType === 3 ? (prevSib.textContent ?? "").slice(-1) : "";
      const next = nextSib !== null && nextSib.nodeType === 3 ? (nextSib.textContent ?? "")[0] ?? "" : "";
      expect(currency.includes(prev) && /[0-9]/.test(next)).toBe(false);
      expect(/[0-9]/.test(prev) && currency.includes(next)).toBe(false);
    }
  });
});

describe("⑪ 表格五式（M11-M14）", () => {
  it("五表五包裹；对齐三式；管道转义；八列；无表体；单行不成表", () => {
    expect(doc.querySelectorAll("table").length).toBe(5);
    expect(doc.querySelectorAll(".table-wrap").length).toBe(5);
    expect(fragment.querySelectorAll(".table-wrap").length).toBe(5); // fragment 路径同源
    for (const t of doc.querySelectorAll("table")) {
      expect(t.parentElement?.classList.contains("table-wrap")).toBe(true);
    }
    expect(doc.querySelectorAll("tbody tr").length).toBe(5);
    const aligns = [...doc.querySelectorAll("table")[1]?.querySelectorAll("th") ?? []].map((c) => c.getAttribute("style"));
    expect(aligns).toEqual(["text-align:left", "text-align:center", "text-align:right"]);
    const cells = [...doc.querySelectorAll("table")[2]?.querySelectorAll("th, td") ?? []].map((c) => c.textContent);
    expect(cells).toEqual(["名称 | 别名", "数值", "含竖线 | 甲", "$1,000"]);
    expect(doc.querySelectorAll("table")[3]?.querySelectorAll("th").length).toBe(8);
    const noBody = doc.querySelectorAll("table")[4];
    expect(noBody?.querySelector("thead th")?.textContent).toBe("无表体列");
    expect(noBody?.querySelector("tbody")).toBe(null);
    expect(doc.body.textContent).toContain("| 无表头体孤行不是表 |"); // 单行不成表，出字面
  });
});

describe("⑫ 列表矩阵（M15）", () => {
  it("无序/有序两式/任务三态/三层嵌套/懒延续", () => {
    expect(doc.querySelectorAll("ul").length).toBe(5); // 无序+二层+三层+任务+懒延续
    expect(doc.querySelectorAll("ol").length).toBe(3); // 句点+括号+脚注列表
    expect(doc.querySelectorAll("li").length).toBe(15);
    expect(doc.querySelectorAll("li ul li ul li").length).toBe(1); // 三层嵌套
    const boxes = [...doc.querySelectorAll('input[type="checkbox"]')];
    expect(boxes.length).toBe(3);
    expect(boxes.filter((b) => (b as HTMLInputElement).checked).length).toBe(1);
    for (const b of boxes) expect(b.hasAttribute("disabled")).toBe(true);
    const lazy = paraByText("懒延续项首行");
    expect(lazy.parentElement?.tagName).toBe("LI");
    expect(lazy.querySelectorAll("br").length).toBe(1); // 懒延续并入同段
  });
});

describe("⑬ 引用与 Alert（M16/M19）", () => {
  it("blockquote×10；Alert 五类各就位且标记剥除；引用内标题/列表/围栏/公式全通", () => {
    expect(doc.querySelectorAll("blockquote").length).toBe(10);
    expect(doc.querySelectorAll("blockquote.alert").length).toBe(5);
    expect([...doc.querySelectorAll("[data-alert]")].map((e) => e.getAttribute("data-alert"))).toEqual([
      "note", "tip", "important", "warning", "caution",
    ]);
    expect(doc.body.textContent).not.toContain("[!NOTE]");
    expect(paraByText("备注类提示正文").textContent).toBe("备注类提示正文");
    const h4 = [...doc.querySelectorAll("h4")].find((h) => h.textContent === "引用内标题丁");
    expect(h4?.closest("blockquote")).toBeTruthy();
    expect([...doc.querySelectorAll(".katex")].some((k) => k.closest("blockquote") !== null)).toBe(true);
    // fix-22 缺陷B 已修：占位符保行数，outline.line == 真源行号（不再偏小 11）
    const trueLine = lineOf("> #### 引用内标题丁");
    expect(outline[10]?.line).toBe(trueLine);
  });
});

describe("⑭ hr/脚注/emoji（M17/M18/M20）", () => {
  it("hr 三式+脚注分隔线；脚注引用×3、条目×2、多行体保真", () => {
    expect(doc.querySelectorAll("hr").length).toBe(4);
    expect(doc.querySelectorAll("hr.footnotes-sep").length).toBe(1);
    expect(doc.querySelectorAll(".footnote-ref").length).toBe(3);
    expect(doc.querySelectorAll("section.footnotes").length).toBe(1);
    const items = [...doc.querySelectorAll(".footnote-item")];
    expect(items.length).toBe(2);
    expect(items[1]?.textContent).toContain("多行脚注正文乙首行");
    expect(items[1]?.textContent).toContain("缩进续行属于脚注乙。");
  });

  it("emoji 短码/快捷/原生渲染，未收录保持字面", () => {
    const text = doc.body.textContent ?? "";
    expect(text).toContain("🔥");
    expect(text).toContain("🎉");
    expect(text).toContain("😄");
    expect(text).toContain("😀");
    expect(text).toContain(":not_in_table:");
    expect(text).not.toContain(":fire:");
  });
});

describe("⑮ HTML 转义与实体（M21/M22）", () => {
  it("XSS 三例全绿：html:false + DOMPurify；实体解码；未命名实体字面", () => {
    expect(doc.querySelectorAll("script").length).toBe(0);
    expect(html.toLowerCase()).not.toContain("<script");
    expect(doc.querySelectorAll("[onerror],[onload],[onclick]").length).toBe(0);
    const text = doc.body.textContent ?? "";
    expect(text).toContain("<div>块级标签一律转义成文本</div>");
    expect(text).toContain('<span style="color:red">红字片段</span>');
    expect(text).toContain("<b>加粗标签</b>");
    const ent = paraByText("版权");
    expect(ent.textContent).toContain("版权 © 与字母 A 与汉字 中 与未命名 &madeup; 出字面。");
  });
});

describe("⑯ CJK 排版（M23）", () => {
  it("长 token 断行×2；cjk-gap×12 全空 span；中西混排插空", () => {
    const toks = [...doc.querySelectorAll(".tok-break")].map((e) => e.textContent ?? "");
    expect(toks).toContain("super_long_identifier_name_abcdefghij");
    expect(toks).toContain("transform_request_id_20260921");
    expect(doc.querySelectorAll(".tok-break").length).toBe(2);
    const gaps = doc.querySelectorAll(".cjk-gap");
    expect(gaps.length).toBe(12);
    for (const g of gaps) {
      expect(g.textContent).toBe("");
      expect(g.childNodes.length).toBe(0);
    }
  });
});

describe("⑰ 边角与确定性（M24/M30 + 空文档）", () => {
  it("超长行完整；空/纯空白文档零产出；渲染确定性；占位符零残留", () => {
    const long = paraByText("超长行压力测试");
    expect((long.textContent ?? "").length).toBeGreaterThanOrEqual(120);
    const empty = renderDocument("");
    expect(empty.html).toBe("");
    expect(empty.outline.length).toBe(0);
    expect(empty.fragment.childNodes.length).toBe(0);
    expect(renderDocument("   \n\n").html).toBe("");
    expect(renderDocument(src).html).toBe(html); // 确定性
    const off = renderDocument(src, { pangu: false });
    expect(parse(off.html).body.textContent).toBe(doc.body.textContent); // pangu 不改字节
    expect(html).not.toContain("MoDuMathGuard");
    expect(off.html).not.toContain("MoDuMathGuard");
    const box = document.createElement("div");
    box.append(...Array.from(fragment.childNodes).map((n) => n.cloneNode(true)));
    expect(box.innerHTML).toBe(html); // fragment 与惰性 html 逐字节等价
  });
});

/* ---------- Live Preview：同语料，每类型行「渲染/豁免」（EditorState 即可，无 DOM 挂载） ---------- */
interface DecoInfo {
  from: number;
  to: number;
  cls?: string;
  task?: { checked: boolean };
}

const lpState = EditorState.create({ doc: src, extensions: [markdown(), livePreview()] });
ensureSyntaxTree(lpState, lpState.doc.length, 20000);

/** 光标停 cursorLine 行时的全文档装饰集（豁免区间 = 光标行） */
function decosAt(cursorLine: number): DecoInfo[] {
  const line = lpState.doc.line(cursorLine);
  const state = lpState.update({ selection: { anchor: line.from } }).state;
  const out: DecoInfo[] = [];
  buildLivePreviewDecorations(state, [{ from: 0, to: state.doc.length }]).between(
    0,
    state.doc.length,
    (from, to, deco) => {
      const widget = deco.spec.widget;
      out.push({
        from,
        to,
        cls: deco.spec.class,
        task: widget instanceof TaskCheckboxWidget ? { checked: widget.checked } : undefined,
      });
    },
  );
  return out;
}

const inLine = (d: DecoInfo, line: { from: number; to: number }): boolean => d.from >= line.from && d.to <= line.to;
const anyInLine = (decos: DecoInfo[], line: { from: number; to: number }): boolean => decos.some((d) => inLine(d, line));
const clsInLine = (decos: DecoInfo[], line: { from: number; to: number }, cls: string): boolean =>
  decos.some((d) => d.cls === cls && inLine(d, line));

describe("⑱ Live Preview 同语料（commonmark 装配形态）", () => {
  it("渲染类：标题/粗/行内码/链接/引用/任务各有装饰，标记隐藏", () => {
    const L = (n: number) => lpState.doc.line(n);
    const decos = decosAt(lineOf("预算 $1,000")); // 光标停无标记的金额行
    expect(clsInLine(decos, L(lineOf("# 一级标题甲")), "cm-lp-h1")).toBe(true);
    const h1 = L(lineOf("# 一级标题甲"));
    expect(decos.some((d) => d.from === h1.from && d.to === h1.from + 2 && d.cls === undefined)).toBe(true); // 「# 」隐藏
    expect(clsInLine(decos, L(lineOf("**粗体样本**")), "cm-lp-strong")).toBe(true);
    expect(clsInLine(decos, L(lineOf("`单反引号`")), "cm-lp-code")).toBe(true);
    expect(clsInLine(decos, L(lineOf("[行内链接]")), "cm-lp-link")).toBe(true);
    const urlAt = src.indexOf("https://inline.example.com");
    expect(decos.some((d) => d.from === urlAt && d.cls === undefined)).toBe(true); // URL 隐藏
    expect(clsInLine(decos, L(lineOf("> 单层引用一行")), "cm-lp-quote")).toBe(true);
    const q = L(lineOf("> 单层引用一行"));
    expect(decos.some((d) => d.from === q.from && d.to === q.from + 2 && d.cls === undefined)).toBe(true); // 「> 」隐藏
    const tasks = decos.filter((d) => d.task !== undefined);
    expect(tasks.filter((t) => inLine(t, L(lineOf("- [ ] 未完成任务甲"))) && t.task?.checked === false).length).toBe(1);
    expect(tasks.filter((t) => inLine(t, L(lineOf("- [x] 已完成任务乙"))) && t.task?.checked === true).length).toBe(1);
  });

  it("豁免类：代码/表格/数学/HTML/hr/setext/图片行零装饰", () => {
    const L = (n: number) => lpState.doc.line(n);
    const decos = decosAt(lineOf("预算 $1,000"));
    const exempt = [
      "```ts", "const s = \"含", "```json", "```末行无闭合", // 围栏
      "| 列甲 |", "| 甲一 |", "| C1 | C2", // 表格
      "$$\nE = m c^2", "E = m c^2", "方括号显示式", // 数学段（$$ 起段守卫）
      "<!-- M01", "<div>块级标签", "<script>alert('块级脚本')", // HTML 块
      "***\n", "___", "Setext 一级下划标题", "===================", // hr 与 setext 整块
      "![行内图片]", // 图片
    ];
    for (const m of exempt) {
      expect(anyInLine(decos, L(lineOf(m))), `该行应零装饰：${m}`).toBe(false);
    }
  });

  it("光标行退场：移入即退；源码保真", () => {
    const strongLine = lpState.doc.line(lineOf("**粗体样本**"));
    const outside = decosAt(lineOf("预算 $1,000"));
    expect(outside.some((d) => inLine(d, strongLine) && d.cls === "cm-lp-strong")).toBe(true); // 前置：该行在渲染
    const inside = decosAt(lineOf("**粗体样本**"));
    expect(anyInLine(inside, strongLine)).toBe(false); // 光标行零装饰
    expect(inside.length).toBeGreaterThan(0); // 其他行照常
    expect(lpState.doc.toString()).toBe(src); // 装饰不改字节
  });
});
