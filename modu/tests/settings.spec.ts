/**
 * 字体面板（D-02 第二步）契约。
 *
 * 与旧版（四预设 sans/serif/kai/hei）的差别就是本文件的锚：
 *   ① 推荐列表按语义分三组（中文正文 / 西文拉丁 / 代码），选项骨架在 index.html，
 *      「对应哪个栈变量」由 data-stack-var 声明（**字体栈只在 tokens.css**）；
 *   ② 旧持久化值 sans/serif/kai/hei 必须能迁移到新目录项，不能丢成默认值；
 *   ③ 常显「实际生效字体」：按 400 / 700 两个字重各显示一次探测结果
 *      （判据见 font-detect.spec.ts：拉丁串 + 双假名基线 + 双字重）。
 *
 * jsdom 没有布局引擎、也不加载 CSS，所以本文件对两处做**显式替身**（并写清替身口径）：
 *   - canvas 字宽 → hooks.measure 注入一张「族名 + 字重」查表（生产走真实 canvas）；
 *   - CSSOM（tokens.css 的栈变量与 #doc 的计算字体栈）→ seedComputedStyle() 按同名键给值。
 * 替身只替代「浏览器给什么」，不替代被测逻辑。
 */
import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type * as SettingsModule from "../src/ui/settings";
import type { applyThemePref as ApplyThemePref } from "../src/ui/theme";

/** 只剥 HTML 注释：注释里的属性样例不该进 DOM（本文件用正则够，构建产物走真解析器） */
function stripHtmlComments(html: string): string {
  return html.replace(/<!--[\s\S]*?-->/g, "");
}

/** 从 index.html 里取第一段能匹配标签的元素（option / optgroup 两种） */
function pickTag(html: string, tag: string, attr: string): string | null {
  const found = new RegExp(`<${tag}\\b[^>]*${attr}[^>]*>`).exec(html);
  return found === null ? null : found[0];
}

/**
 * 面板骨架：#set-font 的 optgroup / option 直接来自 index.html（id 与中文名不再手抄）。
 * 真机上 index.html 的 option 文字正是「首次渲染读到的中文名」，渲染会把它们写进
 * data-label；这里把同样的关系复现出来（否则第二次渲染就读不到文案了）。
 */
function fontSkeleton(): string {
  const html = stripHtmlComments(readFileSync("index.html", "utf8"));
  const select = /<select[^>]*id="set-font"[^>]*>([\s\S]*?)<\/select>/.exec(html);
  if (select === null) throw new Error("index.html 里找不到 #set-font");
  const groups = select[1].match(/<optgroup[\s\S]*?(?=<optgroup|$)/g) ?? [];
  return groups
    .map((raw) => {
      const open = pickTag(raw, "optgroup", "data-group");
      const options = (raw.match(/<option\b[^>]*>[^<]*/g) ?? [])
        .map((tag) => {
          const label = tag.slice(tag.indexOf(">") + 1).trim();
          const attr = label === "" ? "" : ` data-label="${label}"`;
          return `${tag.slice(0, tag.indexOf(">"))}${attr}>${label}`;
        })
        .join("");
      return open === null ? options : `${open}${options}</optgroup>`;
    })
    .join("");
}

function mountPanel(): void {
  document.body.innerHTML = `
    <button id="btn-settings" type="button">Aa</button>
    <div id="settings-panel" hidden>
      <button id="set-fs-dec" type="button">−</button>
      <span id="set-fs-val">16</span>
      <button id="set-fs-inc" type="button">＋</button>
      <button id="set-width-dec" type="button">−</button>
      <span id="set-width-val">46</span>
      <button id="set-width-inc" type="button">＋</button>
      <select id="set-font" class="settings-select">${fontSkeleton()}</select>
      <span class="settings-label">实际生效</span>
      <code id="set-font-effective"></code>
      <code id="set-font-effective-bold"></code>
      <span id="set-font-hint"></span>
      <select id="set-theme">
        <option value="light">浅色</option>
        <option value="dark">深色</option>
        <option value="auto">自动（跟随系统）</option>
      </select>
      <select id="set-palette">
        <option value="dianlan">靛蓝</option>
        <option value="xuanzhi">宣纸</option>
        <option value="shimo">石墨</option>
        <option value="zidai">紫黛</option>
        <option value="qingmo">青墨</option>
      </select>
      <input id="set-autosave" type="checkbox" />
    </div>
    <article id="doc" class="mdc"></article>`;
}

