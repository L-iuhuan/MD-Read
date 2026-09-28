/**
 * 首次运行引导（2026-09-27 阶段③-②「交付可移植性」）的锚。
 *
 * 钉三件事：
 *   ① 首次启动**显示**引导（新机器装完不知道要做什么 ⇒ 这条是给"别人用"的关键 ✓）
 *   ② 点「知道了」后**写键且不再出现**（不是每次启动都弹 ✗）
 *   ③ 节点缺失 / 存储不可用 ⇒ **不炸、不打扰** ✓
 *
 * ⚠ 为什么它值得一条锚：本机永远验不出"新机首次运行"这条路径 ——
 *    排障期写过 HKCU 关联**影子** ⇒「双击能开」在本机恒真 ✗。
 *    也就是说：这条引导**只能靠单测 + 在真新机上跑一次**，没有第三条路 ✓。
 */
import { beforeEach, describe, expect, it } from "vitest";
import { setupEmptyState } from "../src/ui/empty-state";

/** 与 index.html 的欢迎屏同形的**最小**夹具（req() 会抛，故必需的 id 都要在 ✓） */
function mount(withFirstRun = true): void {
  document.body.innerHTML = `
    <button id="empty-open" type="button"></button>
    <button id="empty-folder" type="button"></button>
    <div id="empty-recent" hidden>
      <span id="empty-recent-count"></span>
      <div id="empty-recent-list"></div>
    </div>
    ${
      withFirstRun
        ? `<p id="empty-first-run" class="empty-foot empty-first-run" hidden>
             <button id="empty-first-run-close" type="button">知道了</button>
           </p>`
        : ""
    }`;
}

const deps = () => ({ onOpen: () => {}, onPick: () => {}, onPickFolder: () => {} });
const box = (): HTMLElement => document.getElementById("empty-first-run") as HTMLElement;

beforeEach(() => {
  document.body.innerHTML = "";
  window.localStorage.clear();
});

describe("首次运行引导（新机交付路径）", () => {
  it("首次启动显示引导", () => {
    mount();
    setupEmptyState(deps());
    expect(box().hidden).toBe(false);
  });

  it("点「知道了」后写键、隐藏，且**再启动不再出现**", () => {
    mount();
    setupEmptyState(deps());
    (document.getElementById("empty-first-run-close") as HTMLButtonElement).click();
    expect(box().hidden).toBe(true);
    expect(window.localStorage.getItem("modu-first-run-done")).toBe("1");
    // 模拟"下次启动"：重建 DOM、复用同一个 localStorage ✓
    mount();
    setupEmptyState(deps());
    expect(box().hidden).toBe(true);
  });

  it("节点缺失时静默返回（不抛错 ✓ —— 老夹具/裁剪版页面也不会炸）", () => {
    mount(false);
    expect(() => setupEmptyState(deps())).not.toThrow();
  });

  it("键已存在（老用户升级上来）⇒ 不弹引导 ✓", () => {
    window.localStorage.setItem("modu-first-run-done", "1");
    mount();
    setupEmptyState(deps());
    expect(box().hidden).toBe(true);
  });
});
