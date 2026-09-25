/**
 * 墨读 M2 应用壳：多标签 + 最近文件 + 文档内查找 + 大纲滚动跟随。
 * M3-A 增编辑态（F7）：CM6 会话在 editor/，此处只做接线（Ctrl+E/S/F、✎ 按钮）。
 * M4 增导出 PDF（⇩ 按钮）：等待渲染完备 → 存路径 → CDP `Page.printToPDF` 直出，逻辑在 render/print-ready 与 Rust print.rs。
 * 排版在 typography/，渲染在 render/，标签/最近在 app/，查找在 ui/——此处只做接线。
 */
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import {
  getCurrentWindow,
  type Window as TauriWindow,
} from "@tauri-apps/api/window";
import { renderDocument, type OutlineItem } from "./render/pipeline";
import { keepOffscreenSkipping, shapeOf } from "./render/offscreen-policy";
import { enhanceView, refitView, refreshMermaidTheme } from "./render/view";
import { attachCodeCopyButtons } from "./render/codecopy";
import { awaitPrintReady, markPrintBlocks } from "./render/print-ready";
import {
  createTabManager,
  type MountContext,
  type Tab,
  type TabManager,
} from "./app/tabs";
import { createCloseGuard } from "./app/close-guard";
import { pushRecent, setupRecentMenu } from "./app/recent";
import { req } from "./app/dom";
import { setupShellOverflow } from "./app/shell-overflow";
import { prevalidateMermaid } from "./render/mermaid";
import { openEachMd } from "./app/drop";
import { createOutlineFollow } from "./app/outline-follow";
import { setupExternalLinks } from "./app/links";
import { resolveRelativeImages } from "./app/images";
import { setupFindbar, closeTopmostOverlay, type Findbar } from "./ui/findbar";
import { setupEmptyState, type EmptyState } from "./ui/empty-state";
import { setupOverlayState } from "./ui/overlay-state";
import { askCloseChoice } from "./ui/close-confirm";
import { installBootWatchdog, revealBootFailure } from "./ui/boot-error";
import { setupSettings, readAutosavePref } from "./ui/settings";
import {
  applyPalettePref,
  applyThemePref,
  nextThemePref,
  readPalettePref,
  readThemePref,
  setupThemeEngine,
  watchSystemTheme,
} from "./ui/theme";
import { createEditSession, flashStatus, type EditSession } from "./editor/editor";
import { firstVisibleLine } from "./editor/position-map";
import "./app.css";
import "./typography/tokens.css";
import "./typography/cjk.css";
import "./typography/print.css";
import "./typography/hljs.css"; // 代码高亮唯一主题（P5 批2 接线；配色细化在批4）
import "katex/dist/katex.min.css";

interface LoadedFile {
  text: string;
  encoding: string;
  /** Rust 车道新增字段（D7 保真），未合入时缺省 */
  bom?: boolean;
  crlf?: boolean;
}

/** 会话先于 tabs 建好，但 showError/resetToWelcome 由 tabs 回调触发——模块级引用 */
let editorSession: EditSession | null = null;
let activeTabs: TabManager | null = null;
/** P5 批2：全局 Esc / Ctrl+P / 导出入口都要操作 findbar，模块级引用（boot 时赋值） */
let activeFindbar: Findbar | null = null;
/** 空态（欢迎页）实例：resetToWelcome 时重画最近列表，故需模块级引用 */
let activeEmptyState: EmptyState | null = null;
/** ⇩PDF 按钮（HTML 初始 disabled，由 JS 在有文档时启用——不动 HTML 的约定） */
let exportButton: HTMLButtonElement | null = null;

/** 取界面元素（批次 3-7：实现搬到 `app/dom.ts` 的 `req`；此处保留 `$` 别名 ⇒ 原有调用点一字未动） */
const $ = req;

/** 打开失败（P5 批2·错误通道统一）：不清正文、不顶标签——当前标签内容保持，
 *  状态栏红字闪错（多文件拖放单个失败同走此道，不中断其余）。
 *  D-05 起中间那个「与标签重复的文件名」已从顶栏删除，故这里不再需要复位标题；
 *  当前文档名改由窗口标题承担（见 mountRendered）。 */
function showError(error: unknown): void {
  flashStatus(`打开失败：${String(error)}`, "error");
}

/* ---- 大纲 ---- */

const outlineLinks = new Map<string, HTMLAnchorElement>();

