/**
 * 墨读 M2 应用壳：多标签 + 最近文件 + 文档内查找 + 大纲滚动跟随。
 * 排版在 typography/，渲染在 render/，标签/最近在 app/，查找在 ui/——此处只做接线。
 */
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { open as openFileDialog } from "@tauri-apps/plugin-dialog";
import { renderDocument, type OutlineItem } from "./render/pipeline";
import { enhanceView, refitView, refreshMermaidTheme } from "./render/view";
import { createTabManager, type TabManager } from "./app/tabs";
import { pushRecent, setupRecentMenu } from "./app/recent";
import { openEachMd } from "./app/drop";
import { setupFindbar, type Findbar } from "./ui/findbar";
import { setFontPref, setupSettings, syncSettingsPanel } from "./ui/settings";
import "./app.css";
import "./typography/tokens.css";
import "./typography/cjk.css";
import "katex/dist/katex.min.css";

interface LoadedFile {
  text: string;
  encoding: string;
}

function $<T extends HTMLElement>(id: string): T {
  const el = document.getElementById(id);
  if (el === null) {
    throw new Error(`界面元素缺失：#${id}`);
  }
  return el as T;
}

function showError(message: string): void {
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
  $("content").scrollTop = 0;
}

function createTabs(findbar: Findbar): TabManager {
  // designer 并行重构标题栏，#tabbar 可能移位或暂缺：缺席时挂到离屏容器保 boot 不炸
  const bar = document.getElementById("tabbar") ?? document.createElement("nav");
  return createTabManager(bar as HTMLElement, {
    render: (source) => renderDocument(source, { pangu: true }),
    mountDoc: ({ tab, html, outline }) => {
      const doc = $<HTMLElement>("doc");
      doc.innerHTML = html;
      doc.hidden = false;
      $("empty-hint").hidden = true;
      mountOutline(outline);
      observeHeadings(); // F4：正文已换，重挂一批观察对象
      enhanceView(doc);
      findbar.close(); // 正文已换，旧命中作废，避免残留陈旧 mark
      $("doc-title").textContent = tab.title;
      $("st-encoding").textContent = tab.encoding;
    },
    getScroll: () => $("content").scrollTop,
    setScroll: (top) => {
      $("content").scrollTop = top;
    },
    onEmpty: resetToWelcome,
    confirmClose: (tab) => window.confirm(`「${tab.title}」有未保存的修改，确定要关闭吗？`),
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
  const tabs = createTabs(findbar);
  $("btn-open").addEventListener("click", () => void onOpenClick(tabs));
  $("btn-newtab").addEventListener("click", () => void onOpenClick(tabs)); // 标签栏「+」= 打开…
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
