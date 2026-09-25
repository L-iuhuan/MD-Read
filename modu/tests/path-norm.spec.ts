/**
 * **标签去重锚（本轮修复）**：同一文件以**两种路径形态**进来时，标签层必须只开**一个**标签。
 *
 * 缺陷原文（已核实）：`src/app/tabs.ts` 的 `find()` 是 `tab.path === path` —— **严格字符串比较**，
 * 而路径形态因通道而异：原生对话框 / 目录树给 `canonicalize` 形态，argv / OS 拖放 / `modu-recent`
 * 历史值给"原始串"形态 ⇒ 同一文件两个字符串 ⇒ **开出两个同名标签** ✗。
 *
 * 修复口径：**归一只有一份实现**（Rust `src-tauri/src/fs.rs::normalize_path`，函数 + 同名命令），
 * 前端经 `app/path-norm.ts` 调用它；`openPath` 是渲染层唯一边界。因此本文件的断言方式是：
 * 把两种形态喂进**真实调用链**（`normalizePaths` → `openEachMd`/`openTab`），
 * 断言产物收敛到同一个字符串、标签层只留一个标签。
 *
 * ⚠ 这是**单测级锚**（jsdom + mock IPC）：真机 OS 拖放**无法用 CDP 注入**（见任务书），
 * 故"拖放拿到的原始串"这一前提由 `normalizePaths` 的调用点（`main.ts` 的 `setupDragDrop`）
 * 与本案共同覆盖，**不声称真机拖放已实测** ✓
 */
import { describe, expect, it, vi } from "vitest";

/** mock 的"canonical 形态"：Windows `std::fs::canonicalize` 的产物含 `\\?\` 前缀（与 trust.rs 同形态）。 */
const CANONICAL = "\\\\?\\C:\\docs\\笔记.md";
const PLAIN = "C:\\docs\\..\\docs\\笔记.md";

const mocks = vi.hoisted(() => ({
  invoke: vi.fn(async (_cmd: string, args?: Record<string, unknown>) => {
    // 模拟 Rust `normalize_path`：同一文件的两种形态收敛到同一个 canonical 串；
    // 不认识的路径原样返回（与 Rust 侧 `unwrap_or_else(|_| raw.to_string())` 同语义）。
    const raw = String(args?.raw ?? "");
    return raw === PLAIN || raw === CANONICAL ? CANONICAL : raw;
  }),
}));
vi.mock("@tauri-apps/api/core", () => ({ invoke: mocks.invoke }));

import { openEachMd } from "../src/app/drop";
import { normalizePaths } from "../src/app/path-norm";
import { createTabManager, type MountContext, type TabManager } from "../src/app/tabs";
import type { RenderResult } from "../src/render/pipeline";
import { flushed, fragOf } from "./raf";

function makeManager(): TabManager {
  document.body.innerHTML =
    '<div id="tabbar" hidden><div id="tab-list"></div><button id="btn-newtab">+</button></div>' +
    '<main id="content"><article id="doc" hidden></article></main>';
  return createTabManager(document.getElementById("tabbar") as HTMLElement, {
    render: (source: string): RenderResult => ({
      html: `<p>${source}</p>`,
      outline: [],
      fragment: fragOf(`<p>${source}</p>`),
    }),
    mountDoc: (ctx: MountContext) => {
      const doc = document.getElementById("doc") as HTMLElement;
      ctx.tab.cachedFragment = null;
      doc.replaceChildren(document.createTextNode(ctx.tab.path));
      doc.hidden = false;
    },
    harvestDoc: () => null,
    beginLoading: () => undefined,
    endLoading: () => undefined,
    getScroll: () => 0,
    setScroll: () => undefined,
    onEmpty: () => undefined,
    confirmClose: () => true,
  });
}

function tabPaths(): string[] {
  return Array.from(document.querySelectorAll<HTMLElement>("#tab-list .tab")).map(
    (el) => el.dataset.path ?? "",
  );
}

describe("拖放路径归一（#3：OS 拖放给的是原始串）", () => {
  it("同一文件的 plain 与 canonical 两种形态都归一到同一个 canonical 串", async () => {
    const [canonicalFromPlain, canonicalItself] = await normalizePaths([PLAIN, CANONICAL]);
    expect(canonicalFromPlain).toBe(CANONICAL);
    expect(canonicalItself).toBe(CANONICAL);
    expect(canonicalFromPlain).toBe(canonicalItself); // 逐字相等 —— 标签去重就靠这一条
  });

  it("归一不吞路径、不换顺序（多文件拖放的「仅末项激活渲染」依赖顺序）", async () => {
    const roundTrip = await normalizePaths(["D:\\a\\b.md", "D:\\c\\d.md"]);
    expect(roundTrip).toEqual(["D:\\a\\b.md", "D:\\c\\d.md"]); // 不存在的路径原样返回
  });

  it("拖放链（归一 → openEachMd → 标签层）与「树里点」收敛到同一个 tab.path，不重复开标签", async () => {
    const manager = makeManager();
    // ① 拖放：原始串 → 归一 → 逐个开标签（与 main.ts setupDragDrop 同一条链）
    await normalizePaths([PLAIN]).then((paths) =>
      openEachMd(paths, async (path) => {
        manager.openTab(path, { text: "笔记", encoding: "UTF-8" });
      }),
    );
    await flushed();
    // ② 树里点：路径本来就是 canonical（来自 list_dir）⇒ 必须命中同一个标签
    manager.openTab(CANONICAL, { text: "笔记", encoding: "UTF-8" });
    await flushed();

    expect(manager.count()).toBe(1);
    expect(tabPaths()).toEqual([CANONICAL]);
    expect(manager.activeTab()?.path).toBe(CANONICAL);
  });
});
describe("标签层去重（缺陷本体：tabs.ts 的 find 按字符串比较）", () => {
  it("同一文件的两种形态喂进标签层：若未先归一就是两个标签（鉴别力对照）", async () => {
    const manager = makeManager();
    manager.openTab(PLAIN, { text: "x", encoding: "UTF-8" });
    await flushed();
    manager.openTab(CANONICAL, { text: "x", encoding: "UTF-8" });
    await flushed();
    // 未归一的两条形态在标签层是**两个不同身份** —— 这正是缺陷的可观测形状
    expect(manager.count()).toBe(2);
    expect(tabPaths().length).toBe(2);
  });

  it("先归一（openPath 边界）再进标签层：只有一个标签 ✓", async () => {
    const manager = makeManager();
    for (const raw of [PLAIN, CANONICAL]) {
      const canonical = (await normalizePaths([raw]))[0] as string;
      manager.openTab(canonical, { text: "x", encoding: "UTF-8" });
      await flushed();
    }
    expect(manager.count()).toBe(1);
    expect(tabPaths()).toEqual([CANONICAL]);
    expect(mocks.invoke).toHaveBeenCalledWith("canonical_path", { raw: PLAIN });
  });
});
