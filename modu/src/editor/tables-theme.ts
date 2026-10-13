/**
 * 编辑器表格主题（C0·单主题方案）：把 codemirror-markdown-tables 的 TableTheme
 * **全部 16 个颜色槽**覆盖为 tokens.css 变量串——变量随 data-theme 在渲染时翻转，
 * 亮暗一套通吃，无需按 CM 亮暗档分双主题 / Compartment。
 *
 * 映射基准（C0 任务书）：单元格底 --bg-code｜边框 --border｜文字 --text｜
 * 表头强调 --accent-ink 系（亮档 --bg-th 与 --bg-code 同式，直接用会与单元格
 * 无分界 ⇒ 再压 15% --accent-ink 加深一档；暗档 --bg-th 本就偏强，同式仍保领先）
 * ｜高亮/激活面 --bg-code-inline｜其余槽按语义就近；零字面色值（color-mix 也只混变量）。
 */
import { TableTheme } from "codemirror-markdown-tables";

export const editorTableTheme: TableTheme = TableTheme.light.with({
  /* 底色：单元格统一 --bg-code；奇偶行同值（阅读态 D2 已删斑马纹，编辑态同口径不做斑马） */
  "--tbl-theme-row-background": "var(--bg-code)",
  "--tbl-theme-even-row-background": "var(--bg-code)",
  "--tbl-theme-odd-row-background": "var(--bg-code)",
  /* 表头：accent 强调底（见头注）；文字仍全局 --text（对底对比与阅读态 .mdc thead 同源量级） */
  "--tbl-theme-header-row-background": "color-mix(in oklab, var(--bg-th) 85%, var(--accent-ink))",
  /* 边框：常态 --border；悬停加深一档 --border-strong；按下与选中格描边走强调墨 */
  "--tbl-theme-border-color": "var(--border)",
  "--tbl-theme-border-hover-color": "var(--border-strong)",
  "--tbl-theme-border-active-color": "var(--accent-ink)",
  "--tbl-theme-outline-color": "var(--accent-ink)",
  /* 文字 */
  "--tbl-theme-text-color": "var(--text)",
  /* 行/列菜单：纸面底 + --border 描边；悬停高亮面走 --bg-code-inline（与行内码高亮同源） */
  "--tbl-theme-menu-border-color": "var(--border)",
  "--tbl-theme-menu-background": "var(--bg-app)",
  "--tbl-theme-menu-hover-background": "var(--bg-code-inline)",
  "--tbl-theme-menu-text-color": "var(--text)",
  "--tbl-theme-menu-hover-text-color": "var(--text)",
  /* 全选覆盖层：包要求**带 alpha**（层叠在表格与文字之上，实心色会盖住内容）——
   *  以软底 token（选中/命中/悬停底语义）调透明度合成，焦点态略强于失焦态 */
  "--tbl-theme-select-all-focus-overlay": "color-mix(in oklab, var(--accent-tint) 40%, transparent)",
  "--tbl-theme-select-all-blur-overlay": "color-mix(in oklab, var(--accent-tint) 30%, transparent)",
});
