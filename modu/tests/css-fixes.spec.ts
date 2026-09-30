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
const hljs = readFileSync("src/typography/hljs.css", "utf8");
const printCss = readFileSync("src/typography/print.css", "utf8");
const main = readFileSync("src/main.ts", "utf8");
const themeSrc = readFileSync("src/ui/theme.ts", "utf8");
const zoomSrc = readFileSync("src/app/zoom.ts", "utf8");
// ⚠ **锚读"最终形态"，不读文件名** ✗（Phase 2.5 外移教训，2026-09-27）：
//   标签快捷键已搬到 src/app/tab-hotkeys.ts ⇒ 只读 main.ts 会假红 ✓。
//   **以后每外移一段 TS，把它加进这个清单，别改断言** ✓。
const mainPlusMovedModules = [main, readFileSync("src/app/tab-hotkeys.ts", "utf8")].join("\n");
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

  it("反馈⑤：顶栏刻度在 tokens，查找条定位计入顶栏高度（防回归重叠）", () => {
    // D-05 起顶栏只剩一层（--h-chrome = 48px），旧两层刻度（--h-titlebar/--h-topbar）已删
    expect(tokens).toMatch(/--h-chrome:\s*48px/);
    expect(tokens).not.toMatch(/--h-titlebar/);
    const offsets = app.match(/\.findbar\s*\{[^}]*inset-block-start:[^}]*/g) ?? [];
    const withChrome = offsets.filter((rule) => rule.includes("--h-chrome"));
    expect(withChrome.length).toBeGreaterThanOrEqual(1);
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
    // L1（Lane L）→ M1（FB-11 返修，2026-09-30）：表格顶 accent 细线（2px --accent-solid）
    // 从 wrap 顶边框**移到 thead th 顶边框**——线宽随表格本体（打印宽表横页才横贯全部列）。
    // 语义不放宽：外框三边/圆角仍 1px --border（顶边让位归零），行底线不动
    // （表头底按 O1/FB-13 改走 --bg-th，见文件末 Lane O 组）。
    expect(cjk).toMatch(
      /\.mdc thead th\s*\{[^}]*border-block-start:\s*2px solid var\(--accent-solid\)/,
    );
    expect(cjk).toMatch(/\.mdc \.table-wrap\s*\{[^}]*border-block-start:\s*0/);
    expect(cjk).not.toMatch(
      /\.mdc \.table-wrap\s*\{[^}]*border-block-start:\s*2px/,
    ); // 旧落点不得回归（线会只盖 wrap 宽）
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
    expect(app).toMatch(/\.tab:hover \.tab-close, \.tab:focus-within \.tab-close\s*\{\s*opacity:\s*1/);
  });

  it("顶栏：「墨读」文字与空拖拽垫片均已去（D-05 单栏合并，拖拽区改挂 header）", () => {
    expect(html).not.toMatch(/titlebar-title/);
    expect(app).not.toMatch(/titlebar-title/);
    // 空垫片 .titlebar-drag 已删：标签条自己吃掉剩余宽度（见 app.css §1）
    expect(html).not.toMatch(/titlebar-drag/);
    expect(app).not.toMatch(/\.titlebar-drag\s*\{/);
    // 拖拽区语义保留在本条栏里：data-tauri-drag-region 只写在标签条容器上
    expect(html).toMatch(/<div id="tabbar" class="tabbar" data-tauri-drag-region/);
    expect(html).toMatch(/<div id="tab-list" class="tab-list" role="tablist" data-tauri-drag-region/);
  });

  it("最大化双态图标：#ic-max 单框 / #ic-restore 双框（还原态预置 hidden）", () => {
    expect(html).toMatch(/<svg id="ic-max"/);
    expect(html).toMatch(/<svg id="ic-restore"[^>]*hidden/);
  });

  it("CM 查找卡：勾选行 flex 对齐 + 右内边距为关闭钮留位", () => {
    // P2 起这一组选择器放宽到 `:is(.cm-search, .cm-dialog)`（跳转行对话框共用同一套皮）
    expect(app).toMatch(
      /#editor-pane :is\(\.cm-search, \.cm-dialog\) label\s*\{[^}]*display:\s*inline-flex[^}]*align-items:\s*center/s,
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
    expect(cjk).toMatch(/\.mdc \.code-wrap:hover \.code-copy/);
  // 反向锚：P2Q-34 后钮不在 pre 内，`pre:hover .code-copy` 是死选择器（2026-09-30 主人实测回归），禁止回归
  expect(cjk).not.toMatch(/pre:hover \.code-copy/);
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
    expect(mainPlusMovedModules).toMatch(/cycleTab\(getTabs, event\.shiftKey \? -1 : 1\)/);
  });
});

