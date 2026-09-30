/**
 * 纸面缩放（2026-09-27 首版；2026-09-30 J2 改为只缩放纸面）的锚。
 *
 * J2（用户实测原话：「放大成了应用内所有都放大，应该只放大中间的纸面区域」）：
 * 缩放目标 = 阅读态 #doc、编辑态 .cm-editor；**documentElement 一律不碰** ⇒
 * 顶栏/标签/状态栏/大纲/设置面板不缩放。出错表现是"根元素又被写了 zoom"——
 * 肉眼很难发现 ✗ ⇒ 用单测钉住：
 *   ① 档位表合法且夹取不越界  ② 持久化键的读写与脏数据防御  ③ **启动回填**
 *   ④ 纸面元素拿到内联 zoom 且根元素为空  ⑤ clear/restore 三步（导出联动用）
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  applyPaperZoom,
  clearPaperZoom,
  readZoomPref,
  restorePaperZoom,
  setupZoom,
  ZOOM_STEPS,
} from "../src/app/zoom";

/** 只造缩放相关的最小 DOM（与 index.html 的 id 一致 ✓）：面板行 + 阅读态纸面 */
function mount(): void {
  document.body.innerHTML = `
    <button id="set-zoom-dec" type="button"></button>
    <span id="set-zoom-val">100</span>
    <button id="set-zoom-inc" type="button"></button>
    <article id="doc"></article>`;
}

/** 造编辑态纸面（.cm-editor 懒建：首测没有、本函数补上，模拟进编辑态后） */
function mountEditor(): HTMLElement {
  const cm = document.createElement("div");
  cm.className = "cm-editor";
  document.getElementById("doc")?.after(cm);
  return cm;
}

const val = (): string | null => document.getElementById("set-zoom-val")?.textContent ?? null;
const dec = (): HTMLButtonElement => document.getElementById("set-zoom-dec") as HTMLButtonElement;
const inc = (): HTMLButtonElement => document.getElementById("set-zoom-inc") as HTMLButtonElement;
const doc = (): HTMLElement => document.getElementById("doc") as HTMLElement;
const rootZoom = (): string => document.documentElement.style.zoom;

beforeEach(() => {
  vi.useRealTimers();
  document.body.innerHTML = "";
  document.documentElement.style.removeProperty("zoom");
  window.localStorage.clear();
});

