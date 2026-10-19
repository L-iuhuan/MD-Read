/**
 * displayPath（src/app/paths.ts）的行为测试 + 消费面静态锚。
 *
 * · 行为四形态：盘符前缀 / UNC 前缀 / 无前缀 / 空串；
 * · 消费面静态锚：各显示面的 title / textContent 赋值必须以 displayPath 为源 ——
 *   防有人把显示层改回 canonical 原串（`\\?\` 前缀再漏到界面上）。
 *   锚的是「赋值语句的字面形态」，与产品共用同一套假设：显示赋值在左、displayPath 在右。
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { displayPath } from "../src/app/paths";

const recentSrc = readFileSync("src/app/recent.ts", "utf8");
const tabDomSrc = readFileSync("src/app/tab-dom.ts", "utf8");
const emptyStateSrc = readFileSync("src/ui/empty-state.ts", "utf8");
const workspacePanelSrc = readFileSync("src/app/workspace-panel.ts", "utf8");
const tabsMenuSrc = readFileSync("src/ui/tabs-menu.ts", "utf8");

describe("displayPath：剥 Windows canonical 前缀（纯函数、零依赖）", () => {
  it("盘符前缀被剥掉，其余逐字保留", () => {
    expect(displayPath("\\\\?\\d:\\docs\\a.md")).toBe("d:\\docs\\a.md");
    expect(displayPath("\\\\?\\E:\\资料\\笔记.md")).toBe("E:\\资料\\笔记.md");
  });

  it("UNC 前缀剥掉后补回开头的双反斜杠", () => {
    expect(displayPath("\\\\?\\UNC\\srv\\share\\a.md")).toBe("\\\\srv\\share\\a.md");
  });

  it("无前缀：原样返回（不改大小写、不动分隔符）", () => {
    expect(displayPath("D:\\docs\\a.md")).toBe("D:\\docs\\a.md");
    expect(displayPath("/home/u/a.md")).toBe("/home/u/a.md");
  });

  it("空串：原样返回", () => {
    expect(displayPath("")).toBe("");
  });
});

describe("消费面静态锚：显示赋值必须经 displayPath（防回退）", () => {
  it("最近下拉（recent.ts）：条目 title 与目录行都以 displayPath 为源", () => {
    expect(recentSrc).toMatch(/item\.title = displayPath\(path\)/);
    expect(recentSrc).toMatch(/line\.textContent = displayPath\(dir\)/);
  });

  it("标签 DOM（tab-dom.ts）：el.title 以 displayPath 为源", () => {
    expect(tabDomSrc).toMatch(/el\.title = displayPath\(tab\.path\)/);
  });

  it("空态最近列表（empty-state.ts）：条目 title 与目录行都以 displayPath 为源", () => {
    expect(emptyStateSrc).toMatch(/item\.title = displayPath\(path\)/);
    expect(emptyStateSrc).toMatch(/line\.textContent = displayPath\(dir\)/);
  });

  it("工作区头部（workspace-panel.ts）：路径文本与悬停 title 都以 displayPath 为源", () => {
    expect(workspacePanelSrc).toMatch(/path\.textContent = displayPath\(root\)/);
    expect(workspacePanelSrc).toMatch(/path\.title = displayPath\(root\)/);
  });

  it("全部标签列表（tabs-menu.ts）：目录行以 displayPath 为源（本轮全库扫描扫出的面）", () => {
    expect(tabsMenuSrc).toMatch(/p\.textContent = displayPath\(dir\)/);
  });
});
