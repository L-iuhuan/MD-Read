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
  // ① 原生缩放：Tauri `Webview.setZoom`
  void getCurrentWebview()
    .setZoom(z / 100)
    .catch((e: unknown) => {
      console.error("[zoom] 设置整体缩放失败", e);
    });
  // ② ⚠ 2026-09-27 **真机实测**：只调 ① 时**界面毫无变化** ✗ ——
  //    三路读数（`innerWidth` 1680 / 工具栏高 48 / 正文字号 16px）**全都不动**，
  //    而面板值与 `localStorage` 都已写成 125 ✓ ⇒ ① 在本机是空操作 ✗。
  //    （教训：这一项走**原生** API，`tsc` 通过**不等于**生效 ✗ —— 上一版就是这么误判的。）
  //    ⇒ 再叠一层 CSS `zoom` 兜底：Chromium 对根元素应用 `zoom` 会**整体等比缩放**
  //      （视口 CSS px 随之收缩 ✓），正是用户要的"像浏览器 Ctrl+加号"效果 ✓。
  //    ⚠ 两层并存**并非**「不会更差」：若某环境 ① 真正生效，两层会**叠乘**
  //      （如 125%×125%≈156%）✗。当前实测 ① 在本机是空操作、效果全由 ② 承担；
  //      导出 PDF 前 main.ts 会暂时清掉 ②（markPrintBlocks 量宽与打印都不吃缩放），
  //      导出结束还原（onExportClick 的 finally）。
  document.documentElement.style.zoom = String(z / 100);
}

function setZoom(z: number): void {
  const next = clampStep(z);
  applyZoom(next);
  const el = document.getElementById("set-zoom-val");
  if (el !== null) {
    el.textContent = String(next);
  }
}

/**
 * ⚠ **幂等守卫**（2026-09-27 阶段④-③ 由单测抓出 ✗）：`setupZoom()` 若被调两次，
 * 滚轮/键盘这两个 **document 级** 监听会**叠加** ⇒ 一次手势跳多档
 * （实测：8 次 setup 后一次 wheel 直接顶到 150% ✗）。
 * ⇒ 只注册一次 ✓；**档位回填仍每次执行**（那才是"回填"的语义 ✓）。
 * ⚠ 只守 document 级：`±` 按钮的监听挂在元素上，DOM 重建后自然消失 ⇒ 无需守 ✓
 *   （也因此单测里每次重建 DOM 后 `setupZoom()` 仍能正常绑上按钮 ✓）
 */
let documentWired = false;

/** 按档位表走一格（± 键 / Ctrl+滚轮 / 快捷键三条入口共用，避免三份逻辑 ✗） */
function stepZoom(delta: number): void {
  const steps = ZOOM_STEPS as readonly number[];
  const i = steps.indexOf(readZoomPref());
  const next = Math.min(steps.length - 1, Math.max(0, i + delta));
  setZoom(steps[next]);
}

/**
 * Ctrl/⌘ + 滚轮 = 整体缩放（浏览器手感 ✓）。
 * ⚠ 三条纪律：
 *  ① **普通滚轮一律不拦**（不带修饰键直接 return ✓）—— 正文滚动是主行为，不能被抢 ✗
 *  ② 监听必须 `{ passive: false }` 才能 `preventDefault()` ✓（否则报"无法取消"并静默失效 ✗）
 *  ③ **节流 120ms**：一次触控板手势会连发几十个 wheel 事件 ⇒ 不节流会一滑到底 ✗
 *  （Windows 的触控板捏合也走 ctrl+wheel ⇒ 顺带支持 ✓）
 */
function wireZoomWheel(): void {
  let last = 0;
  document.addEventListener(
    "wheel",
    (event) => {
      if (!(event.ctrlKey || event.metaKey)) {
        return;
      }
      event.preventDefault();
      const now = Date.now();
      if (now - last < 120) {
        return;
      }
      last = now;
      stepZoom(event.deltaY < 0 ? 1 : -1);
    },
    { passive: false },
  );
}

/** 键盘：Ctrl+= 放大 / Ctrl+- 缩小 / Ctrl+0 复位（与浏览器一致 ✓）。
 *  ⚠ 这三个组合在本应用**未被占用**（现有只有 Ctrl+P 导出 / Ctrl+F 查找 / Ctrl+E 编辑 ✓，2026-09-27 全仓核对）。 */
function wireZoomKeys(): void {
  document.addEventListener("keydown", (event) => {
    if (!(event.ctrlKey || event.metaKey) || event.altKey) {
      return;
    }
    const key = event.key;
    if (key === "=" || key === "+") {
      event.preventDefault();
      stepZoom(1);
    } else if (key === "-" || key === "_") {
      event.preventDefault();
      stepZoom(-1);
    } else if (key === "0") {
      event.preventDefault();
      setZoom(100); // 复位到 100%（不是"减到最小"✗）
    }
  });
}

/** 启动/接线：回填当前档位 + 绑 ± 两键（与字号/行宽同一套交互语言 ✓）+ 滚轮/快捷键 ✓ */
export function setupZoom(): void {
  applyZoom(readZoomPref()); // 启动回填：面板显示值与实际缩放必须一致 ✓
  const val = document.getElementById("set-zoom-val");
  if (val !== null) {
    val.textContent = String(readZoomPref());
  }
  document.getElementById("set-zoom-dec")?.addEventListener("click", () => stepZoom(-1));
  document.getElementById("set-zoom-inc")?.addEventListener("click", () => stepZoom(1));
  if (!documentWired) {
    documentWired = true;
    wireZoomWheel();
    wireZoomKeys();
  }
}
