/**
 * X1（2026-09-23 第二批）：沉浸淡出豁免的状态类。
 * 原来 7 条根级 `html:has(...)` 选择器换成 `html.panel-open` / `html.settings-open` /
 * `html.editing`，本文件测状态类的**判据与单一入口**，不测 CSS（CSS 由 panel-unify 锚）。
 * 判据必须与原来的 `:not([hidden])` 一致：只认 hidden 属性。
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { setupOverlayState } from "../src/ui/overlay-state";

function mount(): void {
  document.body.innerHTML = `
    <div id="recent-menu" hidden></div>
    <div id="settings-panel" hidden></div>
    <div id="tabs-menu" hidden></div>
    <div id="overflow-menu" hidden></div>
    <div id="editor-pane" hidden></div>`;
  document.documentElement.className = "";
}

const root = (): HTMLElement => document.documentElement;
const show = (id: string, on: boolean): void => {
  (document.getElementById(id) as HTMLElement).hidden = !on;
};
/** MutationObserver 回调按微任务派发：等一拍再断言 */
const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

describe("X1 沉浸淡出豁免状态类", () => {
  beforeEach(() => {
    mount();
  });

  it("初值：四个浮层与编辑态都关着 → 三个类都不在", () => {
    setupOverlayState();
    expect(root().classList.contains("panel-open")).toBe(false);
    expect(root().classList.contains("settings-open")).toBe(false);
    expect(root().classList.contains("editing")).toBe(false);
  });

  it("四个浮层**任意一个**打开都算 panel-open；只有 Aa 面板打开才 settings-open", async () => {
    setupOverlayState();
    for (const id of ["recent-menu", "tabs-menu", "overflow-menu", "settings-panel"]) {
      show(id, true);
      await settle();
      expect(root().classList.contains("panel-open"), `${id} 打开应置 panel-open`).toBe(true);
      expect(root().classList.contains("settings-open"), `${id} ≠ settings-panel`).toBe(id === "settings-panel");
      show(id, false);
      await settle();
      expect(root().classList.contains("panel-open")).toBe(false);
      expect(root().classList.contains("settings-open")).toBe(false);
    }
  });

  it("同时开两个浮层：关掉一个仍保持 panel-open，全关才落", async () => {
    setupOverlayState();
    show("recent-menu", true);
    show("tabs-menu", true);
    await settle();
    expect(root().classList.contains("panel-open")).toBe(true);
    show("recent-menu", false);
    await settle();
    expect(root().classList.contains("panel-open")).toBe(true);
    show("tabs-menu", false);
    await settle();
    expect(root().classList.contains("panel-open")).toBe(false);
  });

  it("编辑态：只有 #editor-pane 决定 editing（与浮层互不影响）", async () => {
    setupOverlayState();
    show("editor-pane", true);
    await settle();
    expect(root().classList.contains("editing")).toBe(true);
    expect(root().classList.contains("panel-open")).toBe(false);
    show("editor-pane", false);
    await settle();
    expect(root().classList.contains("editing")).toBe(false);
  });

  it("元素缺席不致命：其余元素照常观察（单个浮层缺失不该让整块豁免失效）", () => {
    (document.getElementById("tabs-menu") as HTMLElement).remove();
    const warn = vi.spyOn(console, "error").mockImplementation(() => undefined);
    expect(() => setupOverlayState()).not.toThrow();
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it("sync() 可显式现算（不依赖观察回调）", () => {
    const state = setupOverlayState();
    show("settings-panel", true);
    state.sync();
    expect(root().classList.contains("panel-open")).toBe(true);
    expect(root().classList.contains("settings-open")).toBe(true);
  });
});
