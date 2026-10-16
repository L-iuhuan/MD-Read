/**
 * 编辑态格式工具栏（编辑增强 B2）——「记不住快捷键」时的那张可点击的脸。
 *
 * 契约（与 B1 总装对齐，签名冻结）：
 *   mountEditorToolbar(container, cmds, getView): EditorToolbarHandle
 *   · container = 编辑器容器（#editor-pane）：工具栏插为**首个子元素**，并在容器上
 *     挂 `.md-toolbar-host`（toolbar.css 由它给 34px 条目条让位、给折叠把手定锚）；
 *   · cmds = A1 命令注册表（键名见 ITEMS；**缺键 ⇒ 该钮不渲染**——契约收窄不崩 UI）；
 *   · getView() = null ⇒ 命令钮全 disabled（点击什么都不做；折叠把手不受影响）。
 *
 * 纪律：
 *   · 只 `import type`——不引 CM 实现（避免与 editor.ts 的视图单例打架）；
 *   · 点击只调命令，变更由命令自己 dispatch（工具栏不碰 view.dispatch）；
 *   · mousedown 一律 preventDefault：连续点击不丢编辑器焦点（查找条 ↑↓✕ 同款）；
 *   · 样式在 toolbar.css（容器 chrome，不走 EditorView.theme）；B1 在 main.ts import 它；
 *   · 本文件零 document 级监听——unmount 无泄漏面（监听全挂在被移除的根元素上）。
 */
import type { EditorView } from "@codemirror/view";

export interface EditorToolbarHandle {
  unmount(): void;
}

/* ---- 图标：内联 SVG，16×16 网格、1.5px 描边、currentColor（不引图标库） ---- */

function icon(body: string): string {
  return (
    '<svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true" fill="none" ' +
    'stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">' +
    `${body}</svg>`
  );
}

/* ---- 钮表：顺序 = 视觉顺序；group 变号处插分隔线 ----
 * 键名 = cmds 注册表键；缺键 ⇒ 该钮不渲染（防 B1 契约变动崩 UI）。
 * 键位串与 markdown-commands.ts 的键位表逐字一致：改 A1 键位必须同批改这里。
 * 引用 / 表格：A1 无默认键位 ⇒ tooltip 只给名称。
 * 标题：A1 是工厂 toggleHeading(level)，B1 包装成 toggleHeading1..3 三键。 */

interface ToolbarItem {
  key: string;
  label: string;
  /** 键位串（tooltip 用），无键位留空 */
  keys?: string;
  /** aria-keyshortcuts 值（ARIA 语法），与 keys 同源 */
  shortcut?: string;
  group: number;
  glyph: string;
}

