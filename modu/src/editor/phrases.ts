/**
 * CM6 界面短语全量汉化（search 面板 + goto line，17 键）。
 * 2026-10-12 自 editor.ts 逐字搬出（500 行棘轮让位编辑增强 A1）；
 * editor.ts re-export 本表，对外引用面不变（tests 仍从 editor 导入）。
 */
export const PHRASES_ZH: Readonly<Record<string, string>> = {
  Find: "查找",
  Replace: "替换",
  next: "下一个",
  previous: "上一个",
  all: "全部",
  "match case": "区分大小写",
  regexp: "正则表达式",
  "by word": "全字匹配",
  replace: "替换",
  "replace all": "全部替换",
  close: "关闭",
  "current match": "当前匹配",
  "on line": "于行",
  "replaced $ matches": "已替换 $ 处匹配",
  "replaced match on line $": "已替换第 $ 行的匹配",
  "Go to line": "跳转到行",
  go: "跳转",
};
