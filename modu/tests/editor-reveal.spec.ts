/**
 * P0-2 回归：**真实 EditorView** 的 reveal 定位 / 聚焦。
 *
 * 为什么单开一个文件：`editor.spec.ts` 全程注入 mock `EditorHandle`（`deps.makeEditor`），
 * 走不到 `createEditor` 内部的 `requestMeasure → dispatch` 路径，因此漏掉了
 *   `Calls to EditorView.update are not allowed while an update is in progress`
 * 这个真实报错——异常发生在 measure 的 write 回调里，把紧随其后的 `view.focus()`
 * 一起吞掉，于是「切编辑后没定位、也没聚焦」（实测 `.cm-scroller.scrollTop = 0`、
 * `document.activeElement = BODY`）。
 *
 * 断言口径（jsdom 无布局引擎，故不验像素位置）：
 *   1. reveal 不抛同步异常；
 *   2. 等 measure 周期跑完后，焦点落在编辑器内部 —— 修复前该断言必失败（focus 被吞）。
 * 真实滚动位置（`scrollTop > 0`）由 Windows + CDP 实机用例验证，见 .verify/。
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createEditor, type EditorHandle } from "../src/editor/editor";

/** 500 行文档：够到第 401 行，复现手测场景 */
function longDoc(lines: number): string {
  return Array.from({ length: lines }, (_, i) => `第 ${i + 1} 行 内容 content`).join("\n");
}

/** 冲刷若干轮宏任务 + rAF：等 CM 的 measure 周期真正跑完 */
async function settleRounds(rounds = 3): Promise<void> {
  for (let i = 0; i < rounds; i++) {
    await new Promise<void>((resolve) => {
      setTimeout(resolve, 0);
    });
    if (typeof requestAnimationFrame === "function") {
      await new Promise<void>((resolve) => {
        requestAnimationFrame(() => resolve());
      });
    }
  }
}

let container: HTMLElement;
let handle: EditorHandle | null = null;

beforeEach(() => {
  document.body.innerHTML = "";
  container = document.createElement("div");
  container.style.width = "800px";
  container.style.height = "600px";
  document.body.append(container);
  handle = null;
});

afterEach(() => {
  // EditorView 常驻：销毁以避免影响后续用例的 activeElement
  if (handle !== null) {
    handle.dom.remove();
  }
  document.body.innerHTML = "";
});

describe("P0-2 真实 EditorView reveal（定位 + 聚焦）", () => {
  it("reveal({line}) 不抛异常，且 measure 后焦点在编辑器内", async () => {
    handle = createEditor(container, { onDocChanged: () => {} });
    handle.setDoc(longDoc(500), false);

    expect(() => {
      handle?.reveal({ line: 401 });
    }).not.toThrow();

    await settleRounds();

    expect(container.contains(document.activeElement)).toBe(true);
  });

  it("reveal({scrollTop}) 不抛异常，且 measure 后焦点在编辑器内", async () => {
    handle = createEditor(container, { onDocChanged: () => {} });
    handle.setDoc(longDoc(500), false);

    expect(() => {
      handle?.reveal({ scrollTop: 1234 });
    }).not.toThrow();

    await settleRounds();

    expect(container.contains(document.activeElement)).toBe(true);
  });

  it("行号越界被夹紧，不抛异常且仍聚焦", async () => {
    handle = createEditor(container, { onDocChanged: () => {} });
    handle.setDoc(longDoc(20), false);

    expect(() => {
      handle?.reveal({ line: 99999 });
    }).not.toThrow();

    await settleRounds();

    expect(container.contains(document.activeElement)).toBe(true);
  });

  it("无 line 无 scrollTop 时也只聚焦，不抛异常", async () => {
    handle = createEditor(container, { onDocChanged: () => {} });
    handle.setDoc(longDoc(20), false);

    expect(() => {
      handle?.reveal({});
    }).not.toThrow();

    await settleRounds();

    expect(container.contains(document.activeElement)).toBe(true);
  });
});
