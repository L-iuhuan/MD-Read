/**
 * 主题引擎（用户反馈批次·跟随系统主题；D-01 批次加「配色」维度）。
 *
 * - 「自动」= matchMedia('(prefers-color-scheme: dark)') 即时解析：系统切换
 *   主题的瞬间跟随（watchSystemTheme 的 change 监听），亮/暗档是用户显式
 *   选择，不被系统覆盖；
 * - 持久化沿用 modu-theme（新增合法值 "auto"，坏值回退 light）；
 * - data-theme 恒写**解析值**（light/dark）——tokens.css 的暗色块只认这两个值，
 *   面板下拉与 ◐ 按钮则回显三档偏好本身；
 * - ◐ 按钮循环三态：亮 → 暗 → 自动 → 亮（nextThemePref）。
 * - D-01（5 套主题 × 亮暗 = 10 组调色板）：新增**正交**维度 data-palette，
 *   与 data-theme 互不干涉（data-theme 语义一字未改，既有测试与代码依赖不变）。
 *   data-palette 只取 dianlan / xuanzhi / shimo / zidai / qingmo；持久化键
 *   modu-palette，无记录/坏值回退 "dianlan"（默认主题，与 tokens.css 的
 *   :root 组同值）。若属性缺失，CSS 由 :root 兜底成靛蓝亮，不会掉样式。
 * 从 settings.ts 拆出（该文件管面板 DOM 接线，本文件管主题状态机），
 * main.ts 经 setupThemeEngine 接 refreshMermaidTheme。
 */

export type ThemePref = "light" | "dark" | "auto";
export type ResolvedTheme = "light" | "dark";
/** D-01 五套配色（亮暗由 ThemePref 决定，两者正交组合出 10 组调色板） */
export type PalettePref = "dianlan" | "xuanzhi" | "shimo" | "zidai" | "qingmo";

const THEME_KEY = "modu-theme";
const PALETTE_KEY = "modu-palette";

const PREF_LABELS: Readonly<Record<ThemePref, string>> = {
  light: "浅色",
  dark: "深色",
  auto: "自动",
};

const PALETTE_LABELS: Readonly<Record<PalettePref, string>> = {
  dianlan: "靛蓝",
  xuanzhi: "宣纸",
  shimo: "石墨",
  zidai: "紫黛",
  qingmo: "青墨",
};

/** 主题变更钩子（收到的是解析值；boot 前为无害默认） */
let changeHook: (theme: ResolvedTheme) => void = () => {};

export function setupThemeEngine(hook: (theme: ResolvedTheme) => void): void {
  changeHook = hook;
}

export function isThemePref(v: string): v is ThemePref {
  return v === "light" || v === "dark" || v === "auto";
}

/** 读三档偏好；无记录/坏值回退 light（与 index.html 初始 data-theme 一致） */
export function readThemePref(): ThemePref {
  const raw = localStorage.getItem(THEME_KEY);
  return raw !== null && isThemePref(raw) ? raw : "light";
}

export function isPalettePref(v: string): v is PalettePref {
  return v === "dianlan" || v === "xuanzhi" || v === "shimo" || v === "zidai" || v === "qingmo";
}

/** 读配色偏好；无记录/坏值回退 dianlan（默认主题，与 tokens.css :root 同值） */
export function readPalettePref(): PalettePref {
  const raw = localStorage.getItem(PALETTE_KEY);
  return raw !== null && isPalettePref(raw) ? raw : "dianlan";
}

/** 应用配色：data-palette + 持久化 + 面板下拉回显 + 钩子（Mermaid 重画） */
export function applyPalettePref(pref: PalettePref): void {
  document.documentElement.dataset.palette = pref;
  localStorage.setItem(PALETTE_KEY, pref);
  const select = document.getElementById("set-palette");
  if (select instanceof HTMLSelectElement) {
    select.value = pref;
  }
  const btn = document.getElementById("btn-theme");
  if (btn !== null) {
    btn.title = themeButtonTitle(readThemePref());
  }
  changeHook(resolvedTheme(readThemePref()));
}

/** 系统当前是否偏好深色（matchMedia 缺席——如 jsdom——按亮色） */
export function systemPrefersDark(): boolean {
  return (
    typeof matchMedia === "function" && matchMedia("(prefers-color-scheme: dark)").matches
  );
}

/** 纯函数：偏好 → 实际主题。prefersDark 可注入（测试），缺省读系统 */
export function resolvedTheme(pref: ThemePref, prefersDark = systemPrefersDark()): ResolvedTheme {
  if (pref === "auto") {
    return prefersDark ? "dark" : "light";
  }
  return pref;
}

/** ◐ 按钮循环序：亮 → 暗 → 自动 → 亮 */
export function nextThemePref(cur: ThemePref): ThemePref {
  return cur === "light" ? "dark" : cur === "dark" ? "auto" : "light";
}

/** ◐ 按钮 title：亮暗偏好 + 当前配色（两维度都在同一个回显点） */
function themeButtonTitle(pref: ThemePref): string {
  return `主题：${PREF_LABELS[pref]} · 配色：${PALETTE_LABELS[readPalettePref()]}（点击切换）`;
}

/** 应用主题：data-theme=解析值 + 持久化 + 面板下拉/◐ 钮回显 + 钩子 */
export function applyThemePref(pref: ThemePref): void {
  document.documentElement.dataset.theme = resolvedTheme(pref);
  localStorage.setItem(THEME_KEY, pref);
  const select = document.getElementById("set-theme");
  if (select instanceof HTMLSelectElement) {
    select.value = pref;
  }
  const btn = document.getElementById("btn-theme");
  if (btn !== null) {
    btn.title = themeButtonTitle(pref);
  }
  changeHook(resolvedTheme(pref));
}

/** 系统主题变化即时跟随：仅自动档响应 */
export function watchSystemTheme(): void {
  if (typeof matchMedia !== "function") {
    return; // 测试环境（jsdom）无此 API
  }
  const mq = matchMedia("(prefers-color-scheme: dark)");
  const onChange = (): void => {
    if (readThemePref() === "auto") {
      applyThemePref("auto");
    }
  };
  if (typeof mq.addEventListener === "function") {
    mq.addEventListener("change", onChange);
    return;
  }
  mq.addListener(onChange); // 旧引擎兜底（addListener 仍在 lib.dom 类型里）
}
