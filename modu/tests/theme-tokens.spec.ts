/**
 * D-01 主题 token 化回归锚（Phase 2 第一步）。
 * jsdom 无布局引擎，故本文件只锚「CSS 里写了什么」：
 *   ① DOM 契约四条选择器（data-palette 是新维度，data-theme 语义不变）；
 *   ② 10 组调色板各自齐全的 --pal-* 原色；
 *   ③ 新结构刻度（radius 7/8/10、控件高 28、卡片/控件投影）；
 *   ④ 暗色三级表面不再塌成两级；
 *   ⑤ 色值纪律：色值只出现在 tokens.css（app.css / cjk.css / hljs.css 零字面色值）。
 * ⚠ vitest 会把 .css?raw 桩化为空串，故走 fs 直读（cwd = 项目根）。
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const app = readFileSync("src/app.css", "utf8");
const cjk = readFileSync("src/typography/cjk.css", "utf8");
const hljs = readFileSync("src/typography/hljs.css", "utf8");
const tokens = readFileSync("src/typography/tokens.css", "utf8");

const KEYS = ["dianlan", "xuanzhi", "shimo", "zidai", "qingmo"] as const;

/** 剥掉注释：注释里的举例色值不算「字面色值」，否则门禁永远假红 */
function stripComments(css: string): string {
  return css.replace(/\/\*[\s\S]*?\*\//g, "");
}

describe("D-01 ① DOM 契约（向后兼容）", () => {
  it("默认主题亮态走 :root（无属性），靛蓝与 :root 同写一条", () => {
    expect(tokens).toMatch(/:root,\s*\n:root\[data-palette="dianlan"\]\s*\{/);
  });

  it("5 套 × 亮/暗：亮态单属性选择器 + 暗态双属性选择器齐备", () => {
    for (const key of KEYS) {
      expect(tokens).toContain(`:root[data-palette="${key}"]`);
      expect(tokens).toContain(`:root[data-palette="${key}"][data-theme="dark"]`);
    }
    // 默认暗态与靛蓝暗态同写一条
    expect(tokens).toMatch(/:root\[data-theme="dark"\],\s*\n:root\[data-palette="dianlan"\]\[data-theme="dark"\]\s*\{/);
  });

  it("data-theme 仍只取 light|dark（tokens.css 里不出现第三个取值）", () => {
    const values = [...tokens.matchAll(/data-theme="([^"]+)"/g)].map((m) => m[1]);
    expect(new Set(values)).toEqual(new Set(["dark"]));
  });

  it("顺序纪律：暗态块在亮态块之后（同权选择器靠先后定胜负）", () => {
    const lastLight = tokens.indexOf(':root[data-palette="qingmo"] {');
    const firstDark = tokens.indexOf(':root[data-theme="dark"],');
    expect(lastLight).toBeGreaterThan(-1);
    expect(firstDark).toBeGreaterThan(lastLight);
  });
});

describe("D-01 ② 10 组调色板齐全", () => {
  const REQUIRED = [
    "--pal-chrome",
    "--pal-card",
    "--pal-paper",
    "--pal-line",
    "--pal-line-2",
    "--pal-hair",
    "--pal-hover",
    "--pal-fg",
    "--pal-muted",
    "--pal-dim",
    "--pal-accent",
    "--pal-soft",
    "--pal-on",
    "--pal-quote",
    "--pal-th",
  ];

  it("每组 15 个原色各出现 10 次（5 套 × 亮暗）", () => {
    for (const name of REQUIRED) {
      const hits = tokens.match(new RegExp(`${name}\\s*:`, "g")) ?? [];
      expect(hits.length, `${name} 应声明 10 次`).toBe(10);
    }
  });

  it("语义层从原色派生（三级表面 / 描边 / 文本阶 / 强调族）", () => {
    expect(tokens).toMatch(/--bg-chrome:\s*var\(--pal-chrome\)/);
    expect(tokens).toMatch(/--bg-surface:\s*var\(--pal-card\)/);
    expect(tokens).toMatch(/--bg-app:\s*var\(--pal-paper\)/);
    expect(tokens).toMatch(/--border:\s*var\(--pal-line-2\)/);
    expect(tokens).toMatch(/--rule:\s*var\(--pal-hair\)/);
    expect(tokens).toMatch(/--text:\s*var\(--pal-fg\)/);
    expect(tokens).toMatch(/--text-muted:\s*var\(--pal-muted\)/);
    // P7：三级文字不能用调色板 --pal-dim 原值（对纸面 2.54~2.67:1，做文本不达标），
    // 语义层按 mix(dim 60%, fg) 压深成可读档；--text-dim 是同一值的既有名。
    expect(tokens).toMatch(/--fg-dim:\s*color-mix\(in oklab, var\(--pal-dim\) 60%, var\(--pal-fg\)\)/);
    expect(tokens).toMatch(/--text-dim:\s*var\(--fg-dim\)/);
    expect(tokens).toMatch(/--accent-solid:\s*var\(--pal-accent\)/);
    expect(tokens).toMatch(/--accent-text:\s*var\(--pal-on\)/);
    expect(tokens).toMatch(/--accent-tint:\s*var\(--pal-soft\)/);
    expect(tokens).toMatch(/--on-accent-soft:\s*var\(--pal-on\)/);
  });

  it("暗色三级表面：surface 与 app 分别指向 card / paper（不再塌成两级）", () => {
    const surface = /--bg-surface:\s*var\((--pal-[a-z0-9-]+)\)/.exec(tokens)?.[1];
    const paper = /--bg-app:\s*var\((--pal-[a-z0-9-]+)\)/.exec(tokens)?.[1];
    expect(surface).toBe("--pal-card");
    expect(paper).toBe("--pal-paper");
  });
});

describe("D-01 ③ 新结构刻度", () => {
  it("圆角 7 / 8 / 10 三档", () => {
    expect(tokens).toMatch(/--radius-1:\s*7px/);
    expect(tokens).toMatch(/--radius-2:\s*8px/);
    expect(tokens).toMatch(/--radius-3:\s*10px/);
  });

  it("控件高 28px 落成 token，app.css 不再散落字面 28px 控件高", () => {
    expect(tokens).toMatch(/--h-ctl:\s*28px/);
    // 顶栏按钮 / 查找输入框 / 查找按钮 / 步进按钮 / CM 输入框与按钮 全部走 token
    expect(app).not.toMatch(/^\s*(height|block-size|inline-size):\s*28px;/m);
  });

  it("#close-guard 按钮由 31px 落回控件统一高（padding 撑高改为显式高度）", () => {
    expect(app).toMatch(/#close-guard button\s*\{[^}]*block-size:\s*var\(--h-ctl\)/);
    expect(app).not.toMatch(/#close-guard button\s*\{[^}]*padding:\s*5px/);
  });

  it("卡片大投影 + 控件轻投影（--shadow-2 仍可消费，值同卡片档）", () => {
    expect(tokens).toMatch(/--shadow-card:\s*0 8px 28px rgba\(16, 24, 40, \.14\)/);
    expect(tokens).toMatch(/--shadow-2:\s*var\(--shadow-card\)/);
    expect(tokens).toMatch(/--shadow-ctl:\s*0 1px 2px rgba\(16, 24, 40, \.06\)/);
  });
});

describe("D-01 ⑤ 色值纪律：色值只落在 tokens.css", () => {
  it("app.css / cjk.css / hljs.css 剥掉注释后无任何字面色值", () => {
    for (const [name, css] of [
      ["app.css", app],
      ["cjk.css", cjk],
      ["hljs.css", hljs],
    ] as const) {
      const body = stripComments(css);
      expect(body.match(/#[0-9a-fA-F]{3,8}\b/g) ?? [], `${name} 出现字面 hex`).toEqual([]);
      expect(body.match(/\b(?:rgba?|hsla?)\(/g) ?? [], `${name} 出现字面 rgb/hsl`).toEqual([]);
    }
  });
});

/**
 * D-02 字体栈（2026-09-23）：三个 --font-* 与面板的 15 条预设链都只在 tokens.css 出现。
 * 本文件只锚「CSS 里写了什么」——命中的**渲染级**证据走真机拉丁串字宽探测（.verify/phase2/）。
 * 顺序纪律：tokens.css 里 --font-sans / --font-serif / --font-mono 三条是「全站默认」，
 * 必须排在 --font-pick-* 之前（后者只是面板预设）。
 */
describe("D-02 字体栈（三层结构与死候选清理）", () => {
  /** 取某条自定义属性的值（到分号为止），多行声明也能取全 */
  function stackOf(name: string): string {
    const found = new RegExp(`\\${name}:([^;]+);`).exec(tokens);
    expect(found, `tokens.css 缺少 ${name}`).not.toBeNull();
    return (found?.[1] ?? "").replace(/\s+/g, " ").trim();
  }

  /** 一条链的首选族名（第一个候选） */
  function headOf(stack: string): string {
    return stack.split(",")[0].trim().replace(/^["']|["']$/g, "");
  }

  it("--font-sans 首选 HarmonyOS Sans SC，且以西文/系统兜底收尾", () => {
    const stack = stackOf("--font-sans");
    expect(headOf(stack)).toBe("HarmonyOS Sans SC");
    expect(stack).toContain("Segoe UI Variable Text");
    expect(stack).toContain("Microsoft YaHei UI");
    expect(stack.endsWith("sans-serif")).toBe(true);
  });

  it("--font-serif 保留 Noto Serif SC（400 字重实测可用）", () => {
    const stack = stackOf("--font-serif");
    expect(headOf(stack)).toBe("Noto Serif SC");
    expect(stack.endsWith("serif")).toBe(true);
    expect(stack).toContain("SimSun");
  });

  it("--font-mono 首选 Maple Mono NF / Maple Mono，含 ui-monospace 与 monospace", () => {
    const stack = stackOf("--font-mono");
    expect(headOf(stack)).toBe("Maple Mono NF");
    expect(stack).toContain("Maple Mono");
    expect(stack).toContain("ui-monospace");
    expect(stack).toContain("Cascadia Mono");
    expect(stack).toContain("Consolas");
    expect(stack.endsWith("monospace")).toBe(true);
  });

  it("死候选被清掉：Source Han * / Songti SC / Noto Sans SC / 不存在的 Segoe UI Variable", () => {
    // 只看「真正被消费的变量值」，不看注释（注释里留着实测记录与踩坑结论）
    const declared = [...tokens.matchAll(/--font-[a-z0-9-]+:([^;]+);/g)]
      .map((m) => stripComments(m[1]).replace(/\s+/g, " "))
      .join(" | ");
    for (const dead of ["Source Han Sans SC", "Source Han Serif SC", "Songti SC", "Noto Sans SC"]) {
      expect(declared, `字体栈里仍有死候选 ${dead}`).not.toContain(dead);
    }
    // 「Segoe UI Variable」族名不存在；真实可用名是 …Text / Display / Small
    expect(/["']Segoe UI Variable["']/.test(declared)).toBe(false);
    expect(declared).toContain('"Segoe UI Variable Text"');
  });

  it("三条全局栈都在 --font-pick-* 预设之前（面板预设不得篡改全站默认）", () => {
    const sans = tokens.indexOf("--font-sans:");
    const pick = tokens.indexOf("--font-pick-");
    expect(sans).toBeGreaterThan(-1);
    expect(pick).toBeGreaterThan(sans);
  });

  it("每条预设链（15 条）都是完整回退链：≥2 个候选且以通用族收尾", () => {
    const names = [...tokens.matchAll(/(--font-pick-[a-z0-9-]+)\s*:/g)].map((m) => m[1]);
    expect(new Set(names).size).toBe(15);
    for (const name of names) {
      const stack = stackOf(name);
      expect(stack.split(",").length, `${name} 候选不足`).toBeGreaterThanOrEqual(2);
      expect(/(sans-serif|serif|monospace)$/.test(stack), `${name} 未以通用族收尾`).toBe(true);
    }
  });

  it("两个衬线预设不是同一条链（选了 A 实际是 B 的另一种形态）", () => {
    expect(stackOf("--font-pick-cjk-songti")).not.toBe(stackOf("--font-pick-cjk-notoserif"));
    expect(headOf(stackOf("--font-pick-cjk-songti"))).toBe("宋体");
    expect(headOf(stackOf("--font-pick-cjk-notoserif"))).toBe("Noto Serif SC");
  });

  it("字体族名零外泄：app.css / cjk.css / hljs.css 只有 var(--font-*)，无字面族名", () => {
    for (const [name, css] of [
      ["app.css", app],
      ["cjk.css", cjk],
      ["hljs.css", hljs],
    ] as const) {
      const families = [...css.matchAll(/font-family:\s*([^;]+);/g)].map((m) => m[1].trim());
      for (const value of families) {
        expect(value, `${name} 的 font-family 不是 var(--font-*)`).toMatch(/^var\(--font-[a-z-]+\)$/);
      }
    }
  });

  it("代码块栈写在真正承载文字的元素上：cjk.css 有 .mdc pre > code 规则", () => {
    // 栈写在 <pre> 上会被 <code> 的用户代理样式（monospace）吃掉；实测补口见 cjk.css 注释
    expect(cjk).toMatch(/\.mdc pre > code\s*\{[^}]*font-family:\s*var\(--font-mono\)/);
  });
});
