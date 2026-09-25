/**
 * `workspace-panel.ts` 回归锚（切片③ 撤销路径 + ② 不可读原因）
 *
 * ⚠ **本 spec 自建本项目的第一处 `@tauri-apps/api/core` mock 惯例**（此前无先例 ✓），供后来者照抄：
 *   `vi.mock` 必须写在 import 之前（hoisted ✓）⇒ 用【命令名分派】的 mockImplementation ✓
 *   ＋ **每个用例 `vi.resetModules()` + 动态 `import()`** ✓ —— 因为模块在 `setupWorkspacePanel()` 里
 *   **一次性读 `localStorage['modu-workspace']`** ✓ ⇒ 静态 import 会让用例之间互相污染 ✗
 *
 * 语义被**三态钉死**（Lead 口径 ✓）：
 *   ①【列目录失败】⇒ 指针**不清** ✓（工作区仍选中，只是列不出 ⇒ 界面显示中文原因、不崩 ✓）
 *   ②【显式移除】成功 ⇒ 指针**清掉** ✓ ＋ 回空状态 ✓
 *   ③【显式移除】**被拒**（护栏 2：不在受信集合里，陈旧指针）⇒ 指针**也清** ✓ ＋ 如实显示中文原因 ✓
 *   ⇒ 「清指针」= **用户的移除意图**已表达 ✓，**不是**"命令成功"✗
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));

import { invoke } from "@tauri-apps/api/core";

const WORKSPACE_KEY = "modu-workspace";
const WS = "D:\\ws";

interface Listing {
  path: string;
  entries: { name: string; is_dir: boolean; is_markdown: boolean }[];
  truncated: boolean;
  total: number | null;
}

/** 夹具 DOM：四要素齐（缺一个 `setupWorkspacePanel` 会抛"界面资源未就绪"✗）*/
function mountDom(): void {
  document.body.innerHTML = [
    '<button id="btn-panel-outline" class="panel-tab"></button>',
    '<button id="btn-panel-workspace" class="panel-tab"></button>',
    '<nav id="outline-list"></nav>',
    '<nav id="workspace-list" hidden></nav>',
  ].join("");
}

async function loadPanel(): Promise<void> {
  const mod = await import("../src/app/workspace-panel");
  mod.setupWorkspacePanel({ openFile: () => {} });
}

function nav(): HTMLElement {
  return document.getElementById("workspace-list") as HTMLElement;
}

function clickWorkspaceTab(): void {
  (document.getElementById("btn-panel-workspace") as HTMLButtonElement).click();
}

/** 找到树上方那行里的「移除工作区」按钮 ✓（形态：头行 + 按钮 + 树，全部在 nav 内 ✓）*/
function removeButton(): HTMLButtonElement {
  const found = Array.from(nav().querySelectorAll("button")).find((b) => b.textContent === "移除工作区");
  if (found === undefined) throw new Error("找不到「移除工作区」按钮（头行未渲染？）");
  return found as HTMLButtonElement;
}

const tick = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

/** 命令名分派的 mock ✓（只认本项目这几条命令 ✓）*/
function dispatch(handlers: {
  listDir?: () => Promise<Listing>;
  remove?: () => Promise<string>;
}): void {
  (invoke as unknown as { mockImplementation: (fn: (cmd: string, args?: unknown) => Promise<unknown>) => void }).mockImplementation(
    (cmd: string): Promise<unknown> => {
      if (cmd === "list_dir") return handlers.listDir ? handlers.listDir() : Promise.resolve({ path: WS, entries: [], truncated: false, total: null });
      if (cmd === "remove_workspace") return handlers.remove ? handlers.remove() : Promise.resolve(WS);
      return Promise.reject("未知命令");
    },
  );
}

describe("workspace-panel 锚 · 切片③ 撤销路径 + ② 不可读原因", () => {
  beforeEach(() => {
    vi.resetModules();
    mountDom();
    localStorage.clear();
  });

  it('①【列目录失败】⇒ 原样透出 Rust 文案、不崩、且指针【不清】（工作区仍选中 ✓）', async () => {
    localStorage.setItem(WORKSPACE_KEY, WS);
    const reason = `无法列出目录：${WS}（该目录不在受信清单中）`;
    dispatch({ listDir: () => Promise.reject(reason) });
    await loadPanel();
    clickWorkspaceTab();
    await tick();

    // ⭐ 断言**完整的给定串**（不是前缀子串 ✗ —— 否则面板硬编码一句相似文案也会过 ✗）
    expect(nav().textContent).toContain(reason);
    expect(nav().hidden, "面板必须仍在（未崩 ✓）").toBe(false);
    expect(document.getElementById("workspace-list"), "DOM 不得被摧毁 ✓").not.toBeNull();
    // ⭐ 反向区分：**渲染失败不清指针** ✓（清指针只属显式「移除工作区」✓）
    expect(localStorage.getItem(WORKSPACE_KEY)).toBe(WS);
  });

  it("②【显式移除】成功 ⇒ 指针清掉 ＋ 回空状态 ✓", async () => {
    localStorage.setItem(WORKSPACE_KEY, WS);
    dispatch({ remove: () => Promise.resolve(WS) });
    await loadPanel();
    clickWorkspaceTab();
    await tick();
    removeButton().click();
    await tick();

    expect(localStorage.getItem(WORKSPACE_KEY), "显式移除成功 ⇒ 指针必须清掉 ✓").toBeNull();
    expect(nav().textContent).toContain("还没有工作区");
  });

  it("③【显式移除】被拒（护栏 2：不在受信集合）⇒ 指针【也】清 ✓ ＋ 如实显示中文原因 ✓", async () => {
    localStorage.setItem(WORKSPACE_KEY, WS);
    const reason = `无法浏览目录/位置：${WS}（该文件不在本次已打开的清单中，请用「打开文件」重新选择）`;
    dispatch({ remove: () => Promise.reject(reason) });
    await loadPanel();
    clickWorkspaceTab();
    await tick();
    removeButton().click();
    await tick();

    // ⭐ 用户的"移除"意图已表达 ⇒ **陈旧指针不能把面板卡死** ✗ ⇒ 仍清指针 ✓
    expect(localStorage.getItem(WORKSPACE_KEY), "被拒时也必须清指针（否则陈旧指针卡死面板 ✗）").toBeNull();
    expect(nav().textContent, "被拒原因要如实显示 ✓").toContain(reason);
    expect(nav().textContent).toContain("还没有工作区");
  });
});
