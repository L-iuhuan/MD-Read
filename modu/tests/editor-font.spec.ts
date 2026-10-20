/**
 * des-8 编辑态字体治理锚（2026-10-13；fix-32 修订行号契约）：
 * ① editorTheme：正文行 = 阅读字体栈（--font-reading 回落 --font-sans）、**行号族与正文
 *    同字体同源＋同显式 lineHeight**（fix-32：0.2.4 把 scroller 改吃 --font-reading 后
 *    行号族没跟上，用户字体度量与行号度量不一致 ⇒ 真机复验行号持续错位——des-8 旧
 *    「行号槽回等宽」契约作废，数字对齐改靠 tabular-nums）——断言挂在**真实
 *    EditorView 注入的样式表**上（CM6 经 style-mod 注入 document.head），不读源码字面；
 * ② tokens.css 的 --font-mono 默认链：Windows 高概率族前置（Consolas/Cascadia）、
 *    Maple 退后保留、中文回落交给阅读栈（var(--font-sans)）、以 monospace 收尾、
 *    旧的中文等宽兜底（Microsoft YaHei UI）已撤。
 * ③ fix-32 换字体重测接线：remeasureEditor 导出存在且可安全调用；font-picker 的
 *    编辑态栈落点后调用 remeasure（静态源码锚——jsdom 无真实字体度量，运行时序
 *    归真机 CDP 验证）。
 * ⚠ style-mod 的序列化格式（空格/分号）未承诺 ⇒ 断言前统一去空白。
 * ⚠ 围栏代码内容 v1 随正文（无既有行类，取舍见任务报告）——本锚不含围栏字体断言。
 */
import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createEditor, remeasureEditor, type EditorHandle } from "../src/editor/editor";

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

/** 全部注入样式（含 CM6 基础主题）拼合、去空白，便于跨 style-mod 序列化格式断言 */
function injectedCss(): string {
  return [...document.querySelectorAll("style")]
    .map((s) => s.textContent ?? "")
    .join("\n")
    .replace(/\s+/g, "");
}

describe("editorTheme 字体（des-8）", () => {
  it("正文行用阅读字体栈（--font-reading，回落 --font-sans），不再整屏等宽", () => {
    handle = createEditor(container, { onDocChanged: () => {} });
    const rules = [...injectedCss().matchAll(/\.cm-scroller\{([^}]*)\}/g)].map((m) => m[1]);
    expect(rules.length).toBeGreaterThan(0); // 含基础主题的 monospace 档
    // des-11 P1：编辑态字体改为由 #editor-pane 的 --font-reading 驱动（用户所选正文栈），
    // 无用户选择时回落 --font-sans；旧锚只认 --font-sans，会把「设置已生效」误判成红。
    expect(
      rules.some((body) => body.includes("font-family:var(--font-reading,var(--font-sans))")),
    ).toBe(true);
    expect(rules.every((body) => !body.includes("var(--font-mono)"))).toBe(true);
  });

  it("行号族与正文同字体同源＋同显式行高（fix-32：0.2.4 行号错位回归，推翻 des-8 旧契约）", () => {
    handle = createEditor(container, { onDocChanged: () => {} });
    const rules = [...injectedCss().matchAll(/\.cm-gutters\{([^}]*)\}/g)].map((m) => m[1]);
    expect(rules.length).toBeGreaterThan(0);
    // 字体与 .cm-scroller 同源（gutters 是 scroller 兄弟，不继承其字体——必须显式同值）
    expect(rules.some((body) => body.includes("font-family:var(--font-reading,var(--font-sans))"))).toBe(true);
    // 行高同源：scroller 显式 1.7，行号族必须同样显式（否则字体度量差异仍会错位）
    expect(rules.some((body) => body.includes("line-height:1.7"))).toBe(true);
    // 数字列对齐改靠 tabular-nums，不再回退等宽栈
    expect(rules.some((body) => body.includes("font-variant-numeric:tabular-nums"))).toBe(true);
    expect(rules.every((body) => !body.includes("var(--font-mono)"))).toBe(true);
  });
});

describe("fix-32：换字体后 CM6 重测接线", () => {
  it("remeasureEditor 导出可安全调用（无实例早退 / 有实例走 rAF 不炸）", () => {
    expect(() => remeasureEditor()).not.toThrow(); // 无实例态：早退
    handle = createEditor(container, { onDocChanged: () => {} });
    expect(() => remeasureEditor()).not.toThrow(); // 有实例：rAF 推一帧再 requestMeasure
  });

  it("font-picker 的编辑态栈落点后调用 remeasureEditor（静态源码锚）", () => {
    const src = readFileSync("src/ui/font-picker.ts", "utf8");
    expect(src).toContain("from \"../editor/editor\""); // ui→editor 单向 import（无环，环检查见任务报告）
    expect(src.match(/remeasureEditor\(\)/g)?.length ?? 0).toBeGreaterThanOrEqual(1);
    // 依据：applyFontPrefs 是 #editor-pane 上 --font-reading/--font-mono 的唯一写路径
    // （含启动恢复与 setFontPref），调用点在此即覆盖全部换字体路径；jsdom 无真实字体
    // 度量与加载时序，运行时行为归真机 CDP 验证——故静态锚。
  });

  it("font-picker 含 document.fonts.ready 重测链（fix-32 真根因：webfont 异步加载后度量改变）", () => {
    const src = readFileSync("src/ui/font-picker.ts", "utf8");
    expect(src).toContain("document.fonts");
    expect(src).toMatch(/fonts\.ready\.then\(\(\)\s*=>\s*remeasureEditor\(\)\)/);
    // 依据：CM6 首测常落在回退字体上（webfont 偏好如霞鹜文楷），加载完成后必须重测，
    // 否则行号永久错位（0.2.5 真机定案）；jsdom 无 FontFaceSet 实现与真实加载时序，
    // 运行时验证归真机 CDP——故静态锚；覆盖链（boot 必经 applyFontPrefs）见 font-picker.ts 注释。
  });
});

describe("tokens.css：--font-mono 默认链治理（des-8）", () => {
  it("Consolas/Cascadia 前置、Maple 退后、中文回落阅读栈、monospace 收尾", () => {
    const tokens = readFileSync("src/typography/tokens.css", "utf8");
    const found = /--font-mono:([^;]+);/.exec(tokens);
    expect(found).not.toBeNull();
    const stack = (found?.[1] ?? "").replace(/\s+/g, " ").trim();
    const families = stack.split(",").map((f) => f.trim().replace(/^["']|["']$/g, ""));
    expect(families[0]).toBe("Consolas"); // 本机探测：Consolas/Cascadia Mono 在、Maple 不在
    expect(stack).toContain('"Cascadia Mono"');
    expect(stack).toContain("ui-monospace");
    expect(stack).toContain("Maple Mono NF"); // 装了 Maple 的机器仍命中（退后不删）
    expect(stack.indexOf("Cascadia Mono")).toBeLessThan(stack.indexOf("Maple Mono"));
    expect(stack).toContain("var(--font-sans)"); // 中文回落交给阅读栈
    expect(stack).not.toContain("Microsoft YaHei UI"); // 旧硬编码等宽兜底已撤
    expect(stack.endsWith("monospace")).toBe(true);
  });
});
