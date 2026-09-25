/**
 * 最近文件（M2 波1，F5）：localStorage("modu-recent") 存路径数组，
 * 去重、最新在前、上限 10。
 * D-05（审计 S-5）：条目由单行文件名改为**两行式**（文件名 + 弱化目录），
 * 目录部分走 .menu-path（--fg-dim）；结构与「全部标签列表 / ⋯ 溢出菜单」共用
 * .menu-item 那一套列表项语言（app.css §6），三处菜单外观因此天然一致。
 *
 * 本轮（标签重复缺陷）加 `hydrateRecent`：读取时把历史双形态值收敛到 canonical，
 * **只在值真的变了才写回**。归一实现不在本文件 —— 见 app/path-norm.ts（Rust 侧唯一一份）。
 */
import { normalizePath } from "./path-norm";

const STORAGE_KEY = "modu-recent";
const RECENT_LIMIT = 10;

function req<T extends HTMLElement>(id: string): T {
  const el = document.getElementById(id);
  if (el === null) {
    console.error(`界面元素缺失：#${id}`); // A4：技术细节只进 console，使用者只看下一行
    throw new Error("界面资源未就绪，请重启墨读");
  }
  return el as T;
}

function fileName(path: string): string {
  return path.split(/[\\/]/).pop() ?? path;
}

/** 目录部分（去掉文件名与末尾分隔符）；无目录时返回空串 → 不渲染第二行 */
export function dirName(path: string): string {
  const cut = Math.max(path.lastIndexOf("\\"), path.lastIndexOf("/"));
  return cut <= 0 ? "" : path.slice(0, cut);
}

/** 读取最近列表；存储缺失/损坏一律回退为空，不致命 */
export function loadRecent(): string[] {
  const raw = localStorage.getItem(STORAGE_KEY);
  if (raw === null) {
    return [];
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    if (error instanceof SyntaxError) {
      return []; // 内容损坏视为没有历史
    }
    throw error;
  }
  if (!Array.isArray(parsed)) {
    return [];
  }
  return parsed.filter((item): item is string => typeof item === "string");
}

/** 记录一次打开：去重、最新在前、截断到上限，返回新列表 */
export function pushRecent(path: string): string[] {
  const list = [path, ...loadRecent().filter((item) => item !== path)].slice(0, RECENT_LIMIT);
  localStorage.setItem(STORAGE_KEY, JSON.stringify(list));
  return list;
}

/**
 * 把已存的最近列表收敛到 canonical 形态（本轮修复：历史值里**同一文件两种形态并存**）。
 *
 * 历史成因：早期 argv/文件关联通道把"用户给的原始串"直接 push 进来，而对话框/目录树给的是
 * `canonicalize` 形态 —— 同一个文件因此在列表里躺了两条。现在新写入的值已由 `openPath`
 * 归一，但**旧值不会自己消失**，故读取时必须收敛一次。
 *
 * ⚠ **只在真的变了才写回**：`modu-recent` 是使用者可见的列表（最近菜单 + 空态），
 * 每次启动都无条件 `setItem` 是"没人要求写的写"。值没变（或存储本就为空）⇒ 一个字节都不动。
 *
 * 返回收敛后的列表（无论是否写回），调用方据此重画界面。
 * 归一实现只有一份：Rust `fs.rs::normalize_path`（经 app/path-norm.ts 调用）。
 */
export async function hydrateRecent(): Promise<string[]> {
  const raw = loadRecent();
  if (raw.length === 0) {
    return raw; // 空存储：无事可做，也绝不凭空造一个键
  }
  const normalized: string[] = [];
  for (const path of raw) {
    const canonical = await normalizePath(path);
    // 去重键用归一后的串：历史双形态的两条在归一时会撞成同一条 ⇒ 只留靠前（更新）的那条。
    // 同一轮里出现两个**原始**重复串也一并处理（存储被外部工具写过也不会漏）。
    if (!normalized.includes(canonical)) {
      normalized.push(canonical);
    }
  }
  const list = normalized.slice(0, RECENT_LIMIT);
  if (JSON.stringify(list) !== JSON.stringify(raw)) {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(list));
  }
  return list;
}

/**
 * 启动接线的收尾（把"归一 → 判否写回 → 重画空态列表"三步留在本模块）：
 * · 「最近」下拉每次展开都现读存储（`renderMenu`），所以只需重画**空态**那份；
 * · `refreshEmpty` 传 `null`（空态组件缺席）或 `undefined`（调用方是旧接口）都安全 —— 但不传
 *   就什么都不重画，所以 main.ts 必须把 `activeEmptyState?.refresh` 这类**取值**传进来，
 *   不能传一个"以后再取"的假函数。
 * · 归一失败（IPC 异常）**不阻断启动**：存储原样留着，下次启动再试（错误上报在调用方）。
 */
export function hydrateRecentOnBoot(
  refreshEmpty?: (() => void) | null,
): Promise<string[]> {
  return hydrateRecent().then((list) => {
    if (list.length > 0) {
      refreshEmpty?.();
    }
    return list;
  });
}

/** 工具条「最近」下拉：点击展开/收起，选中回调 onPick；hover 展开由波2 CSS 实现 */
export function setupRecentMenu(onPick: (path: string) => void): void {
  const btn = req<HTMLButtonElement>("btn-recent");
  const menu = req<HTMLElement>("recent-menu");

  /** 两行式条目：第一行文件名（正文色），第二行弱化目录（--fg-dim） */
  function buildItem(path: string): HTMLButtonElement {
    const item = document.createElement("button");
    item.type = "button";
    item.className = "menu-item";
    item.title = path;
    const box = document.createElement("span");
    box.className = "menu-text";
    const name = document.createElement("span");
    name.className = "menu-name";
    name.textContent = fileName(path);
    box.appendChild(name);
    const dir = dirName(path);
    if (dir !== "") {
      const line = document.createElement("span");
      line.className = "menu-path";
      line.textContent = dir;
      box.appendChild(line);
    }
    item.appendChild(box);
    item.addEventListener("click", () => {
      menu.hidden = true;
      onPick(path);
    });
    return item;
  }

  function renderMenu(): void {
    menu.textContent = "";
    const paths = loadRecent();
    if (paths.length === 0) {
      const empty = document.createElement("span");
      empty.className = "recent-empty";
      empty.textContent = "暂无最近文件";
      menu.appendChild(empty);
      return;
    }
    for (const path of paths) {
      menu.appendChild(buildItem(path));
    }
  }

  btn.addEventListener("click", () => {
    menu.hidden = !menu.hidden;
    if (!menu.hidden) {
      renderMenu();
    }
  });
  document.addEventListener("click", (event) => {
    if (menu.hidden) {
      return;
    }
    const target = event.target;
    if (target instanceof Node && (btn.contains(target) || menu.contains(target))) {
      return;
    }
    menu.hidden = true; // 点外部收起
  });
}