/**
 * CSSOM 替身：键名与 tokens.css 完全同名同值（真值以 tokens.css 为准，
 * 本文件只补 jsdom 读不到的那一层）。三条全局栈供「#doc 没内联」时使用。
 */
const FONT_STACKS: Readonly<Record<string, string>> = {
  "--font-sans": '"HarmonyOS Sans SC", "Segoe UI Variable Text", "Segoe UI", system-ui, sans-serif',
  "--font-serif": '"Noto Serif SC", Georgia, "Times New Roman", 宋体, SimSun, serif',
  "--font-mono": '"Maple Mono NF", "Maple Mono", ui-monospace, "Cascadia Mono", Consolas, monospace',
  "--font-pick-cjk-harmonyos": '"HarmonyOS Sans SC", "Microsoft YaHei UI", system-ui, sans-serif',
  "--font-pick-cjk-yahei": '"Microsoft YaHei UI", "Microsoft YaHei", system-ui, sans-serif',
  "--font-pick-cjk-lxgw": '"LXGW WenKai Screen", "LXGW WenKai", "HarmonyOS Sans SC", serif',
  "--font-pick-cjk-songti": '宋体, SimSun, "Noto Serif SC", "Microsoft YaHei UI", serif',
  "--font-pick-cjk-notoserif": '"Noto Serif SC", 宋体, SimSun, Georgia, serif',
  "--font-pick-latin-inter": 'Inter, "Segoe UI Variable Text", "Segoe UI", Arial, sans-serif',
  "--font-pick-latin-segoe": '"Segoe UI Variable Text", "Segoe UI", Inter, Arial, sans-serif',
  "--font-pick-latin-georgia": 'Georgia, "Times New Roman", serif',
  "--font-pick-latin-times": '"Times New Roman", Times, Georgia, serif',
  "--font-pick-latin-yaheiui": '"Microsoft YaHei UI", "Segoe UI Variable Text", "Segoe UI", sans-serif',
  "--font-pick-mono-maple-nf": '"Maple Mono NF", ui-monospace, "Cascadia Mono", Consolas, monospace',
  "--font-pick-mono-maple": '"Maple Mono", ui-monospace, "Cascadia Mono", Consolas, monospace',
  "--font-pick-mono-cascadia": '"Cascadia Mono", ui-monospace, Consolas, monospace',
  "--font-pick-mono-consolas": 'Consolas, "Cascadia Mono", ui-monospace, monospace',
  "--font-pick-mono-maple-mix": '"Maple Mono NF", "Microsoft YaHei UI", ui-monospace, monospace',
};

/**
 * @param docStack #doc 的计算字体栈键名（或直接给一条栈字面量）：
 *   默认走 --font-sans，等于「用户选默认档」时 cjk.css 算出来的那条。
 */
function seedComputedStyle(docStack = "--font-sans"): void {
  const stack = FONT_STACKS[docStack] ?? docStack;
  vi.spyOn(window, "getComputedStyle").mockImplementation(((el: Element) => {
    const isDoc = el instanceof HTMLElement && el.id === "doc";
    const value = (name: string): string => {
      if (isDoc) return name === "font-family" ? stack : "";
      return FONT_STACKS[name] ?? "";
    };
    return { getPropertyValue: value, fontFamily: isDoc ? stack : "" } as unknown as CSSStyleDeclaration;
  }) as typeof window.getComputedStyle);
}

/** 假的字宽表（值取自本机实测比例）：族名 + 字重 → 宽度 */
const WIDTHS: Readonly<Record<string, Readonly<Record<number, number>>>> = {
  "HarmonyOS Sans SC": { 400: 575.792, 700: 575.792 },
  "Microsoft YaHei UI": { 400: 595.234, 700: 630.523 },
  "Noto Serif SC": { 400: 610.598, 700: 637.429 },
};
/** 缺字重 / 未知族名 → 返回假族名基线宽度（模拟 Chromium 的静默回退） */
const BOGUS: Readonly<Record<number, number>> = { 400: 570.098, 700: 603.125 };

/** 假量器：jsdom 的 canvas.getContext 返回 null，真机上这里量的是 `400 16px "族名"` */
const fakeMeasure = (fontSpec: string): number => {
  const parsed = /^(\d+)\s+16px\s+"(.+)"$/.exec(fontSpec);
  if (parsed === null) throw new Error(`探测字串格式不符：${fontSpec}`);
  const weight = Number.parseInt(parsed[1], 10);
  return WIDTHS[parsed[2]]?.[weight] ?? BOGUS[weight] ?? fontSpec.length;
};

