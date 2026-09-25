/**
 * 双 rAF 时机工具 —— 批次 3-7 阶段一自 `tabs.ts` **整段搬移**（纯搬移，导出名不变）。
 *
 * 语义：本帧先让 loading 落 DOM 并完成绘制，下一帧才跑同步重渲染（避免首帧空白）。
 * tests/raf.ts 的测试助手依赖"无 rAF 时同步退化"的行为 ⇒ 搬移不改该退化路径 ✓
 */
/** 双 rAF：本帧先让 loading 落 DOM 并完成绘制，下一帧才跑同步重渲染——
 *  若同任务内连跑（class 加完立刻 renderDocument），长任务会饿死绘制，
 *  指示符直到渲染结束才可见，等于没挂（P5 批3·loading 先绘的帧预算事实）。 */
export function whenPainted(run: () => void): void {
  if (typeof requestAnimationFrame !== "function") {
    run();
    return;
  }
  requestAnimationFrame(() => requestAnimationFrame(run));
}

