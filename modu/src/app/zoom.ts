/**
 * 页面整体缩放（2026-09-27 用户反馈：「想放大一点也不行，像浏览器里面直接放大整个页面」）
 *
 * 与「字号 / 行宽」**语义不同**（这点要在 UI 上讲清 ✓）：
 *   · 字号 / 行宽 ⇒ 只改**正文排版**（`--fs-body` / `--me-width`，阅读栏宽与行距）
 *   · 本模块     ⇒ 走 Tauri 的 `Webview.setZoom`，把**整个 webview 内容**等比缩放
 *                  （工具栏、标签、大纲、状态栏、设置面板、正文全在内 ✓）＝ 浏览器 Ctrl+加号的手感 ✓
 *
 * 档位 90 / 100 / 110 / 125 / 150（%），持久化在 `modu-zoom`。
 * ⚠ 缩放是**原生侧**状态：启动时必须回填一次，否则重启回到 100% 而面板还显示旧值 ✗
 */
import { getCurrentWebview } from "@tauri-apps/api/webview";

const ZOOM_KEY = "modu-zoom";
export const ZOOM_STEPS = [90, 100, 110, 125, 150] as const;
const ZOOM_DEFAULT = 100;

/** 读持久化档位；非法值回默认（与字号/行宽同款防御 ✓） */
export function readZoomPref(): number {
  const raw = window.localStorage.getItem(ZOOM_KEY);
  const n = raw === null ? Number.NaN : Number.parseInt(raw, 10);
  return (ZOOM_STEPS as readonly number[]).includes(n) ? n : ZOOM_DEFAULT;
}

/** 夹到最近的合法档位（越界时贴边，不抛错 ✓） */
function clampStep(z: number): number {
  const steps = ZOOM_STEPS as readonly number[];
  let best = steps[0];
  for (const s of steps) {
    if (Math.abs(s - z) < Math.abs(best - z)) {
      best = s;
    }
  }
  return best;
}

/** 应用到原生 webview（失败只记日志：缩放不该拦住启动 ✓） */
function applyZoom(z: number): void {
  window.localStorage.setItem(ZOOM_KEY, String(z));
  void getCurrentWebview()
    .setZoom(z / 100)
    .catch((e: unknown) => {
      console.error("[zoom] 设置整体缩放失败", e);
    });
}

function setZoom(z: number): void {
  const next = clampStep(z);
  applyZoom(next);
  const el = document.getElementById("set-zoom-val");
  if (el !== null) {
    el.textContent = String(next);
  }
}

/** 启动/接线：回填当前档位 + 绑 ± 两键（与字号/行宽同一套交互语言 ✓） */
export function setupZoom(): void {
  applyZoom(readZoomPref()); // 启动回填：面板显示值与实际缩放必须一致 ✓
  const val = document.getElementById("set-zoom-val");
  if (val !== null) {
    val.textContent = String(readZoomPref());
  }
  document.getElementById("set-zoom-dec")?.addEventListener("click", () => {
    const i = (ZOOM_STEPS as readonly number[]).indexOf(readZoomPref());
    setZoom((ZOOM_STEPS as readonly number[])[Math.max(0, i - 1)]);
  });
  document.getElementById("set-zoom-inc")?.addEventListener("click", () => {
    const i = (ZOOM_STEPS as readonly number[]).indexOf(readZoomPref());
    setZoom((ZOOM_STEPS as readonly number[])[Math.min(ZOOM_STEPS.length - 1, i + 1)]);
  });
}