interface Ctx {
  settings: typeof SettingsModule;
  applyThemePref: typeof ApplyThemePref;
  onFontChange: ReturnType<typeof vi.fn>;
}

/**
 * 每例重取模块，拿一份干净的模块级状态（量器在测试里由 hooks.measure 注入，
 * 不依赖 import 缓存，也不受上一例影响）。
 */
async function freshSettings(): Promise<Ctx> {
  vi.resetModules();
  const settings = await import("../src/ui/settings");
  const theme = await import("../src/ui/theme");
  const onFontChange = vi.fn();
  settings.setupSettings({
    getDoc: () => document.getElementById("doc"),
    onFontChange,
    measure: fakeMeasure,
  });
  return { settings, applyThemePref: theme.applyThemePref, onFontChange };
}

function fsVar(): string {
  return document.documentElement.style.getPropertyValue("--fs-body");
}

function widthVar(): string {
  return document.documentElement.style.getPropertyValue("--me-width");
}

function choose(id: string): void {
  const select = document.getElementById("set-font") as HTMLSelectElement;
  select.value = id;
  select.dispatchEvent(new Event("change"));
}

beforeEach(() => {
  localStorage.clear();
  document.documentElement.style.removeProperty("--fs-body");
  document.documentElement.style.removeProperty("--me-width");
  delete document.documentElement.dataset.theme;
  mountPanel();
  seedComputedStyle();
});

afterEach(() => {
  vi.restoreAllMocks();
  localStorage.clear();
});

describe("字号步进（14–20px）", () => {
  it("clampFs 钳制到 [14, 20]", async () => {
    const { settings } = await freshSettings();
    expect(settings.clampFs(10)).toBe(14);
    expect(settings.clampFs(26)).toBe(20);
    expect(settings.clampFs(16.4)).toBe(16); // 四舍五入到整数 px
  });

  it("＋ 步进：写 --fs-body、回显数值、持久化 modu-fs", async () => {
    await freshSettings();
    document.getElementById("set-fs-inc")?.click();
    expect(fsVar()).toBe("17px");
    expect(document.getElementById("set-fs-val")?.textContent).toBe("17");
    expect(localStorage.getItem("modu-fs")).toBe("17");
  });

  it("上下界不再增减（20 封顶 / 14 保底）", async () => {
    localStorage.setItem("modu-fs", "20");
    await freshSettings();
    document.getElementById("set-fs-inc")?.click();
    expect(fsVar()).toBe("20px");
    localStorage.setItem("modu-fs", "14");
    await freshSettings();
    document.getElementById("set-fs-dec")?.click();
    expect(fsVar()).toBe("14px");
  });

  it("启动恢复：modu-fs=18 → --fs-body 与回显均为 18", async () => {
    localStorage.setItem("modu-fs", "18");
    await freshSettings();
    expect(fsVar()).toBe("18px");
    expect(document.getElementById("set-fs-val")?.textContent).toBe("18");
  });

  it("坏值回退默认 16（与 tokens --fs-body 同值）", async () => {
    localStorage.setItem("modu-fs", "abc");
    await freshSettings();
    expect(fsVar()).toBe("16px");
  });
});

