/**
 * F 批 · 关窗三选一浮层（ui/close-confirm.ts，从 main.ts 抽出）。
 *
 * 抽出后行为必须逐条不变，本组就是那份契约：
 * 节点 #close-guard、按钮次序「保存/放弃/取消」、首枚 guard-primary、
 * 默认焦点在保存、点浮层空白 = 取消、Esc = 取消且 capture 阶段 stopPropagation
 * （不让全局 Esc 顺手关掉底下的浮层）、一次询问只认一个答案。
 * 另锚样式已迁到 app.css §13（不再由 main.ts 注入 <style>）。
 */
import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { askCloseChoice } from "../src/ui/close-confirm";

const main = readFileSync("src/main.ts", "utf8");
const app = readFileSync("src/app.css", "utf8");
const closeConfirm = readFileSync("src/ui/close-confirm.ts", "utf8");

const buttons = (): HTMLButtonElement[] =>
  Array.from(document.querySelectorAll<HTMLButtonElement>("#close-guard button"));

describe("F · askCloseChoice 运行时契约（保持与抽出前一致）", () => {
  beforeEach(() => {
    document.body.innerHTML = "";
  });
  afterEach(() => {
    document.body.innerHTML = "";
  });

  it("浮层形态：单块 #close-guard 遮罩 + 卡片 + 三按钮，次序为 保存/放弃/取消", () => {
    void askCloseChoice("有 2 个文件尚未保存，关闭窗口前要保存吗？");
    const overlays = document.querySelectorAll("#close-guard");
    expect(overlays.length).toBe(1);
    const overlay = overlays[0] as HTMLElement;
    expect(overlay.getAttribute("role")).toBe("dialog");
    expect(overlay.getAttribute("aria-modal")).toBe("true");
    expect(overlay.querySelector(".close-guard-card")).not.toBeNull();
    expect(buttons().map((button) => button.textContent)).toEqual(["保存", "放弃", "取消"]);
    expect(overlay.querySelector("p")?.textContent).toBe(
      "有 2 个文件尚未保存，关闭窗口前要保存吗？",
    );
  });

  it("首页按钮是主操作（guard-primary）且默认聚焦", () => {
    void askCloseChoice("要保存吗？");
    const [save, discard, cancel] = buttons();
    expect(save.className).toBe("guard-primary");
    expect(discard.className).toBe("");
    expect(cancel.className).toBe("");
    expect(document.activeElement).toBe(save);
  });

  it("点「保存」→ 解析为 save，浮层移除", async () => {
    const answer = askCloseChoice("要保存吗？");
    buttons()[0].click();
    await expect(answer).resolves.toBe("save");
    expect(document.getElementById("close-guard")).toBeNull();
  });

  it("点「放弃」→ discard；点「取消」→ cancel", async () => {
    const discardAnswer = askCloseChoice("要保存吗？");
    buttons()[1].click();
    await expect(discardAnswer).resolves.toBe("discard");

    const cancelAnswer = askCloseChoice("要保存吗？");
    buttons()[2].click();
    await expect(cancelAnswer).resolves.toBe("cancel");
  });

  it("点浮层空白（事件目标是遮罩本身）→ cancel，浮层移除", async () => {
    const answer = askCloseChoice("要保存吗？");
    const overlay = document.getElementById("close-guard") as HTMLElement;
    overlay.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    await expect(answer).resolves.toBe("cancel");
    expect(document.getElementById("close-guard")).toBeNull();
  });

  it("点卡片内部不误判（目标不是遮罩）", async () => {
    const answer = askCloseChoice("要保存吗？");
    const card = document.querySelector(".close-guard-card") as HTMLElement;
    card.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    expect(document.getElementById("close-guard")).not.toBeNull(); // 还开着
    buttons()[2].click();
    await expect(answer).resolves.toBe("cancel");
  });

  it("Esc = 取消，且在 capture 阶段拦下事件（不惊动全局 Esc 仲裁）", async () => {
    const answer = askCloseChoice("要保存吗？");
    const seen: string[] = [];
    // 模拟全局 Esc 仲裁（main.ts setupGlobalKeys）：document 冒泡阶段监听
    const globalListener = (event: KeyboardEvent): void => {
      if (event.key === "Escape") {
        seen.push("global");
      }
    };
    document.addEventListener("keydown", globalListener);
    const event = new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true });
    document.dispatchEvent(event);
    document.removeEventListener("keydown", globalListener);
    await expect(answer).resolves.toBe("cancel");
    expect(event.defaultPrevented, "须 preventDefault").toBe(true);
    expect(seen, "stopPropagation 后全局 Esc 不得看到这次按键").toEqual([]);
  });

  it("一次询问只认一个答案：连点两个按钮只解析第一次", async () => {
    const answer = askCloseChoice("要保存吗？");
    const [save, discard] = buttons();
    save.click();
    discard.click(); // 浮层已移除，这里点的是残留引用
    await expect(answer).resolves.toBe("save");
  });

  it("收场后摘掉 keydown 监听（不残留 capture 钩子）", async () => {
    const answer = askCloseChoice("要保存吗？");
    buttons()[2].click();
    await answer;
    const event = new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true });
    document.dispatchEvent(event);
    expect(event.defaultPrevented, "浮层已关，Esc 不该再被本模块拦").toBe(false);
  });

  it("两块浮层同时在飞：各自独立解析、互不串台", async () => {
    const first = askCloseChoice("第一个");
    const second = askCloseChoice("第二个");
    const panels = Array.from(document.querySelectorAll<HTMLElement>("#close-guard"));
    expect(panels.length).toBe(2); // 同一 id 的两块面板（真实路径上会被 createCloseGuard 的 asking 挡住）
    // 先答第二块「放弃」，再答第一块「保存」
    panels[1]?.querySelectorAll<HTMLButtonElement>("button")[1]?.click();
    await expect(second).resolves.toBe("discard");
    panels[0]?.querySelector<HTMLButtonElement>("button.guard-primary")?.click();
    await expect(first).resolves.toBe("save");
    expect(document.getElementById("close-guard")).toBeNull();
  });
});

