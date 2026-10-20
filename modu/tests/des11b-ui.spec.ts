/**
 * des-11b：最近卡片布局 + 版本脚注的源级锚。
 * 最近条的运行期结构未变（仍是 .menu-item + .menu-text 两行式），本文件锁 CSS 的三处修法；
 * 版本号链在 settings.spec 另有一条真实 DOM 行为锚（__APP_VERSION__ → #settings-version）。
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

function read(path: string): string {
  return readFileSync(path, "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
}

const empty = read("src/ui/empty-state.css");
const app = read("src/app.css");
const settingsPanel = read("src/app/settings-panel.css");
const settingsTs = readFileSync("src/ui/settings.ts", "utf8");
const indexHtml = readFileSync("index.html", "utf8");
const viteConfig = readFileSync("vite.config.ts", "utf8");
const viteEnv = readFileSync("src/vite-env.d.ts", "utf8");

describe("des-11b 最近卡布局", () => {
  it("卡头与条目文字共用 12px 水平边界（list 4 + item 8 = size-3）", () => {
    expect(empty).toMatch(
      /\.empty-recent-head\s*\{[^}]*padding:\s*10px var\(--size-3\) 8px/s,
    );
    expect(empty).toMatch(/\.empty-recent-list\s*\{\s*padding:\s*var\(--size-1\)/);
    expect(app).toMatch(/\.menu-item\s*\{[^}]*padding:\s*var\(--size-2\)/s);
  });

  it("相邻文件项有 hairline 分组（卡片 + 下拉各一处）", () => {
    expect(empty).toMatch(
      /\.empty-recent-list \.menu-item \+ \.menu-item\s*\{[^}]*border-block-start:\s*1px solid var\(--line\)/s,
    );
    expect(app).toMatch(
      /#recent-menu \.menu-item:not\(\.is-action\) \+ \.menu-item:not\(\.is-action\)\s*\{[^}]*border-block-start:\s*1px solid var\(--line\)/s,
    );
  });

  it("长路径：名称/目录都 min-inline-size:0 + ellipsis；下拉滚动条双边留槽", () => {
    const rule =
      /\.menu-item \.menu-name,[\s\S]*?\.menu-item \.menu-path\s*\{([^}]*)\}/.exec(app)?.[1] ?? "";
    expect(rule).toMatch(/min-inline-size:\s*0/);
    expect(rule).toMatch(/inline-size:\s*100%/);
    expect(rule).toMatch(/text-overflow:\s*ellipsis/);
    expect(rule).toMatch(/white-space:\s*nowrap/);
    expect(app).toMatch(/\.recent-menu\s*\{[^}]*scrollbar-gutter:\s*stable both-edges/s);
  });
});

describe("des-11b 版本号接线", () => {
  it("package.json 是唯一来源：vite define 不手抄版本号", () => {
    expect(viteConfig).toMatch(/from\s+"\.\/package\.json"/);
    expect(viteConfig).toMatch(/__APP_VERSION__:\s*JSON\.stringify\(pkg\.version\)/);
    expect(viteConfig).not.toMatch(/\b0\.2\.\d+\b/);
  });

  it("d.ts 声明、面板 DOM、设置 TS 与脚注 CSS 四处齐备", () => {
    expect(viteEnv).toMatch(/declare const __APP_VERSION__:\s*string/);
    expect(indexHtml).toContain('id="settings-version"');
    expect(settingsTs).toMatch(/function wireVersion\(\)/);
    expect(settingsTs).toMatch(/__APP_VERSION__/);
    expect(settingsPanel).toMatch(/\.settings-version\s*\{[^}]*color:\s*var\(--text-dim\)/s);
  });
});