function mountOutline(items: OutlineItem[]): void {
  const list = $<HTMLElement>("outline-list");
  list.textContent = "";
  outlineLinks.clear();
  // Fragment 批量挂载：长文大纲可达数千条，逐个 appendChild 会触发回流风暴（P3 性能诊断）
  const frag = document.createDocumentFragment();
  for (const item of items) {
    const link = document.createElement("a");
    link.textContent = item.text;
    link.href = `#${item.id}`;
    link.style.paddingLeft = `${(item.level - 1) * 12}px`;
    link.addEventListener("click", (event) => {
      event.preventDefault();
      document.getElementById(item.id)?.scrollIntoView();
    });
    outlineLinks.set(item.id, link);
    frag.appendChild(link);
  }
  list.appendChild(frag);
}

/* ---- 大纲滚动跟随（F4）· X2（2026-09-23 第二批）----
   旧实现用 IntersectionObserver 观察**全部** h1–h6（本机 2MB 语料实测 4,715 个），
   Blink 每帧为它们重算相交矩形：`computeIntersections` 占滚动墙钟 26.3%~33.6%，
   单它就超过 13.3ms 的 vsync 预算（性能实验 §3.2）。
   现在改成每帧一次**实时二分**（log₂n ≈ 13 次 getBoundingClientRect），语义与旧逐条
   比较逐点等价 —— 推导与边界写在 app/outline-follow.ts 顶部注释里，那里也解释了为什么
   不用「渲染期预算偏移表」（content-visibility 估高会让偏移失真、必须反复重建）。
   rAF 节流（scheduleFollow）保持不变：M10「滚动节流开关」已判不做。 */

/** 大纲跟随实例：deps 惰性取 DOM，模块级创建不碰 DOM；正文换/回空态时 reset。 */
const outlineFollow = createOutlineFollow({
  content: () => $("content"),
  doc: () => $("doc"),
  links: () => outlineLinks,
});
let followPending = false;

function scheduleFollow(): void {
  if (followPending) {
    return;
  }
  followPending = true;
  requestAnimationFrame(() => {
    followPending = false;
    outlineFollow.update(); // 当前项没变时它不碰 DOM（旧版每次变化要对 4,715 条链接各 toggle 一次）
    updateStatusLine(); // 状态栏行号与大纲跟随同一帧节流（P5 批2）
  });
}

/* ---- 状态栏行号（P5 批2）：阅读态随滚动取视口首个 [data-line] 块；
 *      编辑态由切态回填（onModeChange）。 ---- */

function setStatusLine(line: number): void {
  const el = $<HTMLElement>("st-line");
  el.hidden = false;
  el.textContent = `行 ${line}`;
}

function updateStatusLine(): void {
  const doc = document.getElementById("doc");
  if (doc === null || doc.hidden) {
    $<HTMLElement>("st-line").hidden = true;
    return;
  }
  const line = firstVisibleLine($("content"));
  if (line === null) {
    $<HTMLElement>("st-line").hidden = true; // 无 data-line 块（空文档等）：不显示
    return;
  }
  setStatusLine(line);
}

/* ---- 标签接线（四个入口最终都汇到 openPath → tabs.openTab） ---- */

function resetToWelcome(): void {
  editorSession?.reset(); // 空态：收起编辑器并作废当前档
  const doc = $<HTMLElement>("doc");
  doc.textContent = "";
  doc.hidden = true;
  $("empty-hint").hidden = false;
  document.body.classList.add("empty"); // 空态判据（唯一来源）：CSS 据此隐大纲与 ☰
  activeEmptyState?.refresh(); // 空态回来了：最近列表按最新存储重画（无则整块不显示）
  mountOutline([]);
  outlineFollow.reset(); // X2：回到空态 —— 标题列表清空（之后 update() 直接返回 false）
  document.title = "墨读 MoDu"; // 窗口标题（D-05 起它是文档名的唯一去处）
  $("st-encoding").textContent = "—";
  $("st-progress").textContent = "0%";
  $("st-line").hidden = true;
  const editBtn = document.getElementById("btn-edit") as HTMLButtonElement | null;
  if (editBtn !== null) {
    editBtn.disabled = true; // 无文档不可编辑
  }
  if (exportButton !== null) {
    exportButton.disabled = true; // 无文档不可导出
  }
  $("content").scrollTop = 0;
}

function createTabs(session: EditSession, mountRendered: (ctx: MountContext) => void): TabManager {
  // designer 并行重构标题栏，#tabbar 可能移位或暂缺：缺席时挂到离屏容器保 boot 不炸
  const bar = document.getElementById("tabbar") ?? document.createElement("nav");
  return createTabManager(bar as HTMLElement, {
    render: (source) => renderDocument(source, { pangu: true }),
    mountDoc: mountRendered,
    // 切走时零拷贝回收正文（P5 批3 渲染缓存）；编辑态正文可能滞后 source，不回收
    harvestDoc: () => {
      if (editorSession?.isEditing() === true) {
        return null;
      }
      const doc = document.getElementById("doc");
      if (doc === null || doc.hidden) {
        return null;
      }
      const frag = document.createDocumentFragment();
      frag.replaceChildren(...Array.from(doc.childNodes)); // 节点搬运，mermaid/增强产物随行
      return frag;
    },
    beginLoading: () => $("content").classList.add("content-loading"),
    endLoading: () => $("content").classList.remove("content-loading"),
    getScroll: () => $("content").scrollTop,
    setScroll: (top) => {
      $("content").scrollTop = top;
    },
    onEmpty: resetToWelcome,
    confirmClose: (tab) => window.confirm(`「${tab.title}」有未保存的修改，确定要关闭吗？`),
    saveEditorState: () => session.saveEditorState(), // 切走标签：编辑器态存回
    loadEditorState: (saved) => session.loadEditorState(saved), // 切入标签：按档恢复
  });
}

