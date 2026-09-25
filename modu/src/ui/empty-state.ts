/**
 * 空态（首访欢迎页）· 2026-09-23 第二批落地（用户选 V1「克制」稿）。
 *
 * 为什么单独一个模块：它是**壳层 DOM**（与 findbar / settings / tabs-menu 同层），
 * 不是标签状态机也不碰渲染管线；main.ts 只做接线（onOpen = 与「＋」同一个处理函数，
 * onPick = openPath），逻辑与 DOM 构造留在本文件，便于单测。
 *
 * 两行式最近条目**复用 §7c 的 .menu-item 列表语言**（文件名 + 弱化目录），
 * 与「最近下拉 / ▾ 全部标签 / ⋯ 溢出菜单」四处同构 —— 全站只此一套「两行式条目」，
 * 不新增第二种条目皮。
 *
 * 判据不另立：空态显隐仍由 `#empty-hint.hidden` 与 `body.empty` 一个来源决定
 * （main.ts 的 resetToWelcome / mountRendered），本模块只管**内容**。
 */
import { dirName, loadRecent } from "../app/recent";

/** 空态里最多显示几条最近打开（设计稿定稿 5；存储层上限仍是 recent.ts 的 10） */
const RECENT_MAX = 5;

export interface EmptyStateDeps {
  /** 点「打开 Markdown 文件」（= 标签条「＋」的同一处理函数） */
  onOpen(): void;
  /** 点某条最近打开（= openPath） */
  onPick(path: string): void;
}

export interface EmptyState {
  /** 重画最近列表（无最近时整块 hidden）。boot 一次、每次回到空态一次。 */
  refresh(): void;
}

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

export function setupEmptyState(deps: EmptyStateDeps): EmptyState {
  const openBtn = req<HTMLButtonElement>("empty-open");
  const wrap = req<HTMLElement>("empty-recent");
  const list = req<HTMLElement>("empty-recent-list");
  const count = req<HTMLElement>("empty-recent-count");

  /** 两行式条目：第一行文件名（正文色），第二行弱化目录（--fg-dim）；无目录不画第二行 */
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
    item.addEventListener("click", () => deps.onPick(path));
    return item;
  }

  function refresh(): void {
    const paths = loadRecent().slice(0, RECENT_MAX);
    wrap.hidden = paths.length === 0; // 无最近：整块不出现（设计稿的对照态）
    count.textContent = paths.length === 0 ? "" : `${paths.length} / ${RECENT_MAX}`;
    list.textContent = "";
    const frag = document.createDocumentFragment();
    for (const path of paths) {
      frag.appendChild(buildItem(path));
    }
    list.appendChild(frag);
  }

  openBtn.addEventListener("click", () => deps.onOpen());
  refresh(); // 初值现算：启动即空态时列表必须已就位
  return { refresh };
}
