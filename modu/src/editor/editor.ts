/**
 * CM6 源码编辑器（M3-A，F7）：EditorView 常驻单例，只改显隐；
 * 每标签保存/恢复 {EditorState, scrollTop}——history 是 StateField，
 * 态随标签走即跨标签保撤销链（规格 D1）。
 * 三坑：①CRLF——建态设 lineSeparator.of("\r\n")、读回一律 sliceDoc()
 * （toString 恒按 \n join，D7 红线）；②display:none 度量失效——先显示容器
 * 再 requestMeasure 的 write 里定位/聚焦（reveal）；③无 openReplacePanel
 * ——Mod-h 绑 openSearchPanel，自定义 keymap 排在 searchKeymap 之前。
 */
import { defaultKeymap, history, historyKeymap } from "@codemirror/commands";
import { markdown } from "@codemirror/lang-markdown";
import { LanguageDescription, defaultHighlightStyle, syntaxHighlighting } from "@codemirror/language";
import { openSearchPanel, searchKeymap } from "@codemirror/search";
import { EditorState, type Extension } from "@codemirror/state";
import { EditorView, highlightActiveLine, keymap, lineNumbers } from "@codemirror/view";
import type { Tab } from "../app/tabs";
import { firstVisibleLine, nearestBlockLine } from "./position-map";

/** 围栏代码精选语言表（七项，懒加载；无 lang-typescript，ts 复用 lang-javascript） */
export const CODE_LANGUAGES: LanguageDescription[] = [
  LanguageDescription.of({ name: "typescript", alias: ["ts"],
    load: () => import("@codemirror/lang-javascript").then((m) => m.javascript({ typescript: true })) }),
  LanguageDescription.of({ name: "javascript", alias: ["js"],
    load: () => import("@codemirror/lang-javascript").then((m) => m.javascript()) }),
  LanguageDescription.of({ name: "python", alias: ["py"],
    load: () => import("@codemirror/lang-python").then((m) => m.python()) }),
  LanguageDescription.of({ name: "json",
    load: () => import("@codemirror/lang-json").then((m) => m.json()) }),
  LanguageDescription.of({ name: "rust", alias: ["rs"],
    load: () => import("@codemirror/lang-rust").then((m) => m.rust()) }),
  LanguageDescription.of({ name: "html",
    load: () => import("@codemirror/lang-html").then((m) => m.html()) }),
  LanguageDescription.of({ name: "css",
    load: () => import("@codemirror/lang-css").then((m) => m.css()) }),
];

/** CM6 界面短语全量汉化（search 面板 + goto line，17 键） */
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

/** 主题与阅读态同源：全走 tokens.css 的 CSS 变量，亮暗自动跟随 */
const editorTheme = EditorView.theme({
  "&": { height: "100%", backgroundColor: "var(--bg-app)", color: "var(--text)" },
  ".cm-scroller": { fontFamily: "var(--font-mono)", fontSize: "var(--fs-body)", lineHeight: "1.7" },
  /* 度量对齐：与 #doc 同限宽同内边距（--measure + --pad-page），左右中轴一致 */
  ".cm-content": {
    maxWidth: "var(--measure)",
    marginInline: "auto",
    padding: "var(--size-7) var(--pad-page) 25vh",
    caretColor: "var(--text)",
  },
  "&.cm-focused": { outline: "none" },
  ".cm-cursor": { borderLeftColor: "var(--text)", borderLeftWidth: "2px" },
  ".cm-selectionBackground, &.cm-focused .cm-selectionBackground": {
    backgroundColor: "var(--bg-active)",
  },
  ".cm-gutters": {
    backgroundColor: "var(--bg-app)",
    color: "var(--text-muted)",
    border: "none",
    borderInlineEnd: "1px solid var(--border-chrome)",
  },
  ".cm-activeLine": { backgroundColor: "color-mix(in srgb, var(--text) 6%, transparent)" },
  ".cm-activeLineGutter": { backgroundColor: "transparent", color: "var(--text)" },
});

/** 组装全部扩展。crlf 决定 lineSeparator（坑1）；onDocChanged 只接用户改动 */
function baseExtensions(crlf: boolean, onDocChanged: () => void): Extension[] {
  return [
    crlf ? EditorState.lineSeparator.of("\r\n") : [],
    history(),
    keymap.of([...defaultKeymap, ...historyKeymap]),
    keymap.of([{ key: "Mod-h", run: openSearchPanel, preventDefault: true }]), // 坑3
    keymap.of([...searchKeymap]),
    lineNumbers(),
    highlightActiveLine(),
    EditorView.lineWrapping,
    markdown({ codeLanguages: CODE_LANGUAGES }),
    syntaxHighlighting(defaultHighlightStyle),
    editorTheme,
    EditorView.updateListener.of((update) => {
      if (update.docChanged) {
        onDocChanged();
      }
    }),
  ];
}

