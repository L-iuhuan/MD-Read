/**
 * 语料审查 · CommonMark 0.31.2 边角（语料：tests/corpus/commonmark-边角.md）。
 * 断言 = 设计值（CommonMark 规范 + 本项目 D1 决策：breaks:true / html:false），非照抄当前输出。
 * 与实现不一致的用例单独 it.skip 并在 .verify/audit/reports/visual.md 记账。
 */
import { describe, expect, it } from "vitest";
import { renderDocument } from "../src/render/pipeline";
import corpusSrc from "./corpus/commonmark-边角.md?raw";

const src = corpusSrc.replace(/\r\n/g, "\n");
const doc = new DOMParser().parseFromString(renderDocument(src).html, "text/html");
const q = (sel: string): Element[] => [...doc.querySelectorAll(sel)];
const text = (): string => doc.body.textContent ?? "";

describe("CM 标题 / Setext / 分割线", () => {
  it("h1-h6 计数与锚点 id；七井号是段落；闭合井号空格式剥离、无空格式保留", () => {
    expect([1, 2, 3, 4, 5, 6].map((n) => q(`h${n}`).length)).toEqual([2, 3, 1, 0, 1, 1]);
    expect(q("h1,h2,h3,h4,h5,h6").map((h) => h.id)).toEqual([
      "五级标题", "六级标题", "闭合井号", "闭合井号无尾随空格", "无空格闭合井号",
      "setext-一级标题", "setext-二级标题", "setext-二级紧贴现成段落变标题",
    ]);
    expect(text()).toContain("####### 七井号是段落不是标题");
    expect(q("h2").map((e) => e.textContent)).toContain("闭合井号无尾随空格##");
    expect(q("h3").map((e) => e.textContent)).toContain("无空格闭合井号###");
  });

  it("段落 + `---` 紧贴 = Setext H2；空行后 `---` = thematic break（hr）", () => {
    expect(q("h2").map((e) => e.textContent)).toContain("Setext 二级紧贴现成段落变标题");
    expect(q("p").some((p) => p.textContent?.includes("段落与横线之间有空行则是分割线"))).toBe(true);
    expect(q("hr").length).toBe(1);
  });
});

describe("CM 强调定界符规则", () => {
  it("em/strong 计数按设计值；星号字内合法、下划线字内保持字面、空格式保持字面", () => {
    expect(q("em").length).toBe(7);
    expect(q("strong").length).toBe(10);
    expect(q("strong").some((s) => s.textContent === "bar")).toBe(true); // foo**bar**baz
    expect(text()).toContain("a_b_c");
    expect(text()).toContain("中文_下划线强调_中文");
    expect(text()).toContain("** 两侧空格 **");
    expect(text()).toContain("*不是强调*");
    expect(q("s").length).toBe(0);
  });
});

describe("CM 链接与引用定义", () => {
  it("行内/引用/折叠/短式/大小写不敏感/尖括号目标全部成链；未定义引用保持字面", () => {
    const links = q("a");
    expect(links.length).toBe(8);
    expect(links.map((a) => a.getAttribute("href"))).toEqual([
      "https://cm.example.com/a", "https://cm.example.com/b", "https://cm.example.com/ref",
      "https://cm.example.com/collapsed", "https://cm.example.com/short",
      "https://cm.example.com/ref", "https://cm.example.com/angle", "https://cm.example.com/multiline",
    ]);
    expect(links.find((a) => a.textContent === "带题注链接")?.getAttribute("title")).toBe("题注甲");
    expect(text()).toContain("[未定义引用][nowhere]");
    expect(text()).toContain("[未定义短式]");
  });
});

