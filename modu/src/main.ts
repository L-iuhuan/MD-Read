/**
 * 墨读 M2 应用壳：多标签 + 最近文件 + 文档内查找 + 大纲滚动跟随。
 * M3-A 增编辑态（F7）：CM6 会话在 editor/，此处只做接线（Ctrl+E/S/F、✎ 按钮）。
 * M4 增导出 PDF（⇩ 按钮）：等待渲染完备 → 存路径 → PrintToPdf 直出，逻辑在 render/print-ready 与 Rust print.rs。
 * 排版在 typography/，渲染在 render/，标签/最近在 app/，查找在 ui/——此处只做接线。
 */
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { open as openFileDialog } from "@tauri-apps/plugin-dialog";
import { renderDocument, type OutlineItem } from "./render/pipeline";
import { enhanceView, refitView, refreshMermaidTheme } from "./render/view";
import { awaitPrintReady } from "./render/print-ready";
import { createTabManager, type MountContext, type TabManager } from "./app/tabs";
import { pushRecent, setupRecentMenu } from "./app/recent";
import { openEachMd } from "./app/drop";
import { setupExternalLinks } from "./app/links";
import { resolveRelativeImages } from "./app/images";
import { setupFindbar, closeTopmostOverlay, type Findbar } from "./ui/findbar";
import { setupSettings, syncSettingsPanel, readAutosavePref } from "./ui/settings";
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
/** ⇩PDF 按钮（HTML 初始 disabled，由 JS 在有文档时启用——不动 HTML 的约定） */
let exportButton: HTMLButtonElement | null = null;

function $<T extends HTMLElement>(id: string): T {
  const el = document.getElementById(id);
  if (el === null) {
    throw new Error(`界面元素缺失：#${id}`);
  }
  return el as T;
}

/** 打开失败（P5 批2·错误通道统一）：不清正文、不顶标签——当前标签内容保持，
 *  状态栏红字闪错（多文件拖放单个失败同走此道，不中断其余）；
 *  doc-title 若指向失败文件则复位为当前活动标签名。 */
