/**
 * des-11 UI 全修 · 纯样式/源级锚（2026-10-19）
 * 行为锚分别在：tabs-menu（拥挤态代理浮层）、tabs（关闭图标）、settings（编辑态字体）、
 * workspace-panel（树展开）。本文件只锁「只写 CSS/TS 常量的修法」不会在后续改动中丢。
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

function read(path: string): string {
  return readFileSync(path, "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
}

const app = read("src/app.css");
const settingsPanel = read("src/app/settings-panel.css");
const workspacePanel = read("src/app/workspace-panel.css");
const cjk = read("src/typography/cjk.css");
const livePreview = read("src/editor/live-preview.ts");
const lint = read("src/editor/md-lint.css");
const toolbar = read("src/editor/toolbar.css");

describe("des-11 样式锚", () => {
  it("全应用选中色走 accent 软底 + 正文色（覆盖正文/表格/代码/空态）", () => {
    expect(app).toMatch(
      /#app ::selection\s*\{[^}]*background:\s*var\(--accent-tint-hover\)[^}]*color:\s*var\(--text\)/s,
    );
  });

  it("滚动条主题化：细滚动条 token + 标签条仍隐藏（ID 规则不得把它顶回来）", () => {
    expect(app).toMatch(/#app ::-webkit-scrollbar\s*\{/);
    expect(app).toMatch(/#app ::-webkit-scrollbar-thumb\s*\{[^}]*var\(--border-strong\)/s);
    expect(app).toMatch(/#app \.tab-list::-webkit-scrollbar\s*\{\s*display:\s*none/);
  });

  it("设置面板：矮窗限高并自身滚动", () => {
    expect(settingsPanel).toMatch(
      /\.settings-panel\s*\{[^}]*max-block-size:[^}]*overflow-y:\s*auto/s,
    );
  });

  it("H5/H6 与 live-preview 同值（.9em / .85em + 上间距）", () => {
    expect(cjk).toMatch(/\.mdc h5\s*\{[^}]*font-size:\s*\.9em[^}]*margin-block-start:\s*1\.5em/s);
    expect(cjk).toMatch(
      /\.mdc h6\s*\{[^}]*font-size:\s*\.85em[^}]*margin-block-start:\s*1\.4em[^}]*color:\s*var\(--text-muted\)/s,
    );
    expect(livePreview).toMatch(/cm-lp-h5[\s\S]*?fontSize:\s*"\.9em"/);
    expect(livePreview).toMatch(/cm-lp-h6[\s\S]*?fontSize:\s*"\.85em"/);
  });

  it("lint warning 的线级颜色统一走 --warn-line", () => {
    expect(lint).not.toMatch(
      /\.cm-diagnostic-warning\s*\{\s*border-left-color:\s*var\(--warn-text\)/,
    );
    expect(lint).toMatch(/\.cm-diagnostic-warning\s*\{\s*border-left-color:\s*var\(--warn-line\)/);
  });

  it("状态栏 lint 钮有 hover/按压底，且 severity 色不被悬停覆盖", () => {
    expect(lint).toMatch(/#st-lint:hover\s*\{\s*background:\s*var\(--bg-hover\)/);
    expect(lint).toMatch(/#st-lint:active\s*\{\s*background:\s*var\(--bg-active\)/);
    expect(lint).toMatch(/#st-lint\[data-severity="error"\]\s*\{\s*color:\s*var\(--danger-text\)/);
    expect(lint).toMatch(/#st-lint\[data-severity="warning"\]\s*\{\s*color:\s*var\(--warn-text\)/);
  });

  it("编辑工具条折叠把手 hover 走壳层 accent 文字档，不再消费纸面 --accent-ink", () => {
    expect(toolbar).toMatch(
      /\.md-toolbar-handle:hover:not\(:disabled\)\s*\{\s*color:\s*var\(--accent-text-hover\)/,
    );
    expect(toolbar).not.toMatch(
      /\.md-toolbar-handle:hover:not\(:disabled\)\s*\{[^}]*var\(--accent-ink\)/,
    );
  });

  it("工作区树：chevron 旋转 + disabled 降色皮", () => {
    expect(workspacePanel).toMatch(/\.workspace-chevron\s*\{/);
    expect(workspacePanel).toMatch(
      /\.menu-item\[aria-expanded="true"\] \.workspace-chevron\s*\{\s*transform:\s*rotate\(90deg\)/,
    );
    expect(app).toMatch(/\.menu-item:disabled\s*\{[^}]*cursor:\s*default[^}]*opacity:/s);
  });
});
