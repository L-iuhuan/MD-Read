/**
 * CSS 修复回归锚（M2 波3 修复、波4 归位后更新）。
 * jsdom 无布局引擎，样式修复以「规则存在/不复现」为锚。
 * 波4 已把临时规则从 app.css 归位 typography 层：
 *   math-fallback 与表格间距 → cjk.css；--h-titlebar → tokens.css；
 *   末行线根治方式 = 删除「末行 border-bottom:0」抑制规则（裸 table 无 wrap 容器，
 *   该抑制规则就是末行线消失的根因），末行线由 th/td 边框自然产生。
 * 注：vitest 会把 .css?raw 桩化为空串，故走 fs 直读；cwd 即项目根。
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const app = readFileSync("src/app.css", "utf8");
const cjk = readFileSync("src/typography/cjk.css", "utf8");
const tokens = readFileSync("src/typography/tokens.css", "utf8");

describe("M2 波3 CSS 修复锚点（波4 归位后）", () => {
  it("反馈③：末行线根因规则不得复现（抑制规则已根治删除）", () => {
    expect(`${app}${cjk}`).not.toMatch(
      /tbody tr:last-child td\s*\{[^}]*border-bottom:\s*0/,
    );
  });

  it("反馈④：表格块级间距规则存在（已归位 cjk.css 表格节）", () => {
    expect(cjk).toMatch(/\.mdc table\s*\{[^}]*margin-block/);
  });

  it("反馈②：math-fallback 降级样式存在（已归位 cjk.css 公式节）", () => {
    expect(cjk).toMatch(/\.math-fallback\s*\{[^}]*color/);
    expect(cjk).toMatch(/\.math-fallback--display\s*\{[^}]*text-align:\s*center/);
  });

  it("反馈⑤：标题栏刻度在 tokens，查找条定位计入标题栏高度（防回归重叠）", () => {
    expect(tokens).toMatch(/--h-titlebar:\s*32px/);
    const offsets = app.match(/\.findbar\s*\{[^}]*inset-block-start:[^}]*/g) ?? [];
    const withTitlebar = offsets.filter((rule) => rule.includes("--h-titlebar"));
    expect(withTitlebar.length).toBeGreaterThanOrEqual(1);
  });
});
