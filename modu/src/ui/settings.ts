/**
 * 「Aa」设置面板（M2 波3，用户反馈：字体是否考虑可以切换或者设置）。
 *
 * 七件事：
 * ① 字号步进 14–20px：改 --fs-body（cjk.css 认定的唯一作用点），
 *   localStorage modu-fs 持久化、启动恢复；
 * ② 字体（D-02 → 2026-09-30 J1 换血）：**三个独立下拉（中文正文/西文/代码，各自
 *   回显当前值——原「实际生效」读数行已冗余删除）**，实现全部在 ui/font-picker.ts
 *   （目录来自 tokens.css，探测判据见 ui/font-detect.ts）。本文件只保留接线；
 *   持久化拆三键 modu-font-cn/-latin/-code，
 *   旧单键 modu-font（含更早 modu-face=serif）由 font-picker 一次性迁移回退。
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
  setFontPref as applyFontPick,
  syncFontSelects,
  type FontPickGroup,
  type FontPickerHooks,
} from "./font-picker";
import { invoke } from "@tauri-apps/api/core";

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
  /** 行宽变化后排版重算（F3/P2-2：断行守卫须随行宽重跑；本模块已做停顿防抖，
   *  ± 连点只在停顿后触发一次——refitView 逐块量宽，重活不值得连跑） */
  onWidthChange?(): void;
  /** 测试用的量器注入点（生产不传，走真实 canvas；见 font-picker 的 FontPickerHooks.measure） */
  measure?: FontPickerHooks["measure"];
  /** 状态栏闪信（2026-09-27：「设为默认应用」的结果反馈）；测试可省略 */
  notify?: (message: string, kind: "ok" | "warn" | "error") => void;
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

/** 字体选择（D-02 → 2026-09-30 J1 三下拉）：目录/探测/组合应用全在 ui/font-picker.ts */
export { readFontPref };

/** 统一入口（对外保留旧名 setFontPref）：应用 + 持久化（该组键）+ 回显 + 刷新读数。
 *  旧单键 modu-font / modu-face 由 font-picker 的 migrateLegacyPicks 一次性迁移。 */
export function setFontPref(group: FontPickGroup, id: string): void {
  applyFontPick(group, id, fontHooks());
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

/** 行宽重排的停顿防抖（F3）：连点 ± 只在停顿后触发一次 onWidthChange */
let widthRefitTimer: number | undefined;
function scheduleWidthRefit(): void {
  window.clearTimeout(widthRefitTimer);
  widthRefitTimer = window.setTimeout(() => {
    widthRefitTimer = undefined;
    hooks.onWidthChange?.();
  }, 200);
}

/** 应用行宽：写 --me-width（tokens --measure 派生链消费）、回显、持久化。
 *  F3（P2-2）：--measure-wide（宽表上限）随行宽派生——tokens.css 本体禁改
 *  （视觉 lane），故在 documentElement 以内联值覆盖 :root 同名声明；
 *  差值 +14em 取 tokens.css 现状既有语义（--measure 默认 46、--measure-wide 60，
 *  即「宽表比正文宽一档」的固定档差），行宽拉满 60 时宽表随之到 74em。 */
function writeWidth(em: number): void {
  const v = clampWidth(em);
  document.documentElement.style.setProperty("--me-width", String(v));
  document.documentElement.style.setProperty(
    "--measure-wide",
    `calc((${v} + 14) * var(--fs-body))`,
  );
  req<HTMLElement>("set-width-val").textContent = String(v);
  localStorage.setItem(WIDTH_KEY, String(v));
  scheduleWidthRefit();
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
  const font = document.getElementById("set-font-cn");
  if (font !== null) {
    syncFontSelects(); // J1：三下拉各自回显各自键（面板外改过不陈旧）
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
  // UX-6（des-5）：数值本身可点击直改（16→20 连点 4 次太磨人）
  wireDirectEdit("set-fs-val", readFsPref, writeFs);
}

/**
 * UX-6（des-5）：数值回显 span 点击 → 就地变 `input[type=number]`。
 * Enter / 失焦提交（越界由 writeFs/writeWidth 钳到既有范围），Esc 取消。
 * 先还原 span 再提交——write 里的回显走 req(id)，节点不在树里会炸。
 */
function wireDirectEdit(valId: string, read: () => number, write: (value: number) => void): void {
  req<HTMLElement>(valId).addEventListener("click", () => {
    const span = req<HTMLElement>(valId); // 现取：还原路径要放回这个节点
    const input = document.createElement("input");
    input.type = "number";
    input.value = String(read());
    let settled = false;
    const done = (apply: boolean): void => {
      if (settled) {
        return; // Enter 提交后随后的 blur 不再二次提交
      }
      settled = true;
      input.replaceWith(span);
      if (apply) {
        const n = Number.parseInt(input.value, 10);
        if (Number.isFinite(n)) {
          write(n);
        }
      }
    };
    input.addEventListener("keydown", (event) => {
      if (event.key === "Enter" || event.key === "Escape") {
        event.preventDefault();
        done(event.key === "Enter");
      }
    });
    input.addEventListener("blur", () => done(true));
    span.replaceWith(input);
    input.focus();
    input.select();
  });
}

/** 字体面板接线（D-02）：填目录 → 恢复选择 → 接 change（实现全在 font-picker） */
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
  wireDirectEdit("set-width-val", readWidthPref, writeWidth); // UX-6：数值点击直改
}

/** UX-6（des-5）：恢复默认排版（16px / 46em）。只复位字号与行宽——主题与配色是
 *  用户长期选择，不被动（审计原文「不要重置主题」）。 */
function wireResetTypo(): void {
  req<HTMLButtonElement>("set-reset-typo").addEventListener("click", () => {
    writeFs(FS_DEFAULT);
    writeWidth(WIDTH_DEFAULT);
    hooks.notify?.("已恢复默认字号与行宽", "ok");
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

/** 「设为 .md 默认应用」（2026-09-27 用户反馈）：写全 HKCU 注册（Rust 侧
 *  register_markdown_default，自动打开系统默认应用页），结果走状态栏闪信。
 *  安全软件弹窗询问关联变更属预期——用户点允许即可。 */
function wireDefaultApp(): void {
  req<HTMLButtonElement>("set-default-app").addEventListener("click", () => {
    void (async () => {
      try {
        await invoke("register_markdown_default");
        hooks.notify?.("已注册为 .md 打开候选：请在系统设置页选择「墨读」", "ok");
      } catch (error) {
        hooks.notify?.(String(error), "error");
      }
    })();
  });
}

/** boot 时调用一次：恢复字号/行宽/字体/主题/配色并接好全部面板交互 */
export function setupSettings(deps: SettingsHooks): void {
  hooks = deps;
  wireFontSize();
  wireWidth();
  wireResetTypo(); // UX-6：恢复默认（只回字号/行宽）
  wireFontSelect();
  wireThemeSelect();
  wirePaletteSelect();
  wireAutosaveToggle();
  wireDefaultApp();
  wireToggle();
  wireClickOutside(req<HTMLElement>("settings-panel"));
}
