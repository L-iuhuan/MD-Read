/**
 * 相对路径图片解析（P5 批1，P0 #5；P0-3 补 asset scope 授权）断言：
 * - joinRelativeToDoc：目录拼接、./ 与 ../ 归一、双分隔符兼容、盘符段钳制；
 * - isDirectlyLoadable：http/data/asset/blob 直载，其余视为相对；
 * - resolveRelativeImages：仅相对 src 转 asset 协议、幂等、失败补中文 title
 *   且不替换元素；P0-3：赋 src 前先 invoke("allow_asset_paths") 授权具体文件，
 *   invoke 失败时补同一中文 title 且不赋 src。
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  convertFileSrc: vi.fn((path: string) => `asset-mock:${path}`),
  invoke: vi.fn(() => Promise.resolve(undefined)),
}));
vi.mock("@tauri-apps/api/core", () => ({
  convertFileSrc: mocks.convertFileSrc,
  invoke: mocks.invoke,
}));

import { isDirectlyLoadable, joinRelativeToDoc, resolveRelativeImages } from "../src/app/images";

/**
 * 等异步分支落定：resolveRelativeImages 保持同步签名，src 赋值发生在
 * invoke(...).then 内，故断言前须把微任务队列排空。
 */
async function settle(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

beforeEach(() => {
  mocks.convertFileSrc.mockClear();
  mocks.invoke.mockClear();
  mocks.invoke.mockImplementation(() => Promise.resolve(undefined));
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

  it("仅相对 src 被拼接转换；远程与内嵌图原样不动", async () => {
    const container = mount(
      '<img src="./pic.png"><img src="https://a.example/b.png">' +
        '<img src="data:image/gif;base64,R0"><img src="../shared/d.png">'
    );
    resolveRelativeImages(container, "E:\\docs\\sub\\a.md");
    await settle();
    const imgs = Array.from(container.querySelectorAll("img"));
    expect(imgs[0].getAttribute("src")).toBe("asset-mock:E:/docs/sub/pic.png");
    expect(imgs[1].getAttribute("src")).toBe("https://a.example/b.png");
    expect(imgs[2].getAttribute("src")).toBe("data:image/gif;base64,R0");
    expect(imgs[3].getAttribute("src")).toBe("asset-mock:E:/docs/shared/d.png");
    expect(mocks.convertFileSrc).toHaveBeenCalledTimes(2);
  });

  it("P0-3：赋 src 前先授权 scope，且只授权相对图的绝对路径（不含 https/data）", async () => {
    const container = mount(
      '<img src="./pic.png"><img src="https://a.example/b.png">' +
        '<img src="data:image/gif;base64,R0"><img src="../shared/d.png">'
    );
    resolveRelativeImages(container, "E:\\docs\\sub\\a.md");
    await settle();
    expect(mocks.invoke).toHaveBeenCalledTimes(1);
    expect(mocks.invoke).toHaveBeenCalledWith("allow_asset_paths", {
      paths: ["E:/docs/sub/pic.png", "E:/docs/shared/d.png"],
    });
    // 授权先于赋 src：invoke 的调用顺序必须早于任何 convertFileSrc
    expect(mocks.invoke.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.convertFileSrc.mock.invocationCallOrder[0]
    );
  });

  it("P0-3：invoke 拒绝时不赋 src，补同一中文失败 title", async () => {
    mocks.invoke.mockImplementation(() => Promise.reject(new Error("scope denied")));
    const container = mount('<img src="./missing.png"><img src="https://a/ok.png">');
    resolveRelativeImages(container, "E:/docs/a.md");
    await settle();
    const [rel, remote] = Array.from(container.querySelectorAll("img"));
    expect(mocks.convertFileSrc).not.toHaveBeenCalled();
    expect(rel.title).toBe("图片加载失败：文件不存在或不可读");
    expect(rel.getAttribute("src")).toBe("./missing.png"); // 未改写成必然 404 的 asset URL
    expect(remote.title).toBe(""); // 直载图不在授权清单内，也不挂提示
  });

  it("幂等：重复调用跳过已处理元素，不重复转换", async () => {
    const container = mount('<img src="./pic.png">');
    resolveRelativeImages(container, "E:/docs/a.md");
    resolveRelativeImages(container, "E:/docs/a.md");
    await settle();
    expect(mocks.invoke).toHaveBeenCalledTimes(1);
    expect(mocks.invoke).toHaveBeenCalledWith("allow_asset_paths", { paths: ["E:/docs/pic.png"] });
    expect(mocks.convertFileSrc).toHaveBeenCalledTimes(1);
  });

  it("加载失败：补中文占位 title，不替换元素；直载图失败不挂提示", async () => {
    const container = mount('<img src="./missing.png"><img src="https://a/404.png">');
    resolveRelativeImages(container, "E:/docs/a.md");
    await settle();
    const [rel, remote] = Array.from(container.querySelectorAll("img"));
    rel.dispatchEvent(new Event("error"));
    remote.dispatchEvent(new Event("error"));
    expect(rel.title).toBe("图片加载失败：文件不存在或不可读");
    expect(rel.tagName).toBe("IMG"); // 元素未被替换
    expect(remote.title).toBe("");
  });
});
