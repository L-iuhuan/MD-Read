/**
 * 视图增强总装（M1 批2）：justify 守卫 → 公式缩放 → Mermaid 懒观察。
 * main.ts 只认这里的两个入口（enhanceView / refitView）与转发的 refreshMermaidTheme。
 */
import { fitMathBlocks, watchMathFit } from './fitmath'
import { guardJustify } from './justify'
import { observeMermaid } from './mermaid'

export { refreshMermaidTheme } from './mermaid'

/** 打开/重开文档后的三连增强。幂等，可重复调用（innerHTML 重写后重挂即可） */
export function enhanceView(container: HTMLElement): void {
  guardJustify(container) // 先守卫：实测模式的临时属性一次性读写完成
  fitMathBlocks(container) // 再缩放公式：量宽不受临时测量属性影响
  watchMathFit(container) // 容器宽度变了防抖重跑缩放
  observeMermaid(container) // 最后挂懒加载观察
}

/** 衬线切换后：字体度量变了，断行与撑开判定、公式缩放都要重算（Mermaid 不受影响） */
export function refitView(container: HTMLElement): void {
  guardJustify(container)
  fitMathBlocks(container)
}
