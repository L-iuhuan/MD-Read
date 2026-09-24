/**
 * 多文件拖放 / 二次实例参数 / 启动参数（M2 波3，用户反馈：同时拖放多个文件不支持）。
 * drop.ts 契约：筛出全部 Markdown 路径、按原顺序串行逐个打开——
 * openTab 逐次激活，最后一个自然成为活动标签；串行 await 保证打开顺序。
 * P0-6：筛选清单改为共享的 app/md-ext.ts（md/markdown/mdx，大小写不敏感），
 * 本组因此从「只认 .md」改为「三种扩展名都认」。
 */
import { describe, expect, it, vi } from "vitest";
import { isMd, selectMdPaths, openEachMd } from "../src/app/drop";
import { MD_EXTENSIONS } from "../src/app/md-ext";

describe("selectMdPaths（Markdown 筛选，P0-6 扩到 md/markdown/mdx）", () => {
  it("筛出全部 Markdown 文件（三种扩展名 + 大小写不敏感），保持原顺序", () => {
    expect(
      selectMdPaths(["a.md", "b.txt", "c.MD", "d.png", "e.markdown", "f.MDx", "g.mdown"]),
    ).toEqual(["a.md", "c.MD", "e.markdown", "f.MDx"]);
  });

  it("空列表 / 无 Markdown → 空数组", () => {
    expect(selectMdPaths([])).toEqual([]);
    expect(selectMdPaths(["x.txt", "y.zip"])).toEqual([]);
  });

  it("isMd 兼容别名与共享清单同判（三种扩展名全真）", () => {
    for (const extension of MD_EXTENSIONS) {
      expect(isMd(`note.${extension}`)).toBe(true);
      expect(isMd(`note.${extension.toUpperCase()}`)).toBe(true);
    }
    expect(isMd("note.md.bak")).toBe(false);
  });
});

describe("openEachMd（串行逐开）", () => {
  it("逐个打开全部 Markdown 路径，顺序保持（最后一个最终激活）", async () => {
    const open = vi.fn().mockResolvedValue(undefined);
    await openEachMd(["a.md", "b.txt", "c.md"], open);
    expect(open.mock.calls.map((call) => call[0])).toEqual(["a.md", "c.md"]);
  });

  it("无 Markdown 时一次也不打开", async () => {
    const open = vi.fn().mockResolvedValue(undefined);
    await openEachMd(["a.txt"], open);
    expect(open).not.toHaveBeenCalled();
  });

  it("activate 标记：中间项 false、仅末项 true（P5 批2：中间渲染白做）", async () => {
    const open = vi.fn().mockResolvedValue(undefined);
    await openEachMd(["a.md", "b.md", "c.md"], open);
    expect(open.mock.calls.map((call) => call[1])).toEqual([false, false, true]);
  });

  it("单个 Markdown 文件也带 activate=true", async () => {
    const open = vi.fn().mockResolvedValue(undefined);
    await openEachMd(["only.md"], open);
    expect(open.mock.calls[0]?.[1]).toBe(true);
  });

  it("多文件启动/二次实例：两个 Markdown 都必须打开（P0-6 回归——旧实现只取第一个）", async () => {
    const open = vi.fn().mockResolvedValue(undefined);
    await openEachMd(
      ["C:\\docs\\一.markdown", "C:\\docs\\二.mdx", "C:\\docs\\说明.txt"],
      open,
    );
    expect(open).toHaveBeenCalledTimes(2);
    expect(open.mock.calls.map((call) => call[0])).toEqual([
      "C:\\docs\\一.markdown",
      "C:\\docs\\二.mdx",
    ]);
    expect(open.mock.calls.map((call) => call[1])).toEqual([false, true]);
  });

  it("串行：前一个 open 未 resolve 前不启动下一个", async () => {
    const order: string[] = [];
    let release: (() => void) | null = null;
    const open = async (path: string, _activate: boolean): Promise<void> => {
      order.push(`start:${path}`);
      if (path === "a.md") {
        await new Promise<void>((resolve) => {
          release = resolve;
        });
      }
      order.push(`end:${path}`);
    };
    const pending = openEachMd(["a.md", "b.md"], open);
    await Promise.resolve();
    expect(order).toEqual(["start:a.md"]);
    release?.();
    await pending;
    expect(order).toEqual(["start:a.md", "end:a.md", "start:b.md", "end:b.md"]);
  });
});
