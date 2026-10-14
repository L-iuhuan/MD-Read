/**
 * 语料审查 · 对抗形态（语料：tests/corpus/对抗形态.md）。
 * 断言 = 设计值（未闭合定界符保持字面、三层嵌套结构、长 token 断行、金额红线、
 * KaTeX 三定界符各归其位、末行未闭合围栏归位）。
 * 三个原「已知缺陷」（M1/M2/M3）已于 2026-10-13 修复批次修掉，原 skip 已翻成正式回归锚。
 */
import { describe, expect, it } from "vitest";
import { renderDocument } from "../src/render/pipeline";
import corpusSrc from "./corpus/对抗形态.md?raw";

const src = corpusSrc.replace(/\r\n/g, "\n");
const doc = new DOMParser().parseFromString(renderDocument(src).html, "text/html");
const q = (sel: string): Element[] => [...doc.querySelectorAll(sel)];
const text = (): string => doc.body.textContent ?? "";

describe("AD 未闭合定界符", () => {
  it("孤立 * / ** / ~~ / [ / ( 一律保持字面，不吞正文不成块", () => {
    expect(text()).toContain("*孤立一个");
    expect(text()).toContain("**孤立两个");
    expect(text()).toContain("***孤立三个");
    expect(text()).toContain("~~孤立两个");
    expect(text()).toContain("[孤立与未闭合圆括号 (孤立");
    expect(q("s").length).toBe(1); // 只有 AD07 表格里的 ~~删~~
  });
});

describe("AD 三层嵌套", () => {
  it("列表四层 / 引用三层 / 引用内列表嵌套结构成立；强调三层嵌套产 em+strong", () => {
    expect(q("ul ul ul").length).toBeGreaterThanOrEqual(1);
    expect(q("blockquote blockquote blockquote").length).toBe(1);
    expect(q("blockquote ol ul").length).toBe(1);
    expect(q("em strong").length).toBeGreaterThanOrEqual(1); // ***粗斜内 *再斜* 再粗***
  });
});

describe("AD 超长 token 与金额", () => {
  it("4 个超长串包 .tok-break；金额与短标识符不受影响", () => {
    expect(q(".tok-break").map((s) => s.textContent)).toEqual([
      "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789_-abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789",
      "segment-abcdefghijklmnopqrstuvwxyz0123456789",
      "another-very-long-segment-0123456789",
      "abcdefghijklmnopqrstuvwxyz",
    ]);
    expect(text()).toContain("$1,000 与 $2,000");
    expect(text()).toContain("¥12,345.67");
    expect(text()).toContain("$x$");
    expect(text()).toContain("100$ 与 $");
  });
});

describe("AD 公式：纯 CJK 降级 / 混合定界符", () => {
  it("纯 CJK 块级公式降级 .math-fallback--display，无 KaTeX 伪排版", () => {
    const fb = q(".math-fallback--display");
    expect(fb.length).toBe(1);
    expect(fb[0]?.textContent).toContain("中文公式总量");
    expect(fb[0]?.querySelectorAll(".katex").length).toBe(0);
  });

  it("同一行混合 \\(..\\) / $$..$$ / \\[..\\] 三定界符各自归位，裸 $g+h$ 字面", () => {
    const p = q("p").find((el) => el.textContent?.startsWith("混合"));
    expect(p).toBeTruthy();
    expect(p?.querySelectorAll(".katex-display").length).toBe(2); // $$c+d$$ 与 \[e+f\]
    expect(p?.querySelectorAll(".katex").length).toBe(3); // \(a+b\) + 两个 display
    expect(p?.querySelectorAll(".math-fallback").length).toBe(1); // \(中文\) 走 CJK 降级
    expect(p?.textContent).toContain("$g+h$");
  });
});

describe("AD 表格单元格内行内元素与容器", () => {
  it("单元格内粗/斜/删/码/链接/脚注引用均按行内规则渲染；HTML 转义", () => {
    const table = q("table")[0];
    expect(table?.querySelectorAll("strong, em, s").length).toBe(3);
    expect(table?.querySelectorAll("code").length).toBeGreaterThanOrEqual(1);
    expect(table?.querySelectorAll("a").length).toBeGreaterThanOrEqual(1);
    expect(table?.querySelectorAll(".footnote-ref").length).toBe(1);
    expect(text()).toContain("<b>不粗</b>");
  });
});

describe("AD 图片与末行未闭合围栏", () => {
  it("图片 alt/src 正确；末行未闭合围栏归位 pre[data-lang]", () => {
    const img = q("img")[0];
    expect(img?.getAttribute("alt")).toBe("替代文字");
    expect(img?.getAttribute("src")).toBe("https://adv.example.com/pic.png");
    const pre = q('pre[data-lang="末行无闭合对抗"]')[0];
    expect(pre?.textContent).toBe("未闭合围栏内容甲\n未闭合围栏内容乙\n");
  });
});

describe("原已知缺陷 M1/M2/M3 的回归锚（2026-10-13 已修，skip 已撤）", () => {
  it("缺陷-1（fix, 已修）（Lead 已确认）：源文无 \\( 或 \\[ 时多行 $$ 整段不渲染", () => {
    const d = new DOMParser().parseFromString(renderDocument("$$\nE = mc^2\n$$\n").html, "text/html");
    expect(d.querySelectorAll(".katex-display").length).toBe(1);
  });

  it("缺陷-2（fix, 已修）（本轮新增）：跨空行的孤立反引号不应配对成代码区间吞掉行内公式", () => {
    const s = "段落甲有孤立反引号 `\n\n中间行内公式 \\(x^2\\) 应渲染成 KaTeX。\n\n段落乙有孤立反引号 `\n";
    const d = new DOMParser().parseFromString(renderDocument(s).html, "text/html");
    expect(d.querySelectorAll(".katex").length).toBe(1);
  });

  it("缺陷-3（fix, 已修）（本轮新增）：未闭合 \\( 之后的独立 \\[...\\] 应渲染", () => {
    const s = "未闭合公式 \\( 没有结束符\n\n显示式 \\[e+f\\] 应当渲染成 KaTeX。\n";
    const d = new DOMParser().parseFromString(renderDocument(s).html, "text/html");
    expect(d.querySelectorAll(".katex-display").length).toBe(1);
  });
});