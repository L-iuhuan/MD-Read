/**
 * 页面整体缩放（2026-09-27 新功能）的锚。
 *
 * 为什么必须有锚：这一项走**原生** `Webview.setZoom`（不是 CSS），
 * 出错表现是"面板显示 125% 而实际没缩放"——**肉眼很难发现** ✗ ⇒ 用单测钉住三件事：
 *   ① 档位表合法且夹取不越界  ② 持久化键的读写与脏数据防御  ③ **启动回填**（面板值 == 实际缩放）
 *
 * ⚠ Tauri API 必须 mock（jsdom 里没有原生 webview）⇒ 用 `vi.hoisted` 提升 spy，
 *   否则 `vi.mock` 的工厂（会被提升到文件顶部）拿不到它 ✗。
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({ setZoom: vi.fn(() => Promise.resolve()) }));
vi.mock("@tauri-apps/api/webview", () => ({
  getCurrentWebview: () => ({ setZoom: h.setZoom }),
}));

import { readZoomPref, setupZoom, ZOOM_STEPS } from "../src/app/zoom";

/** 只造面板里缩放那一行的最小 DOM（与 index.html 的 id 一致 ✓） */
function mount(): void {
  document.body.innerHTML = `
    <button id="set-zoom-dec" type="button"></button>
    <span id="set-zoom-val">100</span>
    <button id="set-zoom-inc" type="button"></button>`;
}

const val = (): string | null => document.getElementById("set-zoom-val")?.textContent ?? null;
const dec = (): HTMLButtonElement => document.getElementById("set-zoom-dec") as HTMLButtonElement;
const inc = (): HTMLButtonElement => document.getElementById("set-zoom-inc") as HTMLButtonElement;

beforeEach(() => {
  document.body.innerHTML = "";
  window.localStorage.clear();
  h.setZoom.mockClear();
});

describe("页面整体缩放（Webview.setZoom）", () => {
  it("档位表是 90 / 100 / 110 / 125 / 150", () => {
    expect([...ZOOM_STEPS]).toEqual([90, 100, 110, 125, 150]);
  });

  it("没有持久化值时回默认 100（不是 NaN/0 ✗）", () => {
    mount();
    expect(readZoomPref()).toBe(100);
  });

  it("脏数据（不在档位表里）回默认 100，不抛错", () => {
    mount();
    window.localStorage.setItem("modu-zoom", "137");
    expect(readZoomPref()).toBe(100);
    window.localStorage.setItem("modu-zoom", "abc");
    expect(readZoomPref()).toBe(100);
  });

  it("⭐ 启动回填：面板显示值必须与实际缩放一致（否则重启回 100% 而面板显示旧值 ✗）", () => {
    mount();
    window.localStorage.setItem("modu-zoom", "125");
    setupZoom();
    expect(val()).toBe("125");
    expect(h.setZoom).toHaveBeenCalledWith(1.25);
  });

  it("± 键按档位走，且两端夹住（不越界 ✗）", () => {
    mount();
    setupZoom();
    expect(h.setZoom).toHaveBeenLastCalledWith(1); // 启动即回填 100% ✓
    inc().click();
    expect(readZoomPref()).toBe(110);
    inc().click();
    expect(readZoomPref()).toBe(125);
    inc().click();
    expect(readZoomPref()).toBe(150);
    inc().click(); // 上端
    expect(readZoomPref()).toBe(150);
    expect(val()).toBe("150");
    dec().click();
    expect(readZoomPref()).toBe(125);
    dec().click();
    dec().click();
    dec().click(); // 下端
    expect(readZoomPref()).toBe(90);
    dec().click();
    expect(readZoomPref()).toBe(90);
  });

  it("每次变更都真的调用原生 setZoom（不是只写 localStorage ✗）", () => {
    mount();
    setupZoom();
    h.setZoom.mockClear();
    inc().click();
    expect(h.setZoom).toHaveBeenCalledTimes(1);
    expect(h.setZoom).toHaveBeenCalledWith(1.1);
  });
});
