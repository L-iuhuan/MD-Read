/**
 * 视图增强总装（M1 批2）：justify 守卫 → 公式缩放 → Mermaid 懒观察。
 * main.ts 只认这里的两个入口（enhanceView / refitView）与转发的 refreshMermaidTheme。
 */
import { fitMathBlocks, watchMathFit } from './fitmath'
import { guardJustify } from './justify'
import { observeMermaid } from './mermaid'

export { refreshMermaidTheme } from './mermaid'

/** 打开/重开文档后的三连增强。幂等，可重复调用（innerHTML 重写后重挂即可）。
 *  各阶段耗时挂 window.__viewProfile（性能基线诊断用）。 */
export function enhanceView(container: HTMLElement): void {
  const t: Record<string, number> = {};
  let s = performance.now();
  guardJustify(container); // 先守卫：实测模式的临时属性一次性读写完成
  t.guardJustify = Math.round(performance.now() - s); s = performance.now();
  fitMathBlocks(container); // 再缩放公式：量宽不受临时测量属性影响
  t.fitMath = Math.round(performance.now() - s); s = performance.now();
  watchMathFit(container); // 容器宽度变了防抖重跑缩放
  t.watchFit = Math.round(performance.now() - s); s = performance.now();
  observeMermaid(container); // 最后挂懒加载观察
  t.mermaid = Math.round(performance.now() - s);
  (window as unknown as Record<string, unknown>).__viewProfile = t;
}

/** 衬线切换后：字体度量变了，断行与撑开判定、公式缩放都要重算（Mermaid 不受影响） */
export function refitView(container: HTMLElement): void {
  guardJustify(container)
  fitMathBlocks(container)
}