/** activate=false：多文件连开的中间项——只开标签不挂载（P5 批2，见 drop.ts） */
async function openPath(tabs: TabManager, path: string, activate = true): Promise<void> {
  try {
    const file = await invoke<LoadedFile>("read_file", { path });
    tabs.openTab(path, file, activate);
    pushRecent(path);
  } catch (error) {
    showError(error);
  }
}

/** 打开对话框：**对话框在 Rust 侧**（R-01）——用户亲手选中的文件由 Rust 登记为受信路径，
 *  渲染层拿不到"凭空登记"的能力（否则攻陷页面可 `登记任意路径 → 读任意文件`）。
 *  filter/多选由 Rust 命令设定（`md/markdown/mdx`，与关联注册/拖放/命令行同一份清单）。 */
async function onOpenClick(tabs: TabManager): Promise<void> {
  try {
    const pickedPaths = await invoke<string[]>("pick_markdown_files");
    if (pickedPaths.length === 0) {
      return; // 用户取消：静默结束
    }
    await openEachMd(pickedPaths, (path, activate) => openPath(tabs, path, activate));
  } catch (error) {
    showError(error);
  }
}

/* ---- 导出 PDF（M4）：等待渲染完备 → 存路径 → CDP `Page.printToPDF` 直出 ---- */

/** 默认存档名：当前文件名去 .md/.markdown 扩展 + .pdf */
function defaultPdfName(path: string): string {
  const name = path.split(/[\\/]/).pop() ?? "";
  const stem = name.replace(/\.(md|markdown)$/i, "");
  return `${stem === "" ? "文档" : stem}.pdf`;
}

async function onExportClick(tabs: TabManager): Promise<void> {
  activeFindbar?.close(); // P5 批2：查找 mark 不进 PDF
  const tab = tabs.activeTab();
  if (tab === null) {
    return; // 无文档：按钮本应禁用，双保险
  }
  if (editorSession?.isEditing() === true) {
    editorSession.toRead(); // beta 席 D2 条款：编辑态导出先切回阅读态（含重渲正文）
  }
  const doc = document.getElementById("doc");
  if (doc === null) {
    return;
  }
  const failed = doc.querySelectorAll(".mermaid[data-mmd-error]").length;
  if (failed > 0) {
    flashStatus(`有 ${failed} 张图渲染失败，将按占位导出`, "warn"); // 告警不阻断（P5 批2）
  }
  const ready = await awaitPrintReady(doc);
  if (ready.timedOut) {
    flashStatus("部分图表未渲染完成，将按当前版式导出", "warn");
  }
  // P1-4 补：字体/图片没在时限内就绪时提示（此前只有 mermaid 有等待与提示）
  if (ready.fontsTimedOut) {
    flashStatus("字体加载超时，部分字形可能按回退字体导出", "warn");
  } else if (ready.imageFailures.length > 0) {
    flashStatus(`有 ${ready.imageFailures.length} 张图片未就绪，将按当前版式导出`, "warn");
  }
  // P1-4(b)+宽表：竖版放不下的表自动横排；连横版都放不下的再压列换行（用户裁决 ④）。
  // 「可能被截」提醒已于 2026-09-23 撤除：压列后表格不丢列、图片有 max-inline-size:100%、
  // pre 会换行 ⇒ 已无会静默丢内容的类别，留着就是会撒谎的提示。
  markPrintBlocks(doc);
  let picked: string | null;
  try {
    picked = await invoke<string | null>("pick_save_path", {
      defaultName: defaultPdfName(tab.path),
    });
  } catch (error) {
    flashStatus(`导出失败：${String(error)}`, "error");
    return;
  }
  if (picked === null || picked === "") {
    return; // 用户取消：静默结束
  }
  try {
    // 页眉已按平台限制取舍清空（用户反馈批次：PDF 只要页码不要页眉，print.rs 查证注释）
    flashStatus(await invoke<string>("export_pdf", { path: picked }), "ok");
  } catch (error) {
    flashStatus(`导出失败：${String(error)}`, "error");
  }
}

