/**
 * C0 表格主题变量化锚：editorTableTheme 必须**全槽**是 tokens.css 变量串——
 * 漏任一槽都会漏出包内建主题的字面色值（暗色发白的老病根），本锚按值判红。
 */
import { describe, expect, it } from "vitest";
import { editorTableTheme } from "../src/editor/tables-theme";

const SLOTS = [
  "--tbl-theme-row-background",
  "--tbl-theme-even-row-background",
  "--tbl-theme-odd-row-background",
  "--tbl-theme-header-row-background",
  "--tbl-theme-border-color",
  "--tbl-theme-border-hover-color",
  "--tbl-theme-border-active-color",
  "--tbl-theme-outline-color",
  "--tbl-theme-text-color",
  "--tbl-theme-menu-border-color",
  "--tbl-theme-menu-background",
  "--tbl-theme-menu-hover-background",
  "--tbl-theme-menu-text-color",
  "--tbl-theme-menu-hover-text-color",
  "--tbl-theme-select-all-focus-overlay",
  "--tbl-theme-select-all-blur-overlay",
] as const;

describe("editorTableTheme（C0·单主题方案）", () => {
  it("16 个颜色槽每槽都是变量串（零字面色值，漏槽即漏出内建字面色）", () => {
    for (const slot of SLOTS) {
      expect(editorTableTheme.props[slot], slot).toMatch(/var\(--/);
      expect(editorTableTheme.props[slot], slot).not.toMatch(/#[0-9a-f]{3,8}\b|rgb\(\s*\d/i);
    }
  });

  it("映射基准锚：单元格底/边框/文字走指定 token，奇偶行同值（无斑马）", () => {
    expect(editorTableTheme.props["--tbl-theme-row-background"]).toBe("var(--bg-code)");
    expect(editorTableTheme.props["--tbl-theme-even-row-background"]).toBe("var(--bg-code)");
    expect(editorTableTheme.props["--tbl-theme-odd-row-background"]).toBe("var(--bg-code)");
    expect(editorTableTheme.props["--tbl-theme-border-color"]).toBe("var(--border)");
    expect(editorTableTheme.props["--tbl-theme-text-color"]).toBe("var(--text)");
  });
});
