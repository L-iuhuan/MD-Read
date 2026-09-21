/**
 * 多文件拖放 / 二次实例参数（M2 波3，用户反馈：同时拖放多个文件不支持）。
 * drop.ts 契约：筛出全部 .md 路径、按原顺序串行逐个打开——
 * openTab 逐次激活，最后一个自然成为活动标签；串行 await 保证打开顺序。
 */
import { describe, expect, it, vi } from "vitest";
import { selectMdPaths, openEachMd } from "../src/app/drop";

describe("selectMdPaths（.md 筛选）", () => {
  it("筛出全部 .md（大小写不敏感），保持原顺序", () => {
    expect(selectMdPaths(["a.md", "b.txt", "c.MD", "d.png", "e.markdown"])).toEqual([
      "a.md",
      "c.MD",
    ]);
  });

  it("空列表 / 无 .md → 空数组", () => {
    expect(selectMdPaths([])).toEqual([]);
    expect(selectMdPaths(["x.txt", "y.zip"])).toEqual([]);
  });
});

describe("openEachMd（串行逐开）", () => {
  it("逐个打开全部 .md 路径，顺序保持（最后一个最终激活）", async () => {
    const open = vi.fn().mockResolvedValue(undefined);
    await openEachMd(["a.md", "b.txt", "c.md"], open);
    expect(open.mock.calls.map((call) => call[0])).toEqual(["a.md", "c.md"]);
  });

  it("无 .md 时一次也不打开", async () => {
    const open = vi.fn().mockResolvedValue(undefined);
    await openEachMd(["a.txt"], open);
    expect(open).not.toHaveBeenCalled();
  });
});