describe("纸面缩放（#doc / .cm-editor 内联 zoom）", () => {
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

  it("⭐ 启动回填：面板显示值必须与纸面实际缩放一致（否则重启回 100% 而面板显示旧值 ✗）", () => {
    mount();
    window.localStorage.setItem("modu-zoom", "125");
    setupZoom();
    expect(val()).toBe("125");
    expect(doc().style.zoom).toBe("1.25");
  });

  it("± 键按档位走，且两端夹住（不越界 ✗）", () => {
    mount();
    setupZoom();
    expect(doc().style.zoom).toBe("1"); // 启动即回填 100% ✓
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

  it("⭐ J2：缩放只落纸面元素——documentElement.style.zoom 恒为空（顶栏/标签不缩放）", () => {
    mount();
    window.localStorage.setItem("modu-zoom", "150");
    setupZoom();
    expect(doc().style.zoom).toBe("1.5");
    expect(rootZoom()).toBe(""); // 根元素不碰 —— 写它就是 J2 要修的回归 ✗
    dec().click();
    expect(doc().style.zoom).toBe("1.25");
    expect(rootZoom()).toBe("");
  });

  it("编辑态纸面：restorePaperZoom 把档位补投到新建的 .cm-editor（懒建后不漏）", () => {
    mount();
    setupZoom();
    inc().click(); // 110
    const cm = mountEditor(); // 模拟首次进编辑态：CM 编辑器此刻才出现
    expect(cm.style.zoom).toBe(""); // 新建的还没有
    restorePaperZoom(); // main.ts 在 onModeChange 里调的那一步
    expect(cm.style.zoom).toBe("1.1");
    expect(doc().style.zoom).toBe("1.1"); // 阅读态目标同批保持
  });

  it("clear / restore 三步（导出联动）：清空回基准，还原按持久化档位重投", () => {
    mount();
    setupZoom();
    inc().click();
    inc().click(); // 125
    clearPaperZoom(); // 导出前：量宽回基准
    expect(doc().style.zoom).toBe("");
    expect(readZoomPref()).toBe(125); // 持久化档位不动（=「保存值」）
    restorePaperZoom(); // finally：还原
    expect(doc().style.zoom).toBe("1.25");
  });

  it("applyPaperZoom 直投也钳制并持久化（面板外入口同源）", () => {
    mount();
    applyPaperZoom(137);
    expect(readZoomPref()).toBe(125);
    expect(doc().style.zoom).toBe("1.25");
    expect(val()).toBe("125");
  });
});
describe("阶段④-③ Ctrl+滚轮 与快捷键（三条入口同源）", () => {
  const wheel = (init: WheelEventInit): void => {
    document.dispatchEvent(new WheelEvent("wheel", { bubbles: true, cancelable: true, ...init }));
  };
  const key = (k: string): KeyboardEvent => {
    const e = new KeyboardEvent("keydown", { key: k, ctrlKey: true, bubbles: true, cancelable: true });
    document.dispatchEvent(e);
    return e;
  };

  /** ⚠ 滚轮节流是**跨手势共用的 120ms 窗口**（对真实使用正确 ✓：人手势间隔远超它）⇒
   *  单测里两次手势之间必须**等过节流窗**，否则第二次被吃掉 ⇒ 假红 ✗（本批实测）*/
  const pastThrottle = (): Promise<void> => new Promise((r) => setTimeout(r, 140));

  it("Ctrl+滚轮向上 ⇒ 放大一档；向下 ⇒ 缩小一档", async () => {
    mount();
    setupZoom(); // 默认 100%
    await pastThrottle();
    wheel({ deltaY: -100, ctrlKey: true });
    expect(readZoomPref()).toBe(110);
    await pastThrottle();
    wheel({ deltaY: 100, ctrlKey: true });
    expect(readZoomPref()).toBe(100);
  });

  it("⭐ 普通滚轮**绝不拦**（不带修饰键 ⇒ 不缩放、不 preventDefault ✓）", () => {
    mount();
    setupZoom();
    const e = new WheelEvent("wheel", { deltaY: -100, bubbles: true, cancelable: true });
    document.dispatchEvent(e);
    expect(readZoomPref()).toBe(100); // 没缩放 ✓
    expect(e.defaultPrevented).toBe(false); // 正文照旧滚 ✓
  });

  it("节流：同一次手势连发多个 wheel 只走一档（不滑到底 ✗）", async () => {
    mount();
    setupZoom();
    await pastThrottle(); // 先过掉上一用例留下的节流窗 ✓
    for (let i = 0; i < 8; i++) {
      wheel({ deltaY: -100, ctrlKey: true });
    }
    expect(readZoomPref()).toBe(110); // 只 +1 档 ✓（后面 7 个被 120ms 节流吃掉）
  });

  it("Ctrl+= 放大 / Ctrl+- 缩小 / Ctrl+0 复位（不是减到最小 ✗）", () => {
    mount();
    setupZoom();
    key("=");
    expect(readZoomPref()).toBe(110);
    key("=");
    key("=");
    expect(readZoomPref()).toBe(150);
    key("-");
    expect(readZoomPref()).toBe(125);
    key("0");
    expect(readZoomPref()).toBe(100);
  });

  it("快捷键会 preventDefault（不让浏览器默认缩放插手 ✓）", () => {
    mount();
    setupZoom();
    expect(key("=").defaultPrevented).toBe(true);
    expect(key("-").defaultPrevented).toBe(true);
    expect(key("0").defaultPrevented).toBe(true);
  });

  it("无修饰键的 = / - / 0 **不触发**缩放（只认 Ctrl/⌘ ✓）", () => {
    mount();
    setupZoom();
    for (const k of ["=", "-", "0"]) {
      document.dispatchEvent(new KeyboardEvent("keydown", { key: k, bubbles: true, cancelable: true }));
    }
    expect(readZoomPref()).toBe(100);
  });
});
