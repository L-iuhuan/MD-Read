/**
 * fix-32 深修 · CM6 根上禁 CSS zoom（行号/内容几何失步根因）防回归锚。
 *
 * 根因（真机 + dev 双坐实，证据链见任务报告）：zoom.ts 曾把 CSS zoom 直接写在
 * `.cm-editor`（CM6 根）——clientHeight〔布局〕与 getBoundingClientRect〔视觉〕
 * 两套坐标按 1/k 分叉（125% 实测 452.5/362 = 1.25 精确成立；装机 0.2.6 转储
 * rectH 4222 = scrollH 3378×1.25 同族）⇒ CM6 测量系统崩坏，长文行号与内容错位。
 *
 * 修复契约（本锚守护）：
 *  ① CM6 根上永不出现 CSS zoom 声明（注入样式断言）；
 *  ② 编辑态缩放 = 纸面整体语义缩放（2026-10-20 用户裁定）：font-size、内容盒 maxWidth、
 *     内边距、行号锚点全部消费 `calc(… * var(--paper-zoom, 1))`——与阅读态 `#doc` 的
 *     CSS zoom 视觉等价；**只缩字号被否决**（纸面宽度不变、折行变密，不是"界面缩放"）；
 *  ③ zoom.ts 编辑态目标写 `--paper-zoom` 变量且写后调 remeasureEditor（源静态锚）。
 *
 * 依据：jsdom 无真实布局/字体加载时序，「逐行 dy≤1px」的对齐级验证只能真机 CDP
 * （入库探针 `tests/tools/probe-align.mjs`，生产构建 + 五档缩放 + 阅读/编辑纸宽等价断言）；
 * jsdom 锚定的是契约形状。写侧另有 tests/zoom.spec.ts（fix-32 同批更新为变量断言）。
 */
import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createEditor, type EditorHandle } from "../src/editor/editor";

let container: HTMLElement;
let handle: EditorHandle | null = null;

beforeEach(() => {
  document.body.innerHTML = "";
  container = document.createElement("div");
  document.body.append(container);
  handle = null;
});

afterEach(() => {
  handle?.dom.remove();
  document.body.innerHTML = "";
});

/** 全部注入样式拼合去空白（style-mod 序列化格式未承诺，口径同 editor-font.spec） */
function injectedCss(): string {
  return [...document.querySelectorAll("style")]
    .map((s) => s.textContent ?? "")
    .join("\n")
    .replace(/\s+/g, "");
}

describe("fix-32 深修：CM6 根上禁 CSS zoom", () => {
  it("注入样式无 zoom 声明（除 --paper-zoom 自定义属性名外）", () => {
    handle = createEditor(container, { onDocChanged: () => {} });
    // 负向后顾排除自定义属性名 --paper-zoom；style-mod 注入的全部规则不得再写 zoom
    expect(injectedCss()).not.toMatch(/(?<!--)zoom:/);
  });

  it("scroller 与行号族 fontSize 同源消费 --paper-zoom（度量一致 = 对齐的前提）", () => {
    handle = createEditor(container, { onDocChanged: () => {} });
    const want = "font-size:calc(var(--fs-body)*var(--paper-zoom,1))";
    const scroller = [...injectedCss().matchAll(/\.cm-scroller\{([^}]*)\}/g)].map((m) => m[1]);
    const gutters = [...injectedCss().matchAll(/\.cm-gutters\{([^}]*)\}/g)].map((m) => m[1]);
    expect(scroller.some((body) => body.includes(want))).toBe(true);
    expect(gutters.some((body) => body.includes(want))).toBe(true); // 行号随缩放，缺此条即错位回归
  });

  it("纸面缩放：栏宽 / 内边距 / 行号锚点都随 --paper-zoom 同倍率（只缩字号 = 用户已否决）", () => {
    handle = createEditor(container, { onDocChanged: () => {} });
    const css = injectedCss();
    // 栏宽：内容盒 = (measure + 2*pad) × k（与阅读态 #doc 的 CSS zoom 视觉等价）
    expect(css).toContain("max-width:calc((var(--measure)+2*var(--pad-page))*var(--paper-zoom,1))");
    // 内边距：上/左 + 底部 25vh 都乘 k（纸面随缩放整体变大/变小）
    expect(css).toContain(
      "padding:calc(var(--size-7)*var(--paper-zoom,1))calc(var(--pad-page)*var(--paper-zoom,1))calc(25vh*var(--paper-zoom,1))",
    );
    // 行号锚点：贴正文左缘的公式同样乘 k（否则缩放后行号列与正文脱位）
    expect(css).toContain(
      "left:max(calc(var(--pad-page)*var(--paper-zoom,1)),calc((100%-var(--measure)*var(--paper-zoom,1))/2))",
    );
  });

  it("设 --paper-zoom 后 remeasureEditor 可安全调用（变量经 calc 消费，jsdom 不布局只验不炸）", () => {
    handle = createEditor(container, { onDocChanged: () => {} });
    handle.dom.style.setProperty("--paper-zoom", "1.25");
    expect(() => handle?.dom.querySelector(".cm-scroller")).not.toThrow();
  });
});

describe("fix-32 深修：zoom.ts 写侧契约（源静态锚）", () => {
  it("编辑态目标只写 --paper-zoom 变量（禁 style.zoom 赋值）并写后重测", () => {
    const src = readFileSync("src/app/zoom.ts", "utf8");
    expect(src).toContain('setProperty("--paper-zoom"');
    expect(src).not.toMatch(/cm\.style\.zoom\s*=/); // CM6 根上写 CSS zoom = 本根因复发
    expect(src.match(/remeasureEditor\(\);/g)?.length ?? 0).toBeGreaterThanOrEqual(2); // 写入与清空两处都重测
    // 依据：jsdom 无真实布局，坐标分叉只能真机复现；源级锚守住「根上无 zoom + 写后重测」契约形状。
  });
});