/* ---- 全局键位（P5 批2）：Ctrl+P 绑导出（阅读/编辑两态都触发，
 *      preventDefault 阻浏览器打印对话框）；Esc 依序关浮层
 *      findbar → 设置面板 → 最近菜单（一次只关一个）。
 *      ⚠ 须先于 setupFindbar 注册：统一 Esc 要抢在 findbar 自有 Esc 之前定夺，
 *      否则一次 Esc 会连关两层。 ---- */
function setupGlobalKeys(): void {
  document.addEventListener("keydown", (event) => {
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "p") {
      event.preventDefault();
      if (activeTabs !== null) {
        void onExportClick(activeTabs);
      }
      return;
    }
    if (event.key === "Escape") {
      closeTopmostOverlay(activeFindbar);
    }
  });
}

/* ---- 标签快捷键（用户反馈批次）：Ctrl+W 关标签、Ctrl+Tab / Ctrl+Shift+Tab
 *      循环切换。capture 阶段全局拦截——Ctrl+Tab 若放行会先被 CM 的面板/编辑器
 *      键位吃掉，先于一切目标定夺；编辑态照常工作（CM 对 Mod-w / Tab 无默认绑定，
 *      有绑定的 Tab 缩进被 preventDefault 接管）。 ---- */

/** 循环切换：delta=1 下一个（Ctrl+Tab），-1 上一个（Ctrl+Shift+Tab），环回 */
function cycleTab(delta: number): void {
  const tabs = activeTabs;
  if (tabs === null) {
    return;
  }
  const paths = tabs.paths();
  if (paths.length < 2) {
    return; // 0/1 张标签无可切换
  }
  const active = tabs.activeTab();
  if (active === null) {
    return;
  }
  const idx = paths.indexOf(active.path);
  if (idx < 0) {
    return;
  }
  tabs.activateTab(paths[(idx + delta + paths.length) % paths.length]);
}

function setupTabHotkeys(): void {
  document.addEventListener(
    "keydown",
    (event) => {
      if (!(event.ctrlKey || event.metaKey)) {
        return;
      }
      if (event.key.toLowerCase() === "w") {
        event.preventDefault();
        event.stopPropagation();
        if (activeTabs !== null) {
          const tab = activeTabs.activeTab();
          if (tab !== null) {
            activeTabs.closeTab(tab.path); // dirty 标签走 confirmClose 确认
          }
        }
        return;
      }
      if (event.key === "Tab") {
        event.preventDefault();
        event.stopPropagation();
        cycleTab(event.shiftKey ? -1 : 1);
      }
    },
    true,
  );
}

function setupDragDrop(tabs: TabManager): void {
  void getCurrentWebview().onDragDropEvent((event) => {
    if (event.payload.type === "drop") {
      // 多文件拖放（M2 波3 反馈①）：全部 Markdown（md/markdown/mdx，共用清单见 app/md-ext.ts）
      // 逐个开标签；仅末项渲染（P5 批2）
      void openEachMd(event.payload.paths, (path, activate) => openPath(tabs, path, activate));
    }
  });
}

/* ---- 无边框窗口标题栏（M2 波3 反馈⑤）---- */

/** 最大化/还原图标状态切换（用户反馈批次）：两套 SVG（#ic-max 单框 /
 *  #ic-restore 双框）+ title/aria 同步「最大化 / 向下还原」 */
async function syncMaxState(win: TauriWindow): Promise<void> {
  let maximized = false;
  try {
    maximized = await win.isMaximized();
  } catch {
    return; // 查询失败（窗口关闭中等）：维持当前图标态
  }
  const btn = $("win-max");
  btn.title = maximized ? "向下还原" : "最大化";
  btn.setAttribute("aria-label", maximized ? "向下还原" : "最大化");
  document.getElementById("ic-max")?.toggleAttribute("hidden", maximized);
  document.getElementById("ic-restore")?.toggleAttribute("hidden", !maximized);
}

function setupWindowControls(): void {
  const win = getCurrentWindow();
  $("win-min").addEventListener("click", () => void win.minimize());
  $("win-max").addEventListener("click", () => void win.toggleMaximize());
  $("win-close").addEventListener("click", () => void win.close());
  // 双击顶栏空白 = 最大化/还原（Windows 标题栏惯例）。
  // D-05：拖拽垫片 .titlebar-drag 已删，双击改绑在 <header> 本体上；
  // 因此必须按事件目标排除控件——否则双击标签/按钮会连带最大化（旧实现绑在垫片上，
  // 那时不需要这层判断，现在结构变了，这层判断就是正确性的一部分）。
  const header = $("titlebar");
  header.addEventListener("dblclick", (event) => {
    const target = event.target;
    if (target instanceof Element && target.closest("button, .tab, input, select, a") !== null) {
      return; // 控件上的双击归控件自己（标签双击不该最大化窗口）
    }
    void win.toggleMaximize();
  });
  void syncMaxState(win); // 启动对齐（可能是系统记住的最大化态）
  void win.onResized(() => void syncMaxState(win)); // 最大化/还原随尺寸变化即时切图标
  // 关闭守卫（P0-7）：标题栏 ✕ 的 close() 与 Alt+F4 都发 close-requested，同一入口
  void win.onCloseRequested((event) => closeGuard(event));
}

