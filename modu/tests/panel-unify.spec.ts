/**
 * P2 第二步 · 面板/浮层 UI 统一批次的回归锚（依据 docs/tasks/Phase2-面板UI一致性审计-2026-09-23.md）。
 * jsdom 无布局引擎，故本文件只锚「CSS 里写了什么」——把审计里每一条
 * 「实测穿帮」翻译成一条静态断言，防的是同一处再被权重/选择器穿透回去：
 *   P1 顶栏按钮不得用后代选择器（会穿透进最近下拉，整列变「一排小按钮」）
 *   P2 CM6 跳转行对话框的内部控件必须在重皮范围内
 *   P3 焦点规则不得改写 border-radius
 *   P4 关窗浮层主按钮不得回退为实心强调填充（宣纸·亮 4.39:1）
 *   P5 不得再留「两态查找工具是同一件东西」这类与实测不符的注释
 *   P6 已定义未接线的 token 必须有真实消费方，或按注释说明留待批次
 *   P7 hljs 函数名红走 11×12 混色，三级文字不再用装饰档
 * ⚠ vitest 会把 .css?raw 桩化为空串，故走 fs 直读（cwd = 项目根）。
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const app = readFileSync("src/app.css", "utf8");
const cjk = readFileSync("src/typography/cjk.css", "utf8");
const hljs = readFileSync("src/typography/hljs.css", "utf8");
const tokens = readFileSync("src/typography/tokens.css", "utf8");
const html = readFileSync("index.html", "utf8");
const mainSrc = readFileSync("src/main.ts", "utf8");
const tabsSrc = readFileSync("src/app/tabs.ts", "utf8");
const menuSrc = readFileSync("src/ui/tabs-menu.ts", "utf8");
const closeOverlaySrc = readFileSync("src/ui/findbar.ts", "utf8");

/** 剥掉注释：注释里说明性文字不算规则（P5 的反向锚另有专门用例） */
function stripComments(css: string): string {
  return css.replace(/\/\*[\s\S]*?\*\//g, "");
}
const appBody = stripComments(app);
const tokensBody = stripComments(tokens);
const hljsBody = stripComments(hljs);

describe("P1 最近下拉条目不再被顶栏按钮权重压过", () => {
  it("顶栏按钮规则只认「动作区的直属结构」，不存在 `.topbar button` 这个后代选择器", () => {
    // 反向锚：裸后代选择器会让 .topbar 的按钮皮穿透进 #recent-menu / #settings-panel /
    // #tabs-menu / #overflow-menu 的条目，把它们渲染成「一排小按钮」（I-1 的根因）。
    expect(appBody).not.toMatch(/\.topbar button(?![-\w])/);
    expect(appBody).toMatch(/\.actions > button\b/);
    expect(appBody).toMatch(/\.actions > \.recent-wrap > button\b/);
    expect(appBody).toMatch(/\.actions > \.settings-wrap > button\b/);
    expect(appBody).toMatch(/\.actions > \.overflow-wrap > button\b/);
  });

  it("index.html 里的动作区入口钮确实落在上述结构内（直属 + 三个包装层）", () => {
    // 本批起文件入口只剩标签条的「＋」，动作区里不再有并列的「打开」按钮
    const directIds = ["btn-edit", "btn-theme", "btn-export"];
    for (const id of directIds) {
      // 直属按钮：`<button id="…"` 紧跟换行/缩进，且不嵌在包装 div 里
      expect(html).toMatch(new RegExp(`<button id="${id}"`));
    }
    expect(html).toMatch(/<div id="recent-wrap" class="recent-wrap">\s*<button id="btn-recent"/);
    expect(html).toMatch(/<div class="settings-wrap">\s*<button id="btn-settings"/);
    expect(html).toMatch(/<div id="overflow-wrap" class="overflow-wrap">\s*<button id="btn-overflow"/);
    // 反向锚：与「＋」重复的动作区「打开」按钮不得回来（含 id 与文案两种写法）
    expect(html).not.toMatch(/btn-open/);
    expect(html).not.toMatch(/>打开<\/button>/);
    // D-05：☰ 与标签条在动作区**之外**（左组），不参与这套按钮皮
    const stripped = html.replace(/<!--[\s\S]*?-->/g, "");
    expect(stripped).toMatch(/<button id="btn-outline"[^>]*>☰<\/button>\s*<div id="tabbar"/);
  });

  it("条目回到列表项语言：7px 圆角 + 无描边 + hover 面 + 左侧 3px accent 色条", () => {
    expect(app).toMatch(/\.menu-item\s*\{[^}]*border:\s*0/);
    expect(app).toMatch(/\.menu-item\s*\{[^}]*border-radius:\s*var\(--radius-1\)/);
    expect(app).toMatch(/\.menu-item\s*\{[^}]*border-inline-start:\s*3px solid transparent/);
    expect(app).toMatch(/\.menu-item:hover\s*\{[^}]*background:\s*var\(--bg-hover\)/);
    expect(app).toMatch(/\.menu-item:hover\s*\{[^}]*border-inline-start-color:\s*var\(--accent-solid\)/);
  });

  it("条目不再有 height 被改写的可能（28px 只属于动作区那几段结构）", () => {
    // 剥注释后再断言，否则文件头的变更纪要会把「.menu-item」与紧邻的 height 串成假命中
    expect(appBody).not.toMatch(/\.menu-item\s*\{[^}]*height:/);
    expect(appBody).not.toMatch(/\.menu-item[^{]*\{[^}]*height:\s*var\(--h-ctl\)/);
  });
});

describe("P2 CM6 跳转行对话框内部控件纳入重皮范围", () => {
  it("输入框/按钮/标签三组选择器都放宽到 :is(.cm-search, .cm-dialog)", () => {
    expect(app).toMatch(/#editor-pane :is\(\.cm-search, \.cm-dialog\) \.cm-textfield\s*\{/);
    expect(app).toMatch(/#editor-pane :is\(\.cm-search, \.cm-dialog\) \.cm-button\s*\{/);
    expect(app).toMatch(/#editor-pane :is\(\.cm-search, \.cm-dialog\) label\s*\{/);
    // 反向锚：旧的一元写法不得残留（它就是「对话框控件全裸」的根因）
    expect(app).not.toMatch(/#editor-pane \.cm-search \.cm-textfield\s*\{/);
    expect(app).not.toMatch(/#editor-pane \.cm-search \.cm-button\s*\{/);
  });

  it("控件皮走 token：28px 高 + radius-2 + 1px --border + 轻投影", () => {
    const field = /#editor-pane :is\(\.cm-search, \.cm-dialog\) \.cm-textfield\s*\{([^}]*)\}/.exec(app)?.[1] ?? "";
    expect(field).toMatch(/height:\s*var\(--h-ctl\)/);
    expect(field).toMatch(/border-radius:\s*var\(--radius-2\)/);
    expect(field).toMatch(/border:\s*1px solid var\(--border\)/);
    expect(field).toMatch(/box-shadow:\s*var\(--shadow-ctl\)/);
  });

  it(".cm-dialog 留出关闭钮车道（修关闭钮与「跳转」按钮横向重叠 16px）", () => {
    const dialog = /#editor-pane \.cm-dialog\s*\{([^}]*)\}/.exec(app)?.[1] ?? "";
    expect(dialog).toMatch(/padding:[^;]*calc\(var\(--size-3\) \+ 32px\)/);
  });

  it("既有命中高亮规则不被 :is() 波及（.cm-search 不匹配 .cm-searchMatch）", () => {
    expect(app).toMatch(/#editor-pane \.cm-searchMatch\s*\{[^}]*background:\s*var\(--accent-tint\)/);
    expect(app).toMatch(/#editor-pane \.cm-searchMatch-selected/);
  });
});

describe("P3 焦点态只加 outline，不改圆角", () => {
  it("全控件 focus-visible 规则里没有 border-radius", () => {
    const rule = /#app :where\(button, input, a, select, \[tabindex\]\):focus-visible\s*\{([^}]*)\}/.exec(app)?.[1] ?? "";
    expect(rule).toContain("outline: 2px solid var(--focus-ring)");
    expect(rule).not.toMatch(/border-radius/);
  });
});

describe("P4 关窗浮层主按钮不再实心强调填充", () => {
  it("主按钮三件套 = 软底 + accent 描边 + 软底文字，且带 hover 抬档", () => {
    const primary = /#close-guard button\.guard-primary\s*\{([^}]*)\}/.exec(app)?.[1] ?? "";
    expect(primary).toMatch(/background:\s*var\(--accent-tint\)/);
    expect(primary).toMatch(/color:\s*var\(--on-accent-soft\)/);
    expect(primary).toMatch(/border-color:\s*var\(--accent-solid\)/);
    expect(app).toMatch(/#close-guard button\.guard-primary:hover\s*\{[^}]*background:\s*var\(--accent-tint-hover\)/);
  });

  it("反向锚：实心填充 + 纸面文字的旧写法不得复现", () => {
    expect(app).not.toMatch(/#close-guard button\.guard-primary\s*\{[^}]*background:\s*var\(--accent-solid\)/);
    expect(app).not.toMatch(/#close-guard button\.guard-primary\s*\{[^}]*color:\s*var\(--bg-app\)/);
  });

  it("按钮高度走 --h-ctl（复核 D-01 的 31px → 28px）", () => {
    expect(app).toMatch(/#close-guard button\s*\{[^}]*block-size:\s*var\(--h-ctl\)/);
  });
});

describe("P5 两态查找工具：注释如实说明位置差异", () => {
  it("不再声称与 findbar「同角落、同一件东西」", () => {
    expect(app).not.toContain("编辑/阅读两态的查找工具看起来是同一件东西");
    expect(app).not.toMatch(/与 findbar 同角落/);
  });

  it("如实写明：编辑态在 .cm-panels-bottom，阅读态在内容区右上", () => {
    expect(app).toContain(".cm-panels-bottom");
    expect(app).toMatch(/故意不同/);
  });
});

describe("P6 已定义未接线的 token 归位", () => {
  it("--border-chrome 回到壳层分隔语义（--line），控件描边走 --border", () => {
    expect(tokensBody).toMatch(/--line:\s*var\(--pal-line\)/);
    expect(tokensBody).toMatch(/--border-chrome:\s*var\(--line\)/);
    expect(appBody).toMatch(/\.actions > button,[\s\S]*?\{[^}]*border:\s*1px solid var\(--border\)/);
  });

  it("--shadow-ctl / --shadow-seg / --on-accent-soft 各有真实消费方", () => {
    expect(appBody).toMatch(/box-shadow:\s*var\(--shadow-ctl\)/);
    expect(appBody).toMatch(/box-shadow:\s*var\(--shadow-seg\)/);
    expect(appBody).toMatch(/color:\s*var\(--on-accent-soft\)/);
    // 微浮控件走同一档轻投影（审计 I-6）
    expect(cjk).toMatch(/\.mdc \.code-copy\s*\{[^}]*box-shadow:\s*var\(--shadow-ctl\)/);
  });

  it("--bg-th 按注释明确留给「正文排版」批（本批不动正文消费方）", () => {
    expect(tokens).toMatch(/--bg-th:\s*var\(--pal-th\)/);
    expect(tokens).toContain("本批（面板/控件）故意不接线");
    expect(cjk).toMatch(/\.mdc thead th\s*\{[^}]*background:\s*var\(--bg-code\)/);
  });
});

describe("P7 对比度修正", () => {
  it("hljs 函数名红 = red.11 × red.12 7:3，且 tokens 提供 --red-12 亮暗两档", () => {
    expect(hljsBody).toMatch(/--hljs-name:\s*color-mix\(in oklab, var\(--red-11\) 70%, var\(--red-12\)\)/);
    expect(tokensBody.match(/--red-12:/g)?.length).toBe(2);
  });

  it("三级文字由装饰档改成可读档，且有真实消费方（下拉空态 + 两行式第二行）", () => {
    expect(tokensBody).toMatch(/--fg-dim:\s*color-mix\(in oklab, var\(--pal-dim\) 60%, var\(--pal-fg\)\)/);
    // 三处菜单空态共用一条规则（最近下拉 / 全部标签 / ⋯ 溢出）
    expect(appBody).toMatch(
      /\.recent-menu \.recent-empty,\s*\n\.tabs-menu \.recent-empty,\s*\n\.overflow-menu \.recent-empty\s*\{[^}]*color:\s*var\(--fg-dim\)/,
    );
    expect(appBody).toMatch(/\.menu-item \.menu-path\s*\{[^}]*color:\s*var\(--fg-dim\)/);
  });

  it("焦点环仍由 2px --accent-solid outline 承担（实测 ≥3:1，故不改）", () => {
    expect(tokensBody).toMatch(/--focus-ring:\s*var\(--pal-accent\)/);
    expect(appBody).toMatch(/outline:\s*2px solid var\(--focus-ring\)/);
  });
});

/**
 * D-05 壳层视觉施工（T1 顶栏 + S1 标签 + B2 轻分层）的静态锚点。
 * 只锚「CSS/HTML 里写了什么」；顶栏实测高度、标签下划线与分隔线相对栏底/文字的
 * 实测数值走 CDP 真机（报告 §5）。
 */
describe("D-05 T1 单栏合并顶栏", () => {
  it("顶栏只有一层：--h-chrome 48px，旧两层刻度不再被任何规则消费", () => {
    expect(tokensBody).toMatch(/--h-chrome:\s*48px/);
    expect(appBody).not.toMatch(/--h-titlebar/);
    expect(appBody).not.toMatch(/--h-topbar/);
    expect(appBody).toMatch(/\.topbar\s*\{[^}]*height:\s*var\(--h-chrome\)/);
  });

  it("index.html 是单条 <header>，且同时挂 id=titlebar 与 class=topbar（兼容旧退场名单）", () => {
    expect(html).toMatch(/<header id="titlebar" class="topbar"/);
    // 旧的两层结构不得复现
    expect(html).not.toMatch(/<header class="topbar">/);
    expect(html).not.toMatch(/class="titlebar"/);
    expect(html).not.toMatch(/titlebar-drag/);
    expect(html).not.toMatch(/topbar-spacer/);
  });

  it("中间那个与标签重复的文件名已删（#doc-title 不再出现在 HTML/TS/JS 里）", () => {
    expect(html).not.toMatch(/doc-title/);
    expect(mainSrc).not.toMatch(/doc-title/);
    expect(appBody).not.toMatch(/doc-title/);
    // 文档名改由窗口标题承担
    expect(mainSrc).toMatch(/document\.title = /);
  });

  it("强调按钮 = 编辑（主色软底 + 600 字重），且是动作区唯一一处 is-accent 规则", () => {
    expect(html).toMatch(/<button id="btn-edit"[^>]*class="is-accent"/);
    expect(appBody).toMatch(/\.actions > button\.is-accent:not\(:disabled\)\s*\{[^}]*background:\s*var\(--accent-tint\)/);
    expect(appBody).toMatch(/\.actions > button\.is-accent:not\(:disabled\)\s*\{[^}]*font-weight:\s*600/);
    // 只有「基础规则 + hover」两处选择器带 is-accent（注释里出现的不算）
    expect(appBody.match(/is-accent/g)?.length).toBe(2);
  });

  it("无 emoji：顶栏动作按钮文案只用功能性字形/中文（PDF 前的 ⇩ 与编辑前的 ✎ 已去）", () => {
    expect(html).not.toMatch(/✎ 编辑/);
    expect(html).not.toMatch(/⇩ PDF/);
    expect(html).toMatch(/>编辑<\/button>/);
    expect(html).toMatch(/>PDF<\/button>/);
    // 保留的功能性字形：☰ / ◐ / ＋ / ⋯ / ‹ / › / ▾
    for (const glyph of ["☰", "◐", "＋", "⋯", "‹", "›", "▾"]) {
      expect(html, `缺少功能性字形 ${glyph}`).toContain(glyph);
    }
  });

  it("拥挤态：判据走 token，收起的动作在 CSS 里明确隐身", () => {
    // 2026-09-23 第二批：判据换成「标签装不下」——旧的「标签条可分宽度下限」
    // --w-tabs-min(420px) 已废弃（那个量只随窗口宽度变 ⇒ 折叠不可达；
    // 且随 .overflow 自己变宽 ⇒ 阈值再准也自激）。
    expect(tokensBody).not.toMatch(/--w-tabs-min\s*:/);
    expect(tokensBody).toMatch(/--w-chrome-reserve:\s*\d+px/);
    // 本批收口：拥挤态只剩「编辑 + ⋯」——最近 / Aa / ◐ / PDF 全部隐身
    for (const sel of ["\\.recent-wrap", "\\.settings-wrap", "#btn-theme", "#btn-export"]) {
      expect(appBody, `拥挤态未隐身 ${sel}`).toMatch(
        new RegExp(`\\.topbar\\.overflow ${sel}`),
      );
    }
    expect(appBody).not.toMatch(/\.topbar\.overflow #btn-open/);
    expect(mainSrc).toMatch(/setupShellOverflow/);
    expect(mainSrc).toMatch(/ResizeObserver/);
    // 标签增删不改变标签条宽度 ⇒ 旧实现只盯 ResizeObserver，漏了「又多了一个标签」
    expect(mainSrc).toMatch(/MutationObserver/);
  });
});

describe("2026-09-23 第二批：＋ 跟随滚动 / 空态标签条 / ☰ 空态一致", () => {
  const htmlStripped = html.replace(/<!--[\s\S]*?-->/g, "");

  it("＋ 是 #tab-list 的最后一个孩子（不是它的兄弟）——sticky 两段语义的前提", () => {
    expect(htmlStripped).toMatch(/<div id="tab-list"[^>]*>\s*<button id="btn-newtab"/);
    expect(htmlStripped).not.toMatch(/<\/div>\s*<button id="btn-newtab"/);
  });

  it("标签条不再带 hidden：空态也显示（空态 ＋ 是唯一可见的文件入口）", () => {
    expect(htmlStripped).toMatch(/<div id="tabbar" class="tabbar" data-tauri-drag-region>/);
    expect(htmlStripped).not.toMatch(/<div id="tabbar"[^>]*\shidden/);
    expect(tabsSrc).toMatch(/bar\.hidden = false/);
  });

  it("空态（body.empty）同时隐大纲与 ☰，且不再用 :has() 判空态", () => {
    expect(appBody).toMatch(/\.empty \.outline\s*\{\s*display:\s*none/);
    expect(appBody).toMatch(/\.empty #btn-outline\s*\{\s*display:\s*none/);
    expect(appBody).not.toMatch(/:has\(#empty-hint/);
    expect(mainSrc).toMatch(/classList\.add\("empty"\)/);
    expect(mainSrc).toMatch(/classList\.remove\("empty"\)/);
  });

  it("拥挤态判据只用与开合无关的量（视口宽 + 标签总宽），不再读标签条自己的宽度", () => {
    const fn = /function setupShellOverflow[\s\S]*?\n\}/.exec(mainSrc)?.[0] ?? "";
    expect(fn).not.toBe("");
    expect(fn).toMatch(/document\.documentElement\.clientWidth/);
    expect(fn).toMatch(/desiredTabsWidth/);
    expect(fn).not.toMatch(/bar\.clientWidth/);
  });
});

describe("D-05 S1 底部下划线式标签", () => {
  it("标签与容器都 align-self: stretch（下划线贴栏底、分隔线居中于文字的前提）", () => {
    expect(appBody).toMatch(/\.tabbar\s*\{[^}]*align-self:\s*stretch/);
    expect(appBody).toMatch(/\.tab\s*\{[^}]*align-self:\s*stretch/);
  });

  it("活动标签 = 字重 600 + 底部 2px 主色线（左右各内缩 6px），不再是浮起白卡", () => {
    expect(appBody).toMatch(/\.tab\.active\s*\{[^}]*font-weight:\s*600/);
    const after = /\.tab\.active::after\s*\{([^}]*)\}/.exec(appBody)?.[1] ?? "";
    expect(after).toMatch(/inset-inline:\s*6px/);
    expect(after).toMatch(/block-size:\s*2px/);
    expect(after).toMatch(/background:\s*var\(--accent-solid\)/);
    // 反向锚：旧「纸面填充 + 内描边白卡」不得复现
    expect(appBody).not.toMatch(/\.tab\.active\s*\{[^}]*background:\s*var\(--bg-surface\)/);
    expect(appBody).not.toMatch(/\.tab\.active\s*\{[^}]*box-shadow:\s*inset/);
  });

  it("标签之间 1px × 14px 细分隔线，且活动/悬停两侧不画（:has 兄弟选择器）", () => {
    const sep = /\.tab-sep\s*\{([^}]*)\}/.exec(appBody)?.[1] ?? "";
    expect(sep).toMatch(/inline-size:\s*1px/);
    expect(sep).toMatch(/block-size:\s*14px/);
    expect(sep).toMatch(/background:\s*var\(--hair\)/);
    expect(appBody).toMatch(/\.tab-list > \.tab\.active \+ \.tab-sep/);
    expect(appBody).toMatch(/\.tab-list > \.tab:has\(\+ \.tab\.active\) \+ \.tab-sep/);
    expect(appBody).toMatch(/\.tab-list > \.tab:hover \+ \.tab-sep/);
  });

  it("✕ 仅活动标签常驻；脏点 ● 与 ✕ 互斥（悬停/聚焦让位）", () => {
    expect(appBody).toMatch(/\.tab\.active \.tab-close\s*\{\s*opacity:\s*1/);
    expect(appBody).toMatch(/\.tab:hover \.tab-close, \.tab:focus-within \.tab-close\s*\{\s*opacity:\s*1/);
    expect(appBody).toMatch(/\.tab:hover \.tab-dirty, \.tab:focus-within \.tab-dirty\s*\{\s*visibility:\s*hidden/);
    // 非活动标签的 ✕ 不是「常驻」：基础规则里 opacity 为 0
    expect(appBody).toMatch(/\.tab-close\s*\{[^}]*opacity:\s*0/);
  });

  it("多标签滚动：单行永不折行 + 滚轮横滚 + ‹ › ▾ 与 ＋ 就位", () => {
    expect(appBody).toMatch(/\.tab-list\s*\{[^}]*overflow-x:\s*auto/);
    expect(appBody).toMatch(/\.tab-list\s*\{[^}]*white-space:\s*nowrap/);
    expect(appBody).toMatch(/\.tab-list\s*\{[^}]*overflow-y:\s*hidden/);
    // ＋ 钉在可视区右端
    expect(appBody).toMatch(/#btn-newtab\s*\{[^}]*position:\s*sticky/);
    // 导航组只在有溢出时出现
    expect(html).toMatch(/<div id="tabs-nav" class="tabs-nav" hidden>/);
    expect(html).toMatch(/<button id="tabs-prev"[^>]*disabled>/);
    expect(html).toMatch(/<button id="tabs-next"[^>]*disabled>/);
  });

  it("横向滚动/‹ ›/自动滚进可视区三条接线都在 tabs.ts", () => {
    expect(tabsSrc).toMatch(/addEventListener\(\s*"wheel"/);
    expect(tabsSrc).toMatch(/scrollLeft \+= delta/);
    expect(tabsSrc).toMatch(/scrollIntoView\(\{ block: "nearest", inline: "nearest" \}\)/);
    expect(tabsSrc).toMatch(/prevBtn\.disabled = tabList\.scrollLeft <= 0/);
    expect(tabsSrc).toMatch(/nextBtn\.disabled = tabList\.scrollLeft >= max - 1/);
  });
});

describe("D-05 ⋯ 溢出菜单与 ▾ 全部标签列表（新增功能）", () => {
  it("两个菜单容器常驻 HTML、默认 hidden、带 role=menu", () => {
    expect(html).toMatch(/<div id="tabs-menu" class="tabs-menu" role="menu"[^>]*hidden>/);
    expect(html).toMatch(/<div id="overflow-menu" class="overflow-menu" role="menu"[^>]*hidden>/);
    expect(html).toMatch(/<button id="btn-overflow"[^>]*aria-haspopup="menu"[^>]*hidden>/);
    expect(html).toMatch(/<button id="tabs-list"[^>]*aria-haspopup="menu"/);
  });

  it("两处菜单共用同一套浮层四件套与同一套列表项语言", () => {
    expect(appBody).toMatch(/\.tabs-menu,\s*\n\.overflow-menu\s*\{[^}]*border-radius:\s*var\(--radius-3\)/);
    expect(appBody).toMatch(/\.tabs-menu,\s*\n\.overflow-menu\s*\{[^}]*box-shadow:\s*var\(--shadow-2\)/);
    expect(appBody).toMatch(/\.tabs-menu,\s*\n\.overflow-menu\s*\{[^}]*min-inline-size:\s*240px/);
    expect(appBody).toMatch(/\.tabs-menu,\s*\n\.overflow-menu\s*\{[^}]*max-inline-size:\s*min\(420px/);
  });

  it("两行式条目：文件名 + 弱化目录两个 span，当前项浅主色底", () => {
    expect(appBody).toMatch(/\.menu-item \.menu-text\s*\{[^}]*flex-direction:\s*column/);
    expect(appBody).toMatch(/\.menu-item \.menu-path\s*\{[^}]*color:\s*var\(--fg-dim\)/);
    expect(appBody).toMatch(/\.menu-item\.is-current\s*\{[^}]*background:\s*var\(--accent-tint\)/);
    expect(menuSrc).toMatch(/menu-name/);
    expect(menuSrc).toMatch(/menu-path/);
    expect(menuSrc).toMatch(/dirOf/);
  });

  it("菜单逻辑独立成 ui/tabs-menu.ts，不塞进已超限的 tabs.ts", () => {
    expect(menuSrc).toMatch(/export function createTabMenus/);
    expect(menuSrc).toMatch(/export interface TabMenus/);
    expect(tabsSrc).toMatch(/import \{ createTabMenus/);
    // 批量关闭：快照路径再遍历（closeTab 会改数组）
    expect(tabsSrc).toMatch(/function closeMany\(paths: string\[\]\)/);
    expect(tabsSrc).toMatch(/for \(const path of \[\.\.\.paths\]\)/);
  });

  it("Esc 仲裁把两个新菜单排在设置面板/最近菜单之后（一次只关一个）", () => {
    const order = ["settings-panel", "recent-menu", "tabs-menu", "overflow-menu"];
    let cursor = -1;
    for (const id of order) {
      const at = closeOverlaySrc.indexOf(`"${id}"`);
      expect(at, `${id} 未出现在 closeTopmostOverlay`).toBeGreaterThan(-1);
      expect(at, `${id} 的优先序不对`).toBeGreaterThan(cursor);
      cursor = at;
    }
  });
});

describe("D-05 B2 轻分层与状态栏/大纲", () => {
  it("状态栏：11.5px 走 token，上沿 1px --hair，底色 chrome", () => {
    expect(tokensBody).toMatch(/--fs-status:\s*11\.5px/);
    const bar = /\.statusbar\s*\{([^}]*)\}/.exec(appBody)?.[1] ?? "";
    expect(bar).toMatch(/font-size:\s*var\(--fs-status\)/);
    expect(bar).toMatch(/border-top:\s*1px solid var\(--hair\)/);
    expect(bar).toMatch(/background:\s*var\(--bg-chrome\)/);
  });

  it("大纲活动项 = 浅主色底圆角矩形 + 主色文字 + 600 字重；左侧硬色条已去", () => {
    const active = /\.outline-list a\.active\s*\{([^}]*)\}/.exec(appBody)?.[1] ?? "";
    expect(active).toMatch(/background:\s*var\(--accent-tint\)/);
    expect(active).toMatch(/color:\s*var\(--accent-text-hover\)/);
    expect(active).toMatch(/font-weight:\s*600/);
    expect(appBody).not.toMatch(/border-inline-start-color:\s*var\(--outline-active-bar\)/);
    // 层级只用缩进 + 字重/字号：大纲条目不再有颜色维度
    expect(appBody).not.toMatch(/--outline-active-bar/);
  });

  it("三级表面都是 token 引用，暗色下 card 与 paper 不塌成一档", () => {
    expect(tokensBody).toMatch(/--bg-chrome:\s*var\(--pal-chrome\)/);
    expect(tokensBody).toMatch(/--bg-surface:\s*var\(--pal-card\)/);
    expect(tokensBody).toMatch(/--bg-app:\s*var\(--pal-paper\)/);
    // 暗色 10 组里 card ≠ paper 各出现 5 次
    const darkBlocks = tokensBody.split(':root[data-theme="dark"],')[1] ?? "";
    expect(darkBlocks.length).toBeGreaterThan(0);
  });

  it("分层靠 1px 线 + 卡片投影：顶栏下沿与卡片四件套都在", () => {
    expect(appBody).toMatch(/\.topbar\s*\{[^}]*border-bottom:\s*1px solid var\(--border-chrome\)/);
    expect(appBody).toMatch(/box-shadow:\s*var\(--shadow-2\)/);
    expect(tokensBody).toMatch(/--shadow-card:\s*0 8px 28px rgba\(16, 24, 40, \.14\)/);
  });
});
