/**
 * 数学配对安全网（2026-10-13 审查修复的回归锚）。
 *
 * 修复前的两条真实缺陷（本文件逐条锁住）：
 *  A. `needGuard` 快路径只看 `\(`/`\[` ⇒ 「多行 `$$…$$` 且全文无 `\(` `\[`」时整块不渲染：
 *     breaks:true 把换行渲染成 <br>，KaTeX auto-render 按**单个文本节点**匹配定界符，
 *     开/闭 `$$` 被劈进两个文本节点 ⇒ 退化成纯文本（`$$` 字面残留）。
 *     同一原因还让块体里的 `*b*` 被 emphasis 拆走。
 *  B. 配对不区分代码 ⇒ 两个 bash 围栏各含 `echo $$`（shell 的 PID 变量）会**跨块配对**，
 *     两块之间的整篇文档被当成公式正文原样还原 ⇒ 第二个围栏之后的全文被吞进第一个代码块。
 */
import { describe, expect, it } from "vitest";
import { extractMath, restoreMath } from "../src/render/mathprotect";
import { renderDocument } from "../src/render/pipeline";

function dom(src: string): Document {
  return new DOMParser().parseFromString(renderDocument(src).html, "text/html");
}

describe("A · 多行 $$ 不依赖 \( 或 \[ 的存在", () => {
  it("整篇只有多行 $$（无任何反斜杠定界符）⇒ 出 .katex-display，正文零裸 $$", () => {
    const doc = dom("$$\nE = mc^2\n$$\n");
    expect(doc.querySelectorAll(".katex-display").length).toBe(1);
    expect(doc.body.textContent ?? "").not.toContain("$$");
  });

  it("段落之间的多行 $$ ⇒ 成块渲染且 data-line 与真源行号一致", () => {
    const src = "前置段落。\n\n$$\nE = mc^2\n$$\n\n后置段落。";
    const doc = dom(src);
    expect(doc.querySelectorAll(".katex-display").length).toBe(1);
    const later = [...doc.querySelectorAll("p")].find((p) => p.textContent === "后置段落。");
    expect(later?.getAttribute("data-line")).toBe("7");
  });

  it("块体含 markdown 活跃字符（*b*）⇒ 收走保护，em 数 0", () => {
    const doc = dom("$$\na *b* c\n$$\n");
    expect(doc.querySelectorAll(".katex-display").length).toBe(1);
    expect(doc.querySelectorAll("em").length).toBe(0);
  });

  it("单行 $$a *b* c$$（无 \( 与 \[）⇒ 同样被收走", () => {
    const doc = dom("$$\na *b* c\n$$\n\n行内 $$x *y* z$$ 结束。");
    expect(doc.querySelectorAll(".katex").length).toBe(2);
    expect(doc.querySelectorAll("em").length).toBe(0);
  });

  it("纯中文多行 $$ ⇒ 走 .math-fallback--display（不是 KaTeX），零裸定界符", () => {
    const doc = dom("$$\n中文公式 = 甲 + 乙\n$$\n");
    expect(doc.querySelectorAll(".math-fallback--display").length).toBe(1);
    expect(doc.body.textContent ?? "").not.toContain("$$");
  });

  it("引用内 / 列表内的缩进 $$ 块仍按块处理（行级独占允许块级标记前缀）", () => {
    const quote = dom("> $$\n> a = 1\n> $$\n");
    expect(quote.querySelectorAll(".katex-display").length).toBe(1);
    const list = dom("- 项甲\n  $$\n  a = 1\n  $$\n");
    expect(list.querySelectorAll(".katex-display").length).toBe(1);
  });

  it("未闭合的 $$ 不保护（保持字面，不吞正文）", () => {
    const doc = dom("前文 $$未闭合 后文\n\n第二段。");
    expect(doc.body.textContent ?? "").toContain("$$未闭合");
    expect(doc.querySelectorAll(".katex").length).toBe(0);
  });
});