/* ---- 顶栏拥挤态（D-05 定稿）已搬至 app/shell-overflow.ts（批次 3-7）---- */

/* ---- 关闭守卫（P0-7）：窗口关闭请求前拦一道——有未保存改动就问
 *      保存 / 放弃 / 取消，别让防抖窗口里的编辑随窗口一起没。
 *      判据/状态机在 app/close-guard.ts（shouldGuardClose / resolveCloseAction /
 *      createCloseGuard），浮层在 ui/close-confirm.ts（F 批抽出的三选一对话框，
 *     样式在 app.css §13），本文件只负责接线。 ---- */

/** 未落盘文本：活动标签以体内 source 为准（回阅读态时已同步，编辑器存档可能滞后），
 *  非活动标签取切走时存的编辑器态（存档 sliceDoc 按行分隔符 join，CRLF 保真）。 */
function unsavedText(tab: Tab, isActive: boolean): string {
  const saved = tab.editor;
  return isActive || saved === null ? tab.source : saved.state.sliceDoc();
}

/** 逐个落盘未保存标签（P0-7）：活动编辑标签走会话保存链（原编码/BOM 保真、
 *  失败文案复用），其余按未落盘文本直存。任一失败返回 false（窗口不关）。 */
async function saveDirtyTabs(tabs: TabManager): Promise<boolean> {
  const active = tabs.activeTab();
  let allSaved = true;
  for (const tab of tabs.dirtyTabs()) {
    const isActive = active !== null && tab.path === active.path;
    const session = editorSession;
    if (isActive && session !== null && session.isEditing()) {
      await session.save(); // 失败自闪「保存失败：…」，成败按 dirty 回读判定
      if (tab.dirty) {
        allSaved = false;
      }
      continue;
    }
    const text = unsavedText(tab, isActive);
    try {
      await invoke<void>("save_file", {
        path: tab.path,
        text,
        encoding: tab.encoding,
        bom: tab.bom,
      });
      tab.source = text;
      tabs.setDirty(tab.path, false);
    } catch (error) {
      flashStatus(`保存失败：${String(error)}`, "error");
      allSaved = false;
    }
  }
  return allSaved;
}

/** 关闭请求处理（P0-7）：Alt+F4 与标题栏 ✕ 在 Tauri 2 上是同一条 close-requested
 *  事件（tao 的 WM_CLOSE → CloseRequested → 前端事件），故只此一处入口，不另设键位。
 *
 *  【P0-7 回归修复·2026-09-23 实机测量】旧版此处开头无条件 event.preventDefault()，
 *  再由本函数自己调 win.destroy() 收尾，结果窗口再也关不掉。真正原因不是 destroy()
 *  本身没效果，而是**没权限**：
 *    1. `window.__TAURI__.window.getCurrentWindow().destroy()` 实测抛
 *       `window.destroy not allowed. Permissions associated with this command:
 *        core:window:allow-destroy`（capabilities 此前只授了 allow-close 等）；
 *    2. @tauri-apps/api 2.11.1 的 onCloseRequested 是「先 await handler，再看
 *       event.isPreventDefault()；没 prevent 就自己调一次 destroy()」——旧版无条件
 *       prevent 把它这条自动收尾也一并掐掉了，于是两道 destroy 全废。
 *  修法：守卫状态机搬进 app/close-guard.ts 的 createCloseGuard（纯依赖注入，可单测）；
 *  这里只接线。preventDefault 只在真要被拦的那一轮调，放行的一轮交给自动 destroy；
 *  用户选「保存/放弃」后用 close() 重入一次（close 有 core:window:allow-close 权限）。
 *  另注：capabilities/default.json 已补 core:window:allow-destroy —— 自动收尾走的正是
 *  destroy，没这条权限干净态仍然关不掉；旧版把它一起挡住，所以先前只看到「destroy()
 *  点了没用」，而非「destroy() 是坏 API」。 */
const closeGuard = createCloseGuard({
  // 关窗守卫接线：状态机在 app/close-guard.ts 的 createCloseGuard（纯依赖注入，可单测）
  hasDirty: () => activeTabs?.hasDirty() ?? false,
  dirtyCount: () => activeTabs?.dirtyTabs().length ?? 0,
  ask: (message) => askCloseChoice(message),
  save: async () => {
    const tabs = activeTabs;
    return tabs === null ? true : saveDirtyTabs(tabs);
  },
  quit: () => getCurrentWindow().close(),
});

