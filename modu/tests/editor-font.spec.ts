/**
 * des-8 编辑态字体治理锚（2026-10-13）：
 * ① editorTheme：正文行 = 阅读字体栈（--font-sans，与阅读态 .mdc 同源）、行号槽 = 等宽
 *    （--font-mono）——断言挂在**真实 EditorView 注入的样式表**上（CM6 经 style-mod 注入
 *    document.head），不读源码字面；
 * ② tokens.css 的 --font-mono 默认链：Windows 高概率族前置（Consolas/Cascadia）、
 *    Maple 退后保留、中文回落交给阅读栈（var(--font-sans)）、以 monospace 收尾、
 *    旧的中文等宽兜底（Microsoft YaHei UI）已撤。
 * ⚠ style-mod 的序列化格式（空格/分号）未承诺 ⇒ 断言前统一去空白。
 * ⚠ 围栏代码内容 v1 随正文（无既有行类，取舍见任务报告）——本锚不含围栏字体断言。
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

/** 全部注入样式（含 CM6 基础主题）拼合、去空白，便于跨 style-mod 序列化格式断言 */
function injectedCss(): string {
  return [...document.querySelectorAll("style")]
    .map((s) => s.textContent ?? "")
    .join("\n")
    .replace(/\s+/g, "");
}

describe("editorTheme 字体（des-8）", () => {
  it("正文行用阅读字体栈（--font-sans），不再整屏等宽", () => {
    handle = createEditor(container, { onDocChanged: () => {} });
    const rules = [...injectedCss().matchAll(/\.cm-scroller\{([^}]*)\}/g)].map((m) => m[1]);
    expect(rules.length).toBeGreaterThan(0); // 含基础主题的 monospace 档
    expect(rules.some((body) => body.includes("font-family:var(--font-sans)"))).toBe(true);
    expect(rules.every((body) => !body.includes("var(--font-mono)"))).toBe(true);
  });

  it("行号槽保持等宽（--font-mono）——数字列对齐不随正文字体改", () => {
    handle = createEditor(container, { onDocChanged: () => {} });
    const rules = [...injectedCss().matchAll(/\.cm-gutters(?:-before)?\{([^}]*)\}/g)].map((m) => m[1]);
    expect(rules.some((body) => body.includes("font-family:var(--font-mono)"))).toBe(true);
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