const ITEMS: readonly ToolbarItem[] = [
  {
    key: "toggleBold", label: "粗体", keys: "Ctrl+B", shortcut: "Control+B", group: 0,
    glyph: icon('<path d="M5.5 3.5v9"/><path d="M5.5 3.5h3.3a2.2 2.2 0 0 1 0 4.4H5.5"/><path d="M5.5 7.9h3.9a2.3 2.3 0 0 1 0 4.6H5.5"/>'),
  },
  {
    key: "toggleItalic", label: "斜体", keys: "Ctrl+I", shortcut: "Control+I", group: 0,
    glyph: icon('<path d="M6.5 3.5h4.5M5 12.5h4.5M9.8 3.5l-3.6 9"/>'),
  },
  {
    key: "toggleStrikethrough", label: "删除线", keys: "Ctrl+Shift+X", shortcut: "Control+Shift+X", group: 0,
    glyph: icon('<path d="M11 5.3c-.5-.9-1.6-1.4-2.8-1.4-1.5 0-2.7.7-2.7 1.9 0 2.6 5.9 1.3 5.9 4 0 1.3-1.4 2.1-3 2.1-1.3 0-2.4-.5-3-1.5"/><path d="M3 8h10"/>'),
  },
  {
    key: "toggleInlineCode", label: "行内代码", keys: "Ctrl+Shift+K", shortcut: "Control+Shift+K", group: 0,
    glyph: icon('<path d="M5.8 5 2.8 8l3 3"/><path d="M10.2 5l3 3-3 3"/><path d="M9.3 3.9 6.7 12.1"/>'),
  },
  {
    key: "toggleLink", label: "链接", keys: "Ctrl+K", shortcut: "Control+K", group: 0,
    glyph: icon('<path d="M10 5h2a3 3 0 0 1 0 6h-2"/><path d="M6 11H4a3 3 0 0 1 0-6h2"/><path d="M5.3 8h5.4"/>'),
  },
  {
    key: "toggleHeading1", label: "一级标题", keys: "Ctrl+1", shortcut: "Control+1", group: 1,
    glyph: icon('<path d="M3.5 4v8M8 4v8M3.5 8h4.5"/><path d="M10.8 6l1.6-1.1V12"/>'),
  },
  {
    key: "toggleHeading2", label: "二级标题", keys: "Ctrl+2", shortcut: "Control+2", group: 1,
    glyph: icon('<path d="M3.5 4v8M8 4v8M3.5 8h4.5"/><path d="M11 6.1a1.7 1.7 0 0 1 2.9 1c0 1.7-2.9 2.2-2.9 4.9h3"/>'),
  },
  {
    key: "toggleHeading3", label: "三级标题", keys: "Ctrl+3", shortcut: "Control+3", group: 1,
    glyph: icon('<path d="M3.5 4v8M8 4v8M3.5 8h4.5"/><path d="M11 6a1.6 1.6 0 0 1 2.7 1.1c0 .9-.7 1.3-1.5 1.5 .9 .2 1.7.7 1.7 1.7a1.7 1.7 0 0 1-3 .9"/>'),
  },
  {
    key: "toggleTaskItem", label: "任务项", keys: "Ctrl+Enter", shortcut: "Control+Enter", group: 2,
    glyph: icon('<rect x="2.75" y="3" width="10.5" height="10" rx="1.75"/><path d="M5.4 8.2l1.8 1.8 3.5-4.3"/>'),
  },
  {
    key: "toggleBlockquote", label: "引用", group: 2,
    glyph: icon('<path d="M3.2 5.2 5.6 8l-2.4 2.8"/><path d="M8 5.5h4.8M8 8.5h4.8M8 11.5h3"/>'),
  },
  {
    key: "insertTable", label: "表格", group: 2,
    glyph: icon('<rect x="2.75" y="3.25" width="10.5" height="9.5" rx="1.5"/><path d="M2.75 6.75h10.5M6.9 6.75v6"/>'),
  },
  {
    key: "tidySpacing", label: "整理（中文间距）", keys: "Ctrl+Shift+T", shortcut: "Control+Shift+T", group: 3,
    glyph: icon('<path d="M3 4.5h7M3 8h5M3 11.5h7"/><path d="M12.4 3.2v2.4M11.2 4.4h2.4"/>'),
  },
];

const HOST_CLASS = "md-toolbar-host";
const HOST_COLLAPSED_CLASS = "md-toolbar-host--collapsed";

/** 命令钮：tooltip = 名称＋快捷键。title＝原生兜底＋读屏，data-tip＝统一提示泡
 *  （ui/tooltip.ts 全局委托；悬停期引擎会暂时摘 title 防双泡、离开即还原）；
 *  aria-keyshortcuts 供读屏 */
function commandButton(item: ToolbarItem, fire: () => void): HTMLButtonElement {
  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = "md-toolbar-btn";
  btn.dataset.cmd = item.key;
  const tip = item.keys === undefined ? item.label : `${item.label} ${item.keys}`;
  btn.title = tip;
  btn.dataset.tip = tip; // 统一提示泡（src/ui/tooltip.ts）
  btn.setAttribute("aria-label", tip);
  if (item.shortcut !== undefined) {
    btn.setAttribute("aria-keyshortcuts", item.shortcut);
  }
  btn.innerHTML = item.glyph;
  btn.addEventListener("click", fire);
  return btn;
}

/** 组间分隔线（纯装饰） */
function separator(): HTMLSpanElement {
  const sep = document.createElement("span");
  sep.className = "md-toolbar-sep";
  sep.setAttribute("aria-hidden", "true");
  return sep;
}

