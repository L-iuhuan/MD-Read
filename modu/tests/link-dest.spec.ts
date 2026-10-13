/**
 * 链接目标裸空格编码（link-dest）契约锚（2026-10-01 用户反馈根因修复）。
 *
 * 背景：`[x](./a b.md)` 的裸空格让 CommonMark 链接解析断裂，残文 `b.md` 被 linkify
 * 补链成 http://xn--….md（punycode 域名）→ 点击跳系统浏览器。修法 = 渲染前把
 * 目标里的空格编码为 %20；围栏/行内代码免疫；`<...>` 形态本就合法不动。
 */
import { describe, expect, it } from "vitest";
import { encodeLinkDestSpaces } from "../src/render/link-dest";

describe("链接目标裸空格编码", () => {
  it("基本形态：相对路径带空格 → %20（用户反馈的原始形态）", () => {
    expect(encodeLinkDestSpaces("[笔记](./目标 文档.md)")).toBe("[笔记](./目标%20文档.md)");
  });

  it("无 ./ 前缀的裸文件名同样编码", () => {
    expect(encodeLinkDestSpaces("[x](a b.md)")).toBe("[x](a%20b.md)");
  });

  it("多个空格逐个编码；其余字符（含中文、括号）原样", () => {
    expect(encodeLinkDestSpaces("[x](我的 笔记 第二.md)")).toBe("[x](我的%20笔记%20第二.md)");
  });

  it("已是 %20 的目标幂等直通（不存在裸空格即不动）", () => {
    expect(encodeLinkDestSpaces("[x](a%20b.md)")).toBe("[x](a%20b.md)");
  });

  it("图片目标同样编码（![alt](path)）", () => {
    expect(encodeLinkDestSpaces("![图](截图 2026.png)")).toBe("![图](截图%202026.png)");
  });

  it("<...> 包裹形态本就合法：原样保留（含内部空格与括号）", () => {
    expect(encodeLinkDestSpaces("[x](<a b (c).md>)")).toBe("[x](<a b (c).md>)");
  });

  it("平衡括号感知：目标内的成对括号不截断", () => {
    expect(encodeLinkDestSpaces("[x](附件 (v2 最终).md)")).toBe("[x](附件%20(v2%20最终).md)");
  });

  it("转义括号不计为闭合：\\) 在目标内时继续扫描", () => {
    expect(encodeLinkDestSpaces("[x](a\\) b.md)")).toBe("[x](a\\)%20b.md)");
  });

  it("http URL 里的空格同样编码（CommonMark 对 URL 同样要求 <> 包裹）", () => {
    expect(encodeLinkDestSpaces("[x](https://a.com/p q)")).toBe("[x](https://a.com/p%20q)");
  });

  it("围栏代码块免疫：内部 ](a b.md) 一字不动", () => {
    const src = "前文\n```\n[x](a b.md)\n```\n后文";
    expect(encodeLinkDestSpaces(src)).toBe(src);
  });

  it("波浪线围栏同样免疫；围栏开闭配对后正文恢复处理", () => {
    const src = "~~~\n[x](a b.md)\n~~~\n[y](c d.md)";
    expect(encodeLinkDestSpaces(src)).toBe("~~~\n[x](a b.md)\n~~~\n[y](c%20d.md)");
  });

  it("行内代码免疫：`…](a b.md)…` 内部不动，代码后的链接正常编码", () => {
    const src = "看 `` ](a b.md) `` 与 [x](c d.md)";
    expect(encodeLinkDestSpaces(src)).toBe("看 `` ](a b.md) `` 与 [x](c%20d.md)");
  });

  it("无闭合括号的残缺形态原样放行（不制造半截链接）", () => {
    expect(encodeLinkDestSpaces("[x](a b.md")).toBe("[x](a b.md");
  });

  it("空目标/锚点/普通文本直通；无 ]( 的全文零成本直通", () => {
    expect(encodeLinkDestSpaces("[x]()")).toBe("[x]()");
    expect(encodeLinkDestSpaces("普通文本 没有链接")).toBe("普通文本 没有链接");
  });

  it("Windows 绝对盘符形态（反斜杠/正斜杠）→ file:/// 重写（含空格同步编码）", () => {
    expect(encodeLinkDestSpaces("[x](D:\\笔记 仓\\a.md)")).toBe("[x](file:///D:/笔记%20仓/a.md)");
    expect(encodeLinkDestSpaces("[x](D:/notes/b.md)")).toBe("[x](file:///D:/notes/b.md)");
  });

  it("<...> 包裹的绝对盘符形态同样重写（否则 DOMPurify 按 d: scheme 摘 href）", () => {
    expect(encodeLinkDestSpaces("[x](<D:\\a b.md>)")).toBe("[x](<file:///D:/a%20b.md>)");
  });

  it("相对盘符形态（c:\\docs\\a.md 作相对链接用）不被误重写——只有「盘符+分隔符」开头才重写", () => {
    // 单字母盘符开头的相对形态极罕见；规则收紧为 ^[A-Za-z]:[\\/] 防误伤
    expect(encodeLinkDestSpaces("[x](a\\b.md)")).toBe("[x](a\\b.md)");
  });

  it("性能冒烟：500KB 纯文本（无链接直通）与 500KB 含链接文本都在预算内", () => {
    const plain = "一行普通文本。\n".repeat(33_000);
    const linked = "[x](a b.md) 一些文字。\n".repeat(23_000);
    const t0 = performance.now();
    encodeLinkDestSpaces(plain);
    encodeLinkDestSpaces(linked);
    const ms = performance.now() - t0;
    expect(ms, `两段 500KB 处理耗时应远小于 1s（实测 ${Math.round(ms)}ms）`).toBeLessThan(1000);
  });
});

describe("fix-22 缺陷A：题注（dest \"title\"）按 CommonMark 链接定义语义剥离", () => {
  it("无空格目标+题注：题注剥离，不再连空格编进目标", () => {
    expect(encodeLinkDestSpaces('[x](https://a.com "题注")')).toBe('[x](https://a.com "题注")');
  });

  it("空格路径+题注：路径编码 %20，题注原样保留", () => {
    expect(encodeLinkDestSpaces('![图](./a b.png "题注")')).toBe('![图](./a%20b.png "题注")');
  });

  it("Windows 盘符路径+题注：file:/// 重写且题注保留（尖括号两式）", () => {
    expect(encodeLinkDestSpaces('[x](D:\\a b.md "题注")')).toBe('[x](<file:///D:/a%20b.md> "题注")');
    expect(encodeLinkDestSpaces('[x](<D:\\a b.md> "题注")')).toBe('[x](<file:///D:/a%20b.md> "题注")');
  });

  it("单引号题注同剥离；括号题注不认（与实路径「文件夹 (2024)」撞车）", () => {
    expect(encodeLinkDestSpaces("[x](a.md '题注')")).toBe("[x](a.md '题注')");
    expect(encodeLinkDestSpaces("[x](D:\\docs (2024))")).toBe("[x](file:///D:/docs%20(2024))");
  });

  it("重写后按原行坐标推进：盘符链接后的正文不再被吞（顺修的潜在缺陷）", () => {
    expect(encodeLinkDestSpaces("[x](D:\\a.md)尾巴")).toBe("[x](file:///D:/a.md)尾巴");
  });

  it("无题注的既有形态零回归：裸空格路径整体编码、空目标直通", () => {
    expect(encodeLinkDestSpaces("[x](./目标 文档.md)")).toBe("[x](./目标%20文档.md)");
    expect(encodeLinkDestSpaces("[x]()")).toBe("[x]()");
  });
});
