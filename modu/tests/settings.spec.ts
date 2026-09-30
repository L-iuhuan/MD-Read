/**
 * 字体面板（D-02 → 2026-09-30 J1 三下拉）契约。
 *
 * 与更早版本（单下拉装三组 optgroup）的差别就是本文件的锚：
 *   ① **三个独立 select**（#set-font-cn / #set-font-latin / #set-font-code），
 *      各自 label 写明角色、各自读写各自键（modu-font-cn / -latin / -code），
 *      选项骨架在 index.html，「对应哪个栈变量」由 data-stack-var 声明（**字体栈只在 tokens.css**）；
 *      选项文案 = 完整字体名（J1：不再截断成「Times New R.」）；
 *   ② 旧持久化值（单键 modu-font 的 sans/serif/kai/hei 与任意组内 id、更早 modu-face=serif）
 *      必须能迁移到对应组的新键，不能丢成默认值。
 *   （原 ③ 常显「实际生效字体」读数行：三下拉各自回显当前值后冗余，2026-09-30 整行
 *      删除，锚同批退役；探测判据本身的单测仍在 font-detect.spec.ts。）
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

// 2026-09-27：settings.ts 新增 `import { invoke } from "@tauri-apps/api/core"`
// （「设为 .md 默认应用」按钮接线）——jsdom 无 __TAURI_INTERNALS__，须 mock（同
// workspace-panel.spec.ts 建立的惯例）。
vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));

/** 只剥 HTML 注释：注释里的属性样例不该进 DOM（本文件用正则够，构建产物走真解析器） */
function stripHtmlComments(html: string): string {
  return html.replace(/<!--[\s\S]*?-->/g, "");
}

/**
 * 面板骨架：三个字体下拉的 option 直接来自 index.html（完整名不再手抄）。
 * 真机上 index.html 的 option 文字正是「首次渲染读到的中文名」，渲染会把它们写进
 * data-label；这里把同样的关系复现出来（否则第二次渲染就读不到文案了）。
 */
