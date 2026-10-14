/**
 * `www.` 前缀自动成链锚（2026-10-13 审查新增）。
 *
 * 背景：原 markdown.ts 注释写「scheme/www 前缀仍自动成链」，实测不成立 ——
 * linkify-it 的 www 规则与裸域名同属 fuzzyLink 路径，2026-10-01 关掉 fuzzyLink 时
 * 把 www 一起关掉了，`www.example.com` 在正文里一直是**字面文本**。
 * 现在由 installWwwAutolink 单独补回 www 一种；**裸域名继续不成链**
 * （2026-10-01 用户反馈实害：`笔记.md` → `http://xn--….md` punycode，点击跳浏览器）。
 *
 * GFM 口径（cmark-gfm）：`www.` 必须**小写**才算 www autolink，大写 `WWW.` 不成链。
 */
import { describe, expect, it } from "vitest";
import { renderDocument } from "../src/render/pipeline";

function dom(src: string): Document {
  return new DOMParser().parseFromString(renderDocument(src).html, "text/html");
}
function anchors(doc: Document): HTMLAnchorElement[] {
  return [...doc.querySelectorAll("a")] as HTMLAnchorElement[];
}

describe("www. 自动成链", () => {
  it("www. 前缀成链，href 补 http://，可见文本逐字保持", () => {
    const doc = dom("www.example.com 结束\n");
    const a = anchors(doc);
    expect(a.length).toBe(1);
    expect(a[0]?.getAttribute("href")).toBe("http://www.example.com");
    expect(a[0]?.textContent).toBe("www.example.com");
  });

  it("裸域名红线不回退：笔记.md / a.example.com / 方案.docx / www.foo 都不成链", () => {
    const doc = dom("笔记.md 与 a.example.com 与 方案.docx 与 www.foo 与 www.\n");
    expect(anchors(doc).length).toBe(0);
  });

  it("www + https 同段各自成链，https 的 href 不被改写", () => {
    const doc = dom("www.example.com 与 https://a.example.com\n");
    const a = anchors(doc);
    expect(a.map((x) => x.getAttribute("href"))).toEqual([
      "http://www.example.com",
      "https://a.example.com",
    ]);
  });

  it("路径 / 查询串 / 锚点原样进 href", () => {
    const doc = dom("看 www.example.com/path?q=1#f 结束\n");
    expect(anchors(doc)[0]?.getAttribute("href")).toBe("http://www.example.com/path?q=1#f");
  });

  it("行内码与围栏里的 www 一律不改写", () => {
    const doc = dom("行内 `www.example.com` 与围栏：\n\n```\nwww.example.com\n```\n");
    expect(anchors(doc).length).toBe(0);
    expect(doc.querySelector("code")?.textContent).toBe("www.example.com");
  });

  it("链接标签内的 www 不套二级链接", () => {
    const doc = dom("[www.a.com](https://b.example.com)\n");
    const a = anchors(doc);
    expect(a.length).toBe(1);
    expect(a[0]?.getAttribute("href")).toBe("https://b.example.com");
    expect(a[0]?.querySelector("a")).toBe(null);
  });

});

describe("www. 边界与红线", () => {
  it("邮箱不成链（fuzzyEmail 仍关）", () => {
    const doc = dom("邮箱 me@example.com 结束\n");
    expect(anchors(doc).length).toBe(0);
  });

  it("CJK 标点紧邻仍成链；同段多个 www 各自成链", () => {
    const doc = dom("（www.a.com）与「www.b.com」\n");
    const a = anchors(doc);
    expect(a.map((x) => x.getAttribute("href"))).toEqual(["http://www.a.com", "http://www.b.com"]);
  });

  it("大写 WWW. 不成链（GFM：www autolink 只认小写前缀）", () => {
    const doc = dom("WWW.EXAMPLE.COM 与 Www.Example.Com\n");
    expect(anchors(doc).length).toBe(0);
  });

  it("与 $$ 块共存时不互相干扰", () => {
    const doc = dom("www.example.com\n\n$$\nE = mc^2\n$$\n");
    expect(anchors(doc).length).toBe(1);
    expect(doc.querySelectorAll(".katex-display").length).toBe(1);
  });
});