describe("F · 样式已迁出 main.ts（真实 CSS，不再注入 <style>）", () => {
  it("main.ts 不再持有 close-guard 样式或注入函数", () => {
    expect(main).not.toMatch(/CLOSE_GUARD_STYLE/);
    expect(main).not.toMatch(/injectCloseGuardStyle/);
    expect(main).not.toMatch(/close-guard-style/);
    expect(main).toMatch(/from "\.\/ui\/close-confirm"/);
  });

  it("app.css §13 提供四个入口的完整皮（遮罩/卡片/按钮/主按钮）", () => {
    expect(app).toMatch(/#close-guard\s*\{[^}]*position:\s*fixed/);
    expect(app).toMatch(/#close-guard\s*\{[^}]*z-index:\s*calc\(var\(--z-float\) \+ 10\)/);
    expect(app).toMatch(/#close-guard \.close-guard-card\s*\{[^}]*border-radius:\s*var\(--radius-3\)/);
    expect(app).toMatch(/#close-guard \.close-guard-card\s*\{[^}]*box-shadow:\s*var\(--shadow-2\)/);
    expect(app).toMatch(/#close-guard \.close-guard-actions\s*\{[^}]*justify-content:\s*flex-end/);
    expect(app).toMatch(/#close-guard button\.guard-primary\s*\{[^}]*background:\s*var\(--accent-solid\)/);
  });

  it("样式表纪律：外壳层不出现字面色值（色值只走 tokens）", () => {
    const section = /#close-guard[\s\S]*$/.exec(app)?.[0] ?? "";
    expect(section).not.toMatch(/#[0-9a-fA-F]{3,8}\b/);
  });

  it("close-confirm.ts 只 import 类型，不 import 任何应用模块（浮层依赖最小）", () => {
    const imports = closeConfirm.match(/^import[\s\S]*?;$/gm) ?? [];
    for (const line of imports) {
      expect(line).toMatch(/^import type /);
    }
  });
});