function applyPrefs(): void {
  applyThemePref(readThemePref()); // 三档主题（含自动：解析系统偏好后落 data-theme）
  applyPalettePref(readPalettePref()); // D-01 配色（5 套；落 data-palette，缺失即靛蓝）
  if (localStorage.getItem("modu-outline") === "off") {
    document.body.classList.add("outline-off"); // 大纲折叠态恢复（P5 批2）
  }
  // 字号/行宽/字体恢复移入 setupSettings（modu-fs / modu-width / modu-font，含旧 modu-face 迁移）
}

/** 大纲折叠钮（P5 批2）：☰ toggle body.outline-off，态存 localStorage modu-outline */
function setupOutlineToggle(): void {
  $<HTMLButtonElement>("btn-outline").addEventListener("click", () => {
    const off = document.body.classList.toggle("outline-off");
    localStorage.setItem("modu-outline", off ? "off" : "on");
  });
}

/** ◐ 按钮循环三态（用户反馈批次·跟随系统主题）：亮 → 暗 → 自动 → 亮；
 *  状态机与回显（含 ◐ 钮 title）在 ui/theme.ts */
function setupToggles(): void {
  $("btn-theme").addEventListener("click", () => {
    applyThemePref(nextThemePref(readThemePref()));
  });
}

function setupProgress(): void {
  const content = $<HTMLElement>("content");
  content.addEventListener("scroll", () => {
    const max = content.scrollHeight - content.clientHeight;
    const percent = max > 0 ? Math.round((content.scrollTop / max) * 100) : 0;
    $("st-progress").textContent = `${percent}%`;
    scheduleFollow(); // F4：滚动时重算最近标题
    // 沉浸淡出（M5/P2）：下滚过 48px 淡化标题栏+顶栏；hover/聚焦/浮层开/编辑态由 CSS 豁免
    document.body.classList.toggle("chrome-dim", content.scrollTop > 48);
  });
}

/* ---- loading 指示符（P5 批3）：#content.content-loading 顶部 2px 脉冲条 ---- */

/** 样式走 main 内联注入而非 cjk.css：它是壳层反馈不是正文排版，且批3 对
 *  cjk.css 的改动面限定为 content-visibility 屏显规则。选 class 方案
 *  （不占状态栏 flashStatus 单槽，长渲染不打扰错误/保存提示）。 */
const LOADING_STYLE = `
#content.content-loading::before {
  content: "";
  position: sticky;
  top: 0;
  display: block;
  height: 2px;
  margin-block-end: -2px;
  background: var(--accent-solid);
  transform-origin: 0 50%;
  animation: modu-loading-pulse .9s ease-in-out infinite alternate;
  z-index: 1;
}
@keyframes modu-loading-pulse {
  from { opacity: .25; transform: scaleX(.3); }
  to { opacity: 1; transform: scaleX(1); }
}
@media (prefers-reduced-motion: reduce) {
  #content.content-loading::before { animation: none; opacity: 1; }
}`;

function injectLoadingStyle(): void {
  if (document.getElementById("loading-style") !== null) {
    return;
  }
  const style = document.createElement("style");
  style.id = "loading-style";
  style.textContent = LOADING_STYLE;
  document.head.appendChild(style);
}

