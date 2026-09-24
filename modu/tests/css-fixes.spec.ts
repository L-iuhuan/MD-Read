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
const printCss = readFileSync("src/typography/print.css", "utf8");
const main = readFileSync("src/main.ts", "utf8");
const html = readFileSync("index.html", "utf8");

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
    expect(tokens).toMatch(/--h-titlebar:\s*36px/);
    const offsets = app.match(/\.findbar\s*\{[^}]*inset-block-start:[^}]*/g) ?? [];
    const withTitlebar = offsets.filter((rule) => rule.includes("--h-titlebar"));
    expect(withTitlebar.length).toBeGreaterThanOrEqual(1);
  });
});

describe("P5 批3 性能锚点（content-visibility 分段 + 打印还原 + fragment 挂载）", () => {
  it("屏显分段：cjk.css .mdc > * 带 content-visibility:auto 与 auto 2lh 占位", () => {
    expect(cjk).toMatch(/\.mdc > \*\s*\{[^}]*content-visibility:\s*auto/);
    expect(cjk).toMatch(/\.mdc > \*\s*\{[^}]*contain-intrinsic-size:\s*auto 2lh/);
  });

  it("打印还原（宪法级红线·反向断言）：print.css 令 .mdc > * visible 并清占位，视口外内容必须进 PDF", () => {
    expect(printCss).toMatch(/\.mdc > \*\s*\{[^}]*content-visibility:\s*visible/);
    expect(printCss).toMatch(/\.mdc > \*\s*\{[^}]*contain-intrinsic-size:\s*auto\s*;/);
  });

  it("摘双重解析：main.ts 挂载走 fragment（adoptNode），不再 innerHTML 二次 parse", () => {
    expect(main).not.toMatch(/doc\.innerHTML/);
    expect(main).toMatch(/adoptNode/);
    expect(main).toMatch(/doc\.replaceChildren\(\)/);
  });
});

