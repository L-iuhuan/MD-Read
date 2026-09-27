/**
 * D-11 文件夹工作区 · 侧栏面板（切片①：最小可用；切片②a：持久化 + 空状态 + 授权范围文案）。
 *
 * 纪律：
 *  · 授权只走 `pick_workspace_directory()`（**无参数**，路径由 Rust 侧原生对话框给）✓
 *  · 列表走 `list_dir(path)`（**校验在命令内部**；前端不判权限、前端不注册信任）✓
 *  · 逐级懒加载：只列已展开的层级，不递归全盘 ✓
 *  · 上限（limit）留到切片④实测后再定，本切片不自己拍数 ✗
 *  · 持久化键 `modu-workspace`（设计 §5）：**只当提示** —— 真伪与权限判定永远在 Rust ✓；坏值/越界 ⇒ 空状态或显示原因，不崩 ✓
 */
import { invoke } from "@tauri-apps/api/core";

const WORKSPACE_KEY = "modu-workspace";

interface DirEntryOut {
  name: string;
  is_dir: boolean;
  is_markdown: boolean;
}

interface DirListing {
  path: string;
  entries: DirEntryOut[];
  truncated: boolean;
  total: number | null;
}

export interface WorkspacePanelDeps {
  /** 点文件时打开（用既有去重通路，不新造开标签逻辑）*/
  openFile: (path: string) => void;
  /**
   * 工作区根变化时回调（2026-09-27 用户反馈批：欢迎页「打开文件夹」入口需要它）。
   * main.ts 据此同步 body.has-workspace —— 空态下侧栏是否保留的判据（CSS §5）。
   * boot 时若有持久化工作区也会触发一次（root 非空）。
   */
  onRootChange?(root: string | null): void;
}

export interface WorkspacePanel {
  refresh(): void;
  /** 从面板外部（欢迎页按钮）发起「选工作区」：切到本面板并弹原生目录对话框 */
  pickFromOutside(): Promise<void>;
}

