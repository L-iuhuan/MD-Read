/**
 * 「Aa」设置面板（M2 波3，用户反馈：字体是否考虑可以切换或者设置）。
 *
 * 五件事：
 * ① 字号步进 14–20px：改 --fs-body（cjk.css 认定的唯一作用点），
 *   localStorage modu-fs 持久化、启动恢复；
 * ② 字体族四预设（微软雅黑/宋体/楷体/黑体，西文回落不变）：
 *   modu-font 持久化——取代「衬」按钮的职能（顶栏按钮并存，布局波4 定）。
 *   serif 走既有 #doc[data-face] 契约（cjk.css --font-serif 栈）；
 *   kai/hei 在 typography 冻结期落内联 font-family，不开新 CSS 钩子；
 *   旧键 modu-face=serif 作存量迁移回退，写入新键后退役。
 * ③ 主题三档（亮/暗/自动）入面板：状态机在 ui/theme.ts，此处只接下拉；
 * ④（波5）syncSettingsPanel：面板外改状态后刷新面板回显，面板打开时自调；
 * ⑤（用户反馈批次）自动保存开关：modu-autosave 持久化、默认开；
 * ⑥（用户反馈批次·语义纠正）行宽步进 40–60em 步进 2（默认 46）：写 --me-width，
 *   tokens.css --measure 派生链消费；modu-width 持久化；
 * ⑦（用户反馈批次·语义纠正）点外关闭：document 点击委托（与最近菜单同款），
 *   点击面板与 Aa 钮之外任意处立即收起；手动路径（Aa 钮/Esc）不变——
 *   原 fix-15 的 focusout 延时自动关按用户语义纠正移除。
 *
 * DOM 结构与 id 就位、样式最简（app.css），波4 美化；禁 any、函数 ≤50 行。
 */
import {
  applyThemePref,
  isThemePref,
  readThemePref,
} from "./theme";

const FS_MIN = 14;
const FS_MAX = 20;
const FS_DEFAULT = 16; // 与 tokens.css --fs-body 默认同值
const FS_KEY = "modu-fs";
const FONT_KEY = "modu-font";
const LEGACY_FACE_KEY = "modu-face"; // M2 波2 起的旧键：serif 存量迁移回退
const WIDTH_MIN = 40; // em；步进 2，默认 46（与 tokens.css --measure 旧固定值同源）
const WIDTH_MAX = 60;
const WIDTH_DEFAULT = 46;
const WIDTH_KEY = "modu-width";
const AUTOSAVE_KEY = "modu-autosave";

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
}

function req<T extends HTMLElement>(id: string): T {
  const el = document.getElementById(id);
  if (el === null) {
    console.error(`界面元素缺失：#${id}`); // A4：技术细节只进 console，使用者只看下一行
    throw new Error("界面资源未就绪，请重启墨读");
  }
  return el as T;
}

/** setupSettings 注入的壳层钩子（模块级单例：应用只有一个设置面板） */
let hooks: SettingsHooks = {
  getDoc: () => null,
  onFontChange: () => {},
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

/** 自动保存开关（用户反馈批次）：默认开——只有显式 off 才关，坏值也当开
 *  （editor.ts 的 EditSessionDeps.isAutosaveEnabled 接此函数） */
export function readAutosavePref(): boolean {
  return localStorage.getItem(AUTOSAVE_KEY) !== "off";
}

/** 统一入口：应用 + 持久化 + 同步面板下拉（「衬」按钮与设置面板共用同一状态源） */
export function setFontPref(font: FontPref): void {
  applyFontPref(font);
  localStorage.setItem(FONT_KEY, font);
  localStorage.removeItem(LEGACY_FACE_KEY); // 双源归一，旧键退役
  req<HTMLSelectElement>("set-font").value = font;
  hooks.onFontChange();
}

/** 行宽钳制到 [40, 60] 并吸附到 2 的倍数（步进 2） */
export function clampWidth(em: number): number {
  const snapped = Math.round(em / 2) * 2;
  return Math.min(WIDTH_MAX, Math.max(WIDTH_MIN, snapped));
}

/** 读持久化行宽；无记录/坏值回退 46（与 tokens --measure 旧固定值一致） */
export function readWidthPref(): number {
  const raw = localStorage.getItem(WIDTH_KEY);
  const n = raw === null ? NaN : Number.parseInt(raw, 10);
  return Number.isFinite(n) ? clampWidth(n) : WIDTH_DEFAULT;
}

/** 应用行宽：写 --me-width（tokens --measure 派生链消费）、回显、持久化 */
function writeWidth(em: number): void {
  const v = clampWidth(em);
  document.documentElement.style.setProperty("--me-width", String(v));
  req<HTMLElement>("set-width-val").textContent = String(v);
  localStorage.setItem(WIDTH_KEY, String(v));
}

/** 当前实际行宽：优先读 --me-width（唯一作用点），未设时回退持久化值 */
function currentWidth(): number {
  const raw = document.documentElement.style.getPropertyValue("--me-width");
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) ? clampWidth(n) : readWidthPref();
}

