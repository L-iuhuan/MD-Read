/**
 * render-audit 波次：link-dest 上下文免疫 + 误改写修复锚。
 *
 * 审查实测（最小输入 → 实际输出）：
 * 1) `> ``` / > code ](a b.md) / > ``` ` 的代码内容被编成 `](a%20b.md)`
 *    —— 围栏检测只认行首 ≤3 空格，没剥 `>` 引用前缀；
 * 2) 4 空格缩进代码块里的 `code ](a b.md)` 同样被改写；
 * 3) 正文里的字面 `](a b)`（前面没有 `[`，根本不是链路）被编成 `](a%20b)`，
 *    `%20` 直接泄漏到屏幕上。
 * 修法：src/render/link-dest.ts 的 stripQuotePrefix / fenceMarkOf /
 * labelDepth（只有闭合真实链路标签的 `](` 才改写）。
 */
import { describe, expect, it } from "vitest";
import { encodeLinkDestSpaces } from "../src/render/link-dest";
import { renderDocument } from "../src/render/pipeline";

function body(html: string): string {
  return new DOMParser().parseFromString(html, "text/html").body.innerHTML;
}
function text(html: string): string {
  return new DOMParser().parseFromString(html, "text/html").body.textContent ?? "";
}

describe("render-audit：围栏/引用块代码免疫", () => {
  it("块引用内反引号围栏：代码原文一字不动（含 `[` 的链路示范代码也不动）", () => {
    const src = "> ```\n> [x](a b.md)\n> ```\n> 后文 [y](c d.md)";
    const fixed = encodeLinkDestSpaces(src);
    expect(fixed).toContain("> [x](a b.md)");
    expect(fixed).not.toContain("a%20b");
    // 后文的真实链接仍编码
    expect(fixed).toContain("[y](c%20d.md)");
  });

  it("块引用内波浪号围栏（含嵌套引用 > >）免疫", () => {
    const src = "> > ~~~\n> > code ](a b.md)\n> > ~~~\n> > 后 [y](c d.md)";
    const fixed = encodeLinkDestSpaces(src);
    expect(fixed).toContain("code ](a b.md)");
    expect(fixed).toContain("[y](c%20d.md)");
  });

  it("4 空格缩进代码块：无 `[` 的 ](a b.md) 不再被改写", () => {
    const src = "前文\n\n    code ](a b.md) here\n\n后文 [x](c d.md)";
    const fixed = encodeLinkDestSpaces(src);
    expect(fixed).toContain("code ](a b.md) here");
    expect(fixed).toContain("[x](c%20d.md)");
  });

  it("闭合围栏带 info（```js）不算闭合：其后的代码行不被改写", () => {
    const src = "```\n```js\n[x](a b.md)\n```\n后文 [y](c d.md)";
    const fixed = encodeLinkDestSpaces(src);
    expect(fixed).toContain("[x](a b.md)");
    expect(fixed).toContain("[y](c%20d.md)");
  });

  it("端到端：引用块围栏代码保留裸空格，正文无 %20", () => {
    const doc = new DOMParser().parseFromString(
      renderDocument("> ```\n> [x](a b.md)\n> ```\n").html,
      "text/html",
    );
    expect(doc.querySelector("pre")?.textContent).toBe("[x](a b.md)\n");
    expect(doc.body.textContent).not.toContain("%20");
  });
});

describe("render-audit：只有真实链路闭合才改写", () => {
  it("正文里的字面 ](a b)（无 [）：原样放行，%20 不泄漏", () => {
    const src = "正文 ](a b) 正文，不是链接。";
    expect(encodeLinkDestSpaces(src)).toBe(src);
  });

  it("端到端：字面 ](a b) 文本保持逐字节", () => {
    const html = renderDocument("正文 ](a b) 正文。").html;
    expect(text(html).trim()).toBe("正文 ](a b) 正文。");
    expect(body(html)).not.toContain("%20");
  });

  it("已有 ] 闭合（[1] 引用式残文）之后的 ](a b) 不改写", () => {
    const src = "见 [1] 与 ](a b) 说明";
    expect(encodeLinkDestSpaces(src)).toBe(src);
  });

  it("跨行链路标签仍然编码（不因新守卫漏配）", () => {
    expect(encodeLinkDestSpaces("[foo\nbar](a b.md)")).toBe("[foo\nbar](a%20b.md)");
  });

  it("嵌套标签仍然编码", () => {
    expect(encodeLinkDestSpaces("[a [b] c](x y.md)")).toBe("[a [b] c](x%20y.md)");
  });

  it("图片包裹在链接里仍然编码", () => {
    expect(encodeLinkDestSpaces("[![alt](img.png)](a b.md)")).toBe("[![alt](img.png)](a%20b.md)");
  });

  it("标签内的转义 ] 不提前结束标签", () => {
    expect(encodeLinkDestSpaces("[a\\]b](x y.md)")).toBe("[a\\]b](x%20y.md)");
  });

  it("未闭合反引号是字面文本：同行其后的 [x](a b.md) 仍被编码", () => {
    expect(encodeLinkDestSpaces("一个未闭合反引号 ` 然后 [x](a b.md) 应该仍是链接。")).toBe(
      "一个未闭合反引号 ` 然后 [x](a%20b.md) 应该仍是链接。",
    );
  });

  it("空行断段：跨空行的残文不当作跨行标签", () => {
    const src = "[foo\n\nbar](a b.md)";
    expect(encodeLinkDestSpaces(src)).toBe(src);
  });

  it("既有形态零回归：普通空格链接仍编码、盘符链接仍重写", () => {
    expect(encodeLinkDestSpaces("[x](a b.md)")).toBe("[x](a%20b.md)");
    expect(encodeLinkDestSpaces("[x](D:\\a b.md)")).toBe("[x](file:///D:/a%20b.md)");
  });
});