function docState(text: string, crlf: boolean, report: () => void): EditorState {
  return EditorState.create({
    doc: text,
    extensions: [baseExtensions(crlf, report), EditorState.phrases.of(PHRASES_ZH)],
  });
}

/** 纯建态（无 DOM）：测试直接验证 lineSeparator / sliceDoc 往返 */
export function createDocState(text: string, crlf: boolean): EditorState {
  return docState(text, crlf, () => {});
}

export interface RevealTarget { line?: number; scrollTop?: number }

export interface SavedEditorState { state: EditorState; scrollTop: number }

export interface EditorHandle {
  readonly dom: HTMLElement;
  /** 全文换档：重置历史——换文档才清撤销链 */
  setDoc(text: string, crlf: boolean): void;
  /** 坑1：sliceDoc 按行分隔符 join，CRLF 保真 */
  getDoc(): string;
  saveState(): SavedEditorState;
  restoreState(saved: SavedEditorState): void;
  /** 坑2：容器显示后调用——测量写阶段定位（行或滚动位）并聚焦 */
  reveal(target: RevealTarget): void;
  scrollToLine(line: number): void;
  topLineNumber(): number;
  openSearch(): void;
  focus(): void;
}

/** 用户改动回调（docChanged）；setDoc/restoreState 换档期间的触发不计 */
export interface EditorHost { onDocChanged(): void }

export function createEditor(container: HTMLElement, host: EditorHost): EditorHandle {
  container.style.height = "100%";
  let silent = false; // 换档期间屏蔽 docChanged，避免误报 dirty
  const report = (): void => {
    if (!silent) {
      host.onDocChanged();
    }
  };
  const view = new EditorView({ parent: container, state: docState("", false, report) });

  function scrollToLine(line: number): void {
    const clamped = Math.min(Math.max(1, line), view.state.doc.lines);
    const pos = view.state.doc.line(clamped).from;
    view.dispatch({ effects: EditorView.scrollIntoView(pos, { y: "start" }) });
  }

  function setDoc(text: string, crlf: boolean): void {
    silent = true;
    view.setState(docState(text, crlf, report));
    silent = false;
  }

  function restoreState(saved: SavedEditorState): void {
    silent = true;
    view.setState(saved.state);
    silent = false;
  }

  function reveal(target: RevealTarget): void {
    view.requestMeasure({
      read: () => null,
      write: () => {
        if (typeof target.scrollTop === "number") {
          view.scrollDOM.scrollTop = target.scrollTop;
        } else if (typeof target.line === "number") {
          scrollToLine(target.line);
        }
        view.focus();
      },
    });
  }

  return {
    dom: view.dom,
    setDoc,
    getDoc: () => view.state.sliceDoc(),
    saveState: () => ({ state: view.state, scrollTop: view.scrollDOM.scrollTop }),
    restoreState,
    reveal,
    scrollToLine,
    topLineNumber: () =>
      view.state.doc.lineAt(view.lineBlockAtHeight(view.scrollDOM.scrollTop).from).number,
    openSearch: () => openSearchPanel(view),
    focus: () => view.focus(),
  };
}

export interface SaveFileArgs {
  path: string;
  text: string;
  encoding: string;
  bom: boolean;
}

/** 组装 save_file 载荷（Rust 车道契约：path/text/encoding/bom） */
export function buildSaveArgs(tab: Tab, text: string): SaveFileArgs {
  return { path: tab.path, text, encoding: tab.encoding, bom: tab.bom };
}
export interface EditSessionDeps {
  /** 编辑器容器（#editor-pane）：显隐由 session 控制 */
  container: HTMLElement;
  /** 阅读容器（#doc） */
  docEl: HTMLElement;
  /** 滚动容器（#content）：视口判定与保位落点 */
  contentEl: HTMLElement;
  /** 状态栏闪显位（#st-saved） */
  statusEl: HTMLElement;
  getTab(): Tab | null;
  saveFile(args: SaveFileArgs): Promise<void>;
  /** 编辑→阅读：用新文本重渲并挂载正文 */
  rerenderRead(tab: Tab, text: string): void;
  setDirty(path: string, dirty: boolean): void;
  /** 测试注入替身；默认真 CM6 编辑器 */
  makeEditor?(container: HTMLElement, host: EditorHost): EditorHandle;
}