describe("CM 列表：紧凑 / 松散 / 嵌套 / 懒延续", () => {
  it("段落隔断的紧凑列表 li 内无 <p>；空行分隔的松散列表 li 内每项 <p>", () => {
    const uls = q("ul");
    expect(uls.some((u) => u.textContent?.includes("紧凑项甲"))).toBe(true);
    const tight = uls.find((u) => u.textContent?.includes("紧凑项甲"));
    expect(tight?.querySelectorAll("li > p").length).toBe(0);
    const loose = uls.find((u) => u.textContent?.includes("松散项甲"));
    expect(loose?.querySelectorAll("li > p").length).toBe(2);
    const ol = q("ol").find((o) => o.textContent?.includes("有序一"));
    expect(ol?.querySelectorAll("li").length).toBe(3); // 空行后 `3.` 仍属同一列表
  });

  it("嵌套三层列表结构存在；懒延续行并入同一段落", () => {
    expect(q("ul ul ul").length).toBeGreaterThanOrEqual(1);
    const lazy = q("p").find((p) => p.textContent?.includes("列表项首行"));
    expect(lazy?.textContent).toContain("续行缩进两格属同项");
  });

  it("从 1 开始的有序列表可打断段落；从 2 开始的不行（CommonMark 规则）", () => {
    expect(q("p").some((p) => p.textContent === "段落紧跟从 1 开始的有序列表")).toBe(true);
    expect(q("ol").some((o) => o.textContent?.includes("有序项甲"))).toBe(true);
    const p2 = q("p").find((p) => p.textContent?.includes("段落紧跟从 2 开始的有序列表"));
    expect(p2?.textContent).toContain("2. 有序项乙");
  });
});

describe("CM 围栏 / 缩进代码 / HTML / 实体 / 换行", () => {
  it("围栏六块：data-lang ts/js/text 各一，无语言块三；缩进代码块零 data-lang", () => {
    expect(q("pre").length).toBe(6);
    expect(q("pre[data-lang]").map((p) => p.getAttribute("data-lang"))).toEqual(["ts", "js", "text"]);
    const indented = q("pre").filter((p) => !p.hasAttribute("data-lang"));
    expect(indented.length).toBe(3);
    expect(indented.some((p) => p.textContent?.includes("制表符开头的缩进代码块"))).toBe(true);
    expect(indented.some((p) => p.textContent?.includes("四空格开头的缩进代码块"))).toBe(true);
  });

  it("html:false：块级/行内/script 标签全部转义成文本，DOM 内无对应元素", () => {
    expect(q("div").length).toBe(0);
    expect(q("script").length).toBe(0);
    expect(q("b").length).toBe(0);
    expect(text()).toContain('<div class="x">块级 HTML 一律转义成文本</div>');
    expect(text()).toContain("<b>粗标签</b>");
  });

  it("实体解码；未命名实体与代码内实体保持字面", () => {
    expect(text()).toContain("© 与 & 与 < 与 A 与 中");
    expect(text()).toContain("&madeup;");
    expect(q("code").some((c) => c.textContent === "&copy;")).toBe(true);
  });

  it("breaks:true：软换行 / 双空格 / 反斜杠三类换行共 7 个 <br>", () => {
    expect(q("br").length).toBe(7);
  });
});
describe("CM 编码：CRLF 与 BOM", () => {
  it("CRLF 源文渲染结构正确", () => {
    const d = new DOMParser().parseFromString(renderDocument("# 标题\r\n\r\n段落\r\n").html, "text/html");
    expect(d.querySelectorAll("h1").length).toBe(1);
    expect(d.querySelector("p")?.textContent).toBe("段落");
  });

  it.skip("BOM：读取层 src-tauri/src/fs.rs decode_with_bom_removal 已剥 BOM；renderDocument 单独调用不覆盖（设计如此，口径记录）", () => {
    const d = new DOMParser().parseFromString(renderDocument("\uFEFF# 标题\n\n正文\n").html, "text/html");
    expect(d.querySelectorAll("h1").length).toBe(1);
    expect((d.body.textContent ?? "").includes("\uFEFF")).toBe(false);
  });
});