function showError(path: string, error: unknown): void {
  flashStatus(`打开失败：${String(error)}`, "error");
  const failedName = path.split(/[\\/]/).pop() ?? path;
  const title = $("doc-title");
  if (title.textContent === failedName) {
    const active = activeTabs?.activeTab() ?? null;
    title.textContent = active !== null ? active.title : "未打开文件";
  }
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

/* ---- 大纲滚动跟随（F4）：IO 圈定可见标题，滚动时取离视口顶最近者高亮 ---- */

let followObserver: IntersectionObserver | null = null;
const visibleHeadings = new Set<Element>();
let followPending = false;

function observeHeadings(): void {
  followObserver?.disconnect();
  visibleHeadings.clear();
  followObserver = new IntersectionObserver(
    (entries) => {
      for (const entry of entries) {
        if (entry.isIntersecting) {
          visibleHeadings.add(entry.target);
        } else {
          visibleHeadings.delete(entry.target);
        }
      }
      updateActiveHeading();
    },
    { root: $("content") }
  );
  for (const heading of $("doc").querySelectorAll("h1,h2,h3,h4,h5,h6")) {
    followObserver.observe(heading);
  }
}

function updateActiveHeading(): void {
  let best: Element | null = null;
  let bestDist = Number.POSITIVE_INFINITY;
  for (const heading of visibleHeadings) {
    const dist = Math.abs(heading.getBoundingClientRect().top);
    if (dist < bestDist) {
      best = heading;
      bestDist = dist;
    }
  }
  if (best !== null && best.id !== "") {
    for (const [key, link] of outlineLinks) {
      link.classList.toggle("active", key === best.id);
    }
  }
}

function scheduleFollow(): void {
  if (followPending) {
    return;
  }
  followPending = true;
  requestAnimationFrame(() => {
    followPending = false;
    updateActiveHeading();
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
  mountOutline([]);
  followObserver?.disconnect();
  visibleHeadings.clear();
  $("doc-title").textContent = "未打开文件";
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
    showError(path, error);
  }
}

async function onOpenClick(tabs: TabManager): Promise<void> {
  const picked = await openFileDialog({
    title: "打开 Markdown 文件",
    multiple: false,
    directory: false,
    filters: [{ name: "Markdown", extensions: ["md", "markdown"] }],
  });
  if (typeof picked === "string") {
    await openPath(tabs, picked);
  }
}

/* ---- 导出 PDF（M4）：等待渲染完备 → 存路径 → PrintToPdf 直出 ---- */

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
    // title：文档名进原生页眉（用户反馈批次·导出问题三，print.rs 查证注释）
    flashStatus(await invoke<string>("export_pdf", { path: picked, title: tab.title }), "ok");
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

function setupDragDrop(tabs: TabManager): void {
  void getCurrentWebview().onDragDropEvent((event) => {
    if (event.payload.type === "drop") {
      // 多文件拖放（M2 波3 反馈①）：全部 .md 逐个开标签；仅末项渲染（P5 批2）
      void openEachMd(event.payload.paths, (path, activate) => openPath(tabs, path, activate));
    }
  });
}

/* ---- 无边框窗口标题栏（M2 波3 反馈⑤）---- */

function setupWindowControls(): void {
  const win = getCurrentWindow();
  $("win-min").addEventListener("click", () => void win.minimize());
  $("win-max").addEventListener("click", () => void win.toggleMaximize());
  $("win-close").addEventListener("click", () => void win.close());
  // 双击拖拽区 = 最大化/还原（Windows 标题栏惯例；原生按钮均带 title/aria，可 Tab 聚焦）
  document.querySelector<HTMLElement>(".titlebar-drag")?.addEventListener("dblclick", () => {
    void win.toggleMaximize();
  });
}

function applyPrefs(): void {
  const theme = localStorage.getItem("modu-theme");
  if (theme === "dark" || theme === "light") {
    document.documentElement.dataset.theme = theme;
  }
  if (localStorage.getItem("modu-outline") === "off") {
    document.body.classList.add("outline-off"); // 大纲折叠态恢复（P5 批2）
  }
  // 字号/字体恢复移入 setupSettings（modu-fs / modu-font，含旧 modu-face 迁移）
}

/** 大纲折叠钮（P5 批2）：☰ toggle body.outline-off，态存 localStorage modu-outline */
function setupOutlineToggle(): void {
  $<HTMLButtonElement>("btn-outline").addEventListener("click", () => {
    const off = document.body.classList.toggle("outline-off");
    localStorage.setItem("modu-outline", off ? "off" : "on");
  });
}

function setupToggles(): void {
  $("btn-theme").addEventListener("click", () => {
    const root = document.documentElement;
    const next = root.dataset.theme === "dark" ? "light" : "dark";
    root.dataset.theme = next;
    localStorage.setItem("modu-theme", next);
    refreshMermaidTheme(next);
    syncSettingsPanel(); // 面板可能开着：◐ 改主题后回显即时跟上（波5 反馈）
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
  injectLoadingStyle(); // loading 指示符样式一次就位（P5 批3）
  applyPrefs();
  setupWindowControls(); // 无边框标题栏三钮（反馈⑤）
  setupOutlineToggle(); // ☰ 大纲折叠（P5 批2）
  // 「Aa」设置面板（反馈⑥）：恢复字号/字体 + 面板接线；钩子接排版重算与 Mermaid 刷新
  setupSettings({
    getDoc: () => document.getElementById("doc"),
    onFontChange: () => {
      const doc = document.getElementById("doc");
      if (doc !== null) {
        refitView(doc); // 字体度量变了：断行守卫与公式缩放重算
      }
    },
    onThemeChange: (theme) => refreshMermaidTheme(theme),
  });
  const findbar = setupFindbar(() => document.getElementById("doc"));
  activeFindbar = findbar;
  // 挂载一篇渲染结果：#doc/大纲/F4 观察/增强/查找作废/状态栏——两处入口（标签激活、编辑回读）共用
  function mountRendered(ctx: MountContext): void {
    const doc = $<HTMLElement>("doc");
    ctx.tab.cachedFragment = null; // 挂载即消费：rerenderRead 等旁路入口同样作废旧缓存
    doc.replaceChildren();
    doc.appendChild(document.adoptNode(ctx.fragment)); // P5 批3：零序列化、零二次 parse
    setupExternalLinks(doc); // P5 批1 接线：外链交系统浏览器（幂等，data 标记防重注册）
    doc.hidden = false;
    $("empty-hint").hidden = true;
    mountOutline(ctx.outline);
    observeHeadings(); // F4：正文已换，重挂一批观察对象
    enhanceView(doc);
    findbar.close(); // 正文已换，旧命中作废，避免残留陈旧 mark
    $("doc-title").textContent = ctx.tab.title;
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
  $("btn-open").addEventListener("click", () => void onOpenClick(tabs));
  $("btn-newtab").addEventListener("click", () => void onOpenClick(tabs)); // 标签栏「+」= 打开…
  exportButton = document.getElementById("btn-export") as HTMLButtonElement | null;
  exportButton?.addEventListener("click", () => void onExportClick(tabs));
  setupRecentMenu((path) => void openPath(tabs, path));
  setupToggles();
  setupDragDrop(tabs);
  setupProgress();
  await listen<string>("open-file", (event) => void openPath(tabs, event.payload));
  await listen<string[]>("second-instance", (event) => {
    // 多文件二次实例参数与拖放同路径（M2 波3 反馈①）：全部 .md 逐个开标签，仅末项渲染
    void openEachMd(event.payload, (path, activate) => openPath(tabs, path, activate));
  });
  const pending = await invoke<string | null>("take_pending_file");
  if (pending !== null) {
    await openPath(tabs, pending);
  }
}

window.addEventListener("DOMContentLoaded", () => {
  // 冒烟信号：boot 失败时此行不会出现在 tauri dev 的 stdout
  void invoke("spike_log", { msg: "boot: 应用壳启动" }).catch((e: unknown) => {
    console.warn("启动日志上报失败", e);
  });
  void boot();
});