async function boot(): Promise<void> {
  setupGlobalKeys(); // 先于 setupFindbar：统一 Esc 仲裁须最先注册（见函数注释）
  setupTabHotkeys(); // Ctrl+W / Ctrl+Tab(+Shift)：capture 拦截，先于 CM 键位
  injectLoadingStyle(); // loading 指示符样式一次就位（P5 批3）
  setupThemeEngine((theme) => refreshMermaidTheme(theme)); // 主题引擎钩子（三档）
  applyPrefs(); // 内含 applyThemePref（自动档按系统解析落 data-theme）
  // 空态起步：启动时还没有文档（若启动参数带了文件，openEachMd → mountRendered 随后摘掉它）。
  // 这一条同时管住大纲与顶栏 ☰ 的显隐（CSS 见 app.css §5），并与 resetToWelcome 同源。
  document.body.classList.add("empty");
  document.documentElement.classList.add("app-ready"); // FOUC 放行：主题偏好已应用，配合 index.html 内联防闪样式
  watchSystemTheme(); // 系统主题变化即时跟随（仅自动档响应）
  setupWindowControls(); // 无边框顶栏三钮 + 最大化/还原图标切换（反馈⑤）+ 双击顶栏空白
  setupShellOverflow(); // D-05：顶栏拥挤态（标签装不下 → 收成「编辑 + ⋯」，判据见函数处注释）
  // X1（性能实验 §4.3）：把 7 条根级 `html:has(...)` 换成 html 上的状态类——
  // 根级 :has() 会让每次 DOM 变动退化成整文档样式重算。单一入口在 ui/overlay-state.ts。
  setupOverlayState();
  setupOutlineToggle(); // ☰ 大纲折叠（P5 批2）
  // 「Aa」设置面板（反馈⑥）：恢复字号/行宽/字体 + 面板接线；钩子接排版重算
  setupSettings({
    getDoc: () => document.getElementById("doc"),
    onFontChange: () => {
      const doc = document.getElementById("doc");
      if (doc !== null) {
        refitView(doc); // 字体度量变了：断行守卫与公式缩放重算
      }
    },
  });
  const findbar = setupFindbar(() => document.getElementById("doc"));
  activeFindbar = findbar;
  // 挂载一篇渲染结果：#doc/大纲/F4 观察/增强/查找作废/状态栏——两处入口（标签激活、编辑回读）共用
  function mountRendered(ctx: MountContext): void {
    const doc = $<HTMLElement>("doc");
    ctx.tab.cachedFragment = null; // 挂载即消费：rerenderRead 等旁路入口同样作废旧缓存
    // P1（2026-09-23）：按文档形态决定是否**保留** content-visibility 的离屏跳过。
    // ⚠ 必须在 adoptNode 之前量：fragment 搬进 #doc 后就被掏空了。
    // 判据是纯函数（render/offscreen-policy.ts），默认保留（= 今天的行为），
    // 只有"确信是轻块文档"时才加 .cv-off 把它关掉。
    doc.classList.toggle("cv-off", !keepOffscreenSkipping(shapeOf(ctx.fragment)));
    doc.replaceChildren();
    doc.appendChild(document.adoptNode(ctx.fragment)); // P5 批3：零序列化、零二次 parse
    setupExternalLinks(doc); // P5 批1 接线：外链交系统浏览器（幂等，data 标记防重注册）
    doc.hidden = false;
    $("empty-hint").hidden = true;
    document.body.classList.remove("empty"); // 有文档了：大纲与 ☰ 回来
    mountOutline(ctx.outline);
    outlineFollow.reset(); // X2：正文已换 —— 重建标题元素列表（只查 DOM，不读几何）
    // X2 补（2026-09-23，P1 批次回归检查发现）：**开箱即高亮**。
    // 旧 IO 版在 observe 后会有一次初始回调；X2 的高亮只发生在滚动帧节流里，
    // 于是"打开文档不动"时大纲一条都不亮（实测：H1 可见却 active=null）。
    outlineFollow.update();
    enhanceView(doc); // 增强幂等：缓存直挂与重渲两路径都走（mermaid 懒观察在此重挂）
  // A5：**空闲**时预校验 mermaid 语法（不阻塞首屏）。改前实测：坏图在折叠线以下时完全静默 ✗
  //    用 mermaid 自己的 parse（禁手写正则）；已定稿节点会被 prevalidateMermaid 跳过 ✓
  const runPrevalidate = (): void => {
    void prevalidateMermaid(doc);
  };
  if (typeof requestIdleCallback === "function") {
    requestIdleCallback(runPrevalidate, { timeout: 2000 });
  } else {
    setTimeout(runPrevalidate, 0); // 无 idle API（测试/jsdom）时退回宏任务
  }
    attachCodeCopyButtons(doc); // 代码块复制钮（用户反馈批次）：幂等，缓存重挂不双挂
    findbar.close(); // 正文已换，旧命中作废，避免残留陈旧 mark
    document.title = `${ctx.tab.title} — 墨读`; // 文档名（顶栏那份已按 D-05 删除）
    $("st-encoding").textContent = ctx.tab.encoding;
    $<HTMLButtonElement>("btn-edit").disabled = false;
    if (exportButton !== null) {
      exportButton.disabled = false; // 有文档即可导出
    }
    updateStatusLine(); // 行号就位（滚动由 setupProgress 的 rAF 持续刷新）
    resolveRelativeImages(doc, ctx.tab.path); // P5 批1 接线：相对路径图片 → asset 协议
  }

  // M3-A 编辑会话（Ctrl+E/S/F 捕获路由、✎ 同 Ctrl+E）：先建会话再建标签（getTab 经 activeTabs 回指）
  editorSession = createEditSession({
    container: $<HTMLElement>("editor-pane"),
    docEl: $<HTMLElement>("doc"),
    contentEl: $<HTMLElement>("content"),
    getTab: () => activeTabs?.activeTab() ?? null,
    setDirty: (path, dirty) => activeTabs?.setDirty(path, dirty), // docChanged → 标签圆点
    // 自动保存开关（用户反馈批次）：面板 modu-autosave，默认开
    isAutosaveEnabled: () => readAutosavePref(),
    saveFile: ({ path, text, encoding, bom }) => invoke<void>("save_file", { path, text, encoding, bom }),
    rerenderRead: (tab, text) => {
      const result = renderDocument(text, { pangu: true });
      mountRendered({ tab, fragment: result.fragment, outline: result.outline });
    },
    onModeChange: (editing, line) => {
      if (editing) {
        findbar.close(); // 进编辑态关查找条（P5 批2）：mark 属阅读 DOM
        setStatusLine(line ?? 1);
      } else {
        updateStatusLine(); // 回阅读：按视口重算
      }
    },
  });
  const tabs = createTabs(editorSession, mountRendered);
  activeTabs = tabs;
  $("btn-edit").addEventListener("click", () => editorSession?.toggle());
  // 文件入口只有标签条的「＋」（#btn-newtab）。原先与它并列的那枚「打开」按钮已删——
  // 两枚按钮本就绑同一个 onOpenClick，做的是同一件事（用户定稿「保留一个加号」）。
  $("btn-newtab").addEventListener("click", () => void onOpenClick(tabs));
  // 空态（欢迎页）接线：主行动按钮与「＋」是同一件事（onOpenClick），最近条目走 openPath
  activeEmptyState = setupEmptyState({
    onOpen: () => void onOpenClick(tabs),
    onPick: (path) => void openPath(tabs, path),
  });
  exportButton = document.getElementById("btn-export") as HTMLButtonElement | null;
  exportButton?.addEventListener("click", () => void onExportClick(tabs));
  setupRecentMenu((path) => void openPath(tabs, path));
  setupToggles();
  setupDragDrop(tabs);
  setupProgress();
  // 二次实例转发：载荷是筛过的 Markdown 路径列表（Rust 侧 md_paths），逐个开标签、仅末项渲染
  await listen<string[]>("second-instance", (event) => {
    void openEachMd(event.payload, (path, activate) => openPath(tabs, path, activate));
  });
  // 启动参数携带的待开文件（P0-6：列表——多文件启动每个都开，不再只开第一个）
  const pending = await invoke<string[]>("take_pending_files");
  if (pending.length > 0) {
    await openEachMd(pending, (path, activate) => openPath(tabs, path, activate));
  }
  // 开发期真机探针入口（D-05 多标签验收用）。为什么不复用既有入口：
  // 开第二个及以后的标签必须**真的走 read_file**（受控语料的自动保存会写回原文件），
  // 所以不能靠上次的渲染缓存或拖放伪造；而磁盘上的草稿副本只能经这条真实读文件链进来。
  // 本批新增 syncMenus：顶栏拥挤态的手工翻转实测（探针切 .overflow 类后要重算 ⋯ 显隐，
  // 而 hidden 的**语义来源**是 tabs-menu.ts 的 sync，不是那个类本身——不调它就测不到
  // 真实收藏行为）。同样只在 vite dev 挂载，生产构建里恒 undefined。
  if (import.meta.env.DEV) {
    window.__moduDev = {
      openFile: (path: string) => openPath(tabs, path),
      openFileInBackground: (path: string) => openPath(tabs, path, false),
      closeAllTabs: () => tabs.closeAll(),
      tabCount: () => tabs.count(),
      syncMenus: () => tabs.syncMenus(),
    };
  }
}