describe("字体推荐列表（D-02：三组语义分组）", () => {
  it("目录按组齐备：中文正文 / 西文拉丁 / 代码 各 5 项", async () => {
    await freshSettings();
    const boxes = [...document.querySelectorAll<HTMLOptGroupElement>("#set-font optgroup")];
    expect(boxes.map((b) => b.label)).toEqual(["中文正文", "西文拉丁", "代码"]);
    for (const box of boxes) {
      expect(box.querySelectorAll("option").length).toBe(5);
    }
    const ids = [...document.querySelectorAll<HTMLOptionElement>("#set-font option")].map((o) => o.value);
    expect(ids).toContain("cjk-harmonyos");
    expect(ids).toContain("cjk-yahei");
    expect(ids).toContain("cjk-songti");
    expect(ids).toContain("cjk-lxgw"); // 霞鹜文楷屏幕版（本机已装）
    expect(ids).toContain("cjk-notoserif");
    expect(ids).toContain("mono-maple-nf");
    expect(ids).toContain("mono-cascadia");
    expect(ids).toContain("mono-consolas");
  });

  it("每个选项都声明 data-stack-var（栈只在 tokens.css，TS 零族名）", async () => {
    await freshSettings();
    for (const option of document.querySelectorAll("#set-font option")) {
      expect(option.getAttribute("data-stack-var")).toMatch(/^--font-pick-/);
    }
  });

  it("本机缺失的首选被标注「本机未安装」，已装的保持原名", async () => {
    await freshSettings();
    const select = document.getElementById("set-font") as HTMLSelectElement;
    // 假字宽表里只登记了 HarmonyOS Sans SC / Microsoft YaHei UI / Noto Serif SC 三族
    const missing = select.querySelector('option[value="mono-maple-nf"]');
    expect(missing?.getAttribute("data-unavailable")).toBe("true");
    expect(missing?.textContent).toContain("本机未安装");
    const present = select.querySelector('option[value="cjk-harmonyos"]');
    expect(present?.getAttribute("data-unavailable")).toBe(null);
    expect(present?.textContent).toBe("HarmonyOS Sans SC");
    const serifPresent = select.querySelector('option[value="cjk-notoserif"]');
    expect(serifPresent?.getAttribute("data-unavailable")).toBe(null);
  });

  it("选非衬线项 → #doc 内联 var(--font-pick-*)，modu-font 持久化", async () => {
    await freshSettings();
    choose("cjk-harmonyos");
    const doc = document.getElementById("doc") as HTMLElement;
    expect(doc.style.fontFamily).toBe("var(--font-pick-cjk-harmonyos)");
    expect(doc.dataset.face).toBeUndefined();
    expect(localStorage.getItem("modu-font")).toBe("cjk-harmonyos");
  });

  it("衬线项 → 走 #doc[data-face] 契约（清内联栈），两个衬线预设各自回显", async () => {
    await freshSettings();
    choose("cjk-notoserif");
    const doc = document.getElementById("doc") as HTMLElement;
    expect(doc.dataset.face).toBe("serif");
    expect(doc.style.fontFamily).toBe("");
    choose("cjk-songti");
    expect((document.getElementById("set-font") as HTMLSelectElement).value).toBe("cjk-songti");
    expect(localStorage.getItem("modu-font")).toBe("cjk-songti");
  });

  it("衬线档契约按**首选族**判定，不按通用族：霞鹜文楷 / Georgia 各走自己的链", async () => {
    await freshSettings();
    const doc = document.getElementById("doc") as HTMLElement;
    // 霞鹜文楷虽以 serif 收尾，但首选是 LXGW WenKai Screen（≠ --font-serif 首选的 Noto Serif SC）
    choose("cjk-lxgw");
    expect(doc.dataset.face).toBeUndefined();
    expect(doc.style.fontFamily).toBe("var(--font-pick-cjk-lxgw)");
    expect((document.getElementById("set-font") as HTMLSelectElement).value).toBe("cjk-lxgw");
  });

  it("启动恢复：modu-font=mono-maple-nf → 面板回显并应用该栈", async () => {
    localStorage.setItem("modu-font", "mono-maple-nf");
    await freshSettings();
    const doc = document.getElementById("doc") as HTMLElement;
    expect(doc.style.fontFamily).toBe("var(--font-pick-mono-maple-nf)");
    expect((document.getElementById("set-font") as HTMLSelectElement).value).toBe("mono-maple-nf");
  });

  it("字体变化触发 onFontChange 钩子（壳层重算排版）", async () => {
    const ctx = await freshSettings();
    ctx.settings.setFontPref("mono-cascadia");
    expect(ctx.onFontChange).toHaveBeenCalled();
  });
});

