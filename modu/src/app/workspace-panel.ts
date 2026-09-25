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
}

export interface WorkspacePanel {
  refresh(): void;
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

  /** 空状态：尚未选工作区时显示（含**授权范围说明** —— 可读写必须说出来 ✓）*/
  function renderEmpty(): void {
    nav.textContent = "";
    const hint = document.createElement("div");
    hint.className = "menu-item";
    hint.textContent = "还没有工作区 —— 选一个文件夹开始";
    const pick = document.createElement("button");
    pick.type = "button";
    pick.className = "menu-item";
    pick.textContent = "选择文件夹…";
    // ⚠ 授权范围必须在 UI 里说出来：目录条目 = 列目录 + 其中的文件可读写 ✓
    const scope = document.createElement("div");
    scope.className = "menu-item";
    scope.textContent = "其中的文件可被打开并编辑";
    pick.addEventListener("click", () => void pickWorkspace());
    nav.appendChild(hint);
    nav.appendChild(pick);
    nav.appendChild(scope);
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
      const full = listing.path + "\\" + entry.name;
      if (entry.is_dir) {
        const kids = document.createElement("div");
        kids.hidden = true;
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
      await fill(nav, root);
    } catch (error) {
      nav.textContent = String(error);
    }
  }

  /** 有持久化值就渲染树；否则空状态 ✓（坏值/越界 ⇒ 命令会拒并显示原因，不崩 ✓）*/
  async function renderWorkspace(): Promise<void> {
    if (root === null || root === "") {
      renderEmpty();
      return;
    }
    await fill(nav, root);
  }

  btnWorkspace.addEventListener("click", () => {
    show("workspace");
    void renderWorkspace();
  });
  btnOutline.addEventListener("click", () => show("outline"));
  show("outline");

  return {
    refresh(): void {
      if (!nav.hidden) void renderWorkspace();
    },
  };
}
