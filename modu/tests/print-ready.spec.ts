/**
 * M4 导出 PDF：print-ready 等待逻辑 + print.css 宪法红线锚。
 * - 等待条件是纯逻辑（mermaid 定稿判定 / 超时路径），测试注入替身，不加载真 mermaid；
 * - css 锚走 fs 直读（vitest 会把 .css?raw 桩化为空串，同 css-fixes.spec 教训）。
 */
import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import {
  awaitPrintReady,
  isMermaidSettled,
  pendingMermaid,
} from "../src/render/print-ready";

type MermaidState = "pending" | "rendered" | "error";

function makeDoc(...states: MermaidState[]): HTMLElement {
  const root = document.createElement("div");
  for (const state of states) {
    const el = document.createElement("div");
    el.className = "mermaid";
    if (state === "rendered") {
      el.setAttribute("data-rendered", "1");
    }
    if (state === "error") {
      el.setAttribute("data-mmd-error", "图表渲染失败：测试");
    }
    root.appendChild(el);
  }
  return root;
}

describe("print-ready：mermaid 定稿判定（纯逻辑）", () => {
  it("无图 / 全部定稿（成功或失败占位）→ settled", () => {
    expect(isMermaidSettled(makeDoc())).toBe(true);
    expect(isMermaidSettled(makeDoc("rendered", "error"))).toBe(true);
  });

  it("存在未定稿节点 → 未 settled；pendingMermaid 只收未定稿者", () => {
    const root = makeDoc("rendered", "pending", "error");
    expect(isMermaidSettled(root)).toBe(false);
    expect(pendingMermaid(root)).toHaveLength(1);
  });
});

describe("print-ready：等待与超时路径", () => {
  it("全部定稿 → 完成且不超时", async () => {
    const result = await awaitPrintReady(makeDoc("rendered", "error"), {
      renderPending: () => Promise.resolve(),
    });
    expect(result).toEqual({ timedOut: false });
  });

  it("替身把 pending 图置为定稿 → 完成不超时", async () => {
    const root = makeDoc("pending");
    const result = await awaitPrintReady(root, {
      renderPending: (el) => {
        el.setAttribute("data-rendered", "1");
        return Promise.resolve();
      },
    });
    expect(result).toEqual({ timedOut: false });
    expect(isMermaidSettled(root)).toBe(true);
  });

  it("永不定稿 → 到时限放行并返回 timedOut（超时路径）", async () => {
    vi.useFakeTimers();
    try {
      const promise = awaitPrintReady(makeDoc("pending"), {
        timeoutMs: 80,
        renderPending: () => Promise.resolve(), // 点火但永不落定稿：模拟卡死
      });
      await vi.advanceTimersByTimeAsync(500);
      await expect(promise).resolves.toEqual({ timedOut: true });
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("print.css 宪法锚（fs 直读）", () => {
  const css = readFileSync("src/typography/print.css", "utf8");

  it("文件存在且自我声明为唯一打印覆盖层", () => {
    expect(css).toContain("唯一打印覆盖层");
  });

  it("@page A4 + 18mm（页边距只归 @page 管）", () => {
    expect(css).toMatch(/@page\s*\{[^}]*size:\s*A4[^}]*margin:\s*18mm/s);
  });

  it("katex-mathml 防鬼影 + thead 跨页重复 + tr 行级防断（D2 ③④）", () => {
    expect(css).toMatch(/\.katex-mathml\s*\{[^}]*display:\s*none/);
    expect(css).toMatch(/thead\s*\{[^}]*display:\s*table-header-group/);
    expect(css).toMatch(/\btr\s*\{[^}]*break-inside:\s*avoid/);
  });

  it("D5 收回两条：print-color-adjust 保真 + box-decoration-break 克隆", () => {
    expect(css).toMatch(/print-color-adjust:\s*exact/);
    expect(css).toMatch(/box-decoration-break:\s*clone/);
  });

  it("壳层退场 + #doc 全幅零边距（边距归 @page，毒资产禁入）", () => {
    expect(css).toMatch(
      /#doc\s*\{[^}]*max-inline-size:\s*none[^}]*margin:\s*0[^}]*padding:\s*0/s,
    );
    expect(css).toMatch(/#titlebar[^{]*\{[^}]*display:\s*none/);
  });

  it("宪法红线（反向断言）：无 @page margin-box、无 counter(page)、无整表 avoid", () => {
    // 只看真规则：文件头注释里写着禁例本身（@bottom-center 等），不算违规
    const rules = css.replace(/\/\*[\s\S]*?\*\//g, "");
    expect(rules).not.toMatch(/@(bottom|top)-(center|left|right)/);
    expect(rules).not.toMatch(/counter\(\s*['"]?page/);
    // 整表 break-inside:avoid 被禁——table 只允许出现在选择器组内（后随逗号），不得独立成规则
    expect(rules).not.toMatch(/(^|[},\s])table\s*\{[^}]*break-inside:\s*avoid/);
  });
});
