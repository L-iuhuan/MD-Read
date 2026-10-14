/**
 * 验收语料自检（2026-10-13）。
 *
 * 语料在仓库根的 docs/验收/ 下（应用要能直接打开它）。本 spec 的作用是：
 * **把语料里写给主人看的每一条「✅ 期望」变成断言** —— 这样主人在真机上只需核对外观，
 * 万一看到不符，就能区分「渲染回归了」与「我期望写错了」。
 *
 * 覆盖：主验收语料（docs/验收/2026-10-13-渲染修复验收语料.md）+ 6 个隔离用例。
 * 隔离用例存在的理由：主语料含反斜杠行内公式，会整篇走「已有反斜杠定界符」分支，
 * 绕开部分缺陷的触发条件（详见语料末节）。
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { renderDocument } from "../src/render/pipeline";

const DIR = "../docs/验收";
const ISO = DIR + "/隔离用例";

function dom(src: string): Document {
  return new DOMParser().parseFromString(renderDocument(src).html, "text/html");
}
function read(path: string): string {
  return readFileSync(path, "utf8").replace(/\r\n/g, "\n");
}
function text(doc: Document): string {
  return doc.body.textContent ?? "";
}
const q = (doc: Document, sel: string): Element[] => [...doc.querySelectorAll(sel)];

const main = dom(read(DIR + "/2026-10-13-渲染修复验收语料.md"));

describe("主验收语料：A 公式", () => {
  it("多行 / 对齐 / 方括号显示式都出 KaTeX 显示公式", () => {
    expect(q(main, ".katex-display").length).toBeGreaterThanOrEqual(4);
  });
  it("含空行的公式块也在（不是被空行断成两段）", () => {
    // A2 的两块各自成一个显示公式
    const anns = q(main, "annotation").map((a) => a.textContent ?? "");
    expect(anns.some((a) => a.includes("b = 2 + a"))).toBe(true);
    expect(anns.some((a) => a.includes("aligned"))).toBe(true);
  });
  it("纯中文公式走 .math-fallback--display（有意降级）", () => {
    expect(q(main, ".math-fallback--display").length).toBe(1);
  });
  it("金额红线：三串金额保持纯文本、未进 KaTeX", () => {
    expect(text(main)).toContain("$1,000 与 $2,000");
    expect(text(main)).toContain("¥12,345.67");
    expect(text(main)).toContain("裸 $x$ 与 $ y $ 都不是公式");
    const katexText = q(main, ".katex").map((e) => e.textContent ?? "").join("");
    expect(katexText.includes("1,000")).toBe(false);
  });
});

describe("主验收语料：B 结构不被吞", () => {
  it("B1 两个 shell 围栏各成块，中间与结尾段落都在", () => {
    const pre = q(main, "pre").map((p) => p.textContent ?? "");
    expect(pre.filter((p) => p.includes("echo $$")).length).toBe(2);
    expect(text(main)).toContain("中间段落：这一行必须看得见。");
    expect(text(main)).toContain("结尾段落：这一行也必须看得见。");
    // 围栏线不得被吞进代码内容
    for (const p of pre) expect(p.includes("```")).toBe(false);
  });
  it("B2 教写法的围栏原样三行", () => {
    const pre = q(main, "pre").map((p) => p.textContent ?? "");
    const teach = pre.find((p) => p.includes("E = mc^2"));
    expect(teach).toBe("$$\nE = mc^2\n$$\n");
  });
  it("B4 正文两个裸定界符保持字面、小标题仍是标题", () => {
    expect(text(main)).toContain("价格 $$ 折扣甲");
    expect(text(main)).toContain("再 $$ 一次");
    const h4 = q(main, "h4").map((h) => h.textContent ?? "");
    expect(h4).toContain("这行小标题必须还是标题");
  });
});

describe("主验收语料：C/D/E/F/G", () => {
  it("C 自动链接：www 成链，文件名/邮箱不成链，且绝不出现 punycode", () => {
    const hrefs = q(main, "a").map((a) => a.getAttribute("href") ?? "");
    expect(hrefs.filter((h) => h.startsWith("http://www.example.com")).length).toBe(2);
    expect(hrefs.some((h) => h.includes("xn--"))).toBe(false);
    const labels = q(main, "a").map((a) => a.textContent ?? "");
    for (const name of ["笔记.md", "README.md", "build.sh", "main.py", "archive.zip", "a.example.com", "me@example.com"]) {
      expect(labels).not.toContain(name);
      expect(text(main)).toContain(name); // 仍在正文里，只是不成链
    }
  });
  it("D1 被引用的脚注进文末脚注区", () => {
    expect(q(main, ".footnote-ref").length).toBe(1);
    expect(q(main, "section.footnotes .footnote-item").length).toBe(1);
  });
  it("D2 未被引用的脚注定义留在原位成段（不消失）", () => {
    const paras = q(main, "p").filter((p) => p.closest("section.footnotes") === null);
    expect(paras.some((p) => (p.textContent ?? "").includes("没有被任何地方引用过"))).toBe(true);
    // 那条定义不得同时出现在脚注区
    expect(q(main, "section.footnotes").map((s) => s.textContent ?? "").join("")).not.toContain("没有被任何地方引用过");
  });
  it("E 规范行为实物：2. 开头不成列表、--- 成 Setext 标题、懒延续并入", () => {
    expect(text(main)).toContain("段落丙\n2. 这行应当并进段落丙，不成为列表");
    expect(q(main, "h2").map((h) => h.textContent ?? "")).toContain("段落戊");
    const li = q(main, "li").map((l) => l.textContent ?? "");
    expect(li.some((l) => l.includes("列表项甲") && l.includes("这行文字应当并进上面的列表项"))).toBe(true);
  });
  it("F 长技术串被 .tok-break 包裹；金额串不被包裹", () => {
    const toks = q(main, ".tok-break").map((t) => t.textContent ?? "");
    expect(toks).toContain("transform_request_id_20260921");
    expect(toks).toContain("super_long_identifier_name_abcdefghij");
    expect(toks.some((t) => t.includes("1,000"))).toBe(false);
  });
  it("G 编辑态操练区：两个任务项、缩进标题、公式与粗体同段", () => {
    expect(q(main, ".task-list-item").length).toBe(2);
    expect(q(main, ".task-list-item input[type=checkbox]").length).toBe(2);
    const inline = q(main, "p").find((p) => (p.textContent ?? "").includes("与 粗体 同一段"));
    expect(inline, "G 节那段「公式 + 粗体」应存在").toBeTruthy();
    expect(inline?.querySelector("strong")?.textContent).toBe("粗体");
    expect(inline?.querySelector(".katex")).toBeTruthy();
  });
});

describe("隔离用例（每个文件一个用例）", () => {
  it("① 只有多行公式的文档 ⇒ 出显示公式、正文零裸定界符", () => {
    const doc = dom(read(ISO + "/01-多行公式-无其他定界符.md"));
    expect(q(doc, ".katex-display").length).toBe(1);
    expect(text(doc)).not.toContain("$$");
  });
  it("② 两个围栏各含 PID 变量 ⇒ 结构完整", () => {
    const doc = dom(read(ISO + "/02-代码围栏含echo-dollar-dollar.md"));
    const pre = q(doc, "pre").map((p) => p.textContent ?? "");
    expect(pre.filter((p) => p.includes("echo $$")).length).toBe(2);
    expect(text(doc)).toContain("中间段落：这一行必须看得见。");
    expect(text(doc)).toContain("结尾段落：这一行也必须看得见。");
  });
  it("③ 宽松多行写法 ⇒ 两处都成显示公式", () => {
    const doc = dom(read(ISO + "/03-宽松多行公式.md"));
    expect(q(doc, ".katex-display").length).toBe(2);
    expect(text(doc)).not.toContain("$$");
  });
  it("④ 未引用的脚注定义 ⇒ 成普通段落", () => {
    const doc = dom(read(ISO + "/04-未引用脚注定义.md"));
    expect(q(doc, "section.footnotes").length).toBe(0);
    expect(q(doc, "p").some((p) => (p.textContent ?? "").includes("没有被任何地方引用"))).toBe(true);
  });
  it("⑤ 自动链接 ⇒ www 成链、文件名不成链", () => {
    const doc = dom(read(ISO + "/05-自动链接.md"));
    const hrefs = q(doc, "a").map((a) => a.getAttribute("href") ?? "");
    expect(hrefs).toEqual(["http://www.example.com"]);
    expect(text(doc)).toContain("笔记.md");
  });
  it("⑥ 编辑态操练区 ⇒ 内容与任务项就位", () => {
    const doc = dom(read(ISO + "/06-编辑态实操.md"));
    expect(q(doc, ".task-list-item").length).toBe(2);
    expect(q(doc, "pre").map((p) => p.textContent ?? "").some((t) => t.includes("代码里的 - [ ] 不该被插入标记"))).toBe(true);
  });
});