/** 铺命令钮：缺键跳过；组变号处插分隔线（首尾不留悬空线） */
function buildCommandButtons(
  root: HTMLElement,
  cmds: Record<string, (view: EditorView) => boolean>,
  getView: () => EditorView | null,
  buttons: HTMLButtonElement[],
): void {
  let prevGroup: number | null = null;
  for (const item of ITEMS) {
    const run: ((view: EditorView) => boolean) | undefined = cmds[item.key];
    if (run === undefined) {
      continue;
    }
    if (prevGroup !== null && item.group !== prevGroup) {
      root.append(separator());
    }
    prevGroup = item.group;
    const btn = commandButton(item, () => {
      const view = getView();
      // P1-4（fix-23）：IME 组词期（view.composing）no-op——不发命令。
      // 组词中点工具栏钮若照发，会在拼音串上直接套标记，旁路 IME 确认流程。
      if (view !== null && !view.composing) {
        run(view); // 命令内部自 dispatch——这里绝不碰 view.dispatch
      }
    });
    buttons.push(btn);
    root.append(btn);
  }
}

/**
 * 折叠把手：展开态 = 行尾钮；收起态 = 16px 浮钮（两态皮都在 toolbar.css）。
 * 收起态以根类 `is-collapsed` 为唯一事实源；返回 setCollapsed（四处同步）。
 */
function setupCollapseToggle(root: HTMLElement, container: HTMLElement): (next: boolean) => void {
  const handle = document.createElement("button");
  handle.type = "button";
  handle.className = "md-toolbar-handle";
  handle.innerHTML = icon('<path d="M4 9.5 8 5.5l4 4"/>');

  const setCollapsed = (next: boolean): void => {
    root.classList.toggle("is-collapsed", next);
    container.classList.toggle(HOST_COLLAPSED_CLASS, next);
    handle.setAttribute("aria-expanded", next ? "false" : "true");
    const tip = next ? "展开格式工具栏" : "收起格式工具栏";
    handle.title = tip;
    handle.dataset.tip = tip; // 统一提示泡（title 同款双写，防双泡由引擎摘还）
    handle.setAttribute("aria-label", tip);
  };
  handle.addEventListener("click", () => setCollapsed(!root.classList.contains("is-collapsed")));
  root.append(handle);
  return setCollapsed;
}

/** getView 失联 ⇒ 命令钮全禁用（把手是视图开关，不随命令可用性变）；
 *  pointerenter / focusin 时重同步——状态可能在两次交互之间变过 */
function wireDisabledState(
  root: HTMLElement,
  buttons: HTMLButtonElement[],
  getView: () => EditorView | null,
): void {
  const sync = (): void => {
    const off = getView() === null;
    for (const btn of buttons) {
      btn.disabled = off;
    }
  };
  sync();
  root.addEventListener("pointerenter", sync);
  root.addEventListener("focusin", sync);
}

export function mountEditorToolbar(
  container: HTMLElement,
  cmds: Record<string, (view: EditorView) => boolean>,
  getView: () => EditorView | null,
): EditorToolbarHandle {
  const root = document.createElement("div");
  root.className = "md-toolbar";
  root.setAttribute("role", "toolbar");
  root.setAttribute("aria-label", "格式工具栏");
  root.setAttribute("aria-orientation", "horizontal");

  const buttons: HTMLButtonElement[] = [];
  buildCommandButtons(root, cmds, getView, buttons);
  const setCollapsed = setupCollapseToggle(root, container);
  wireDisabledState(root, buttons, getView);
  // 连续点击不丢编辑器焦点（查找条 ↑↓✕ 同款：mousedown 一律阻止默认）
  root.addEventListener("mousedown", (event) => event.preventDefault());

  container.classList.add(HOST_CLASS); // 宿主让位（toolbar.css）——unmount 时摘除
  container.prepend(root);
  setCollapsed(false);

  return {
    unmount(): void {
      root.remove();
      container.classList.remove(HOST_CLASS, HOST_COLLAPSED_CLASS);
    },
  };
}
