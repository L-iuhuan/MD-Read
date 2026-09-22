/**
 * P5 批2 接线契约：
 * - flashStatus（错误通道统一）：kind → 语义类映射（st-ok/st-warn/st-error）、
 *   2000ms 统一时长、单槽复用后发覆盖先发；
 * - closeTopmostOverlay（Esc 统一）：findbar → 设置面板 → 最近菜单 的优先序，
 *   一次只关最上层一个。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { flashStatus } from "../src/editor/editor";
import { closeTopmostOverlay, type Findbar } from "../src/ui/findbar";

/** 可断言开闭的 findbar 替身 */
function stubFindbar(open: boolean): Findbar {
  let visible = open;
  return {
    open: () => {
      visible = true;
    },
    close: () => {
      visible = false;
    },
    isOpen: () => visible,
  };
}

describe("flashStatus（错误通道统一）", () => {
  beforeEach(() => {
    document.body.innerHTML = '<span id="st-saved" hidden></span>';
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("kind 映射语义类：ok/warn/error → st-ok/st-warn/st-error，文案与显形就位", () => {
    flashStatus("已保存", "ok");
    const el = document.getElementById("st-saved") as HTMLElement;
    expect(el.textContent).toBe("已保存");
    expect(el.className).toBe("st-ok");
    expect(el.hidden).toBe(false);
    flashStatus("警告一条", "warn");
    expect(el.className).toBe("st-warn");
    flashStatus("出错了", "error");
    expect(el.className).toBe("st-error");
    expect(el.textContent).toBe("出错了");
  });

  it("时长统一 2000ms：到点自动隐藏", () => {
    vi.useFakeTimers();
    flashStatus("消息", "warn");
    const el = document.getElementById("st-saved") as HTMLElement;
    vi.advanceTimersByTime(1999);
    expect(el.hidden).toBe(false);
    vi.advanceTimersByTime(1);
    expect(el.hidden).toBe(true);
  });

  it("单槽复用：后一次闪显重置计时并覆盖文案", () => {
    vi.useFakeTimers();
    flashStatus("第一条", "ok");
    vi.advanceTimersByTime(1000);
    flashStatus("第二条", "error");
    vi.advanceTimersByTime(1500); // 距第一条已 2500ms，但计时已被第二条重置
    const el = document.getElementById("st-saved") as HTMLElement;
    expect(el.hidden).toBe(false);
    expect(el.textContent).toBe("第二条");
    expect(el.className).toBe("st-error");
  });

  it("#st-saved 缺席时静默跳过（不抛错）", () => {
    document.body.innerHTML = "";
    expect(() => flashStatus("无槽", "error")).not.toThrow();
  });
});

describe("closeTopmostOverlay（Esc 优先序）", () => {
  beforeEach(() => {
    document.body.innerHTML =
      '<div id="findbar" hidden></div>' +
      '<div id="settings-panel" hidden></div>' +
      '<div id="recent-menu" hidden></div>';
  });

  it("findbar 最优先：三处都开时只关 findbar，面板与菜单不动", () => {
    const bar = stubFindbar(true);
    (document.getElementById("settings-panel") as HTMLElement).hidden = false;
    (document.getElementById("recent-menu") as HTMLElement).hidden = false;
    expect(closeTopmostOverlay(bar)).toBe(true);
    expect(bar.isOpen()).toBe(false);
    expect((document.getElementById("settings-panel") as HTMLElement).hidden).toBe(false);
    expect((document.getElementById("recent-menu") as HTMLElement).hidden).toBe(false);
  });

  it("findbar 已关：依次关设置面板 → 最近菜单，一次只关一个", () => {
    const bar = stubFindbar(false);
    const panel = document.getElementById("settings-panel") as HTMLElement;
    const menu = document.getElementById("recent-menu") as HTMLElement;
    panel.hidden = false;
    menu.hidden = false;
    expect(closeTopmostOverlay(bar)).toBe(true);
    expect(panel.hidden).toBe(true);
    expect(menu.hidden).toBe(false); // 菜单还开着：第二次 Esc 才轮到它
    expect(closeTopmostOverlay(bar)).toBe(true);
    expect(menu.hidden).toBe(true);
    expect(closeTopmostOverlay(bar)).toBe(false); // 全关：无动作
  });

  it("findbar 引用为 null（boot 早期）时直接从设置面板开始", () => {
    const panel = document.getElementById("settings-panel") as HTMLElement;
    panel.hidden = false;
    expect(closeTopmostOverlay(null)).toBe(true);
    expect(panel.hidden).toBe(true);
  });
});
