/**
 * 关窗三选一浮层（P0-7 的浮层部分；F 批从 main.ts 抽出）。
 *
 * 用自绘而非 plugin-dialog：原生 ask/confirm 只有两键，装不下「保存 / 放弃 / 取消」。
 * 状态机（该不该拦、答案怎么落）在 app/tabs.ts 的 createCloseGuard，本模块只管
 * 「问出来」——依赖注入进 createCloseGuard 的 ask，main.ts 保留接线。
 *
 * 样式在 app.css §13（F 批由 main.ts 的内联注入迁出）：四个入口（浮层卡片语言
 * 三处 + 本浮层）统一在壳层样式表里读，注入 <style> 会多一份无处可查的 CSS。
 * 运行行为与抽取前逐条一致： #close-guard 遮罩、按钮「保存/放弃/取消」次序、
 * 首枚带 guard-primary、默认焦点在保存、Esc 与点浮层空白 = 取消、
 * capture 阶段监听 keydown 并 stopPropagation（不让全局 Esc 顺手关掉底下的浮层）。
 */
import type { CloseChoice } from "../app/tabs";

/** 浮层骨架；文案由调用方给（createCloseGuard 拼「有 N 个文件尚未保存…」）。
 *  返回遮罩与主按钮：默认焦点落在主按钮上，调用方不必再查 DOM。 */
function buildOverlay(
  message: string,
  settle: (choice: CloseChoice) => void,
): { overlay: HTMLDivElement; primary: HTMLButtonElement } {
  const overlay = document.createElement("div");
  overlay.id = "close-guard";
  overlay.setAttribute("role", "dialog");
  overlay.setAttribute("aria-modal", "true");
  const card = document.createElement("div");
  card.className = "close-guard-card";
  const text = document.createElement("p");
  text.textContent = message;
  const row = document.createElement("div");
  row.className = "close-guard-actions";
  const button = (label: string, choice: CloseChoice, primary = false): HTMLButtonElement => {
    const el = document.createElement("button");
    el.type = "button";
    el.textContent = label;
    if (primary) {
      el.className = "guard-primary";
    }
    el.addEventListener("click", () => settle(choice));
    return el;
  };
  const saveBtn = button("保存", "save", true);
  row.append(saveBtn, button("放弃", "discard"), button("取消", "cancel"));
  card.append(text, row);
  overlay.appendChild(card);
  overlay.addEventListener("click", (event) => {
    if (event.target === overlay) {
      settle("cancel"); // 点浮层空白：等同取消（不误触保存/放弃）
    }
  });
  return { overlay, primary: saveBtn };
}

/** 三选一浮层（保存 / 放弃 / 取消）：Esc 或点浮层空白 = 取消，默认焦点在「保存」。 */
export function askCloseChoice(message: string): Promise<CloseChoice> {
  return new Promise<CloseChoice>((resolve) => {
    let settled = false;
    const settle = (choice: CloseChoice): void => {
      if (settled) {
        return; // 一次询问只认一个答案
      }
      settled = true;
      document.removeEventListener("keydown", onKey, true);
      overlay.remove();
      resolve(choice);
    };
    function onKey(event: KeyboardEvent): void {
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation(); // 别让全局 Esc 顺手关掉底下的浮层
        settle("cancel");
      }
    }
    const { overlay, primary } = buildOverlay(message, settle);
    document.addEventListener("keydown", onKey, true);
    document.body.appendChild(overlay);
    primary.focus();
  });
}