/** boot 的顶层收场（P1-7）：成功与失败都先摘掉 FOUC 隐藏，失败另画中文说明。
 *  没有这层 catch，boot 里任何一次抛出都会让 `html:not(.app-ready) body`
 *  永久 visibility:hidden —— 窗口一片空白，用户无从下手。 */
async function startApp(): Promise<void> {
  const stopWatchdog = installBootWatchdog(); // 兜底：boot 挂死不 resolve 也放行首帧
  try {
    await boot();
  } catch (error) {
    // revealBootFailure 自己先加 .app-ready 再画面板，故此处不必再放行首帧
    revealBootFailure(error);
    // 启动失败属使用者可见的异常，上报一条便于排查（失败只记控制台，不再阻断）
    void invoke("spike_log", { msg: `boot: 启动失败 ${String(error)}` }).catch((logError: unknown) => {
      console.warn("启动失败上报失败", logError);
    });
  } finally {
    stopWatchdog(); // 走到这里首帧必已放行，看门狗不许再留一个待触发的定时器
  }
}

window.addEventListener("DOMContentLoaded", () => {
  // 冒烟信号：boot 失败时此行不会出现在 tauri dev 的 stdout
  void invoke("spike_log", { msg: "boot: 应用壳启动" }).catch((e: unknown) => {
    console.warn("启动日志上报失败", e);
  });
  void startApp();
});