/** 当前实际字号：优先读 --fs-body（唯一作用点），未设时回退持久化值 */
function currentFs(): number {
  const raw = document.documentElement.style.getPropertyValue("--fs-body");
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) ? clampFs(n) : readFsPref();
}

/**
 * 刷新面板回显（主题/字号/行宽/字体族）以反映当前实际状态。
 * 壳层在外部改状态后调用；面板每次打开时也自调（防陈旧）。
 * 元素缺席时静默跳过——同步回显属锦上添花，不配炸按钮回调。
 */
export function syncSettingsPanel(): void {
  const theme = document.getElementById("set-theme") as HTMLSelectElement | null;
  if (theme !== null) {
    theme.value = readThemePref(); // 回显三档偏好（非解析值）
  }
  const fsVal = document.getElementById("set-fs-val");
  if (fsVal !== null) {
    fsVal.textContent = String(currentFs());
  }
  const widthVal = document.getElementById("set-width-val");
  if (widthVal !== null) {
    widthVal.textContent = String(currentWidth());
  }
  const font = document.getElementById("set-font") as HTMLSelectElement | null;
  if (font !== null) {
    font.value = readFontPref();
  }
  const autosave = document.getElementById("set-autosave") as HTMLInputElement | null;
  if (autosave !== null) {
    autosave.checked = readAutosavePref();
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
  select.value = readThemePref();
  select.addEventListener("change", () => {
    if (isThemePref(select.value)) {
      applyThemePref(select.value); // 三档状态机（含自动档）在 ui/theme.ts
    }
  });
}

function wireWidth(): void {
  writeWidth(readWidthPref()); // 启动恢复 + 回显
  req<HTMLButtonElement>("set-width-dec").addEventListener("click", () =>
    writeWidth(readWidthPref() - 2),
  );
  req<HTMLButtonElement>("set-width-inc").addEventListener("click", () =>
    writeWidth(readWidthPref() + 2),
  );
}

/** Aa 按钮切换面板显隐；打开时刷新回显（面板外改过的状态不带到面板里） */
function wireToggle(): void {
  const panel = req<HTMLElement>("settings-panel");
  req<HTMLButtonElement>("btn-settings").addEventListener("click", () => {
    panel.hidden = !panel.hidden;
    if (!panel.hidden) syncSettingsPanel();
  });
}

/** 点外关闭（用户反馈批次·语义纠正，与最近菜单同款 document 点击委托）：
 *  点击面板与 Aa 钮之外任意处**立即**收起——不是失焦延时。手动路径
 *  （Aa 钮再点一次 / Esc 统一仲裁）一概不变。 */
function wireClickOutside(panel: HTMLElement): void {
  const btn = document.getElementById("btn-settings");
  document.addEventListener("click", (event) => {
    if (panel.hidden) {
      return;
    }
    const target = event.target;
    if (
      target instanceof Node &&
      (panel.contains(target) || (btn !== null && btn.contains(target)))
    ) {
      return;
    }
    panel.hidden = true; // 点外部立即收起
  });
}

function wireAutosaveToggle(): void {
  const box = req<HTMLInputElement>("set-autosave");
  box.checked = readAutosavePref(); // 启动回显
  box.addEventListener("change", () => {
    localStorage.setItem(AUTOSAVE_KEY, box.checked ? "on" : "off");
  });
}

/** boot 时调用一次：恢复字号/行宽/字体/主题并接好全部面板交互 */
export function setupSettings(deps: SettingsHooks): void {
  hooks = deps;
  wireFontSize();
  wireWidth();
  wireFontSelect();
  wireThemeSelect();
  wireAutosaveToggle();
  wireToggle();
  wireClickOutside(req<HTMLElement>("settings-panel"));
}
