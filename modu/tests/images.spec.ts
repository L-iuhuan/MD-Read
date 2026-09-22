/**
 * 相对路径图片解析（P5 批1，P0 #5）断言：
 * - joinRelativeToDoc：目录拼接、./ 与 ../ 归一、双分隔符兼容、盘符段钳制；
 * - isDirectlyLoadable：http/data/asset/blob 直载，其余视为相对；
 * - resolveRelativeImages：仅相对 src 转 asset 协议、幂等、失败补中文 title
 *   且不替换元素。
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  convertFileSrc: vi.fn((path: string) => `asset-mock:${path}`),
}));
vi.mock("@tauri-apps/api/core", () => ({
  convertFileSrc: mocks.convertFileSrc,
}));

import { isDirectlyLoadable, joinRelativeToDoc, resolveRelativeImages } from "../src/app/images";

beforeEach(() => {
  mocks.convertFileSrc.mockClear();
  document.body.innerHTML = "";
});

describe("joinRelativeToDoc：文档目录 + 相对 src → 绝对路径", () => {
  it("同目录与子目录拼接（/ 与 \\ 分隔符都认）", () => {
    expect(joinRelativeToDoc("E:\\docs\\sub\\a.md", "img/x.png")).toBe("E:/docs/sub/img/x.png");
    expect(joinRelativeToDoc("E:/docs/a.md", "pic.png")).toBe("E:/docs/pic.png");
  });

  it("./ 段忽略；../ 逐级上弹（含反斜杠写法）", () => {
    expect(joinRelativeToDoc("E:/docs/sub/a.md", "./pic.png")).toBe("E:/docs/sub/pic.png");
    expect(joinRelativeToDoc("E:\\docs\\a.md", "..\\img\\x.png")).toBe("E:/img/x.png");
    expect(joinRelativeToDoc("E:/docs/sub/a.md", "../img/y.png")).toBe("E:/docs/img/y.png");
  });

  it("../ 弹到盘符即钳制，不产生越界路径", () => {
    expect(joinRelativeToDoc("E:\\a.md", "../../x.png")).toBe("E:/x.png");
  });
});

describe("isDirectlyLoadable：直载形态判定", () => {
  it("http/https、data、asset、blob → 直载", () => {
    expect(isDirectlyLoadable("https://a.example/b.png")).toBe(true);
    expect(isDirectlyLoadable("http://a.example/b.png")).toBe(true);
    expect(isDirectlyLoadable("data:image/gif;base64,R0")).toBe(true);
    expect(isDirectlyLoadable("asset://localhost/E%3A/x.png")).toBe(true);
    expect(isDirectlyLoadable("blob:https://a/uuid")).toBe(true);
  });

  it("相对路径与空串 → 需解析", () => {
    expect(isDirectlyLoadable("./pic.png")).toBe(false);
    expect(isDirectlyLoadable("img/pic.png")).toBe(false);
    expect(isDirectlyLoadable("")).toBe(false);
  });
});

describe("resolveRelativeImages：容器批处理", () => {
  function mount(html: string): HTMLElement {
    const container = document.createElement("article");
    container.innerHTML = html;
    document.body.appendChild(container);
    return container;
  }

  it("仅相对 src 被拼接转换；远程与内嵌图原样不动", () => {
    const container = mount(
      '<img src="./pic.png"><img src="https://a.example/b.png">' +
        '<img src="data:image/gif;base64,R0"><img src="../shared/d.png">'
    );
    resolveRelativeImages(container, "E:\\docs\\sub\\a.md");
    const imgs = Array.from(container.querySelectorAll("img"));
    expect(imgs[0].getAttribute("src")).toBe("asset-mock:E:/docs/sub/pic.png");
    expect(imgs[1].getAttribute("src")).toBe("https://a.example/b.png");
    expect(imgs[2].getAttribute("src")).toBe("data:image/gif;base64,R0");
    expect(imgs[3].getAttribute("src")).toBe("asset-mock:E:/docs/shared/d.png");
    expect(mocks.convertFileSrc).toHaveBeenCalledTimes(2);
  });

  it("幂等：重复调用跳过已处理元素，不重复转换", () => {
    const container = mount('<img src="./pic.png">');
    resolveRelativeImages(container, "E:/docs/a.md");
    resolveRelativeImages(container, "E:/docs/a.md");
    expect(mocks.convertFileSrc).toHaveBeenCalledTimes(1);
  });

  it("加载失败：补中文占位 title，不替换元素；直载图失败不挂提示", () => {
    const container = mount('<img src="./missing.png"><img src="https://a/404.png">');
    resolveRelativeImages(container, "E:/docs/a.md");
    const [rel, remote] = Array.from(container.querySelectorAll("img"));
    rel.dispatchEvent(new Event("error"));
    remote.dispatchEvent(new Event("error"));
    expect(rel.title).toBe("图片加载失败：文件不存在或不可读");
    expect(rel.tagName).toBe("IMG"); // 元素未被替换
    expect(remote.title).toBe("");
  });
});
