/**
 * P1-7 · 启动失败兜底（ui/boot-error.ts）。
 *
 * 复现的正是空窗事故：index.html 的内联防闪样式是
 *   `html:not(.app-ready) body { visibility: hidden }`
 * 而 `.app-ready` 只在 boot() 跑完才加。boot 抛异常 → 永远加不上 → 窗口永久白屏。
 * 本组断言三件事：
 *   1. 首帧被放行（.app-ready 就位）——body 不再被那条规则隐藏；
 *   2. 失败说明可见、中文、含原因（不是一句无信息量的「出错了」）；
 *   3. 看门狗超时也放行首帧（boot 挂死不 resolve 的第二种白屏）。
 * 另外用 index.html 的真实规则做前提校验：那条内联规则必须还在，
 * 否则本模块测的是空气（规则若被删，这组测试应当被重新审视而非静默通过）。
 */
import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  BOOT_WATCHDOG_MS,
  installBootWatchdog,
  revealBootFailure,
} from "../src/ui/boot-error";

const html = readFileSync("index.html", "utf8");

/** stylesheet 是否真的把 body 藏起来（能力探测：用真实规则算一遍） */
function bodyHiddenByFoucRule(): boolean {
  const style = document.createElement("style");
  style.textContent = "html:not(.app-ready) body { visibility: hidden }";
  document.head.appendChild(style);
  const hidden = getComputedStyle(document.body).visibility === "hidden";
  style.remove();
  return hidden;
}

describe("P1-7 · FOUC 前提（被兜底对付的那条规则）", () => {
  it("index.html 仍带 `html:not(.app-ready) body { visibility: hidden }` 内联防闪", () => {
    expect(html).toMatch(/html:not\(\.app-ready\)\s*body\s*\{\s*visibility:\s*hidden\s*\}/);
  });

  it("前提探测有效：无 .app-ready 时 body 确实被藏（jsdom 也算得出来）", () => {
    document.documentElement.classList.remove("app-ready");
    expect(bodyHiddenByFoucRule()).toBe(true);
    document.documentElement.classList.add("app-ready");
    expect(bodyHiddenByFoucRule()).toBe(false);
  });
});

describe("P1-7 · revealBootFailure（boot 抛错后的兜底）", () => {
  beforeEach(() => {
    document.documentElement.className = "";
    document.body.innerHTML = "";
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
  });
  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it("摘掉隐藏：加 .app-ready，body 不再 visibility:hidden", () => {
    revealBootFailure(new Error("界面元素缺失：#editor-pane"));
    expect(document.documentElement.classList.contains("app-ready")).toBe(true);
    expect(bodyHiddenByFoucRule()).toBe(false);
    // 前提校验：同一条规则在摘掉 .app-ready 后又该藏起来（证明前一行不是侥幸为真）
    document.documentElement.classList.remove("app-ready");
    expect(bodyHiddenByFoucRule()).toBe(true);
  });

  it("失败可见且可操作：中文标题 + 中文指引 + 原始原因都在面板里", () => {
    revealBootFailure(new Error("界面元素缺失：#content"));
    const panel = document.getElementById("boot-error");
    expect(panel, "失败面板必须出现").not.toBeNull();
    expect(panel?.getAttribute("role")).toBe("alert");
    const text = panel?.textContent ?? "";
    expect(text).toContain("墨读启动失败");
    expect(text).toContain("重新打开");
    expect(text).toContain("界面元素缺失：#content"); // 原因可反馈，不是空洞的「出错了」
    expect(panel?.style.display).not.toBe("none");
  });

  it("非 Error 抛出物（字符串/对象/循环引用）也能显示，不二次抛错", () => {
    expect(() => revealBootFailure("插件调用失败")).not.toThrow();
    expect(document.getElementById("boot-error")?.textContent).toContain("插件调用失败");
    // 对象优先 JSON 化：`[object Object]` 对排查没有价值
    expect(() => revealBootFailure({ code: 42 })).not.toThrow();
    expect(document.getElementById("boot-error")?.textContent).toContain('"code":42');
    // 循环引用 JSON 化会抛——此时退回 String()，兜底路径绝不许再炸一次
    // ⚠ 与 `mermaid-prevalidate.spec.ts` 里那条 `not.toContain("[object Object]")` **不矛盾**：
    //   那条针对 mermaid 抛的**普通对象**（有 message/str ⇒ 可读）；这里的 `[object Object]` 是
    //   **循环引用**下 JSON 化失败的**最后兜底**（换成更聪明的格式化只会再炸一次）✓
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    expect(() => revealBootFailure(cyclic)).not.toThrow();
    expect(document.getElementById("boot-error")?.textContent).toContain("[object Object]");
  });

  it("幂等：重复兜底只留一块面板", () => {
    revealBootFailure(new Error("第一次"));
    revealBootFailure(new Error("第二次"));
    expect(document.querySelectorAll("#boot-error").length).toBe(1);
    expect(document.getElementById("boot-error")?.textContent).toContain("第二次");
  });

  it("body 缺席（极端损坏）也不抛错，首帧照放行", () => {
    const body = document.body;
    // jsdom 不允许真的删掉 body，这里只用替身模拟「appendChild 不可用」
    const appendSpy = vi.spyOn(document.body, "appendChild").mockImplementation(() => {
      throw new Error("DOM 已损坏");
    });
    expect(() => revealBootFailure(new Error("启动炸了"))).not.toThrow();
    expect(document.documentElement.classList.contains("app-ready")).toBe(true);
    appendSpy.mockRestore();
    expect(body).toBe(document.body);
  });
});

describe("P1-7 · installBootWatchdog（boot 挂死不 resolve）", () => {
  beforeEach(() => {
    document.documentElement.className = "";
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
  });
  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it("超时未收场 → 强制放行首帧（不画失败面板，避免把「慢」误报成「错」）", () => {
    vi.useFakeTimers();
    const stop = installBootWatchdog(1000);
    vi.advanceTimersByTime(999);
    expect(document.documentElement.classList.contains("app-ready")).toBe(false);
    vi.advanceTimersByTime(1);
    expect(document.documentElement.classList.contains("app-ready")).toBe(true);
    expect(document.getElementById("boot-error")).toBeNull();
    stop();
  });

  it("boot 及时收场 → 拆除后看门狗不再触发（不留待触发的定时器）", () => {
    vi.useFakeTimers();
    const stop = installBootWatchdog(1000);
    stop();
    vi.advanceTimersByTime(5000);
    expect(document.documentElement.classList.contains("app-ready")).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("默认时限是 5s（够 boot 的百毫秒级，只命中真卡死）", () => {
    expect(BOOT_WATCHDOG_MS).toBe(5000);
  });
});
