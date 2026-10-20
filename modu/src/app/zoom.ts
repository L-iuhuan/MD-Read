/**
 * 纸面缩放（2026-09-30 用户实测反馈 J2：「放大成了应用内所有都放大，
 * 应该只放大中间的纸面区域」）。
 *
 * 缩放目标 = **纸面列**：阅读态 `#doc`（CSS zoom）；编辑态 `.cm-editor`（fix-32 深修 +
 * 2026-10-20 纸面缩放口径：改写 --paper-zoom 变量，经 editorTheme 把**字号、栏宽、内边距、
 * 行号锚点**按同一倍率缩放（= 纸面整体等比缩放，与阅读态 #doc 的 CSS zoom 视觉效果等价）；
 * 顶栏 / 标签栏 / 状态栏 / 大纲 / 设置面板**一律不缩放** ✓。
 *
 * 档位 90 / 100 / 110 / 125 / 150（%），持久化在 `modu-zoom`；滚轮 / 快捷键 /
 * 百分比显示的交互语义自 2026-09-27 首版起不变。
 *
 * 历史（为何现在只写纸面内联 zoom）：首版曾叠两层——Tauri `Webview.setZoom`
 * （原生层）+ 根元素 CSS `zoom`（兜底层）。真机实测原生层是空操作、效果全由根
 * zoom 承担，而两层并存有**叠乘**风险（125%×125%≈156% ✗）；且根 zoom 连顶栏/
 * 标签一起放大，正是本批用户反馈要消灭的行为 ✗ ⇒ 纸面化后两层皆弃，只把内联
 * `zoom` 写在纸面元素上。
 *
 * ⚠ 编辑器是懒建的：`.cm-editor` 首次进编辑态才出现 ⇒ main.ts 在 onModeChange
 *   里调 restorePaperZoom() 把缩放补到新目标（幂等，重复调用无害）。
 *  ⚠ 导出联动：markPrintBlocks 量宽须回到基准 ⇒ main.ts onExportClick 导出前
 *   clearPaperZoom()、finally 里 restorePaperZoom()（与旧根 zoom 时代的三步同款）。
 */
import { remeasureEditor } from "../editor/editor"; // app→editor 单向（editor 树不引 zoom.ts，无环）
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

/** 把档位写到纸面：阅读态 #doc 用 CSS zoom（纯展示，安全）；编辑态 .cm-editor 只写
 *  --paper-zoom 变量，由 editorTheme 消费为「字号 + 栏宽 + 内边距 + 行号锚点」同倍率缩放
 *  （纸面整体等比缩放，与阅读态视觉等价）。根因见下：CSS zoom 直接写在 CM6 根上会使
 *  clientHeight〔布局〕与 getBoundingClientRect〔视觉〕两套坐标按 1/k 分叉〔125% 实测
 *  452.5/362=1.25 精确成立〕⇒ CM6 测量系统崩坏；改为语义缩放后 CM6 正常重测，
 *  锚在 tests/editor-align.spec.ts；2026-10-20 用户裁定：**不能只缩字号**（否则纸面宽度
 *  不变、折行变密，与阅读态缩放不等价），栏宽/内边距必须同倍率。 */
function writePaperZoom(step: number): void {
  const v = clampStep(step);
  const doc = document.getElementById("doc");
  if (doc instanceof HTMLElement) {
    doc.style.zoom = String(v / 100);
  }
  const cm = document.querySelector(".cm-editor");
  if (cm instanceof HTMLElement) {
    cm.style.setProperty("--paper-zoom", String(v / 100));
    remeasureEditor(); // 字号变了：行高/断行必须重测（无实例自动早退）
  }
  const el = document.getElementById("set-zoom-val");
  if (el !== null) {
    el.textContent = String(v);
  }
}

/** 应用一档纸面缩放：钳制 → 持久化 → 写纸面 → 回显百分比（对外主入口） */
export function applyPaperZoom(step: number): void {
  const v = clampStep(step);
  window.localStorage.setItem(ZOOM_KEY, String(v));
  writePaperZoom(v);
}

/** 清掉纸面缩放（导出前量宽回基准用；持久化档位不动，便于还原） */
export function clearPaperZoom(): void {
  const doc = document.getElementById("doc");
  if (doc instanceof HTMLElement) {
    doc.style.removeProperty("zoom");
  }
  const cm = document.querySelector(".cm-editor");
  if (cm instanceof HTMLElement) {
    cm.style.removeProperty("--paper-zoom");
    remeasureEditor(); // 回基准字号也要重测
  }
}

/** 按持久化档位重投纸面（导出结束还原 / 编辑器新建后补挂共用；幂等 ✓） */
export function restorePaperZoom(): void {
  writePaperZoom(readZoomPref());
}

/**
 * ⚠ **幂等守卫**（2026-09-27 阶段④-③ 由单测抓出 ✗）：`setupZoom()` 若被调两次，
 * 滚轮/键盘这两个 **document 级** 监听会**叠加** ⇒ 一次手势跳多档
 * （实测：8 次 setup 后一次 wheel 直接顶到 150% ✗）。
 * ⇒ 只注册一次 ✓；**档位回填仍每次执行**（那才是"回填"的语义 ✓）。
 * ⚠ 只守 document 级：`±` 按钮的监听挂在元素上，DOM 重建后自然消失 ⇒ 无需守 ✓
 */
let documentWired = false;

/** 按档位表走一格（± 键 / Ctrl+滚轮 / 快捷键三条入口共用，避免三份逻辑 ✗） */
function stepZoom(delta: number): void {
  const steps = ZOOM_STEPS as readonly number[];
  const i = steps.indexOf(readZoomPref());
  const next = Math.min(steps.length - 1, Math.max(0, i + delta));
  applyPaperZoom(steps[next]);
}

/**
 * Ctrl/⌘ + 滚轮 = 纸面缩放（浏览器手感 ✓）。
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
      applyPaperZoom(100); // 复位到 100%（不是"减到最小"✗）
    }
  });
}

/** 启动/接线：回填当前档位 + 绑 ± 两键（与字号/行宽同一套交互语言 ✓）+ 滚轮/快捷键 ✓ */
export function setupZoom(): void {
  restorePaperZoom(); // 启动回填：面板显示值与实际缩放必须一致 ✓
  document.getElementById("set-zoom-dec")?.addEventListener("click", () => stepZoom(-1));
  document.getElementById("set-zoom-inc")?.addEventListener("click", () => stepZoom(1));
  if (!documentWired) {
    documentWired = true;
    wireZoomWheel();
    wireZoomKeys();
  }
}