describe("B · 代码/行内码里的定界符不参与配对（文档结构保全）", () => {
  it("两个 bash 围栏各含 echo $$：结构完整，中间段落不被吞", () => {
    const src = "```bash\necho " + "$$" + "\n```\n\n中间段落甲\n\n```bash\necho " + "$$" + "\n```\n";
    const doc = dom(src);
    expect(doc.querySelectorAll("pre").length).toBe(2);
    const mid = [...doc.querySelectorAll("p")].find((p) => p.textContent === "中间段落甲");
    expect(mid).toBeTruthy();
    expect(doc.querySelectorAll("h1").length).toBe(0);
    expect(doc.body.textContent ?? "").not.toContain("```");
  });

  it("围栏里的 $$ 讲解样例保持字面，不产生公式", () => {
    const doc = dom("```text\n$$\nnot math\n$$\n```\n\n普通段落。\n");
    expect(doc.querySelectorAll("pre").length).toBe(1);
    expect(doc.querySelectorAll(".katex").length).toBe(0);
    expect(doc.querySelector("pre")?.textContent).toBe("$$\nnot math\n$$\n");
  });

  it("正文两个裸 $$ 不会被配成公式（标题/列表/围栏结构不被吞）", () => {
    const src = "价格 " + "$$" + " 折扣甲\n\n# 标题甲\n\n- 列表甲\n\n再 " + "$$" + " 一次\n";
    const doc = dom(src);
    expect(doc.querySelectorAll("h1").length).toBe(1);
    expect(doc.querySelectorAll("li").length).toBe(1);
    expect(doc.querySelectorAll(".katex, .math-fallback").length).toBe(0);
    expect(doc.body.textContent ?? "").toContain("价格 $$ 折扣甲");
  });

  it("行内码里的 $$ 不被跨片段配对（反引号结构完好）", () => {
    const doc = dom("行内码 `echo " + "$$" + "` 与 `" + "$$" + "` 两处。\n");
    expect(doc.querySelectorAll("code").length).toBe(2);
    expect(doc.querySelectorAll(".katex, .math-fallback").length).toBe(0);
  });

  it("围栏后的真 $$ 块照常渲染（代码不干扰其后的公式）", () => {
    const doc = dom("```bash\necho " + "$$" + "\n```\n\n$$\nE = mc^2\n$$\n");
    expect(doc.querySelectorAll("pre").length).toBe(1);
    expect(doc.querySelectorAll(".katex-display").length).toBe(1);
  });
});

describe("C · extractMath 单元层（配对规则与逐字节往返）", () => {
  const reject: string[] = [
    "价格 $$ 折扣甲\n\n# 标题甲\n\n再 $$ 一次\n",
    "```bash\necho $$\n```\n\n中间\n\n```bash\necho $$\n```\n",
    "```text\n$$\nnot math\n$$\n```\n",
    "行内 `a $$ b` 与 `c $$ d`\n",
  ];
  for (const src of reject) {
    it(`不收：${JSON.stringify(src.slice(0, 24))}…`, () => {
      const g = extractMath(src);
      expect(g.spans.size).toBe(0);
      expect(g.text).toBe(src);
    });
  }

  const accept: string[] = [
    "$$\nE = mc^2\n$$\n",
    "文字\n$$\na *b* c\n$$\n",
    "行内 $$a *b* c$$ 结束。",
    "- 项\n  $$\n  a\n  $$\n",
    "$$\na = 1\n\nb = 2\n$$\n",
  ];
  for (const src of accept) {
    it(`收且往返无损：${JSON.stringify(src.slice(0, 24))}…`, () => {
      const g = extractMath(src);
      expect(g.spans.size).toBe(1);
      expect(g.text).not.toContain("$$");
      expect(restoreMath(g.text, g)).toBe(src);
      // 占位符保行数（fix-22 约束不回退）
      expect(g.text.split("\n").length).toBe(src.split("\n").length);
    });
  }

  it("引用前缀（> ）与列表前缀不阻断行级独占判定", () => {
    const quote = extractMath("> $$\n> a\n> $$\n");
    expect(quote.spans.size).toBe(1);
    expect(quote.text).not.toContain("$$");
    const list = extractMath("- 项\n  $$\n  a\n  $$\n");
    expect(list.spans.size).toBe(1);
    expect(list.text).not.toContain("$$");
  });
  it("单行成对、多行非行级独占的 $$ 不收（避免吞正文）", () => {
    // 开定界符前有正文、闭定界符后也有正文 ⇒ 不是显示公式
    const g = extractMath("文字 $$ 中间\n多行\n$$ 尾巴\n");
    expect(g.spans.size).toBe(0);
  });
});
describe("D · 跨行 $$ 在 render 侧合并（mathprotect 之外的宽松写法）", () => {
  it("定界符与内容同行：$$E / = mc^2$$ ⇒ 成块渲染，零裸 $$", () => {
    const doc = dom("$$E\n= mc^2$$\n");
    expect(doc.querySelectorAll(".katex-display").length).toBe(1);
    expect(doc.body.textContent ?? "").not.toContain("$$");
  });

  it("只有开定界符独占一行：$$ / E = mc^2$$ ⇒ 成块渲染", () => {
    const doc = dom("$$\nE = mc^2$$\n");
    expect(doc.querySelectorAll(".katex-display").length).toBe(1);
    expect(doc.body.textContent ?? "").not.toContain("$$");
  });

  it("只有闭定界符独占一行：$$E = mc^2 / $$ ⇒ 成块渲染", () => {
    const doc = dom("$$E = mc^2\n$$\n");
    expect(doc.querySelectorAll(".katex-display").length).toBe(1);
    expect(doc.body.textContent ?? "").not.toContain("$$");
  });

  it("宽松多行 + CJK ⇒ 走 .math-fallback--display（不是 KaTeX）", () => {
    const doc = dom("$$中文\n公式$$\n");
    expect(doc.querySelectorAll(".math-fallback--display").length).toBe(1);
    expect(doc.body.textContent ?? "").not.toContain("$$");
  });

  it("段落内的宽松多行 $$ 照常成块，前后正文逐字保留", () => {
    const doc = dom("说明文字 $$a\nb$$ 后续\n");
    expect(doc.querySelectorAll(".katex-display").length).toBe(1);
    const p = doc.querySelector("p");
    expect(p?.textContent ?? "").toContain("说明文字");
    expect(p?.textContent ?? "").toContain("后续");
  });

  it("合并范围只限 $$ 跨度：跨度外的硬换行 <br> 不被吃掉", () => {
    // 硬换行（两空格）产 1 个 <br>；宽松 $$ 跨度内的 2 个 <br> 被合并 ⇒ 事后只剩 1 个
    const doc = dom("甲行  \n乙行\n\n$$\nE = mc^2\n$$\n丙行  \n丁行\n");
    expect(doc.querySelectorAll(".katex-display").length).toBe(1);
    expect(doc.querySelectorAll("br").length).toBe(2);
  });

  it("规范块（两端行级独占）仍走 mathprotect，不产生多余 <br>", () => {
    const doc = dom("前置  \n段落\n\n$$\nE = mc^2\n$$\n\n后置\n");
    expect(doc.querySelectorAll(".katex-display").length).toBe(1);
    expect(doc.querySelectorAll("br").length).toBe(1);
  });
});
describe("E · 行内码区间与未闭合开定界符（Lead 复核 visual-audit 的 M2/M3）", () => {
  it("M2 两个游离单反引号不跨空行配对 ⇒ 中间的行内公式仍渲染", () => {
    const doc = dom("段甲 ` 游离反引号\n\n行内 \\(x^2\\) 公式\n\n段乙 ` 游离反引号\n");
    expect(doc.querySelectorAll(".katex").length).toBe(1);
    expect(doc.body.textContent ?? "").toContain("段甲 ` 游离反引号");
    expect(doc.body.textContent ?? "").toContain("段乙 ` 游离反引号");
  });

  it("M3 未闭合的 \\( 不会让后面独立成对的 \\[...\\] 一起失保护", () => {
    const doc = dom("前 \\(未闭合 后 \\[e+f\\] 独立\n");
    expect(doc.querySelectorAll(".katex-display").length).toBe(1);
    expect(doc.body.textContent ?? "").toContain("(未闭合");
  });

  it("合法跨行行内码（段内单换行）仍然成码，不被 M2 的段落上界误伤", () => {
    const doc = dom("跨行 `a\nb` 代码与 \\(y^2\\)\n");
    expect(doc.querySelector("code")?.textContent).toBe("a b");
    expect(doc.querySelectorAll(".katex").length).toBe(1);
  });

  it("围栏代码里的 $$ 不是公式，且不影响其后的真公式块", () => {
    const doc = dom("```\n代码 $$ 不是公式\n```\n\n$$\nE = mc^2\n$$\n");
    expect(doc.querySelector("pre")?.textContent).toContain("$$ 不是公式");
    expect(doc.querySelectorAll(".katex-display").length).toBe(1);
  });
});

