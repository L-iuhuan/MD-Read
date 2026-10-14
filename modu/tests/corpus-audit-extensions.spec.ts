/**
 * 语料审查 · 项目扩展（语料：tests/corpus/项目扩展.md）。
 * 覆盖：脚注 / emoji 短码 / GFM Alert / KaTeX 三定界符 / Mermaid / 锚点 /
 * pangu 中西插空 / tok-break / hljs 语言集。
 * 断言 = 设计值（规格 §4 F2/F3、D2 金额红线、tokens 语言集），非照抄当前输出。
 */
import { describe, expect, it } from "vitest";
import { renderDocument } from "../src/render/pipeline";
import corpusSrc from "./corpus/项目扩展.md?raw";

const src = corpusSrc.replace(/\r\n/g, "\n");
const doc = new DOMParser().parseFromString(renderDocument(src).html, "text/html");
const q = (sel: string): Element[] => [...doc.querySelectorAll(sel)];
const text = (): string => doc.body.textContent ?? "";

describe("扩展: 脚注", () => {
  it("4 引用（含一次复引 + 一条内联）/ 3 条目 / 1 脚注区", () => {
    expect(q(".footnote-ref").length).toBe(4);
    expect(q(".footnote-item").length).toBe(3);
    expect(q("section.footnotes").length).toBe(1);
    expect(text()).toContain("↩︎");
  });
});

describe("扩展: emoji 短码子集", () => {
  it("收录短码与快捷转 emoji；未收录与行内码保持字面", () => {
    for (const glyph of ["🔥", "🎉", "👍", "💯", "😍", "😄", "😉", "❤️"]) {
      expect(text()).toContain(glyph);
    }
    expect(text()).toContain(":not_in_table:");
    expect(text()).toContain(":smile_cat:");
    expect(q("code").some((c) => c.textContent === ":fire:")).toBe(true);
  });
});

describe("扩展: GFM Alert", () => {
  it("5 类白名单各成一类；小写 / 未知 / 非首行 / 普通引用不识别", () => {
    expect(q("blockquote[data-alert]").map((b) => b.getAttribute("data-alert")))
      .toEqual(["note", "tip", "important", "warning", "caution"]);
    expect(q("blockquote").length).toBe(8);
    expect(q("blockquote:not([data-alert])").length).toBe(3);
  });
});

describe("扩展: KaTeX 三定界符 + 金额红线", () => {
  it("display 3 / inline 与 fallback 计数按设计；金额与裸 $ 全程字面且不进 KaTeX", () => {
    expect(q(".katex-display").length).toBe(3);
    expect(q(".katex").length).toBe(4);
    expect(q(".math-fallback").length).toBe(2);
    expect(q(".math-fallback--display").length).toBe(1);
    expect(text()).toContain("$1,000 与 $2,000");
    expect(text()).toContain("¥12,345.67");
    expect(text()).toContain("未闭合 $$ 到行尾保持字面");
    const amountP = q("p").find((p) => p.textContent?.includes("金额红线"));
    expect(amountP?.querySelectorAll(".katex").length).toBe(0);
  });
});

describe("扩展: Mermaid / 锚点", () => {
  it("2 个 div.mermaid（源码态，未注入 SVG）且文本为图定义", () => {
    expect(q("div.mermaid").length).toBe(2);
    expect(q("div.mermaid").some((m) => m.textContent?.includes("graph TD"))).toBe(true);
  });

  it("重复标题锚点去重 -1；CJK/标点 slug 保留可跳转 id", () => {
    expect(q("h2").map((h) => h.id)).toEqual([
      "重复标题", "重复标题-1", "含标点空格的-标题感叹", "english-heading-with-spaces",
    ]);
    expect(q("a").some((a) => a.getAttribute("href") === "#%E9%87%8D%E5%A4%8D%E6%A0%87%E9%A2%98")).toBe(true);
  });
});

describe("扩展: pangu 中西插空", () => {
  it("空 span.cjk-gap 只加在 CJK↔拉丁/货币边界；货币贴数字、code/链接内不插", () => {
    expect(q(".cjk-gap").length).toBe(11);
    const p = q("p").find((el) => el.textContent?.includes("使用TypeScript编写代码"));
    const gaps = [...(p?.querySelectorAll(".cjk-gap") ?? [])] as HTMLElement[];
    expect(gaps.length).toBeGreaterThan(0);
    // 空 span 不贡献字符：textContent 与源文逐字一致
    expect(p?.textContent).toBe("使用TypeScript编写代码，2026年Q3财报与AI大模型GPU集群评测。");
    const code = q("code").find((c) => c.textContent === "中文code混排");
    expect(code?.querySelectorAll(".cjk-gap").length).toBe(0);
    const money = q("p").find((el) => el.textContent?.includes("¥12,345.67"));
    const moneyGaps = money?.querySelectorAll(".cjk-gap").length ?? -1;
    expect(moneyGaps).toBe(0); // ¥ 与数字之间不得插空
  });
});

describe("扩展: tok-break 长串断行", () => {
  it(">=16 位 [A-Za-z0-9_-] 才包裹；金额不被包裹", () => {
    expect(q(".tok-break").map((s) => s.textContent)).toEqual([
      "transform_request", "transform_request_id_20260921", "super_long_identifier_name-abcdefghij",
    ]);
    const money = q("p").find((el) => el.textContent?.includes("1,234,567.89"));
    expect(money?.querySelectorAll(".tok-break").length).toBe(0);
  });
});

describe("扩展: hljs 语言集", () => {
  it("21 个围栏；20 个注册语言各出 hljs-* span；未注册语言零高亮；别名 ts 归一", () => {
    expect(q("pre").length).toBe(21);
    expect(q("code.hljs").length).toBe(21);
    const registered = ["ts", "js", "python", "rust", "sql", "json", "yaml", "bash", "go", "java",
      "cpp", "c", "csharp", "kotlin", "php", "ini", "diff", "html", "css", "markdown"];
    for (const lang of registered) {
      const pre = q(`pre[data-lang="${lang}"]`)[0];
      expect(pre, `围栏 ${lang} 缺失`).toBeTruthy();
      expect(pre?.querySelectorAll("[class^=hljs-]").length, `${lang} 应有高亮 span`).toBeGreaterThan(0);
    }
    const unknown = q('pre[data-lang="unknownlang"]')[0];
    expect(unknown?.querySelectorAll("[class^=hljs-]").length).toBe(0);
    expect(unknown?.querySelector("code.hljs")).toBeTruthy();
    expect(q("code.language-ts.hljs").length).toBeGreaterThan(0);
  });
});