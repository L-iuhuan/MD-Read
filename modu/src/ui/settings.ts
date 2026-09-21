/**
 * 「Aa」设置面板（M2 波3，用户反馈：字体是否考虑可以切换或者设置）。
 *
 * 三件事：
 * ① 字号步进 14–20px：改 --fs-body（cjk.css 认定的唯一作用点），
 *   localStorage modu-fs 持久化、启动恢复；
 * ② 字体族四预设（微软雅黑/宋体/楷体/黑体，西文回落不变）：
 *   modu-font 持久化——取代「衬」按钮的职能（顶栏按钮并存，布局波4 定）。
 *   serif 走既有 #doc[data-face] 契约（cjk.css --font-serif 栈）；
 *   kai/hei 在 typography 冻结期落内联 font-family，不开新 CSS 钩子；
 *   旧键 modu-face=serif 作存量迁移回退，写入新键后退役。
 * ③ 主题亮暗切换入面板（原 ◐ 按钮保留，两者同源 modu-theme）。
 * ④（波5）syncSettingsPanel：面板外（◐ 按钮）改状态后刷新面板回显，
 *   面板每次打开时也自调——修「面板开着时点 ◐，下拉回显陈旧」。
 *
 * DOM 结构与 id 就位、样式最简（app.css），波4 美化；禁 any、函数 ≤50 行。
 */

const FS_MIN = 14;
const FS_MAX = 20;
const FS_DEFAULT = 16; // 与 tokens.css --fs-body 默认同值
const FS_KEY = "modu-fs";
const FONT_KEY = "modu-font";
const LEGACY_FACE_KEY = "modu-face"; // M2 波2 起的旧键：serif 存量迁移回退
const THEME_KEY = "modu-theme";

/** kai/hei 预设字体栈（sans=清内联回默认栈，serif=--font-serif 栈；西文回落沿用衬线/无衬线既有搭配） */
const FONT_STACKS: Readonly<Record<"kai" | "hei", string>> = {
  kai: '"KaiTi", "楷体", "STKaiti", "TW-Kai", Georgia, "Times New Roman", serif',
  hei: '"SimHei", "黑体", "Microsoft YaHei UI", "PingFang SC", system-ui, sans-serif',
};

export type FontPref = "sans" | "serif" | "kai" | "hei";

export interface SettingsHooks {
  /** 取正文容器 #doc（字体预设的落点） */
  getDoc(): HTMLElement | null;
  /** 字体/字号变化后重算排版（壳层接 refitView：字体度量变了，断行与公式缩放要重跑） */
  onFontChange(): void;
  /** 主题切换后刷新 Mermaid（壳层接 refreshMermaidTheme） */
  onThemeChange(theme: "light" | "dark"): void;
}

function req<T extends HTMLElement>(id: string): T {
  const el = document.getElementById(id);
  if (el === null) {
    throw new Error(`界面元素缺失：#${id}`);
  }
  return el as T;
}

/** setupSettings 注入的壳层钩子（模块级单例：应用只有一个设置面板） */
let hooks: SettingsHooks = {
  getDoc: () => null,
  onFontChange: () => {},
  onThemeChange: () => {},
};

/** 字号钳制到 [14, 20] 并取整 px */
export function clampFs(px: number): number {
  return Math.min(FS_MAX, Math.max(FS_MIN, Math.round(px)));
}

/** 读持久化字号；无记录/坏值回退 16（与 tokens 默认一致） */
export function readFsPref(): number {
  const raw = localStorage.getItem(FS_KEY);
  const n = raw === null ? NaN : Number.parseInt(raw, 10);
  return Number.isFinite(n) ? clampFs(n) : FS_DEFAULT;
}

/** 应用字号：写 --fs-body、回显数值、持久化 */
function writeFs(px: number): void {
  const v = clampFs(px);
  document.documentElement.style.setProperty("--fs-body", `${v}px`);
  req<HTMLElement>("set-fs-val").textContent = String(v);
  localStorage.setItem(FS_KEY, String(v));
}

/** 读字体预设：modu-font 优先，无则回退旧 modu-face（serif 存量） */
export function readFontPref(): FontPref {
  const font = localStorage.getItem(FONT_KEY);
  if (font === "sans" || font === "serif" || font === "kai" || font === "hei") {
    return font;
  }
  return localStorage.getItem(LEGACY_FACE_KEY) === "serif" ? "serif" : "sans";
}

