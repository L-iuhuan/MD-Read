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
import { setupFindbar } from "./ui/findbar";
import { setFontPref, setupSettings, syncSettingsPanel } from "./ui/settings";
import { createEditSession, type EditSession } from "./editor/editor";
import "./app.css";
import "./typography/tokens.css";
import "./typography/cjk.css";
import "./typography/print.css";
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
/** ⇩PDF 按钮（HTML 初始 disabled，由 JS 在有文档时启用——不动 HTML 的约定） */
let exportButton: HTMLButtonElement | null = null;

function $<T extends HTMLElement>(id: string): T {
  const el = document.getElementById(id);
  if (el === null) {
    throw new Error(`界面元素缺失：#${id}`);
  }
  return el as T;
}

function showError(message: string): void {
  editorSession?.reset(); // 错误页是纯阅读态：编辑器让位
  const doc = $<HTMLElement>("doc");
  doc.hidden = false;
  doc.textContent = message;
  $("empty-hint").hidden = true;
}

/* ---- 大纲 ---- */

const outlineLinks = new Map<string, HTMLAnchorElement>();

function mountOutline(items: OutlineItem[]): void {
  const list = $<HTMLElement>("outline-list");
  list.textContent = "";
  outlineLinks.clear();
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
    list.appendChild(link);
  }
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
  });
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

async function openPath(tabs: TabManager, path: string): Promise<void> {
  try {
    const file = await invoke<LoadedFile>("read_file", { path });
    tabs.openTab(path, file);
    pushRecent(path);
  } catch (error) {
    showError(`打开失败：${String(error)}`);
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

let exportFlashTimer = 0;

/** 状态栏闪显（复用 #st-saved 位，与「已保存」同一渠道） */
function flashStatus(message: string): void {
  const el = $<HTMLElement>("st-saved");
  el.textContent = message;
  el.hidden = false;
  window.clearTimeout(exportFlashTimer);
  exportFlashTimer = window.setTimeout(() => {
    el.hidden = true;
  }, 2500);
}

/** 默认存档名：当前文件名去 .md/.markdown 扩展 + .pdf */
function defaultPdfName(path: string): string {
  const name = path.split(/[\\/]/).pop() ?? "";
  const stem = name.replace(/\.(md|markdown)$/i, "");
  return `${stem === "" ? "文档" : stem}.pdf`;
}

async function onExportClick(tabs: TabManager): Promise<void> {
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
  const ready = await awaitPrintReady(doc);
  if (ready.timedOut) {
    flashStatus("部分图表未渲染完成，将按当前版式导出");
  }
  let picked: string | null;
  try {
    picked = await invoke<string | null>("pick_save_path", {
      defaultName: defaultPdfName(tab.path),
    });
  } catch (error) {
    flashStatus(`导出失败：${String(error)}`);
    return;
  }
  if (picked === null || picked === "") {
    return; // 用户取消：静默结束
  }
  try {
    flashStatus(await invoke<string>("export_pdf", { path: picked }));
  } catch (error) {
    flashStatus(`导出失败：${String(error)}`);
  }
}

function setupDragDrop(tabs: TabManager): void {
  void getCurrentWebview().onDragDropEvent((event) => {
    if (event.payload.type === "drop") {
      // 多文件拖放（M2 波3 反馈①）：全部 .md 逐个开标签，串行保证最后一个激活
      void openEachMd(event.payload.paths, (path) => openPath(tabs, path));
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
  // 字号/字体恢复移入 setupSettings（modu-fs / modu-font，含旧 modu-face 迁移）
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
  // 「衬」按钮与 Aa 面板同源 modu-font；designer 重构可能删此节点——缺席则跳过注册，不抛错
  document.getElementById("btn-face")?.addEventListener("click", () => {
    const doc = $<HTMLElement>("doc");
    setFontPref(doc.dataset.face === "serif" ? "sans" : "serif");
  });
}

function setupProgress(): void {
  const content = $<HTMLElement>("content");
  content.addEventListener("scroll", () => {
    const max = content.scrollHeight - content.clientHeight;
    const percent = max > 0 ? Math.round((content.scrollTop / max) * 100) : 0;
    $("st-progress").textContent = `${percent}%`;
    scheduleFollow(); // F4：滚动时重算最近标题
  });
}

async function boot(): Promise<void> {
  applyPrefs();
  setupWindowControls(); // 无边框标题栏三钮（反馈⑤）
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
  // 挂载一篇渲染结果：#doc/大纲/F4 观察/增强/查找作废/状态栏——两处入口（标签激活、编辑回读）共用
  function mountRendered(ctx: MountContext): void {
    const doc = $<HTMLElement>("doc");
    doc.innerHTML = ctx.html;
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
  }

  // M3-A 编辑会话（Ctrl+E/S/F 捕获路由、✎ 同 Ctrl+E）：先建会话再建标签（getTab 经 activeTabs 回指）
  editorSession = createEditSession({
    container: $<HTMLElement>("editor-pane"),
    docEl: $<HTMLElement>("doc"),
    contentEl: $<HTMLElement>("content"),
    statusEl: $<HTMLElement>("st-saved"),
    getTab: () => activeTabs?.activeTab() ?? null,
    setDirty: (path, dirty) => activeTabs?.setDirty(path, dirty), // docChanged → 标签圆点
    saveFile: ({ path, text, encoding, bom }) => invoke<void>("save_file", { path, text, encoding, bom }),
    rerenderRead: (tab, text) => {
      const result = renderDocument(text, { pangu: true });
      mountRendered({ tab, html: result.html, outline: result.outline });
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
    // 多文件二次实例参数与拖放同路径（M2 波3 反馈①）：全部 .md 逐个开标签
    void openEachMd(event.payload, (path) => openPath(tabs, path));
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