describe("用户反馈批次：导出修复锚", () => {
  it("问题一：mermaid 渲染成功态去框去底留呼吸位（源码态框与失败态虚线框保留）", () => {
    expect(cjk).toMatch(/\.mermaid\[data-rendered="1"\]\s*\{[^}]*border:\s*none/);
    expect(cjk).toMatch(/\.mermaid\[data-rendered="1"\]\s*\{[^}]*background:\s*transparent/);
    expect(cjk).toMatch(/\.mermaid\[data-rendered="1"\]\s*\{[^}]*padding-block-end:\s*\.4em/);
    expect(cjk).toMatch(/\.mermaid\[data-mmd-error\]\s*\{[^}]*border-style:\s*dashed/);
  });

  it("问题二（反向锚）：首页底色根除——根链 html/body/#app/.body-row 背景清零规则在位", () => {
    expect(printCss).toMatch(/html,\s*body,\s*#app,\s*\.body-row\s*\{[^}]*background:\s*none/);
  });
});

/* P0-5：宽表/大图撑破纸面 —— CSS 侧锚点。
   .table-wrap 的横向滚动只有在渲染层真的生成包裹层时才生效（正向锚在 render.spec.ts）；
   本组只锚「规则存在且打印红线未被破坏」。 */
describe("P0-5 宽表/大图：纸面宽度红线锚", () => {
  it(".table-wrap 提供横向滚动，且宽度上限不越出纸面（auto 宽 + max-inline-size）", () => {
    expect(cjk).toMatch(/\.mdc \.table-wrap\s*\{[^}]*overflow-x:\s*auto/);
    expect(cjk).toMatch(
      /\.mdc \.table-wrap\s*\{[^}]*max-inline-size:\s*var\(--measure-wide\)/,
    );
    // 反向锚：禁止用固定 inline-size/width 把 wrap 撑到纸外（只有上限才安全）
    expect(cjk).not.toMatch(/\.mdc \.table-wrap\s*\{[^}]*[^-]inline-size:\s*\d/);
  });

  it("大图限宽：.mdc img max-inline-size:100% + height:auto", () => {
    expect(cjk).toMatch(/\.mdc img\s*\{[^}]*max-inline-size:\s*100%/);
    expect(cjk).toMatch(/\.mdc img\s*\{[^}]*height:\s*auto/);
  });

  it("表格样式未被削弱：外框/圆角/末行线（无末行抑制规则）", () => {
    expect(cjk).toMatch(/\.mdc \.table-wrap\s*\{[^}]*border:\s*1px solid var\(--border\)/);
    expect(cjk).toMatch(/\.mdc \.table-wrap\s*\{[^}]*border-radius:\s*var\(--radius-2\)/);
    expect(cjk).toMatch(/\.mdc th, \.mdc td\s*\{[^}]*border-bottom:\s*1px solid var\(--border\)/);
    expect(cjk).not.toMatch(/tbody tr:last-child[^{]*\{[^}]*border-bottom:\s*0/);
  });

  it("打印分页红线未破：行级 tr avoid + thead 跨页重复，且无整表 avoid", () => {
    expect(printCss).toMatch(/\btr\s*\{[^}]*break-inside:\s*avoid/);
    expect(printCss).toMatch(/thead\s*\{[^}]*display:\s*table-header-group/);
    expect(printCss).not.toMatch(/(^|[},\s])table\s*\{[^}]*break-inside:\s*avoid/);
    // 屏显层（cjk.css）同两条规则也必须还在
    expect(cjk).toMatch(/\.mdc tr\s*\{\s*break-inside:\s*avoid/);
    expect(cjk).toMatch(/\.mdc thead\s*\{\s*display:\s*table-header-group/);
  });

  it("打印层还原滚动容器 + 清 wrap 限宽（滚动容器不可跨页分页，行级分页才作数）", () => {
    expect(printCss).toMatch(/\.mdc \.table-wrap\s*\{[^}]*overflow:\s*visible/);
    expect(printCss).toMatch(/\.mdc \.table-wrap\s*\{[^}]*max-inline-size:\s*none/);
    // 唯一打印层红线：不得出现第三份打印样式表（cjk.css 不写 @media print）
    expect(cjk).not.toMatch(/@media\s+print/);
  });
});

describe("用户反馈批次（本期 12 项）：交互与导出修复锚", () => {
  it("标签：拖拽半透明反馈 + ✕ 瘦身 18px + 焦点在标签上可见", () => {
    expect(app).toMatch(/\.tab\.dragging\s*\{[^}]*opacity/);
    expect(app).toMatch(/\.tab-close\s*\{[^}]*inline-size:\s*18px/);
    expect(app).toMatch(/\.tab:focus-within \.tab-close\s*,?[^{]*\{\s*opacity:\s*1/);
  });

  it("标题栏：「墨读」文字已删（titlebar-title 不复现），拖拽垫片保留", () => {
    expect(html).not.toMatch(/titlebar-title/);
    expect(app).not.toMatch(/titlebar-title/);
    expect(html).toMatch(/class="titlebar-drag" data-tauri-drag-region/);
  });

  it("最大化双态图标：#ic-max 单框 / #ic-restore 双框（还原态预置 hidden）", () => {
    expect(html).toMatch(/<svg id="ic-max"/);
    expect(html).toMatch(/<svg id="ic-restore"[^>]*hidden/);
  });

  it("CM 查找卡：勾选行 flex 对齐 + 右内边距为关闭钮留位", () => {
    expect(app).toMatch(
      /#editor-pane \.cm-search label\s*\{[^}]*display:\s*inline-flex[^}]*align-items:\s*center/s,
    );
    expect(app).toMatch(
      /#editor-pane \.cm-panel\.cm-search\s*\{[^}]*padding:[^}]*calc\(var\(--size-3\) \+ 32px\)/s,
    );
  });

  it("脚注分隔线：浅一阶 + 40% 短宽，.footnotes 不再画整幅 border-top（双横线消解）", () => {
    expect(cjk).toMatch(/\.mdc hr\.footnotes-sep\s*\{[^}]*max-inline-size:\s*40%/);
    expect(cjk).toMatch(/\.mdc hr\.footnotes-sep\s*\{[^}]*--border/);
    expect(cjk).not.toMatch(/\.mdc \.footnotes\s*\{[^}]*border-top/);
  });

  it("代码块复制钮：hover 浮现 + 打印退场 + pre 锚点化", () => {
    expect(cjk).toMatch(/\.mdc pre\[data-lang\]\s*\{\s*position:\s*relative/);
    expect(cjk).toMatch(/\.mdc \.code-copy\s*\{[^}]*opacity:\s*0/);
    expect(cjk).toMatch(/\.mdc pre:hover \.code-copy/);
    expect(printCss).toMatch(/\.mdc \.code-copy\s*\{[^}]*display:\s*none/);
  });

  it("行宽派生链：--measure 消费 --me-width（默认 46）", () => {
    expect(tokens).toMatch(
      /--measure:\s*calc\(var\(--me-width,\s*46\)\s*\*\s*var\(--fs-body\)\)/,
    );
  });

  it("主题三档：面板下拉含自动档（matchMedia 跟随接线在 ui/theme.ts）", () => {
    expect(html).toMatch(/<option value="auto">自动（跟随系统）<\/option>/);
    expect(main).toMatch(/watchSystemTheme\(\)/);
    expect(main).toMatch(/nextThemePref/);
  });

  it("标签快捷键：Ctrl+W 关标签 + Ctrl+Tab 循环（capture 拦截）", () => {
    expect(main).toMatch(/setupTabHotkeys/);
    expect(main).toMatch(/cycleTab\(event\.shiftKey \? -1 : 1\)/);
  });
});
