/**
 * 三个低危项的修复锚（2026-10-13 审查 · render.md U4/U5/U6）。
 *
 * U4：`[x](a<TAB>b.md)` —— markdown-it 会把裸 TAB 从目标里静默吞掉，链接实际指向 `ab.md`；
 *     现在目标里的裸空白（空格/制表符）一并编码。
 * U5：≥16 位**纯数字**长串不再包 .tok-break（财务场景里它多半是账号/卡号，断在中间会被读成两段）；
 *     含字母/`_`/`-` 的技术串行为不变。
 * U6：pangu 不进 .math-fallback（降级公式体与 KaTeX 渲染的公式都不该有中西文插空）。
 */
import { describe, expect, it } from "vitest";
import { renderDocument } from "../src/render/pipeline";

function dom(src: string): Document {
  return new DOMParser().parseFromString(renderDocument(src).html, "text/html");
}

describe("U4 · 链接目标里的裸制表符", () => {
  it("TAB 被编码，不再被上游静默吞成另一个路径", () => {
    const doc = dom("[x](a\tb.md)\n");
    const href = doc.querySelector("a")?.getAttribute("href") ?? "";
    expect(href).not.toBe("ab.md");
    expect(href).toContain("%09");
  });

  it("空格仍然编成 %20（原行为不回退）", () => {
    const doc = dom("[x](我的 文件.md)\n");
    expect(doc.querySelector("a")?.getAttribute("href")).toContain("%20");
  });

  it("正文里的裸 TAB 不受影响（只编目标段）", () => {
    const doc = dom("甲\t乙\n");
    expect(doc.querySelector("p")?.textContent).toBe("甲\t乙");
  });
});

describe("U5 · 长 token 断行", () => {
  it("≥16 位纯数字不被包 .tok-break", () => {
    const doc = dom("账号 12345678901234567890 结束\n");
    expect(doc.querySelectorAll(".tok-break").length).toBe(0);
    expect(doc.body.textContent).toContain("12345678901234567890");
  });

  it("带分隔符的金额本来就不命中（红线）", () => {
    const doc = dom("金额 $1,234,567,890.12 元\n");
    expect(doc.querySelectorAll(".tok-break").length).toBe(0);
    expect(doc.body.textContent).toContain("1,234,567,890.12");
  });

  it("含字母/下划线的技术串照旧断行", () => {
    const doc = dom("标识 transform_request_id_20260921 结束\n");
    expect(doc.querySelectorAll(".tok-break").length).toBe(1);
  });

  it("纯数字与技术串混在同一节点：只包技术串", () => {
    const doc = dom("12345678901234567890 与 super_long_identifier_name 并列\n");
    const spans = [...doc.querySelectorAll(".tok-break")].map((e) => e.textContent);
    expect(spans).toEqual(["super_long_identifier_name"]);
  });
});

describe("U6 · pangu 不进降级公式体", () => {
  it("CJK 降级公式里没有 .cjk-gap（与 KaTeX 侧一致）", () => {
    const doc = dom("$$\n结算金额P=100元\n$$\n");
    const fb = doc.querySelector(".math-fallback");
    expect(fb).toBeTruthy();
    expect(fb?.querySelectorAll(".cjk-gap").length).toBe(0);
  });

  it("正文里的中西文插空照常（原行为不回退）", () => {
    const doc = dom("使用TypeScript编写\n");
    expect(doc.querySelectorAll(".cjk-gap").length).toBeGreaterThan(0);
  });
});