export interface EditSession {
  isEditing(): boolean;
  toggle(): void;
  toEdit(): void;
  toRead(): void;
  save(): Promise<void>;
  /** 空态（关闭全部标签）：收起编辑器并作废当前档 */
  reset(): void;
  saveEditorState(): SavedEditorState | null;
  loadEditorState(saved: SavedEditorState | null): void;
}

export function createEditSession(deps: EditSessionDeps): EditSession {
  const { container, docEl, contentEl, statusEl } = deps;
  let editing = false;
  let currentPath: string | null = null;
  let flashTimer = 0;
  const editor = (deps.makeEditor ?? createEditor)(container, {
    onDocChanged: () => {
      const tab = deps.getTab();
      if (editing && tab !== null) {
        deps.setDirty(tab.path, true);
      }
    },
  });

  function flash(message: string): void {
    statusEl.textContent = message;
    statusEl.hidden = false;
    window.clearTimeout(flashTimer);
    flashTimer = window.setTimeout(() => {
      statusEl.hidden = true;
    }, 1500);
  }

  /** 编辑器同步到目标标签；返回是否从存量档恢复 */
  function syncDoc(tab: Tab): boolean {
    if (currentPath === tab.path) {
      return false;
    }
    if (tab.editor !== null) {
      editor.restoreState(tab.editor);
    } else {
      editor.setDoc(tab.source, tab.crlf);
    }
    currentPath = tab.path;
    return tab.editor !== null;
  }

  function toEdit(): void {
    const tab = deps.getTab();
    if (tab === null || editing) {
      return;
    }
    const restored = syncDoc(tab);
    const line = firstVisibleLine(contentEl);
    docEl.hidden = true;
    container.hidden = false; // 坑2：先显示
    editing = true;
    if (restored && tab.editor !== null) {
      editor.reveal({ scrollTop: tab.editor.scrollTop }); // 跨标签回来：恢复滚动
    } else {
      editor.reveal({ line: line ?? undefined }); // 阅读位置 → 同行块顶
    }
  }

  function toRead(): void {
    if (!editing) {
      return;
    }
    editing = false;
    container.hidden = true;
    const tab = deps.getTab();
    if (tab === null) {
      return;
    }
    const line = editor.topLineNumber();
    const text = editor.getDoc();
    tab.source = text;
    deps.rerenderRead(tab, text);
    docEl.hidden = false;
    const target = nearestBlockLine(contentEl, line);
    if (target !== null) {
      contentEl.querySelector(`[data-line="${target}"]`)?.scrollIntoView();
    }
  }

  async function save(): Promise<void> {
    const tab = deps.getTab();
    if (tab === null || !editing) {
      return;
    }
    const text = editor.getDoc();
    try {
      await deps.saveFile(buildSaveArgs(tab, text));
    } catch (error) {
      flash(`保存失败：${error instanceof Error ? error.message : String(error)}`);
      return;
    }
    tab.source = text;
    deps.setDirty(tab.path, false);
    flash("已保存");
  }

  function saveEditorState(): SavedEditorState | null {
    const tab = deps.getTab();
    if (tab === null || currentPath !== tab.path) {
      return null; // 编辑器不属当前标签：不动旧档
    }
    return editor.saveState();
  }

  function loadEditorState(saved: SavedEditorState | null): void {
    const tab = deps.getTab();
    if (tab === null) {
      return;
    }
    currentPath = tab.path;
    if (saved !== null) {
      editor.restoreState(saved);
    } else {
      editor.setDoc(tab.source, tab.crlf);
    }
    if (editing) {
      docEl.hidden = true; // 换档仍在编辑态：正文继续让位（openPath 等入口）
      container.hidden = false;
      editor.reveal({ scrollTop: saved !== null ? saved.scrollTop : 0 });
    }
  }

  /** 捕获阶段接管 Ctrl+E/S/F：编辑态 Ctrl+F 走 CM 面板，阅读态放行给 findbar */
  function onKey(event: KeyboardEvent): void {
    if (!(event.ctrlKey || event.metaKey)) {
      return;
    }
    const key = event.key.toLowerCase();
    if (key === "e") {
      event.preventDefault();
      event.stopPropagation();
      if (editing) {
        toRead();
      } else {
        toEdit();
      }
    } else if (key === "s") {
      event.preventDefault();
      event.stopPropagation();
      void save();
    } else if (key === "f" && editing) {
      event.preventDefault();
      event.stopPropagation();
      editor.openSearch();
    }
  }

  document.addEventListener("keydown", onKey, true);

  return {
    isEditing: () => editing,
    toggle: () => (editing ? toRead() : toEdit()),
    toEdit,
    toRead,
    save,
    reset: () => {
      editing = false;
      container.hidden = true;
      currentPath = null;
    },
    saveEditorState,
    loadEditorState,
  };
}
