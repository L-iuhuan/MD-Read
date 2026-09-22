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

/* ---- 状态栏统一闪显（P5 批2·错误通道统一）----
 * #st-saved 单槽复用：kind 映射语义色类（app.css st-ok/st-warn/st-error →
 * tokens.css 的 --ok-text/--warn-text/--danger-text），时长统一 2000ms
 * （替换原先 2.5s/1.5s 两套）。放本模块而非 main.ts：编辑会话（已保存/保存
 * 失败/阅读态键位提示）与应用壳（导出/打开失败）走同一通道，tests 可直接导入。 */
export type FlashKind = "ok" | "warn" | "error";

const FLASH_MS = 2000;
let flashTimer = 0;

export function flashStatus(message: string, kind: FlashKind): void {
  const el = document.getElementById("st-saved");
  if (el === null) {
    return;
  }
  el.textContent = message;
  el.className = `st-${kind}`;
  el.hidden = false;
  window.clearTimeout(flashTimer);
  flashTimer = window.setTimeout(() => {
    el.hidden = true;
  }, FLASH_MS);
}

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
/** 自动保存防抖窗（用户反馈批次）：docChanged 后静默 2s 再落盘——
 *  连续敲键不断重置，停笔才存；与手动 Ctrl+S 同一条保存链（原编码/BOM 保真） */
export const AUTOSAVE_DELAY_MS = 2000;

export interface EditSessionDeps {
  /** 编辑器容器（#editor-pane）：显隐由 session 控制 */
  container: HTMLElement;
  /** 阅读容器（#doc） */
  docEl: HTMLElement;
  /** 滚动容器（#content）：视口判定与保位落点 */
  contentEl: HTMLElement;
  getTab(): Tab | null;
  saveFile(args: SaveFileArgs): Promise<void>;
  /** 编辑→阅读：用新文本重渲并挂载正文 */
  rerenderRead(tab: Tab, text: string): void;
  setDirty(path: string, dirty: boolean): void;
  /** 状态切换通知（P5 批2）：entering=进编辑/回阅读；line=定位行（进入=视口首块，回读=编辑器顶行）。
   *  壳层接 findbar 关闭与状态栏行号回填。 */
  onModeChange?(editing: boolean, line: number | null): void;
  /** 测试注入替身；默认真 CM6 编辑器 */
  makeEditor?(container: HTMLElement, host: EditorHost): EditorHandle;
  /** 自动保存开关（用户反馈批次）：壳层接设置面板 modu-autosave；缺省视为开 */
  isAutosaveEnabled?(): boolean;
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
  const { container, docEl, contentEl } = deps;
  let editing = false;
  let currentPath: string | null = null;
  /** #doc 当前呈现的文本（P5 批2）：toRead 时编辑器内容与之相同即跳过重渲、复用 DOM。
   *  激活标签（loadEditorState）与重渲（toRead 已变分支）两处同步。 */
  let domText: string | null = null;
  /** 自动保存票据：绑调度时的标签路径——切标签后的过期票在触发时对不上路径即作废 */
  let autosaveTimer = 0;
  const autosaveEnabled = deps.isAutosaveEnabled ?? (() => true);

  function cancelAutosave(): void {
    window.clearTimeout(autosaveTimer);
    autosaveTimer = 0;
  }

  function scheduleAutosave(path: string): void {
    window.clearTimeout(autosaveTimer); // 防抖：连续变更只认最后一次
    autosaveTimer = window.setTimeout(() => {
      const tab = deps.getTab();
      if (editing && tab !== null && tab.path === path) {
        void persist("已自动保存", "自动保存失败");
      }
    }, AUTOSAVE_DELAY_MS);
  }

  const editor = (deps.makeEditor ?? createEditor)(container, {
    onDocChanged: () => {
      const tab = deps.getTab();
      if (editing && tab !== null) {
        deps.setDirty(tab.path, true);
        if (autosaveEnabled()) {
          scheduleAutosave(tab.path);
        }
      }
    },
  });

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
    deps.onModeChange?.(true, line); // 壳层：关 findbar + 状态栏行号回填
  }

  function toRead(): void {
    if (!editing) {
      return;
    }
    cancelAutosave(); // 离开编辑态：待存票作废（dirty 仍在，关闭确认不失守）
    editing = false;
    container.hidden = true;
    const tab = deps.getTab();
    if (tab === null) {
      return;
    }
    const line = editor.topLineNumber();
    const text = editor.getDoc();
    if (text !== domText) {
      tab.source = text;
      domText = text;
      deps.rerenderRead(tab, text);
    } // 未变（P5 批2）：跳过重渲，复用已渲染 DOM，只复显正文
    docEl.hidden = false;
    const target = nearestBlockLine(contentEl, line);
    if (target !== null) {
      contentEl.querySelector(`[data-line="${target}"]`)?.scrollIntoView();
    }
    deps.onModeChange?.(false, line); // 壳层：状态栏行号按阅读态重算
  }

  /** 保存链共用（手动 Ctrl+S 与自动保存同路径：buildSaveArgs 原编码/BOM 保真）；
   *  成功清 dirty（关闭确认自然消失）、闪 ok；失败只闪 error 不弹窗——
   *  自动保存失败留给下次变更重试，手动失败用户自己再按。 */
  async function persist(okMessage: string, failPrefix: string): Promise<void> {
    const tab = deps.getTab();
    if (tab === null || !editing) {
      return;
    }
    const text = editor.getDoc();
    try {
      await deps.saveFile(buildSaveArgs(tab, text));
    } catch (error) {
      flashStatus(`${failPrefix}：${error instanceof Error ? error.message : String(error)}`, "error");
      return;
    }
    tab.source = text;
    deps.setDirty(tab.path, false);
    flashStatus(okMessage, "ok");
  }

  async function save(): Promise<void> {
    cancelAutosave(); // 手动优先：撤待存票，防成功后「已自动保存」覆盖「已保存」
    await persist("已保存", "保存失败");
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
    domText = tab.source; // 激活挂载刚渲染了 tab.source：#doc 与之同步
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

  /** 捕获阶段接管 Ctrl+E/S/F/H：编辑态 Ctrl+F 走 CM 面板，阅读态放行给 findbar；
   *  阅读态 Ctrl+S/Ctrl+H 无动作对象，闪中文提示（alpha 反直觉项，P5 批2） */
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
      if (editing) {
        void save();
      } else {
        flashStatus("阅读态无需保存，按 Ctrl+E 进入编辑", "warn");
      }
    } else if (key === "h" && !editing) {
      // 编辑态放行给 CM 面板（Mod-h = openSearchPanel，坑3）
      event.preventDefault();
      event.stopPropagation();
      flashStatus("阅读态无替换，按 Ctrl+E 进入编辑", "warn");
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
      cancelAutosave(); // 空态：待存票随会话作废
      container.hidden = true;
      currentPath = null;
      domText = null;
    },
    saveEditorState,
    loadEditorState,
  };
}