describe("字体旧值迁移（modu-font 四预设 + 旧 modu-face）", () => {
  it("旧 modu-face=serif（无 modu-font）→ 迁到衬线项并走 data-face 契约", async () => {
    localStorage.setItem("modu-face", "serif");
    const { settings } = await freshSettings();
    expect(settings.readFontPref()).toBe("cjk-notoserif");
    const doc = document.getElementById("doc") as HTMLElement;
    expect(doc.dataset.face).toBe("serif");
    expect((document.getElementById("set-font") as HTMLSelectElement).value).toBe("cjk-notoserif");
  });

  it.each([
    ["sans", "sans"],
    ["serif", "cjk-notoserif"],
    ["kai", "cjk-lxgw"],
    ["hei", "cjk-yahei"],
  ])("旧 modu-font=%s → %s（不被丢成默认值）", async (legacy, expected) => {
    localStorage.setItem("modu-font", legacy);
    const { settings } = await freshSettings();
    expect(settings.readFontPref()).toBe(expected);
  });

  it("旧键迁移后退役，双源归一", async () => {
    localStorage.setItem("modu-face", "serif");
    localStorage.setItem("modu-font", "hei"); // 新键优先
    const { settings } = await freshSettings();
    settings.setFontPref("cjk-yahei");
    expect(localStorage.getItem("modu-font")).toBe("cjk-yahei");
    expect(localStorage.getItem("modu-face")).toBe(null);
  });

  it("sans = 清内联、回 tokens.css 的 --font-sans（不是某个预设）", async () => {
    localStorage.setItem("modu-font", "sans");
    await freshSettings();
    const doc = document.getElementById("doc") as HTMLElement;
    expect(doc.style.fontFamily).toBe("");
    expect(doc.dataset.face).toBeUndefined();
  });

  it("坏值 / 未知 id 回退默认项（HarmonyOS Sans SC）", async () => {
    localStorage.setItem("modu-font", "乱码");
    const first = await freshSettings();
    expect(first.settings.readFontPref()).toBe("cjk-harmonyos");
    localStorage.setItem("modu-font", "not-a-real-id");
    const second = await freshSettings();
    expect(second.settings.readFontPref()).toBe("cjk-harmonyos");
  });
});

describe("常显「实际生效字体」（D-02 第三步最关键项）", () => {
  it("读数按 400 / 700 两个字重各显示一次，指向**真命中**的族名", async () => {
    seedComputedStyle("--font-pick-cjk-harmonyos");
    await freshSettings();
    expect(document.getElementById("set-font-effective")?.textContent).toBe("400 · HarmonyOS Sans SC");
    expect(document.getElementById("set-font-effective-bold")?.textContent).toBe("700 · HarmonyOS Sans SC");
    expect(document.getElementById("set-font-hint")?.dataset.state).toBe("ok");
  });

  it("首选在 400 挂掉 → 读数报下一个真命中的族（选了 A 实际是 B 由此暴露）", async () => {
    seedComputedStyle('"NoSuchFamilyZZZ__", "HarmonyOS Sans SC", sans-serif');
    await freshSettings();
    expect(document.getElementById("set-font-effective")?.textContent).toBe("400 · HarmonyOS Sans SC");
  });

  it("全不命中 → 读数说「系统回退」，提示走黄字态（不是静默）", async () => {
    seedComputedStyle("system-ui, sans-serif");
    await freshSettings();
    expect(document.getElementById("set-font-effective")?.textContent).toBe("400 · 系统回退");
    expect(document.getElementById("set-font-hint")?.dataset.state).toBe("fallback");
  });

  it("选出别的项后读数跟着换（400/700 各一条）", async () => {
    seedComputedStyle("--font-pick-cjk-yahei");
    await freshSettings();
    expect(document.getElementById("set-font-effective")?.textContent).toBe("400 · Microsoft YaHei UI");
    expect(document.getElementById("set-font-effective-bold")?.textContent).toBe("700 · Microsoft YaHei UI");
  });

  it("syncSettingsPanel 一并刷新读数（面板打开不陈旧）", async () => {
    seedComputedStyle("--font-pick-cjk-harmonyos");
    const { settings } = await freshSettings();
    const code = document.getElementById("set-font-effective");
    if (code !== null) code.textContent = "陈旧读数";
    settings.syncSettingsPanel();
    expect(code?.textContent).toBe("400 · HarmonyOS Sans SC");
  });
});