/** 应用字体预设到 #doc：serif 走 data-face 契约，kai/hei 内联栈，sans 全清 */
export function applyFontPref(font: FontPref): void {
  const doc = hooks.getDoc();
  if (doc === null) return;
  if (font === "serif") {
    doc.style.removeProperty("font-family");
    doc.dataset.face = "serif";
  } else if (font === "kai" || font === "hei") {
    delete doc.dataset.face;
    doc.style.fontFamily = FONT_STACKS[font];
  } else {
    delete doc.dataset.face;
    doc.style.removeProperty("font-family");
  }
}

function isFontPref(v: string): v is FontPref {
  return v === "sans" || v === "serif" || v === "kai" || v === "hei";
}

/** 统一入口：应用 + 持久化 + 同步面板下拉（「衬」按钮与设置面板共用同一状态源） */
export function setFontPref(font: FontPref): void {
  applyFontPref(font);
  localStorage.setItem(FONT_KEY, font);
  localStorage.removeItem(LEGACY_FACE_KEY); // 双源归一，旧键退役
  req<HTMLSelectElement>("set-font").value = font;
  hooks.onFontChange();
}

/** 主题切换：data-theme + 持久化 + 钩子（与顶栏 ◐ 按钮同源同效果） */
function setTheme(theme: "light" | "dark"): void {
  document.documentElement.dataset.theme = theme;
  localStorage.setItem(THEME_KEY, theme);
  hooks.onThemeChange(theme);
}

/** 当前实际字号：优先读 --fs-body（唯一作用点），未设时回退持久化值 */
function currentFs(): number {
  const raw = document.documentElement.style.getPropertyValue("--fs-body");
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) ? clampFs(n) : readFsPref();
}

/**
 * 刷新面板回显（主题/字号/字体族）以反映当前实际状态。
 * 壳层在 ◐ 按钮改主题后调用；面板每次打开时也自调（防陈旧）。
 * 元素缺席时静默跳过——同步回显属锦上添花，不配炸按钮回调。
 */
export function syncSettingsPanel(): void {
  const theme = document.getElementById("set-theme") as HTMLSelectElement | null;
  if (theme !== null) {
    theme.value = document.documentElement.dataset.theme === "dark" ? "dark" : "light";
  }
  const fsVal = document.getElementById("set-fs-val");
  if (fsVal !== null) {
    fsVal.textContent = String(currentFs());
  }
  const font = document.getElementById("set-font") as HTMLSelectElement | null;
  if (font !== null) {
    font.value = readFontPref();
  }
}

function wireFontSize(): void {
  writeFs(readFsPref()); // 启动恢复 + 回显
  req<HTMLButtonElement>("set-fs-dec").addEventListener("click", () => writeFs(readFsPref() - 1));
  req<HTMLButtonElement>("set-fs-inc").addEventListener("click", () => writeFs(readFsPref() + 1));
}

function wireFontSelect(): void {
  const select = req<HTMLSelectElement>("set-font");
  select.value = readFontPref();
  applyFontPref(readFontPref()); // 启动恢复：#doc 常驻 index.html，落容器上即可
  select.addEventListener("change", () => {
    if (isFontPref(select.value)) setFontPref(select.value);
  });
}

function wireThemeSelect(): void {
  const select = req<HTMLSelectElement>("set-theme");
  select.value = document.documentElement.dataset.theme === "dark" ? "dark" : "light";
  select.addEventListener("change", () => {
    setTheme(select.value === "dark" ? "dark" : "light");
  });
}

/** Aa 按钮切换面板显隐；打开时刷新回显（面板外改过的状态不带到面板里） */
function wireToggle(): void {
  const panel = req<HTMLElement>("settings-panel");
  req<HTMLButtonElement>("btn-settings").addEventListener("click", () => {
    panel.hidden = !panel.hidden;
    if (!panel.hidden) syncSettingsPanel();
  });
}

/** boot 时调用一次：恢复字号/字体并接好全部面板交互 */
export function setupSettings(deps: SettingsHooks): void {
  hooks = deps;
  wireFontSize();
  wireFontSelect();
  wireThemeSelect();
  wireToggle();
}