function selectSkeleton(id: string): string {
  const html = stripHtmlComments(readFileSync("index.html", "utf8"));
  const found = new RegExp(`<select[^>]*id="${id}"[^>]*>([\\s\\S]*?)</select>`).exec(html);
  if (found === null) throw new Error(`index.html 里找不到 #${id}`);
  const options = found[1].match(/<option\b[^>]*>[^<]*/g) ?? [];
  return `<select id="${id}" class="settings-select">${options
    .map((tag) => {
      const label = tag.slice(tag.indexOf(">") + 1).trim();
      const attr = label === "" ? "" : ` data-label="${label}"`;
      return `${tag.slice(0, tag.indexOf(">"))}${attr}>${label}`;
    })
    .join("")}</select>`;
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
      <button id="set-reset-typo" type="button">恢复默认</button>
      ${selectSkeleton("set-font-cn")}
      ${selectSkeleton("set-font-latin")}
      ${selectSkeleton("set-font-code")}
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
      <button id="set-default-app" type="button">设为 .md 默认应用</button>
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
async function freshSettings(extra?: Partial<SettingsModule.SettingsHooks>): Promise<Ctx> {
  vi.resetModules();
  const settings = await import("../src/ui/settings");
  const theme = await import("../src/ui/theme");
  const onFontChange = vi.fn();
  settings.setupSettings({
    getDoc: () => document.getElementById("doc"),
    onFontChange,
    measure: fakeMeasure,
    ...extra,
  });
  return { settings, applyThemePref: theme.applyThemePref, onFontChange };
}

function fsVar(): string {
  return document.documentElement.style.getPropertyValue("--fs-body");
}

function widthVar(): string {
  return document.documentElement.style.getPropertyValue("--me-width");
}

function wideVar(): string {
  return document.documentElement.style.getPropertyValue("--measure-wide");
}

/** 在某组下拉里选一项（J1：三 select 各自 change） */
function choose(group: "cn" | "latin" | "code", id: string): void {
  const select = document.getElementById(`set-font-${group}`) as HTMLSelectElement;
  select.value = id;
  select.dispatchEvent(new Event("change"));
}

beforeEach(() => {
  localStorage.clear();
  document.documentElement.style.removeProperty("--fs-body");
  document.documentElement.style.removeProperty("--me-width");
  document.documentElement.style.removeProperty("--measure-wide");
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

describe("字体三下拉（J1：三组各一个 select、互不影响）", () => {
  const FONT_SELECTS = ["set-font-cn", "set-font-latin", "set-font-code"] as const;

  it("三组目录齐备：三个下拉各 5 项，关键 id 都在", async () => {
    await freshSettings();
    for (const id of FONT_SELECTS) {
      const select = document.getElementById(id) as HTMLSelectElement;
      expect(select.querySelectorAll("option").length).toBe(5);
    }
    const ids = FONT_SELECTS.flatMap((id) =>
      [...document.querySelectorAll<HTMLOptionElement>(`#${id} option`)].map((o) => o.value),
    );
    expect(ids).toContain("cjk-harmonyos");
    expect(ids).toContain("cjk-yahei");
    expect(ids).toContain("cjk-songti");
    expect(ids).toContain("cjk-lxgw"); // 霞鹜文楷屏幕版（本机已装）
    expect(ids).toContain("cjk-notoserif");
    expect(ids).toContain("latin-times");
    expect(ids).toContain("mono-maple-nf");
    expect(ids).toContain("mono-cascadia");
    expect(ids).toContain("mono-consolas");
  });

  it("每个选项都声明 data-stack-var（栈只在 tokens.css，TS 零族名）", async () => {
    await freshSettings();
    for (const id of FONT_SELECTS) {
      for (const option of document.querySelectorAll(`#${id} option`)) {
        expect(option.getAttribute("data-stack-var")).toMatch(/^--font-pick-/);
      }
    }
  });

  it("选项文案为完整字体名（J1：不再截断——「Times New R.」✗）", async () => {
    await freshSettings();
    // Times 本机未装（假字宽表只登记 3 族）⇒ 带后缀，但主体必须是完整名而非缩写
    const times = document.querySelector('#set-font-latin option[value="latin-times"]');
    expect(times?.textContent).toContain("Times New Roman（衬线）");
    expect(times?.textContent).not.toContain("Times New R.");
    const yaheiui = document.querySelector('#set-font-latin option[value="latin-yaheiui"]');
    expect(yaheiui?.textContent).toBe("Microsoft YaHei UI"); // 已装 ⇒ 纯完整名
    const mix = document.querySelector('#set-font-code option[value="mono-maple-mix"]');
    expect(mix?.textContent).toContain("Maple Mono NF（中文回雅黑）");
  });

  it("select 的 title 挂当前完整名（J1：下拉万一截断时的兜底）", async () => {
    await freshSettings();
    const latin = document.getElementById("set-font-latin") as HTMLSelectElement;
    expect(latin.title).toContain("Segoe UI Variable Text"); // 默认档也是完整名
    choose("latin", "latin-times");
    expect(latin.title).toBe("Times New Roman（衬线）");
  });

  it("本机缺失的首选被标注「· 未装」，已装的保持完整名", async () => {
    await freshSettings();
    // 假字宽表里只登记了 HarmonyOS Sans SC / Microsoft YaHei UI / Noto Serif SC 三族
    const missing = document.querySelector('#set-font-code option[value="mono-maple-nf"]');
    expect(missing?.getAttribute("data-unavailable")).toBe("true");
    expect(missing?.textContent).toContain("未装");
    const present = document.querySelector('#set-font-cn option[value="cjk-harmonyos"]');
    expect(present?.getAttribute("data-unavailable")).toBe(null);
    expect(present?.textContent).toBe("HarmonyOS Sans SC");
  });

  it("三 select 各自读写各自键（选中文/西文/代码互不影响）", async () => {
    await freshSettings();
    choose("cn", "cjk-songti");
    choose("latin", "latin-times");
    choose("code", "mono-consolas");
    expect(localStorage.getItem("modu-font-cn")).toBe("cjk-songti");
    expect(localStorage.getItem("modu-font-latin")).toBe("latin-times");
    expect(localStorage.getItem("modu-font-code")).toBe("mono-consolas");
    expect((document.getElementById("set-font-cn") as HTMLSelectElement).value).toBe("cjk-songti");
    expect((document.getElementById("set-font-latin") as HTMLSelectElement).value).toBe("latin-times");
    expect((document.getElementById("set-font-code") as HTMLSelectElement).value).toBe("mono-consolas");
  });

  it("应用：正文栈 = 西文链（去尾通用族）+ 中文章，代码链覆写 --font-mono", async () => {
    await freshSettings();
    const doc = document.getElementById("doc") as HTMLElement;
    // ⚠ 西文链尾的 sans-serif 必须剥掉：通用族在中间会短路 CJK 回退（见 font-picker 头注释）
    expect(doc.style.fontFamily).toBe(
      '"Segoe UI Variable Text", "Segoe UI", Inter, Arial, "HarmonyOS Sans SC", "Microsoft YaHei UI", system-ui, sans-serif',
    );
    expect(doc.style.getPropertyValue("--font-mono")).toBe(
      '"Maple Mono NF", ui-monospace, "Cascadia Mono", Consolas, monospace',
    );
    expect(doc.dataset.face).toBeUndefined(); // 旧衬线档契约退役：三组组合永远走内联栈
  });

  it("换档后组合跟随：latin-times + cjk-yahei 的正文栈、mono-consolas 的代码链", async () => {
    await freshSettings();
    choose("latin", "latin-times");
    choose("cn", "cjk-yahei");
    choose("code", "mono-consolas");
    const doc = document.getElementById("doc") as HTMLElement;
    expect(doc.style.fontFamily).toBe(
      '"Times New Roman", Times, Georgia, "Microsoft YaHei UI", "Microsoft YaHei", system-ui, sans-serif',
    );
    expect(doc.style.getPropertyValue("--font-mono")).toBe(
      'Consolas, "Cascadia Mono", ui-monospace, monospace',
    );
  });

  it("启动恢复：modu-font-code=mono-cascadia → 代码下拉回显并应用该链", async () => {
    localStorage.setItem("modu-font-code", "mono-cascadia");
    await freshSettings();
    const doc = document.getElementById("doc") as HTMLElement;
    expect(doc.style.getPropertyValue("--font-mono")).toBe(
      '"Cascadia Mono", ui-monospace, Consolas, monospace',
    );
    expect((document.getElementById("set-font-code") as HTMLSelectElement).value).toBe("mono-cascadia");
  });

  it("字体变化触发 onFontChange 钩子（壳层重算排版）", async () => {
    const ctx = await freshSettings();
    ctx.settings.setFontPref("mono", "mono-cascadia");
    expect(ctx.onFontChange).toHaveBeenCalled();
  });
});

describe("字体旧值迁移（旧单键 modu-font / 更早 modu-face → 三新键）", () => {
  it("旧 modu-face=serif（无任何新键）→ 迁到中文组思源宋体，其余两组默认，旧键退役", async () => {
    localStorage.setItem("modu-face", "serif");
    const { settings } = await freshSettings();
    expect(settings.readFontPref("cjk")).toBe("cjk-notoserif");
    expect(settings.readFontPref("latin")).toBe("latin-segoe");
    expect(settings.readFontPref("mono")).toBe("mono-maple-nf");
    expect(localStorage.getItem("modu-face")).toBe(null);
    expect((document.getElementById("set-font-cn") as HTMLSelectElement).value).toBe("cjk-notoserif");
  });

  it.each([
    ["sans", "cjk-harmonyos"],
    ["serif", "cjk-notoserif"],
    ["kai", "cjk-lxgw"],
    ["hei", "cjk-yahei"],
  ])("旧 modu-font=%s → 中文组=%s（不被丢成默认值）", async (legacy, expected) => {
    localStorage.setItem("modu-font", legacy);
    const { settings } = await freshSettings();
    expect(settings.readFontPref("cjk")).toBe(expected);
    expect(localStorage.getItem("modu-font")).toBe(null);
  });

  it("旧值落在哪组由值本身决定：latin-times → 西文组得它，中文/代码组用默认", async () => {
    localStorage.setItem("modu-font", "latin-times");
    const { settings } = await freshSettings();
    expect(settings.readFontPref("latin")).toBe("latin-times");
    expect(settings.readFontPref("cjk")).toBe("cjk-harmonyos");
    expect(settings.readFontPref("mono")).toBe("mono-maple-nf");
  });

  it("坏值 → 三组全默认（HarmonyOS Sans SC / Segoe UI Variable Text / Maple Mono NF）", async () => {
    localStorage.setItem("modu-font", "乱码");
    const first = await freshSettings();
    expect(first.settings.readFontPref("cjk")).toBe("cjk-harmonyos");
    expect(first.settings.readFontPref("latin")).toBe("latin-segoe");
    localStorage.setItem("modu-font", "not-a-real-id");
    const second = await freshSettings();
    expect(second.settings.readFontPref("cjk")).toBe("cjk-harmonyos");
    expect(second.settings.readFontPref("mono")).toBe("mono-maple-nf");
  });

  it("三新键已在场时旧键不抢写（双源归一：新键优先，旧键清退）", async () => {
    localStorage.setItem("modu-font-cn", "cjk-yahei");
    localStorage.setItem("modu-font", "hei"); // 旧值与现值冲突 ⇒ 以新键为准
    const { settings } = await freshSettings();
    expect(settings.readFontPref("cjk")).toBe("cjk-yahei");
    expect(localStorage.getItem("modu-font")).toBe(null);
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

/* ---- F3（P2-2）：--measure-wide 随行宽派生 + 行宽重排钩子 ---- */

describe("行宽派生与重排钩子（F3）", () => {
  it("--measure-wide = 行宽 + 14em（tokens.css 现状 60−46 的既有档差），随设置联动", async () => {
    await freshSettings();
    expect(wideVar()).toBe("calc((46 + 14) * var(--fs-body))"); // 启动恢复即派生
    document.getElementById("set-width-inc")?.click();
    expect(widthVar()).toBe("48");
    expect(wideVar()).toBe("calc((48 + 14) * var(--fs-body))");
  });

  it("onWidthChange 停顿防抖：连点两次只在停顿后触发一次（refitView 重活不连跑）", async () => {
    vi.useFakeTimers();
    try {
      const onWidthChange = vi.fn();
      await freshSettings({ onWidthChange });
      document.getElementById("set-width-inc")?.click();
      document.getElementById("set-width-inc")?.click();
      expect(onWidthChange).not.toHaveBeenCalled(); // 停顿未到不跑
      vi.advanceTimersByTime(200);
      expect(onWidthChange).toHaveBeenCalledTimes(1); // 两击合并为一次
    } finally {
      vi.useRealTimers();
    }
  });
});

/* ---- UX-6（des-5）：数值点击直改（Enter/失焦提交、Esc 取消、越界钳制）+ 恢复默认 ---- */

describe("UX-6 · 数值直改与恢复默认", () => {
  function editInput(): HTMLInputElement {
    return document.querySelector("#settings-panel input[type=number]") as HTMLInputElement;
  }

  it("点击数值变输入框：Enter 提交并按既有范围钳制（99 → 20）", async () => {
    await freshSettings();
    document.getElementById("set-fs-val")?.click();
    const input = editInput();
    expect(input).not.toBeNull();
    input.value = "99";
    input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    expect(fsVar()).toBe("20px");
    expect(document.getElementById("set-fs-val")?.textContent).toBe("20"); // span 已还原并回显
    expect(localStorage.getItem("modu-fs")).toBe("20");
  });

  it("Esc 取消：不写任何值，span 原样还原", async () => {
    await freshSettings();
    document.getElementById("set-fs-val")?.click();
    const input = editInput();
    input.value = "18";
    input.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    expect(fsVar()).toBe("16px");
    expect(document.getElementById("set-fs-val")?.textContent).toBe("16");
  });

  it("失焦提交：点到别处也算确认；行宽吸附 2 的倍数", async () => {
    await freshSettings();
    document.getElementById("set-width-val")?.click();
    const input = editInput();
    input.value = "51";
    input.dispatchEvent(new Event("blur"));
    expect(widthVar()).toBe("52"); // clampWidth 吸附偶数档
  });

  it("恢复默认：字号回 16、行宽回 46；主题与配色不动（用户长期选择不被动）", async () => {
    await freshSettings();
    document.getElementById("set-fs-inc")?.click();
    document.getElementById("set-width-inc")?.click();
    document.getElementById("set-width-inc")?.click();
    const theme = document.getElementById("set-theme") as HTMLSelectElement;
    theme.value = "dark";
    theme.dispatchEvent(new Event("change"));
    document.getElementById("set-reset-typo")?.click();
    expect(fsVar()).toBe("16px");
    expect(widthVar()).toBe("46");
    expect(localStorage.getItem("modu-fs")).toBe("16");
    expect(localStorage.getItem("modu-width")).toBe("46");
    expect(document.documentElement.dataset.theme).toBe("dark");
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