describe("主题下拉（三档接线，状态机在 ui/theme.ts）", () => {
  it("选深色 → html[data-theme=dark] + modu-theme 持久化", async () => {
    await freshSettings();
    const select = document.getElementById("set-theme") as HTMLSelectElement;
    select.value = "dark";
    select.dispatchEvent(new Event("change"));
    expect(document.documentElement.dataset.theme).toBe("dark");
    expect(localStorage.getItem("modu-theme")).toBe("dark");
  });

  it("选自动 → modu-theme=auto，data-theme 按系统解析（jsdom 无 matchMedia → 亮）", async () => {
    await freshSettings();
    const select = document.getElementById("set-theme") as HTMLSelectElement;
    select.value = "auto";
    select.dispatchEvent(new Event("change"));
    expect(localStorage.getItem("modu-theme")).toBe("auto");
    expect(document.documentElement.dataset.theme).toBe("light");
    expect(select.value).toBe("auto"); // 下拉回显三档偏好本身，非解析值
  });

  it("启动同步当前偏好（modu-theme=auto → 下拉回显自动）", async () => {
    localStorage.setItem("modu-theme", "auto");
    await freshSettings();
    expect((document.getElementById("set-theme") as HTMLSelectElement).value).toBe("auto");
  });
});

describe("配色下拉（D-01：5 套主题，与亮暗正交）", () => {
  it("选宣纸 → html[data-palette=xuanzhi] + modu-palette 持久化", async () => {
    await freshSettings();
    const select = document.getElementById("set-palette") as HTMLSelectElement;
    select.value = "xuanzhi";
    select.dispatchEvent(new Event("change"));
    expect(document.documentElement.dataset.palette).toBe("xuanzhi");
    expect(localStorage.getItem("modu-palette")).toBe("xuanzhi");
  });

  it("启动恢复：modu-palette=qingmo → 下拉回显并落 data-palette；坏值回退靛蓝", async () => {
    localStorage.setItem("modu-palette", "qingmo");
    await freshSettings();
    expect((document.getElementById("set-palette") as HTMLSelectElement).value).toBe("qingmo");
    expect(document.documentElement.dataset.palette).toBe("qingmo");
    localStorage.setItem("modu-palette", "乱码");
    await freshSettings();
    expect(document.documentElement.dataset.palette).toBe("dianlan");
  });

  it("配色与亮暗正交：data-theme=dark + data-palette=zidai 可同时成立", async () => {
    await freshSettings();
    const palette = document.getElementById("set-palette") as HTMLSelectElement;
    palette.value = "zidai";
    palette.dispatchEvent(new Event("change"));
    const theme = document.getElementById("set-theme") as HTMLSelectElement;
    theme.value = "dark";
    theme.dispatchEvent(new Event("change"));
    expect(document.documentElement.dataset.theme).toBe("dark");
    expect(document.documentElement.dataset.palette).toBe("zidai");
    // 两个下拉各自回显自己的维度
    expect(theme.value).toBe("dark");
    expect(palette.value).toBe("zidai");
  });

  it("syncSettingsPanel 同批回显配色（面板打开不陈旧）", async () => {
    const { settings } = await freshSettings();
    const palette = document.getElementById("set-palette") as HTMLSelectElement;
    palette.value = "shimo"; // 人为制造陈旧
    settings.syncSettingsPanel();
    expect(palette.value).toBe("dianlan");
  });
});

describe("行宽步进（40–60em 步进 2，用户反馈批次）", () => {
  it("clampWidth 钳制到 [40,60] 并吸附 2 的倍数", async () => {
    const { settings } = await freshSettings();
    expect(settings.clampWidth(38)).toBe(40); // 下界外拉回
    expect(settings.clampWidth(62)).toBe(60); // 上界外拉回
    expect(settings.clampWidth(45)).toBe(46); // 奇数吸附到偶数档
    expect(settings.clampWidth(41.4)).toBe(42);
  });

  it("＋ 步进：写 --me-width、回显数值、持久化 modu-width", async () => {
    await freshSettings();
    document.getElementById("set-width-inc")?.click();
    expect(widthVar()).toBe("48");
    expect(document.getElementById("set-width-val")?.textContent).toBe("48");
    expect(localStorage.getItem("modu-width")).toBe("48");
  });

  it("上下界不再增减（60 封顶 / 40 保底）", async () => {
    localStorage.setItem("modu-width", "60");
    await freshSettings();
    document.getElementById("set-width-inc")?.click();
    expect(widthVar()).toBe("60");
    localStorage.setItem("modu-width", "40");
    await freshSettings();
    document.getElementById("set-width-dec")?.click();
    expect(widthVar()).toBe("40");
  });

  it("启动恢复：modu-width=52 → --me-width 与回显均为 52；坏值回退 46", async () => {
    localStorage.setItem("modu-width", "52");
    await freshSettings();
    expect(widthVar()).toBe("52");
    expect(document.getElementById("set-width-val")?.textContent).toBe("52");
    localStorage.setItem("modu-width", "abc");
    await freshSettings();
    expect(widthVar()).toBe("46");
  });
});