/* ---- F · 行数守恒（fix-30 取证锚）：多行公式不使 data-line 漂移 ----
 * 背景：阅读⇄编辑保位依赖「渲染侧 data-line（token.map）与编辑器源码行号同刻度」。
 * mathprotect 若不再保行数（fix-22 曾保），喂给 md.render 的文本行数偏小 ⇒
 * 之后所有块的 token.map / data-line 系统性偏小 ⇒ nearestBlockLine 选错目标。
 * D2 重写后此处逐条实证：占位文本行数 === 源文行数，长文档尾部块 data-line 精确。 */
describe("F · 行数守恒：多行公式长文档的 data-line 与源行号一致（fix-30）", () => {
  const BLOCKS = 60; // 60 个多行 $$ 段（每段占 3 行）＋夹层段落：足够放大任何行数漂移
  const lines: string[] = [];
  for (let i = 0; i < BLOCKS; i++) {
    lines.push(`段落 ${i}`, "", "$$", `x_{${i}} = ${i}`, "$$", "");
  }
  lines.push("## 尾部标题");
  const src = lines.join("\n");
  const total = lines.length; // 尾部标题恰在最后一行（1-based）

  it("extractMath 占位文本行数与源文一致（fix-22 补偿在 D2 重写后仍成立）", () => {
    const guards = extractMath(src);
    expect(guards.spans.size).toBe(BLOCKS); // 60 段全部收走（补偿路径真被走到）
    expect(guards.text.split("\n").length).toBe(total);
  });

  it("尾部标题 data-line === 真源行号；全部锚点落在 [1, 总行数] 内", () => {
    const doc = dom(src);
    const tail = doc.querySelector("h2");
    expect(tail?.getAttribute("data-line")).toBe(String(total));
    const anchors = [...doc.querySelectorAll("[data-line]")];
    expect(anchors.length).toBeGreaterThan(BLOCKS); // 锚点确实在场（非空转）
    for (const el of anchors) {
      const n = Number(el.getAttribute("data-line"));
      expect(n).toBeGreaterThanOrEqual(1);
      expect(n).toBeLessThanOrEqual(total);
    }
  });
});