/**
 * 关闭守卫（P0-7）—— 批次 3-7 阶段一自 `tabs.ts` **整段搬移**（纯搬移，导出名不变）。
 *
 * 内容：三选一类型（保存/放弃/取消）+ 处置结论 + 纯函数 `shouldGuardClose` / `resolveCloseAction`
 *      + 依赖注入的 `CloseGuardDeps` + 状态机 `createCloseGuard`。
 *
 * ⚠ 搬移纪律：段内容与 `tabs.ts` 改前对应段**逐字相同**；锚在 `tests/tabs.spec.ts`（断言未改）✓
 */
/** 关闭守卫（P0-7）用户三选一：保存 / 放弃 / 取消 */
export type CloseChoice = "save" | "discard" | "cancel";
/** 处置结论：save-then-close=先存后关、close=直接关、stay=不关 */
export type CloseAction = "close" | "save-then-close" | "stay";

/** 拦不拦这次关闭请求（P0-7 回归修复·纯函数，脱离 Tauri 可单测）。
 *  返回 false ⇒ 调用方**不得**调 event.preventDefault()：放默认行为走完，
 *  @tauri-apps/api 的 onCloseRequested 才会在 handler 返回后自动 destroy 窗口。
 *  返回 true ⇒ 这次要问人/落盘，必须先 preventDefault 把窗口留住。 */
export function shouldGuardClose(hasDirty: boolean): boolean {
  return hasDirty; // 只有真有未保存改动才拦；干净态一律放行
}

/** 关闭决策（P0-7·纯函数，脱离 Tauri 可单测）：脏才拦，选保存且落盘失败也不关窗 */
export function resolveCloseAction(
  hasDirty: boolean,
  choice: CloseChoice | null,
  saveFailed = false
): CloseAction {
  if (!hasDirty) {
    return "close";
  }
  if (choice === "save") {
    return saveFailed ? "stay" : "save-then-close";
  }
  return choice === "discard" ? "close" : "stay"; // cancel / 未作答：不关窗
}

/** 关窗守卫的对外依赖（main.ts 只做接线，行为在本模块可测） */
export interface CloseGuardDeps {
  /** 当前是否有未保存改动（问询期间可变化，每次现取不缓存） */
  hasDirty(): boolean;
  /** 未保存标签数（问询文案用，现取） */
  dirtyCount(): number;
  /** 弹三选一浮层并等答案 */
  ask(message: string): Promise<CloseChoice>;
  /** 逐个落盘；任一失败返回 false（窗口不关） */
  save(): Promise<boolean>;
  /** 真的关窗（Tauri 侧 close()，重入时守卫放行） */
  quit(): Promise<void>;
}

/** 关窗守卫状态机（P0-7 回归修复）：只有「确实要拦」的那一轮才 preventDefault。
 *
 *  为什么必须这么分（2026-09-23 实机测量）：
 *  - @tauri-apps/api 的 onCloseRequested = `await handler(evt)` 之后
 *    `if (!evt.isPreventDefault()) await window.destroy()`。无条件 preventDefault
 *    等于把这条唯一的自动关窗收尾掐死；
 *  - 手动补的那次 destroy() 又被 ACL 拒（`core:window:allow-destroy` 未授）。
 *
 *  三条出口：
 *  - 干净态：不 preventDefault，直接返回 → 交给自动 destroy；
 *  - 取消/保存失败：preventDefault 留住窗口，复位问询标记，下一次 ✕ 重新弹窗；
 *  - 保存/放弃成功：置 confirmed 再触发一次关窗请求，重入的那一轮不 preventDefault、
 *    不询问 → 又走回自动 destroy。 */
export function createCloseGuard(deps: CloseGuardDeps) {
  let asking = false; // 问询/落盘在飞：忽略连点
  let confirmed = false; // 用户已批准关窗：后续请求一律放行

  return async function onCloseRequested(event: { preventDefault(): void }): Promise<void> {
    if (confirmed || asking || !shouldGuardClose(deps.hasDirty())) {
      return; // 放行：不 preventDefault，让默认的 destroy 收尾
    }
    event.preventDefault(); // 从这里开始要异步问人/落盘，窗口必须留住
    asking = true;
    try {
      const message = `有 ${deps.dirtyCount()} 个文件尚未保存，关闭窗口前要保存吗？`;
      const planned = resolveCloseAction(true, await deps.ask(message));
      asking = false; // 问询收场：取消/保存失败都从此刻起可再次弹窗
      if (planned === "stay") {
        return;
      }
      if (planned === "save-then-close" && !(await deps.save())) {
        return; // 保存失败：不关窗（中文错误已由保存链闪显）
      }
      confirmed = true;
      await deps.quit();
    } finally {
      asking = false; // 任何提前返回/抛错都不把窗口锁在「问询在飞」
    }
  };
}

