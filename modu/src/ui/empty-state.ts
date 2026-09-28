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
  /** 点「打开文件夹为工作区」（2026-09-27 用户反馈批：欢迎页也要能选文件夹） */
  onPickFolder(): void;
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

/** 首次运行引导的存储键（只判"见过没有"，不存版本号 —— 升级不该重弹 ✗） */
const FIRST_RUN_KEY = "modu-first-run-done";

/**
 * 首次运行引导（2026-09-27 阶段③-②「交付可移植性」）。
 *
 * 为什么需要：换到**新机器**装完后，用户不知道还要做什么 —— 尤其"设为 .md 默认应用"
 * 那一步（Windows 不允许安装器代设 `UserChoice`，必须手动选一次 ✓）。
 * ⚠ 本机永远验不出这条：排障期写过 HKCU 关联**影子** ⇒「双击能开」恒真 ✗
 * ⇒ 只能靠应用内引导 + `tests/tools/check-portability.mjs` 自检两边夹 ✓。
 *
 * 行为：显示一次；点「知道了」后写键不再出现。**存储不可用 ⇒ 当作已见过**（不打扰 ✓）；
 * 存不下 ⇒ 下次再显示（无害，不致命 ✓）。节点缺失（如单测夹具没造它）⇒ 静默返回 ✓。
 */
function wireFirstRun(): void {
  const box = document.getElementById("empty-first-run");
  if (box === null) {
    return;
  }
  let seen = false;
  try {
    seen = window.localStorage.getItem(FIRST_RUN_KEY) === "1";
  } catch {
    seen = true; // 存储完全不可用：宁可不提示，也不每次启动都打扰 ✓
  }
  if (seen) {
    return;
  }
  box.hidden = false;
  document.getElementById("empty-first-run-close")?.addEventListener("click", () => {
    box.hidden = true;
    try {
      window.localStorage.setItem(FIRST_RUN_KEY, "1");
    } catch {
      // 存不下就下次再显示一次；不影响使用 ✓
    }
  });
}

export function setupEmptyState(deps: EmptyStateDeps): EmptyState {
  wireFirstRun();
  const openBtn = req<HTMLButtonElement>("empty-open");
  const folderBtn = req<HTMLButtonElement>("empty-folder");
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
  folderBtn.addEventListener("click", () => deps.onPickFolder());
  refresh(); // 初值现算：启动即空态时列表必须已就位
  return { refresh };
}