export function setupWorkspacePanel(deps: WorkspacePanelDeps): WorkspacePanel {
  const outlineNav = document.getElementById("outline-list");
  const workspaceNav = document.getElementById("workspace-list");
  const btnOutline = document.getElementById("btn-panel-outline");
  const btnWorkspace = document.getElementById("btn-panel-workspace");
  if (workspaceNav === null || btnOutline === null || btnWorkspace === null) {
    throw new Error("界面资源未就绪，请重启墨读");
  }
  const nav: HTMLElement = workspaceNav;
  let root: string | null = null;
  try {
    root = localStorage.getItem(WORKSPACE_KEY);
  } catch {
    root = null; // localStorage 不可用 ⇒ 当没有工作区（不崩）✓
  }

  function show(which: "outline" | "workspace"): void {
    const isWorkspace = which === "workspace";
    nav.hidden = !isWorkspace;
    if (outlineNav !== null) outlineNav.hidden = isWorkspace;
    btnWorkspace?.classList.toggle("active", isWorkspace);
    btnOutline?.classList.toggle("active", !isWorkspace);
    btnWorkspace?.setAttribute("aria-pressed", String(isWorkspace));
    btnOutline?.setAttribute("aria-pressed", String(!isWorkspace));
  }

  /** 空状态：尚未选工作区时显示（2026-09-27 用户反馈批重做：清晰度）。
   *  结构 = 弱化提示 / 强调底主按钮（选择文件夹…）/ 授权范围注脚，各归各位；
   *  弃用旧的「三行 .menu-item 假列表」（文案与按钮长得一样，读不出层级）。 */
  function renderEmpty(): void {
    nav.textContent = "";
    const box = document.createElement("div");
    box.className = "workspace-empty";
    const hint = document.createElement("div");
    hint.className = "workspace-hint";
    hint.textContent = "还没有工作区";
    const pick = document.createElement("button");
    pick.type = "button";
    pick.className = "workspace-pick";
    pick.textContent = "选择文件夹…";
    // ⚠ 授权范围必须在 UI 里说出来：目录条目 = 列目录 + 其中的文件可读写 ✓
    const scope = document.createElement("div");
    scope.className = "workspace-scope";
    scope.textContent = "所选文件夹内的文件可被打开并编辑";
    pick.addEventListener("click", () => void pickWorkspace());
    box.appendChild(hint);
    box.appendChild(pick);
    box.appendChild(scope);
    nav.appendChild(box);
  }

  /** 逐级懒加载：只列这一层；子目录由点击时再列 ✓ */
  async function fill(parent: HTMLElement, path: string): Promise<void> {
    parent.textContent = "";
    let listing: DirListing;
    try {
      // ⚠ 不传 limit：上限留待切片④实测后再定（不自己拍数 ✗）
      listing = await invoke<DirListing>("list_dir", { path });
    } catch (error) {
      const hint = document.createElement("div");
      hint.className = "menu-item";
      hint.textContent = String(error); // 不可读/被拒 ⇒ 显示中文原因、不崩 ✓
      parent.appendChild(hint);
      return;
    }
    for (const entry of listing.entries) {
      const item = document.createElement("button");
      item.type = "button";
      item.className = "menu-item";
      item.textContent = (entry.is_dir ? "▸ " : "") + entry.name;
      // 目录行加 data-kind（CSS 加字重与文件区分；2026-09-27 用户反馈「不清晰」）
      if (entry.is_dir) item.dataset.kind = "dir";
      const full = listing.path + "\\" + entry.name;
      if (entry.is_dir) {
        const kids = document.createElement("div");
        kids.hidden = true;
        // 逐层缩进（2026-09-27 复查修复：子层原先与父级齐平，树形同虚设）
        kids.className = "workspace-kids";
        item.addEventListener("click", () => {
          if (kids.hidden) {
            kids.hidden = false;
            void fill(kids, full);
          } else {
            kids.hidden = true;
          }
        });
        parent.appendChild(item);
        parent.appendChild(kids);
      } else {
        if (entry.is_markdown) item.addEventListener("click", () => deps.openFile(full));
        else item.disabled = true;
        parent.appendChild(item);
      }
    }
    if (listing.truncated) {
      const more = document.createElement("div");
      more.className = "menu-item";
      more.textContent = "还有更多项（上限待实测后确定）";
      parent.appendChild(more);
    }
  }

  async function pickWorkspace(): Promise<void> {
    try {
      const picked = await invoke<string | null>("pick_workspace_directory");
      if (picked === null || picked === undefined) return; // 取消不是错误 ✓
      root = picked;
      try {
        localStorage.setItem(WORKSPACE_KEY, picked);
      } catch {
        /* 存不下不影响本次会话 ✓ */
      }
      deps.onRootChange?.(root); // 侧栏在空态的显隐判据（body.has-workspace）✓
      await fill(nav, root);
    } catch (error) {
      nav.textContent = String(error);
    }
  }

  /** 有持久化值就渲染树；否则空状态 ✓（坏值/越界 ⇒ 命令会拒并显示原因，不崩 ✓）
   *  头部（2026-09-27 用户反馈批重做）：等宽路径行（太长优先显示尾部）+ 弱化的
   *  「移除工作区」文字按钮 —— 弃用旧的「两行 .menu-item」（路径与按钮混排难读）。 */
  async function renderWorkspace(): Promise<void> {
    if (root === null || root === "") {
      renderEmpty();
      return;
    }
    await fill(nav, root); // ⚠ fill 会先清空 nav ⇒ 头部必须在它**之后** prepend ✓
    const head = document.createElement("div");
    head.className = "workspace-head";
    const path = document.createElement("span");
    path.className = "workspace-path";
    path.textContent = root;
    path.title = root; // 截断时悬停看全量
    const remove = document.createElement("button");
    remove.type = "button";
    remove.className = "workspace-remove";
    remove.textContent = "移除";
    // ⭐ 文案要真（护栏 5 ✓）：真撤销 ⇒ **该目录下的新文件将被拒绝** ✓（不许写"仅从侧栏隐藏"✗）
    remove.title = "移除工作区（该目录下的新文件将被拒绝）";
    remove.addEventListener("click", () => void removeWorkspace());
    head.appendChild(path);
    head.appendChild(remove);
    nav.prepend(head);
  }

  /** ⭐ 撤销（切片③）：调 Rust 侧 `remove_workspace` ⇒ **真撤销**（从受信目录集合里删 ✓）；
   *  成功后**清 `modu-workspace` 指针** ⇒ 面板回空状态 ✓
   *  ⚠ 命令**拒绝**时（护栏 2：该路径不在受信集合里）⇒ **仍清指针** ✓ ＋ **如实提示中文原因** ✓
   *     —— **陈旧指针不能把面板卡死** ✗（清单被外部改过 / 已撤过一次 / 目录已消失 ✓）*/
  async function removeWorkspace(): Promise<void> {
    const target = root;
    let refused = "";
    try {
      await invoke<string>("remove_workspace", { path: target });
    } catch (error) {
      refused = String(error); // 护栏 2 的中文原因 ✓（无英文 OS 原串 ✓）
    }
    root = null;
    deps.onRootChange?.(null); // 侧栏在空态的显隐判据同步 ✓
    try {
      localStorage.removeItem(WORKSPACE_KEY); // 清指针 ✓（**拒绝时也清** ✓）
    } catch {
      /* 清不掉不影响本次会话 ✓ */
    }
    renderEmpty();
    if (refused !== "") {
      const note = document.createElement("div");
      note.className = "menu-item";
      note.textContent = refused;
      nav.appendChild(note);
    }
  }

  btnWorkspace.addEventListener("click", () => {
    show("workspace");
    void renderWorkspace();
  });
  btnOutline.addEventListener("click", () => show("outline"));
  // 有持久化工作区 ⇒ 初始就切到工作区面板（大纲在无文档时是空的）＋ 通知侧栏显隐
  if (root !== null && root !== "") {
    show("workspace");
    deps.onRootChange?.(root);
  } else {
    show("outline");
  }

  return {
    refresh(): void {
      if (!nav.hidden) void renderWorkspace();
    },
    async pickFromOutside(): Promise<void> {
      show("workspace"); // 选完目录树要立刻出现在眼前
      await pickWorkspace();
      if (root !== null) await renderWorkspace();
    },
  };
}