/* Lane C 批次（2026-09-29）：C1 暗色导出 / C2 Alert 打印块归位 / C4 缩放污染 /
   C5 孤寡行 / C8 撒谎注释——沿用本文件「源码文本锚」模式（jsdom 无布局引擎）。 */
describe("Lane C：导出归一与打印契约锚", () => {
  it("C1/C4(+J2)：导出前归一主题与纸面缩放（先于量宽/等渲染），finally 无条件还原", () => {
    // 归一点必须先于 markPrintBlocks（量宽）与 awaitPrintReady（等渲染）
    const normalizeAt = main.indexOf('document.documentElement.dataset.theme = "light"');
    const measureAt = main.indexOf("markPrintBlocks(doc)");
    const waitAt = main.indexOf("awaitPrintReady(doc)");
    expect(normalizeAt).toBeGreaterThan(-1);
    expect(measureAt).toBeGreaterThan(normalizeAt);
    expect(waitAt).toBeGreaterThan(normalizeAt);
    // 偏好读 theme.ts 权威来源；还原按原偏好的解析值（auto 跟系统）。
    // J2（2026-09-30）：缩放目标从根元素换成纸面——导出前 clearPaperZoom()、
    // finally 在还原主题之后 restorePaperZoom()（清空/还原成对，语义不放宽 ✓）。
    expect(main).toMatch(/const savedThemePref = readThemePref\(\)/);
    expect(main).toMatch(/clearPaperZoom\(\)/);
    expect(main).toMatch(
      /\} finally \{[\s\S]*?resolvedTheme\(savedThemePref\)[\s\S]*?restorePaperZoom\(\)/,
    );
  });

  it("C4(+J2)：zoom.ts 纸面化——不再写根元素，历史注释写明叠乘风险", () => {
    expect(zoomSrc).not.toMatch(/不会比单给更差/);
    expect(zoomSrc).toMatch(/叠乘/);
    // J2：documentElement.style.zoom 不得再被 zoom.ts 写（写了就是整体放大回归 ✗）
    expect(zoomSrc).not.toMatch(/documentElement\.style\.zoom\s*=/);
  });

  it("C2：Alert 打印覆盖规则收进 @media print 块内（媒体块闭合后的顶层不复现）", () => {
    expect(printCss).toMatch(
      /\.mdc blockquote\.alert\s*\{[^}]*background:\s*transparent\s*!important/,
    );
    expect(printCss).toMatch(
      /\.mdc blockquote\.alert::before\s*\{[^}]*color:\s*currentColor\s*!important/,
    );
    // 位置锚：从 @media print 起点做花括号深度计数（源码文本锚口径，注释里无未配对花括号），
    // alert 规则必须处于深度 1（媒体块内）；挪回块外顶层（深度 0）即红——哪怕带 !important。
    const mediaAt = printCss.indexOf("@media print");
    const alertAt = printCss.indexOf(".mdc blockquote.alert");
    expect(mediaAt).toBeGreaterThanOrEqual(0);
    expect(alertAt).toBeGreaterThan(mediaAt);
    let depth = 0;
    for (let i = mediaAt; i < alertAt; i += 1) {
      const ch = printCss[i];
      if (ch === "{") depth += 1;
      else if (ch === "}") depth -= 1;
    }
    expect(depth).toBe(1);
  });

  it("C5：标题不孤悬页尾 + 段落/列表项孤寡行控制", () => {
    expect(printCss).toMatch(/h1,\s*h2,\s*h3,\s*h4,\s*h5,\s*h6\s*\{\s*break-after:\s*avoid/);
    expect(printCss).toMatch(/\.mdc p,\s*\.mdc li\s*\{[^}]*orphans:\s*2/);
    expect(printCss).toMatch(/\.mdc p,\s*\.mdc li\s*\{[^}]*widows:\s*2/);
  });

  it("C8：app.css §8 的「打印没清底色」过时注释已删（print.css 早已清零）", () => {
    expect(app).not.toMatch(/没清 #content\/#doc 的底色/);
  });

  it("C9：◐ 按钮 aria-label 与 title 同源同文案（theme.ts syncThemeButton）", () => {
    expect(themeSrc).toMatch(/setAttribute\("aria-label", text\)/);
    expect(themeSrc).toMatch(/function syncThemeButton\(/);
  });
});

/* Lane H 批次（2026-09-29）：导出静默化。暗色导出的暗→亮→暗跳变用「同帧冻结层」消解——
   export-state.css 只在 @media screen 命中（PrintToPdf 走 print media，零影响）；
   main.ts 里 add/remove 必须与主题切换落在同一同步块（中间无 await ⇒ 同一次 style recalc）。 */
describe("Lane H：导出冻结层（静默导出）锚", () => {
  const exportCss = readFileSync("src/ui/export-state.css", "utf8");

  it("冻结层只挂 screen 媒体：遮 #app + 居中提示，用色仅 token", () => {
    expect(exportCss).toMatch(/@media\s+screen\s*\{/);
    expect(exportCss).not.toMatch(/@media\s+print/); // 打印态零命中（静默化不得动 PDF）
    expect(exportCss).toMatch(/html\.exporting #app\s*\{[^}]*visibility:\s*hidden/);
    expect(exportCss).toMatch(/html\.exporting body::after\s*\{[^}]*place-items:\s*center/);
    expect(exportCss).toMatch(/html\.exporting body::after\s*\{[^}]*color:\s*var\(--text\)/);
    expect(exportCss).toMatch(/background:\s*var\(--bg-canvas\)/);
  });

  it("同帧时序：add(exporting) 先于亮色归一、finally 先还原主题再揭幕，两段中间无 await", () => {
    const addAt = main.indexOf('classList.add("exporting")');
    const lightAt = main.indexOf('document.documentElement.dataset.theme = "light"');
    const restoreAt = main.indexOf("document.documentElement.dataset.theme = restored");
    const removeAt = main.indexOf('classList.remove("exporting")');
    expect(addAt).toBeGreaterThan(-1);
    expect(lightAt).toBeGreaterThan(addAt); // 先遮屏、后变亮（同一次 recalc 生效）
    expect(main.slice(addAt, lightAt)).not.toContain("await"); // 同一同步块
    expect(restoreAt).toBeGreaterThan(-1);
    expect(removeAt).toBeGreaterThan(restoreAt); // 先还原主题、后揭幕（还原瞬间不闪亮）
    expect(main.slice(restoreAt, removeAt)).not.toContain("await"); // 还原与揭幕同块
    expect(main).toMatch(/import "\.\/ui\/export-state\.css"/); // 样式已接线
  });
});

/* Lane G 批次（2026-09-29）：视觉修复锚。G1 = 查找条右缘纸列基准；G5 = 纸面护栏
   （screen-only paint containment）；G8 = `.no-hit` 类名契约（挂/摘归 Lane I）；
   G2/G7 = 两处 token 值；G9/G10 = 孤儿删除与窗口三钮的皮外移接线。
   ⚠ G4（状态栏纸缘居中）与 G6（暗色纸缘 1px 线）已被主人实测推翻/替换 ⇒ 见下面 Lane K。 */
describe("Lane G：视觉批锚（纸列对齐 / 无结果计数 / 外移接线）", () => {
  it("G1：查找条右缘走 --paper-shift 纸列基准（状态栏已不消费，K2 回退）", () => {
    expect(app).toMatch(/--paper-shift:\s*var\(--w-outline\)/);
    expect(app).toMatch(
      /\.findbar\s*\{[^}]*inset-inline-end:\s*max\(var\(--size-4\),\s*calc\(\(100% - var\(--paper-shift\)/,
    );
  });

  it("G5：纸面护栏——screen-only paint containment（G6 线已删，K3 换明度分层）", () => {
    expect(app).toMatch(/@media screen\s*\{\s*#doc\s*\{\s*contain:\s*paint/);
  });

  it("G8：`.no-hit` 契约——样式只认类名，色走 --amber-11（挂/摘逻辑在 Lane I）", () => {
    expect(app).toMatch(/\.find-count\.no-hit\s*\{\s*color:\s*var\(--amber-11\)/);
    expect(tokens).toMatch(/--amber-11:\s*#ab6400/);
    expect(tokens).toMatch(/--amber-11:\s*#ffca16/);
  });

  it("G9：--bg-zebra 孤儿 token 已删（注释提及不算声明）", () => {
    expect(tokens).not.toMatch(/--bg-zebra\s*:/);
  });

  it("G10：窗口三钮的皮外移到 window-controls.css，并由 index.html <link> 接线", () => {
    expect(html).toMatch(/<link rel="stylesheet" href="\/src\/app\/window-controls\.css"/);
    const win = readFileSync("src/app/window-controls.css", "utf8");
    expect(win).toMatch(
      /\.topbar > #win-close\s*\{\s*inline-size:\s*calc\(var\(--w-winbtn\) \+ 8px\)/,
    );
    expect(app).not.toMatch(/\.topbar > #win-min\s*,/); // 老位置不留残段
  });

  it("G2/G7/L2：暗色 --bg-subtle 重算（hair 92% × fg 8%）+ 淡出值 .4 → .6", () => {
    // L2（Lane L，2026-09-30，连锚裁决）：G2 原配方（20% chrome）在 K3 提亮暗色纸面后
    // 对新纸面只剩 1.13~1.14:1 ⇒ 参照 K4·mmd 手法改为「hair 92% × fg 8%」。
    // 旧值史（只留档在此，不留在代码）：pre-G2 45% chrome（对纸面 1.36~1.42）→ G2 20% chrome
    // （K3 前 1.55~1.62）→ K3 后 1.13~1.14 → L2 本次（探针实测 1.515~1.555）。
    // 语义不放宽：本 token 仍是「行内代码底 / 复制钮 hover 底」；亮色配方一字未动。
    expect(tokens).toMatch(
      /--bg-subtle:\s*color-mix\(in oklab, var\(--pal-hair\) 92%, var\(--pal-fg\)\)/,
    );
    // 反向锚：旧配方不得回归（K3 后它会重新掉回 1.13~1.14）
    expect(tokens).not.toMatch(
      /--bg-subtle:\s*color-mix\(in oklab, var\(--pal-chrome\) 20%/,
    );
    expect(tokens).toMatch(/--opacity-dim:\s*\.6/);
  });
});

/* Lane K 批次（2026-09-29 主人实测三件）：K1 = CM 查找/替换卡上提编辑器顶部
   （editor.ts search({ top: true })），与阅读态 findbar 同右缘/同 z 档；K2 = 状态栏读数
   回退贴窗口两缘（G4 作废）；K3 = 暗色纸面提档（纸/画布 ≥1.25:1），G6 的 1px 内线删除。 */
describe("Lane K：主人实测三件（查找上提 / 状态栏回退 / 暗色纸面）", () => {
  it("K1：编辑器 search 扩展 top:true + 卡片与 findbar 同基准（右缘=纸列右缘、z 同档）", () => {
    const editorSrc = readFileSync("src/editor/editor.ts", "utf8");
    expect(editorSrc).toMatch(/search\(\{\s*top:\s*true\s*\}\)/);
    expect(app).toMatch(/#editor-pane \.cm-panels\s*\{[^}]*z-index:\s*var\(--z-float\)/);
    expect(app).toMatch(
      /#editor-pane \.cm-panel\.cm-search\s*\{[^}]*margin:[^}]*max\(var\(--size-4\),\s*calc\(\(100% - var\(--measure\)/,
    );
    // 位置契约注释已改写：顶部新契约 + 旧「上/下沿故意不同」措辞退场
    expect(app).toMatch(/2026-09-29 主人实测裁决/);
    expect(app).not.toMatch(/上\/下沿/);
  });

  it("K2：状态栏两端读数回退贴窗口两缘（padding: 0 --size-3，不再消费 --paper-shift）", () => {
    const bar = /\.statusbar\s*\{([^}]*)\}/.exec(app)?.[1] ?? "";
    expect(bar).toMatch(/padding:\s*0 var\(--size-3\)/);
    expect(bar).not.toMatch(/--paper-shift/);
  });

  it("K3：暗色五组 --pal-paper 提档（对画布 ≥1.25:1），G6 内线已删", () => {
    for (const v of ["#2d323a", "#33312e", "#313437", "#2f2f3b", "#2c3533"]) {
      expect(tokens).toContain(`--pal-paper: ${v};`);
    }
    expect(tokens).not.toMatch(/--pal-paper:\s*#12151a/);
    expect(tokens).not.toMatch(/--pal-paper:\s*#15151d/);
    expect(app).not.toMatch(/\[data-theme="dark"\] #doc\s*\{[^}]*box-shadow/);
  });
});

/* Lane L 批次（2026-09-30 第四轮·纸面主题色）：FB-8 着色（H2-H4 accent 墨 / 引用 tint /
   表头顶线 / 脚注引用 / 勾选态 / 语言标签）+ P2-37 灰字 dim 豁免 + P2-39 --bg-subtle 连锚
   （见上方 G2/L2）+ L4 死规则清理。所有锚钉「规则存在 / 反向不复现」；实测对比数
   （Edge 153 探针十组）随行注明，jsdom 无布局引擎、不对数值做断言。 */
describe("Lane L：纸面主题色（FB-8）与尾巴锚", () => {
  /** 剥注释副本：反向断言用（注释里的留档文本不算代码） */
  const cjkBody = cjk.replace(/\/\*[\s\S]*?\*\//g, "");
  const appBody = app.replace(/\/\*[\s\S]*?\*\//g, "");

  it("L1a：H2-H4 小节标题走 accent 墨（M2 起专用 --accent-ink）；H1/正文/公式/金额保持中性（红线）", () => {
    expect(cjk).toMatch(/\.mdc h2, \.mdc h3, \.mdc h4\s*\{\s*color:\s*var\(--accent-ink\)/);
    // M2（FB-11 返修）：专用墨档的亮/暗两式（oklch 相对色，只调明度、色相/彩度守恒）
    expect(tokens).toMatch(
      /--accent-ink:\s*oklch\(from var\(--pal-accent\) calc\(l - 0\.1\) c h\)/,
    );
    expect(tokens).toMatch(
      /--accent-ink:\s*oklch\(from var\(--pal-accent\) calc\(l \+ 0\.05\) c h\)/,
    );
    // 标题不得回退到 pal-on 档（除宣纸外暗色组发灰的根因）
    expect(cjkBody).not.toMatch(/\.mdc h[234][^{]*\{[^}]*color:\s*var\(--accent-text/);
    const h1 = /\.mdc h1 \{[^}]*\}/.exec(cjk)?.[0] ?? "";
    expect(h1).not.toMatch(/accent/);
    // H4 旧灰值退役（改为 accent 墨后不得留 --text-muted 声明）
    expect(cjkBody).not.toMatch(/\.mdc h4\s*\{[^}]*color:\s*var\(--text-muted\)/);
    // 红线：正文段落 / 金额（td·th 含 .num 列）不得被着色逻辑命中
    // （\b 防前缀误伤：`.mdc p` 会误命中 `.mdc pre`、`.mdc th` 会误命中 `.mdc thead`）
    expect(cjkBody).not.toMatch(/\.mdc p\b[^{]*\{[^}]*color:\s*var\(--accent/);
    expect(cjkBody).not.toMatch(/\.mdc (td|th)\b[^{]*\{[^}]*color:\s*var\(--accent/);
    // 红线：公式本体（KaTeX 印刷黑 / 中文降级）不得进任何 accent
    expect(cjkBody).not.toMatch(/\.katex[^{]*\{[^}]*color:\s*var\(--accent/);
    expect(cjkBody).not.toMatch(/\.math-fallback[^{]*\{[^}]*color:\s*var\(--accent/);
  });

  it("L1b：引用块 = 4px accent 边条 + --tint-quote 淡底；Alert 各自语义色不动", () => {
    expect(cjk).toMatch(
      /\.mdc blockquote\s*\{[^}]*border-inline-start:\s*4px solid var\(--accent-solid\)/,
    );
    expect(cjk).toMatch(/\.mdc blockquote\s*\{[^}]*background:\s*var\(--tint-quote\)/);
    // tint 双子（N1 起：亮 7% --accent-ink / 暗 5% --accent-solid 不变；
    // 对纸面实测 1.167~1.243:1 ≥ 阈值 1.15——jsdom 不数数值，配方见 tokens 注释）
    expect(tokens).toMatch(
      /--tint-quote:\s*color-mix\(in oklab, var\(--bg-quote\) 93%, var\(--accent-ink\)\)/,
    );
    expect(tokens).toMatch(
      /--tint-quote:\s*color-mix\(in oklab, var\(--bg-quote\) 95%, var\(--accent-solid\)\)/,
    );
    // Alert 五类语义色不被「边条语言统一」波及（抽样 NOTE/CAUTION）
    expect(cjk).toMatch(
      /\.mdc blockquote\.alert-note\s*\{[^}]*border-inline-start-color:\s*var\(--alert-note-line\)/,
    );
    expect(cjk).toMatch(
      /\.mdc blockquote\.alert-caution\s*\{[^}]*border-inline-start-color:\s*var\(--alert-caution-line\)/,
    );
    // 旧内联混色与两行兜底已退役（改走 token；兜底行在变量替换语义下从未可达）
    expect(cjkBody).not.toMatch(/var\(--bg-quote\) 94%, var\(--accent-text\)/);
    expect(cjkBody).not.toMatch(/background:\s*var\(--bg-quote\);\s*\n\s*background:/);
  });

  it("L1c：脚注引用上标补 accent（M2 起 --accent-ink）；fn-ref 死选择器退役、真类名 footnote-ref", () => {
    expect(cjk).toMatch(/\.mdc \.footnote-ref a\s*\{[^}]*color:\s*var\(--accent-ink\)/);
    expect(cjkBody).not.toMatch(/\.fn-ref/);
  });

  it("L1d：语言标签 accent（M2 起 --accent-ink）——hljs 冻结层的唯一定向覆盖（一档特异度）", () => {
    // hljs.css 仍是冻结层：标签色写死在那里（本锚同时钉住这层耦合）
    expect(hljs).toMatch(
      /\.mdc pre\[data-lang\][^{]*::before\s*\{[^}]*color:\s*var\(--text-muted\)/,
    );
    expect(cjk).toMatch(
      /\.mdc\.mdc pre\[data-lang\]:not\(:has\(\.code-lang\)\)::before\s*\{\s*color:\s*var\(--accent-ink\)/,
    );
  });

  it("L1e：勾选态自绘 accent（原生 disabled 灰底实测根因）；未勾选保持中性", () => {
    expect(cjk).toMatch(/\.mdc input\[type="checkbox"\]\s*\{[^}]*appearance:\s*none/);
    expect(cjk).toMatch(
      /\.mdc input\[type="checkbox"\]\s*\{[^}]*border:\s*1px solid var\(--border-strong\)/,
    );
    expect(cjk).toMatch(/\.mdc input\[type="checkbox"\]\s*\{[^}]*background:\s*var\(--bg-app\)/);
    expect(cjk).toMatch(
      /\.mdc input\[type="checkbox"\]:checked\s*\{[^}]*background:\s*var\(--accent-solid\)/,
    );
    expect(cjk).toMatch(
      /\.mdc input\[type="checkbox"\]:checked::after\s*\{[^}]*border:\s*solid var\(--bg-app\)/,
    );
  });

  it("P2-37：灰字 dim 豁免 = 定向重映射（门同四条豁免；机制与豁免规则不动）", () => {
    const l3 =
      /html:not\(\.panel-open\):not\(\.editing\) body\.chrome-dim[\s\S]*?\n\}/.exec(app)?.[0] ??
      "";
    expect(l3).toMatch(/\.topbar:not\(:hover\):not\(:focus-within\)/);
    expect(l3).toMatch(/--text-muted:\s*var\(--text\)/);
    expect(l3).not.toMatch(/opacity/); // 只换墨、不碰淡出机制
    // 窄豁免：不得扩到菜单条目/窗口三钮
    expect(l3).not.toMatch(/\.menu-item/);
    expect(l3).not.toMatch(/#win-/);
  });

  it("L4：.settings-effective 死规则整批删除（DOM 退役、grep 零消费方）", () => {
    expect(appBody).not.toMatch(/settings-effective/);
    // 保留的字体行不折行档仍在
    expect(app).toMatch(
      /\.settings-panel \.settings-font \.settings-label\s*\{\s*white-space:\s*nowrap/,
    );
  });
});

/* Lane N 批次（2026-09-30 第五轮返修 · FB-12「文档其他着色仍灰」）：链接与引用 tint
   的混色基从旧档（--accent-text = pal-on 低彩墨）换到纸面墨档 --accent-ink。
   实测数（Edge 探针十组；jsdom 无布局引擎、只钉规则存在/不复现，不对数值做断言）：
   链接对纸面 5.74~11.25:1（旧 6.45~9.52）、hover 6.68~12.31:1；
   tint 对纸面 1.167~1.243（暗色侧维持 5% solid 不动，1.162~1.206）。 */
describe("Lane N：残余灰源（FB-12）——链接/tint 走 --accent-ink", () => {
  const cjkBody = cjk.replace(/\/\*[\s\S]*?\*\//g, "");

  it("N1a：链接与 hover 走纸面墨档；--accent-ink-hover 落地（78/22 同族配方）", () => {
    expect(cjk).toMatch(/\.mdc a\s*\{\s*color:\s*var\(--accent-ink\)/);
    expect(cjk).toMatch(/\.mdc a:hover\s*\{\s*color:\s*var\(--accent-ink-hover\)/);
    expect(tokens).toMatch(
      /--accent-ink-hover:\s*color-mix\(in oklab, var\(--accent-ink\) 78%, var\(--pal-fg\)\)/,
    );
    // 反向锚：.mdc a / .mdc a:hover 两式不得再出现旧档（accent-text 系）
    expect(cjkBody).not.toMatch(/\.mdc a(?::hover)?\s*\{[^}]*var\(--accent-text/);
  });

  it("N1b：纸面层对旧档零消费（--accent-text 在 cjk 正文规则中清零；tint 旧基不回归）", () => {
    expect(cjkBody).not.toMatch(/var\(--accent-text/);
    expect(tokens).not.toMatch(/--tint-quote:[^;]*var\(--accent-text/);
  });
});

/* Lane O 批次（2026-09-30 第六轮 · FB-13「代码块、表格等着色也都是灰的」）：
   O1 表头淡 accent 底接线（--bg-th；连 panel-unify P6 锚）；O2 代码块/行内代码底
   accent 化 tint（--bg-code / --bg-code-inline，原中性灰 --bg-subtle 系退役）；
   O3 hljs 关键词提彩（受限单裁，**主人 2026-09-30 授权解冻饱和度**：仅关键词
   彩度 ×1.3，色相/明度不动）。
   实测数（复算探针，与真机像素探针同口径；jsdom 无布局引擎、只钉规则存在/不复现）：
   表头文字对 --bg-th 8.8~13.9:1（≥4.5 十组）；代码字对 --bg-code 改后 ≥ 改前
   （minΔ 亮 +0.10 / 暗 +0.14）；行内字对 --bg-code-inline minΔ 亮 +0.50 / 暗 +0.49；
   关键词彩度比（对 --accent-ink）0.59~0.74 → 0.70~1.33。 */
describe("Lane O：表头/代码底 accent 化（FB-13）与 hljs 关键词提彩", () => {
  const cjkBody = cjk.replace(/\/\*[\s\S]*?\*\//g, "");

  it("O1：表头底走 --bg-th，表格骨架（顶线/行底线/圆角）不动", () => {
    expect(cjk).toMatch(/\.mdc thead th\s*\{[^}]*background:\s*var\(--bg-th\)/);
    expect(cjk).toMatch(/\.mdc thead th\s*\{[^}]*color:\s*var\(--text\)/);
    // 反向锚：不得回退旧中性灰路线（--bg-code 是代码块的料，不再上表头）
    expect(cjkBody).not.toMatch(/\.mdc thead th\s*\{[^}]*background:\s*var\(--bg-code\)/);
    // 顶 accent 线（M1 落点）仍在
    expect(cjk).toMatch(
      /\.mdc thead th\s*\{[^}]*border-block-start:\s*2px solid var\(--accent-solid\)/,
    );
    // 末行线抑制不得复现（与 P0-5 组同口径）
    expect(cjk).not.toMatch(/tbody tr:last-child[^{]*\{[^}]*border-bottom:\s*0/);
  });

  it("O1/O2：tokens 双态配方（亮 ink / 暗 solid+tint；十组同族派生）", () => {
    expect(tokens).toMatch(
      /--bg-code:\s*color-mix\(in oklab, var\(--bg-paper\) 90%, var\(--accent-ink\)\)/,
    );
    expect(tokens).toMatch(
      /--bg-code-inline:\s*color-mix\(in oklab, var\(--bg-paper\) 94%, var\(--accent-ink\)\)/,
    );
    expect(tokens).toMatch(
      /--bg-th:\s*color-mix\(in oklab, var\(--bg-paper\) 90%, var\(--accent-ink\)\)/,
    );
    expect(tokens).toMatch(
      /--bg-code:\s*color-mix\(in oklab, var\(--bg-paper\) 40%, var\(--accent-tint\)\)/,
    );
    expect(tokens).toMatch(
      /--bg-code-inline:\s*color-mix\(in oklab, var\(--bg-paper\) 82%, var\(--accent-solid\)\)/,
    );
    expect(tokens).toMatch(
      /--bg-th:\s*color-mix\(in oklab, var\(--bg-paper\) 90%, var\(--accent-solid\)\)/,
    );
    // 反向锚：旧「45% chrome × hair」中性灰配方不得回归到这三个名上
    expect(tokens).not.toMatch(/--bg-(code|code-inline|th):\s*color-mix\(in oklab, var\(--pal-chrome\)/);
  });

  it("O2：行内芯片走 --bg-code-inline；--bg-subtle 仍留真实消费方（复制钮 hover）", () => {
    expect(cjk).toMatch(
      /\.mdc :not\(pre\) > code\s*\{[^}]*background:\s*var\(--bg-code-inline\)/,
    );
    // 反向锚：芯片规则不得再出现 --bg-subtle（旧料退役）
    expect(cjkBody).not.toMatch(/\.mdc :not\(pre\) > code\s*\{[^}]*var\(--bg-subtle\)/);
    // P6 口径：--bg-subtle 不得悬空 —— G2/L2 校准的消费方（复制钮 hover）保持
    expect(cjk).toMatch(/\.mdc \.code-copy:hover\s*\{[^}]*background:\s*var\(--bg-subtle\)/);
  });

  it("O2：代码块底仍由 hljs.css 铺 --bg-code（行内/块底同族不同档）", () => {
    expect(hljs).toMatch(
      /\.mdc pre:has\(> code\.hljs\)\s*\{[^}]*background:\s*var\(--bg-code\)/,
    );
  });

  it("O3：hljs 关键词提彩 ×1.3（授权解冻；色相/明度不动、非逐调色板变体）", () => {
    // 公式：oklch 相对色只乘彩度 c，l 与 h 原样透传（色相 = 原色相，零改写）
    expect(hljs).toMatch(
      /--hljs-keyword:\s*oklch\(from color-mix\(in oklab, var\(--blue-11\) 70%, var\(--blue-12\)\) l calc\(c \* 1\.3\) h\)/,
    );
    expect(hljs).toMatch(/--hljs-keyword:\s*oklch\(from var\(--blue-11\) l calc\(c \* 1\.3\) h\)/);
    expect(hljs.match(/--hljs-keyword\s*:/g)?.length, "只许亮/暗两块各一条").toBe(2);
    expect(hljs, "授权说明必须随锚留档").toContain("授权解冻饱和度");
    // 其余语法色不动（抽样 --hljs-name，与 panel-unify P7 同口径不回归）
    expect(hljs).toMatch(/--hljs-name:\s*color-mix\(in oklab, var\(--red-11\) 70%, var\(--red-12\)\)/);
  });

  it("中性红线未破（反向锚复核）：正文/金额/纸底零 accent 消费", () => {
    expect(cjkBody).not.toMatch(/\.mdc p\b[^{]*\{[^}]*color:\s*var\(--accent/);
    expect(cjkBody).not.toMatch(/\.mdc (td|th)\b[^{]*\{[^}]*color:\s*var\(--accent/);
    // 金额所在 td 不得获得任何底色（表头是本批唯一被 tint 的表格面）
    expect(cjkBody).not.toMatch(/\.mdc td[\s,{][^{]*\{[^}]*background/);
    // 纸底映射不动
    expect(tokens).toMatch(/--bg-app:\s*var\(--pal-paper\)/);
  });
});
