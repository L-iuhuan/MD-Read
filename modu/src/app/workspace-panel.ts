/**
 * D-11 文件夹工作区 · 侧栏面板（切片①：最小可用 —— 能选目录、能逐级展开、能点开文件）。
 *
 * 纪律：
 *  · 授权只走 `pick_workspace_directory()`（**无参数**，路径由 Rust 侧原生对话框给）✓
 *  · 列表走 `list_dir(path)`（**校验在命令内部**，前端不判权限、前端不注册信任）✓
 *  · 逐级懒加载：**只列已展开的层级**，不递归全盘 ✓
 *  · 上限（limit）**留到切片④实测后再定**，本切片**不自己拍数** ✗
 */
import { invoke } from "@tauri-apps/api/core";

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

  function show(which: "outline" | "workspace"): void {
    const isWorkspace = which === "workspace";
    nav.hidden = !isWorkspace;
    if (outlineNav !== null) outlineNav.hidden = isWorkspace;
    btnWorkspace?.classList.toggle("active", isWorkspace);
    btnOutline?.classList.toggle("active", !isWorkspace);
    btnWorkspace?.setAttribute("aria-pressed", String(isWorkspace));
    btnOutline?.setAttribute("aria-pressed", String(!isWorkspace));
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
      // ⑦ 不可读目录显示原因、不崩：原因直接用命令返回的中文文案 ✓
      hint.textContent = String(error);
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

  async function pick(): Promise<void> {
    try {
      const picked = await invoke<string | null>("pick_workspace_directory");
      if (picked === null || picked === undefined) return; // 取消不是错误 ✓
      root = picked;
      await fill(nav, root);
    } catch (error) {
      nav.textContent = String(error);
    }
  }

  btnWorkspace.addEventListener("click", () => {
    show("workspace");
    if (root === null) void pick();
  });
  btnOutline.addEventListener("click", () => show("outline"));
  show("outline");

  return {
    refresh(): void {
      if (root !== null) void fill(nav, root);
    },
  };
}
