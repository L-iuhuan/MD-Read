/**
 * 最近文件（M2 波1，F5）：localStorage("modu-recent") 存路径数组，
 * 去重、最新在前、上限 10。
 * D-05（审计 S-5）：条目由单行文件名改为**两行式**（文件名 + 弱化目录），
 * 目录部分走 .menu-path（--fg-dim）；结构与「全部标签列表 / ⋯ 溢出菜单」共用
 * .menu-item 那一套列表项语言（app.css §6），三处菜单外观因此天然一致。
 */
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
