/**
 * 「Aa」设置面板（M2 波3，用户反馈：字体是否考虑可以切换或者设置）。
 *
 * 七件事：
 * ① 字号步进 14–20px：改 --fs-body（cjk.css 认定的唯一作用点），
 *   localStorage modu-fs 持久化、启动恢复；
 * ② 字体（D-02 第二步起换血）：**推荐列表按语义分三组 + 常显「实际生效字体」**，
 *   实现全部在 ui/font-picker.ts（目录来自 tokens.css，探测判据见 ui/font-detect.ts）。
 *   本文件只保留接线：modu-font 持久化、旧 modu-face=serif 存量迁移回退、
 *   字体变化后回调 onFontChange 重算排版。
 *   ⚠ 旧「四预设 sans/serif/kai/hei」仍可读：resolvePick 会迁到对应新选项，
 *     旧值不会被丢成默认值。
 * ③ 主题三档（亮/暗/自动）入面板：状态机在 ui/theme.ts，此处只接下拉；
 *    D-01 批次再加一行「配色」下拉（5 套主题），与 ③ 正交组合出 10 组调色板；
 *    持久化键 modu-palette（无记录回退靛蓝），读写与回显同样在 ui/theme.ts；
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
  applyPalettePref,
  applyThemePref,
  isPalettePref,
  isThemePref,
  readPalettePref,
  readThemePref,
} from "./theme";
import {
  mountFontPicker,
  readFontPref,
  refreshEffective,
  setFontPref as applyFontPick,
  type FontPickerHooks,
} from "./font-picker";

const FS_MIN = 14;
const FS_MAX = 20;
const FS_DEFAULT = 16; // 与 tokens.css --fs-body 默认同值
const FS_KEY = "modu-fs";
const WIDTH_MIN = 40; // em；步进 2，默认 46（与 tokens.css --measure 旧固定值同源）
const WIDTH_MAX = 60;
const WIDTH_DEFAULT = 46;
const WIDTH_KEY = "modu-width";
const AUTOSAVE_KEY = "modu-autosave";

export interface SettingsHooks {
  /** 取正文容器 #doc（字体预设的落点） */
  getDoc(): HTMLElement | null;
  /** 字体/字号变化后重算排版（壳层接 refitView：字体度量变了，断行与公式缩放要重跑） */
  onFontChange(): void;
  /** 测试用的量器注入点（生产不传，走真实 canvas；见 font-picker 的 FontPickerHooks.measure） */
  measure?: FontPickerHooks["measure"];
}

/** 字体面板需要的那两个钩子（与 SettingsHooks 同形；为避免重复声明只做结构复用） */
export type SettingsFontHooks = FontPickerHooks;

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

/** 传给字体面板的钩子：getDoc / onFontChange 随时取当前值（#doc 可能被重建），
 *  measure 原样透传（生产为 undefined） */
function fontHooks(): FontPickerHooks {
  const measure = hooks.measure;
  return {
    getDoc: () => hooks.getDoc(),
    onFontChange: () => hooks.onFontChange(),
    ...(measure === undefined ? {} : { measure }),
  };
}


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

/** 字体选择（D-02）：目录/探测/「实际生效字体」全在 ui/font-picker.ts */
export { readFontPref, refreshEffective };

/** 统一入口（对外保留旧名 setFontPref）：应用 + 持久化 + 回显 + 刷新读数。
 *  旧值 sans/serif/kai/hei 由 font-picker 的 resolvePick 迁移到对应新选项。 */
export function setFontPref(font: string): void {
  applyFontPick(font, fontHooks());
}

/** 自动保存开关（用户反馈批次）：默认开——只有显式 off 才关，坏值也当开
 *  （editor.ts 的 EditSessionDeps.isAutosaveEnabled 接此函数） */
export function readAutosavePref(): boolean {
  return localStorage.getItem(AUTOSAVE_KEY) !== "off";
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
  const palette = document.getElementById("set-palette") as HTMLSelectElement | null;
  if (palette !== null) {
    palette.value = readPalettePref(); // 回显 5 套配色（D-01）
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
  refreshEffective(fontHooks()); // 「实际生效字体」与选择同批刷新（换主题/字号都可能改变命中）
  const autosave = document.getElementById("set-autosave") as HTMLInputElement | null;
  if (autosave !== null) {
    autosave.checked = readAutosavePref();
  }
}

function wireFontSize(): void {
  writeFs(readFsPref()); // 启动恢复 + 回显
  req<HTMLButtonElement>("set-fs-dec").addEventListener("click", () => {
    writeFs(readFsPref() - 1);
    refreshEffective(fontHooks()); // 字号变了排版要重算，读数同批刷新
  });
  req<HTMLButtonElement>("set-fs-inc").addEventListener("click", () => {
    writeFs(readFsPref() + 1);
    refreshEffective(fontHooks());
  });
}

/** 字体面板接线（D-02）：填目录 → 恢复选择 → change → 亮出「实际生效字体」 */
function wireFontSelect(): void {
  mountFontPicker(fontHooks());
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

/** 配色下拉（D-01）：5 套主题与亮暗正交；启动恢复 + 持久化都在 ui/theme.ts */
function wirePaletteSelect(): void {
  const select = req<HTMLSelectElement>("set-palette");
  select.value = readPalettePref();
  applyPalettePref(readPalettePref()); // 启动恢复：把持久化配色落到 data-palette
  select.addEventListener("change", () => {
    if (isPalettePref(select.value)) {
      applyPalettePref(select.value);
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

/** boot 时调用一次：恢复字号/行宽/字体/主题/配色并接好全部面板交互 */
export function setupSettings(deps: SettingsHooks): void {
  hooks = deps;
  wireFontSize();
  wireWidth();
  wireFontSelect();
  wireThemeSelect();
  wirePaletteSelect();
  wireAutosaveToggle();
  wireToggle();
  wireClickOutside(req<HTMLElement>("settings-panel"));
}
