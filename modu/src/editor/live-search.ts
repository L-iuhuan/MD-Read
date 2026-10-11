/**
 * 编辑态查找面板的即时搜索（用户反馈 2026-10-01）：
 * CM 默认要回车才搜，与阅读态 findbar 的 150ms 防抖即时搜不一致。
 *
 * 只拦查找面板的主输入框（input[name="search"]，CM 6.7 的面板 DOM 约定）：
 * input → setSearchQuery（携带三枚勾选框当前态：case/re/word）→ findNext。
 * replace 框与勾选框保持原生提交语义；150ms 防抖与 findbar 同节奏。
 *
 * 独立成文件（editor/ 目录，同 position-map.ts 先例）：editor.ts 已压 500 行
 * 棘轮上限，任何净增都必须外移。
 */
import { findNext, SearchQuery, setSearchQuery } from "@codemirror/search";
import { EditorView } from "@codemirror/view";

let timer = 0;

/** 即时查找扩展：挂进 baseExtensions 即生效 */
export const liveSearchHandler = EditorView.domEventHandlers({
  input(event, view) {
    const field = event.target;
    if (!(field instanceof HTMLInputElement) || field.name !== "search") return;
    const panel = field.closest(".cm-panel.cm-search");
    if (panel === null) return;
    window.clearTimeout(timer);
    const value = field.value;
    timer = window.setTimeout(() => {
      const box = (n: string): boolean =>
        panel.querySelector<HTMLInputElement>(`input[name="${n}"]`)?.checked === true;
      view.dispatch({
        effects: setSearchQuery.of(
          new SearchQuery({
            search: value,
            caseSensitive: box("case"),
            regexp: box("re"),
            wholeWord: box("word"),
          }),
        ),
      });
      if (value !== "") findNext(view); // 跳到首个命中并滚动（回车仍是原生「下一个」）
    }, 150);
  },
});