describe("回显同步（波5起：◐ 按钮与面板同源，外部改后 sync 不陈旧）", () => {
  it("外部（◐）改主题后 syncSettingsPanel：下拉回显三档偏好", async () => {
    const { settings, applyThemePref } = await freshSettings();
    applyThemePref("auto"); // 模拟面板外改主题（◐ 循环到自动档）
    const select = document.getElementById("set-theme") as HTMLSelectElement;
    expect(select.value).toBe("auto"); // applyThemePref 已即时回显
    select.value = "light"; // 人为制造陈旧
    settings.syncSettingsPanel();
    expect(select.value).toBe("auto");
  });

  it("面板打开时自调 sync：外部改主题后再点 Aa，回显不陈旧", async () => {
    const { applyThemePref } = await freshSettings();
    applyThemePref("dark");
    const select = document.getElementById("set-theme") as HTMLSelectElement;
    select.value = "light"; // 制造陈旧
    document.getElementById("btn-settings")?.click(); // 打开面板 → 触发自调
    expect(select.value).toBe("dark");
  });
});

describe("面板开关", () => {
  it("Aa 按钮切换 settings-panel 显隐", async () => {
    await freshSettings();
    const panel = document.getElementById("settings-panel") as HTMLElement;
    expect(panel.hidden).toBe(true);
    document.getElementById("btn-settings")?.click();
    expect(panel.hidden).toBe(false);
    document.getElementById("btn-settings")?.click();
    expect(panel.hidden).toBe(true);
  });
});

/* ---- 自动保存开关（用户反馈批次）：modu-autosave 持久化、默认开 ---- */

describe("自动保存开关", () => {
  it("默认开：无记录 readAutosavePref=true，面板勾选框回显 checked", async () => {
    const { settings } = await freshSettings();
    expect(settings.readAutosavePref()).toBe(true);
    expect((document.getElementById("set-autosave") as HTMLInputElement).checked).toBe(true);
  });

  it("modu-autosave=off → 关且面板回显未勾；坏值也当开", async () => {
    localStorage.setItem("modu-autosave", "off");
    const { settings } = await freshSettings();
    expect(settings.readAutosavePref()).toBe(false);
    expect((document.getElementById("set-autosave") as HTMLInputElement).checked).toBe(false);
    localStorage.setItem("modu-autosave", "乱码");
    expect(settings.readAutosavePref()).toBe(true);
  });

  it("面板切换写回 localStorage（off ↔ on）", async () => {
    const { settings } = await freshSettings();
    const box = document.getElementById("set-autosave") as HTMLInputElement;
    box.checked = false;
    box.dispatchEvent(new Event("change"));
    expect(localStorage.getItem("modu-autosave")).toBe("off");
    expect(settings.readAutosavePref()).toBe(false);
    box.checked = true;
    box.dispatchEvent(new Event("change"));
    expect(localStorage.getItem("modu-autosave")).toBe("on");
  });
});

/* ---- Aa 面板点外关闭（用户反馈批次·语义纠正）：与最近菜单同款 document 点击委托，
 *      fix-15 的 focusout 延时自动关已按用户语义移除（点外立即关，无任何计时） ---- */

describe("Aa 面板点外关闭", () => {
  async function openPanel(): Promise<HTMLElement> {
    await freshSettings();
    document.getElementById("btn-settings")?.click();
    return document.getElementById("settings-panel") as HTMLElement;
  }

  it("点击面板与 Aa 钮之外的任意处 → 立即关闭（无延时）", async () => {
    const panel = await openPanel();
    (document.getElementById("doc") as HTMLElement).click();
    expect(panel.hidden).toBe(true);
  });

  it("点击面板内部控件不关；Aa 钮再点一次走手动开关（toggle 关）", async () => {
    const panel = await openPanel();
    document.getElementById("set-fs-inc")?.click(); // 面板内点击
    expect(panel.hidden).toBe(false);
    document.getElementById("btn-settings")?.click(); // Aa 钮 = 手动开关
    expect(panel.hidden).toBe(true);
  });

  it("面板关着时点外部无副作用（不会误开）", async () => {
    await freshSettings();
    (document.getElementById("doc") as HTMLElement).click();
    expect((document.getElementById("settings-panel") as HTMLElement).hidden).toBe(true);
  });
});
