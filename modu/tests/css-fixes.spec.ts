/**
 * CSS 修复回归锚（M2 波3）。jsdom 无布局引擎，样式修复以「规则存在」为锚，
 * 防止波4 归位 typography 层之前被误删。
 * 注：vitest 会把 .css?raw 也按 CSS 模块桩化（拿到空串），故走 fs 直读；
 * vitest 的 cwd 即项目根（pnpm run check 的执行目录）。
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const css: string = readFileSync("src/app.css", "utf8");

describe("M2 波3 CSS 修复锚点", () => {
  it("反馈③：表格末行下边线覆盖规则存在", () => {
    expect(css).toMatch(/\.mdc table tbody tr:last-child td\s*\{[^}]*border-bottom/);
  });

  it("反馈④：表格块级间距规则存在（.table-wrap 同值）", () => {
    expect(css).toMatch(/\.mdc table\s*\{[^}]*margin-block/);
  });

  it("反馈②：math-fallback 降级样式存在（行内弱化 + 块级居中）", () => {
    expect(css).toMatch(/\.math-fallback\s*\{[^}]*color/);
    expect(css).toMatch(/\.math-fallback--display\s*\{[^}]*text-align:\s*center/);
  });

  it("反馈⑤：标题栏刻度存在，查找条定位已计入标题栏高度（防回归重叠）", () => {
    expect(css).toMatch(/--h-titlebar:\s*32px/);
    const offsets = css.match(/\.findbar\s*\{[^}]*inset-block-start:[^}]*/g) ?? [];
    // §3 原两条（无标题栏高度）+ 本节覆盖两条：覆盖态必须计入 --h-titlebar
    const withTitlebar = offsets.filter((rule) => rule.includes("--h-titlebar"));
    expect(withTitlebar.length).toBeGreaterThanOrEqual(2);
  });
});
