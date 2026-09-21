/**
 * 墨读 M1 应用壳：打开文件 → 渲染管线 → 正文 + 大纲。
 * 排版规则在 typography/，渲染在 render/，此处只做接线。
 */
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { open as openFileDialog } from "@tauri-apps/plugin-dialog";
import { renderDocument } from "./render/pipeline";
import { enhanceView, refitView, refreshMermaidTheme } from "./render/view";
import "./app.css";
import "./typography/tokens.css";
import "./typography/cjk.css";
import "katex/dist/katex.min.css";

interface OutlineItem {
  level: number;
  text: string;
  id: string;
  line: number;
}

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

async function openPath(path: string): Promise<void> {
  try {
    const file = await invoke<LoadedFile>("read_file", { path });
    const result = renderDocument(file.text, { pangu: true });
    const doc = $<HTMLElement>("doc");
    doc.innerHTML = result.html;
    doc.hidden = false;
    $("empty-hint").hidden = true;
    mountOutline(result.outline);
    enhanceView(doc);
    $("doc-title").textContent = path.split(/[\\/]/).pop() ?? path;
    $("st-encoding").textContent = file.encoding;
    $<HTMLElement>("content").scrollTop = 0;
  } catch (error) {
    showError(`打开失败：${String(error)}`);
  }
}

function mountOutline(items: OutlineItem[]): void {
  const list = $<HTMLElement>("outline-list");
  list.textContent = "";
  for (const item of items) {
    const link = document.createElement("a");
    link.textContent = item.text;
    link.href = `#${item.id}`;
    link.style.paddingLeft = `${(item.level - 1) * 12}px`;
    link.addEventListener("click", (event) => {
      event.preventDefault();
      document.getElementById(item.id)?.scrollIntoView();
    });
    list.appendChild(link);
  }
}

async function onOpenClick(): Promise<void> {
  const picked = await openFileDialog({
    title: "打开 Markdown 文件",
    multiple: false,
    directory: false,
    filters: [{ name: "Markdown", extensions: ["md", "markdown"] }],
  });
  if (typeof picked === "string") {
    await openPath(picked);
  }
}

function setupDragDrop(): void {
  void getCurrentWebview().onDragDropEvent((event) => {
    if (event.payload.type === "drop") {
      const path = event.payload.paths[0];
      if (path !== undefined && path.toLowerCase().endsWith(".md")) {
        void openPath(path);
      }
    }
  });
}

function applyPrefs(): void {
  const theme = localStorage.getItem("modu-theme");
  if (theme === "dark" || theme === "light") {
    document.documentElement.dataset.theme = theme;
  }
  if (localStorage.getItem("modu-face") === "serif") {
    document.documentElement.dataset.face = "serif";
  }
}

function setupToggles(): void {
  $("btn-theme").addEventListener("click", () => {
    const root = document.documentElement;
    const next = root.dataset.theme === "dark" ? "light" : "dark";
    root.dataset.theme = next;
    localStorage.setItem("modu-theme", next);
    refreshMermaidTheme(next);
  });
  $("btn-face").addEventListener("click", () => {
    const root = document.documentElement;
    if (root.dataset.face === "serif") {
      delete root.dataset.face;
      localStorage.setItem("modu-face", "sans");
    } else {
      root.dataset.face = "serif";
      localStorage.setItem("modu-face", "serif");
    }
    refitView($<HTMLElement>("doc"));
  });
}

function setupProgress(): void {
  const content = $<HTMLElement>("content");
  content.addEventListener("scroll", () => {
    const max = content.scrollHeight - content.clientHeight;
    const percent = max > 0 ? Math.round((content.scrollTop / max) * 100) : 0;
    $("st-progress").textContent = `${percent}%`;
  });
}

async function boot(): Promise<void> {
  applyPrefs();
  $("btn-open").addEventListener("click", () => void onOpenClick());
  setupToggles();
  setupDragDrop();
  setupProgress();
  await listen<string>("open-file", (event) => void openPath(event.payload));
  await listen<string[]>("second-instance", (event) => {
    const mdArg = event.payload.find((arg) => arg.toLowerCase().endsWith(".md"));
    if (mdArg !== undefined) {
      void openPath(mdArg);
    }
  });
  const pending = await invoke<string | null>("take_pending_file");
  if (pending !== null) {
    await openPath(pending);
  }
}

window.addEventListener("DOMContentLoaded", () => {
  // 冒烟信号：boot 失败时此行不会出现在 tauri dev 的 stdout
  void invoke("spike_log", { msg: "boot: 应用壳启动" }).catch((e: unknown) => {
    console.warn("启动日志上报失败", e);
  });
  void boot();
});
