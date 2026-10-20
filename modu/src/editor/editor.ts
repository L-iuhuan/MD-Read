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
import { markdown, markdownLanguage } from "@codemirror/lang-markdown";
import { defaultHighlightStyle, syntaxHighlighting } from "@codemirror/language";
import { openSearchPanel, search, searchKeymap } from "@codemirror/search";
import { EditorState, type Extension } from "@codemirror/state";
import { EditorView, highlightActiveLine, keymap, lineNumbers } from "@codemirror/view";
// markdown-commands 的 A1 命令族 + B1 追加（insertTableSkeleton/tidyChineseText）：工具栏注册表要用
import { insertTableSkeleton, markdownCommands, tableNoopFilter, tidyChineseText, toggleBlockquote, toggleBold, toggleHeading, toggleInlineCode, toggleItalic, toggleLink, toggleStrikethrough, toggleTaskItem } from "./markdown-commands";
import { livePreview } from "./live-preview";
import { liveSearchHandler } from "./live-search";
import { editorPasteHandlers } from "./paste";
import { formatCompletions } from "./snippets";
import { mountEditorToolbar } from "./toolbar";
import type { Tab } from "../app/tabs";
import { firstVisibleLine, nearestBlockLine } from "./position-map";
import { CODE_LANGUAGES } from "./code-langs";
import { mdLint } from "./md-lint"; // C1：MD 格式检查（规则在 lint-rules.ts 纯函数；editor.ts 棘轮 500 满载，故下方并行挂载）

export { CODE_LANGUAGES }; // 语言表外移 code-langs.ts（B1 腾棘轮行数）；re-export 保对外引用面（phrases.ts 先例）
/** CM6 界面短语汉化（17 键）已外移 phrases.ts（编辑增强 A1 腾棘轮行数）；re-export 保对外引用面 */
import { PHRASES_ZH } from "./phrases";
export { PHRASES_ZH };
/** 主题与阅读态同源：全走 tokens.css 的 CSS 变量，亮暗自动跟随。D3/D4（2026-09-29 视觉减负）：
 *  纸色列（--measure + 2×--pad-page）居中、两侧露画布色，切态纸缘不横跳；行号槽贴正文左缘。 */
const editorTheme = EditorView.theme({
  "&": { height: "100%", backgroundColor: "var(--bg-canvas)", color: "var(--text)" },
  /* des-8（2026-10-13）：正文走阅读字体栈，等宽只留给代码场景（行号槽见下、行内码在 live-preview.ts）。
     2026-10-20 缩放口径（用户裁定）：--paper-zoom 同时缩放字号/栏宽/内边距/行号锚点 = 纸面整体等比；
     ⚠ CM6 根上仍禁 CSS zoom（clientHeight 与 getBoundingClientRect 两套坐标按 1/k 分叉 ⇒ 测量崩坏）。 */
  ".cm-scroller": { fontFamily: "var(--font-reading, var(--font-sans))", fontSize: "calc(var(--fs-body) * var(--paper-zoom, 1))", lineHeight: "1.7" },
  /* 纸面列：与 #doc 同限宽/同内边距/同底色，三者随 --paper-zoom 同步缩放（只缩字号 ≠ 纸面缩放） */
  ".cm-content": {
    maxWidth: "calc((var(--measure) + 2 * var(--pad-page)) * var(--paper-zoom, 1))",
    marginInline: "auto",
    padding: "calc(var(--size-7) * var(--paper-zoom, 1)) calc(var(--pad-page) * var(--paper-zoom, 1)) calc(25vh * var(--paper-zoom, 1))",
    background: "var(--bg-app)",
    caretColor: "var(--text)",
  },
  "&.cm-focused": { outline: "none" },
  ".cm-cursor": { borderLeftColor: "var(--text)", borderLeftWidth: "2px" },
  ".cm-selectionBackground, &.cm-focused .cm-selectionBackground": {
    backgroundColor: "var(--bg-active)",
  },
  /* 行号槽：容器宽 0 + row-reverse ⇒ 行号以正文左缘为锚向左溢出；窄窗退左内边距不进负区（1px 分界线用负外边距抵消）。
     left 公式同样乘 --paper-zoom（缩放时行号列与正文左缘不脱位）；行号族字体/行高/字号必须与 .cm-scroller 同源（fix-32）。 */
  ".cm-gutters": { width: 0, flexDirection: "row-reverse", backgroundColor: "transparent", color: "var(--text-muted)", border: "none", borderInlineEnd: "1px solid var(--border-chrome)", marginInlineEnd: "-1px", fontFamily: "var(--font-reading, var(--font-sans))", fontSize: "calc(var(--fs-body) * var(--paper-zoom, 1))", lineHeight: "1.7", fontVariantNumeric: "tabular-nums" },
  ".cm-gutters-before": { left: "max(calc(var(--pad-page) * var(--paper-zoom, 1)), calc((100% - var(--measure) * var(--paper-zoom, 1)) / 2))" },
  ".cm-activeLine": { backgroundColor: "color-mix(in srgb, var(--text) 6%, transparent)" },
  ".cm-activeLineGutter": { backgroundColor: "transparent", color: "var(--text)" },
});

/** 即时查找（2026-10-01）：输入即搜，150ms 防抖——实现外移 live-search.ts（本文件压 500 棘轮） */
/** 组装全部扩展。crlf 决定 lineSeparator（坑1）；onDocChanged 只接用户改动；
 *  getDocPath 供粘贴图片通道取当前文档绝对路径（无文档返回 null）。 */
function baseExtensions(crlf: boolean, onDocChanged: () => void, getDocPath: () => string | null): Extension[] {
  return [
    crlf ? EditorState.lineSeparator.of("\r\n") : [],
    history(), tableNoopFilter(), // fix-18 通用守卫：滤「无标准 userEvent 的同文替换」空事务（缘起表格包空撤销，包已随 fix-20 移除；undo/userEvent 通道永不拦）
    formatCompletions(), // fix-24：格式补全——须在 markdownCommands 前（同为 Prec.high 时先注册先裁：Enter 先判菜单接受，见 snippets.ts 头注）
    markdownCommands(), // A1：格式命令键位——必须在 defaultKeymap 前（Ctrl-Enter 任务勾选压过其 Mod-Enter→insertBlankLine）
    keymap.of([{ key: "Shift-Mod-t", run: tidyChineseText }, ...defaultKeymap, ...historyKeymap]), // B1：中文整理（全仓核过无冲突）
    keymap.of([{ key: "Mod-h", run: openSearchPanel, preventDefault: true }, ...searchKeymap]), // 坑3：自定义绑定须排在 searchKeymap 前
    search({ top: true }), // K1（2026-09-29）：查找/替换面板上提到编辑器顶部，与阅读态 #findbar 同角落
    liveSearchHandler,
    editorPasteHandlers(getDocPath), // B1：粘贴双通道（图片落盘 / HTML→MD）
    lineNumbers(),
    highlightActiveLine(),
    EditorView.lineWrapping, mdLint(), // C1：MD 格式检查（error/warning/info 分级；编辑态 only）
    markdown({ base: markdownLanguage, codeLanguages: CODE_LANGUAGES }), // B1：GFM 基座（A2 遗留②：Task/Strikethrough/Table 节点路径激活）
    livePreview(), // B1 总装：A2 实时渲染（装配位次＝markdown() 之后，A2 建议位）；表格编辑包已随 fix-20 退役，插表走 insertTableSkeleton
    syntaxHighlighting(defaultHighlightStyle),
    editorTheme,
    EditorView.updateListener.of((update) => {
      if (update.docChanged) {
        onDocChanged();
      }
    }),
  ];
}

function docState(text: string, crlf: boolean, report: () => void, getDocPath: () => string | null): EditorState {
  return EditorState.create({
    doc: text,
    extensions: [baseExtensions(crlf, report, getDocPath), EditorState.phrases.of(PHRASES_ZH)],
  });
}

/** 纯建态（无 DOM）：测试直接验证 lineSeparator / sliceDoc 往返 */
export function createDocState(text: string, crlf: boolean): EditorState {
  return docState(text, crlf, () => {}, () => null);
}
/** fix-32（0.2.4 行号错位）：换字体后触发 CM6 重测——无实例早退；rAF 推一帧再 requestMeasure（AGENTS：容器刚显示时块高是估计值；不在 measure 的 write 里 dispatch） */
let activeView: EditorView | null = null; // createEditor 挂当前实例（EditorView 常驻单例，见文件头注）
export function remeasureEditor(): void { if (activeView !== null) requestAnimationFrame(() => activeView?.requestMeasure()); }
export interface RevealTarget { line?: number; scrollTop?: number }
export interface SavedEditorState { state: EditorState; scrollTop: number }

/* ---- 状态栏统一闪显（P5 批2·错误通道统一）----
 * #st-saved 单槽复用：kind 映射语义色类（app.css st-ok/st-warn/st-error →
 * tokens.css 的 --ok-text/--warn-text/--danger-text），普通级 2000ms、error 级 6000ms
 * （J3）。放本模块而非 main.ts：编辑会话（已保存/保存
 * 失败/阅读态键位提示）与应用壳（导出/打开失败）走同一通道，tests 可直接导入。 */
export type FlashKind = "ok" | "warn" | "error";

const FLASH_MS = 2000;
let flashTimer = 0;

export function flashStatus(message: string, kind: FlashKind, durationMs?: number): void {
  const el = document.getElementById("st-saved");
  if (el === null) {
    return;
  }
  const ms = durationMs ?? (kind === "error" ? 6000 : FLASH_MS); // J3：error 6s（读内容+想对策），普通级不变
  el.textContent = message;
  el.className = `st-${kind}`;
  el.hidden = false;
  window.clearTimeout(flashTimer);
  flashTimer = window.setTimeout(() => {
    el.hidden = true;
  }, ms);
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

/** 用户改动回调（docChanged）；setDoc/restoreState 换档期间的触发不计。
 *  getDocPath（B1 粘贴图片通道）：当前文档绝对路径，无文档返回 null；缺省视为恒 null。 */
export interface EditorHost {
  onDocChanged(): void;
  getDocPath?(): string | null;
}

export function createEditor(container: HTMLElement, host: EditorHost): EditorHandle {
  container.style.height = "100%";
  let silent = false; // 换档期间屏蔽 docChanged，避免误报 dirty
  const report = (): void => {
    if (!silent) {
      host.onDocChanged();
    }
  };
  const getDocPath = host.getDocPath ?? (() => null);
  const view = new EditorView({ parent: container, state: docState("", false, report, getDocPath) }); activeView = view; // fix-32：供 remeasureEditor（字体变更后重测）
  // B1 总装·B2 工具栏：键名对齐 toolbar.ts 的 ITEMS（insertTable/tidySpacing 为其查表键；C0 补 toggleBlockquote ⇒「引用」钮点亮）
  mountEditorToolbar(container, {
    toggleBold, toggleItalic, toggleStrikethrough, toggleInlineCode, toggleLink,
    toggleHeading1: toggleHeading(1), toggleHeading2: toggleHeading(2), toggleHeading3: toggleHeading(3),
    toggleTaskItem, toggleBlockquote, insertTable: insertTableSkeleton, tidySpacing: tidyChineseText,
  }, () => view);

  function scrollToLine(line: number): void {
    const clamped = Math.min(Math.max(1, line), view.state.doc.lines);
    const pos = view.state.doc.line(clamped).from;
    view.dispatch({ effects: EditorView.scrollIntoView(pos, { y: "start" }) });
  }

  function setDoc(text: string, crlf: boolean): void {
    silent = true;
    view.setState(docState(text, crlf, report, getDocPath));
    silent = false;
  }

  function restoreState(saved: SavedEditorState): void {
    silent = true;
    view.setState(saved.state);
    silent = false;
  }

  function reveal(target: RevealTarget): void {
    // 先落成 const 再判型：TS 的 typeof 收窄不会穿透到闭包（write 回调）里
    const scrollTop = target.scrollTop;
    const line = target.line;
    if (typeof scrollTop === "number") {
      view.requestMeasure({
        read: () => null,
        write: () => {
          view.scrollDOM.scrollTop = scrollTop;
        },
      });
    } else if (typeof line === "number") {
      // P0-2 修复：这里绝不能 dispatch。原先在 measure 的 write 里调 scrollToLine()
      // （内部 view.dispatch）会被 CM 拒绝——
      //   "Calls to EditorView.update are not allowed while an update is in progress"
      // 异常抛出后，同一个 write 回调里紧随其后的 view.focus() 被一并吞掉，
      // 手测表现即「切编辑后既没定位到阅读位置、也没聚焦」
      // （.cm-scroller.scrollTop = 0、document.activeElement = BODY）。
      // 改为 measure 只读目标行的块顶偏移、write 只写 scrollTop（纯 DOM 写），
      // 等价于 scrollIntoView(pos, { y: "start" }) 且完全不触发 update。
      // ⭐ 2026-09-27 实测修复（用户报「切编辑后行号与内容对不上、要下滑很多」✗）：
      // 上面只保证了"不 dispatch"，但漏了**时序**——`toEdit()` 是 `container.hidden = false`
      // 之后**同一帧**调本函数的 ⇒ CM6 还没按真实 DOM 测过块高 ⇒ `lineBlockAt().top` 是
      // **过时估计**，写进 scrollTop 就落错位置。实测证据（CDP，38KB/796 行真实文档）：
      //   阅读态滚到 8445px（状态栏「行 289」）⇒ 切编辑后 `.cm-scroller.scrollTop = 7645`，
      //   行号槽显示「**999**」✗ —— 落点偏到 ~3.4 倍，用户看到的就是"前面一片空、要下滑很多"。
      // 修法：把测量推到**下一帧**（那时已布局），仍然"measure 只读、write 只写"，不 dispatch ✓
      //（P0-2 铁律不变：在 measure 的 write 里 dispatch 会被 CM 拒绝并连坐吞掉 `view.focus()` ✗）
      const target = view.state.doc.line(Math.min(Math.max(1, line), view.state.doc.lines)).from;
      requestAnimationFrame(() => {
        view.requestMeasure({
          read: () => view.lineBlockAt(target).top,
          write: (top) => {
            view.scrollDOM.scrollTop = top;
          },
        });
      });
    }
    // focus 移出 measure 回调：不再被可能的异常连坐
    view.focus();
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
    getDocPath: () => deps.getTab()?.path ?? null, // B1 粘贴图片通道：docPath=当前标签 canonical 绝对路径
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
    // ⭐ fix-30：编辑器顶行/全文必须**先于 hidden 读**——display:none 的盒子 scrollTop 恒读 0
    // （CSSOM View「无关联盒返回 0」），旧序先隐藏再测 ⇒ line=1 ⇒ 回阅读落回首块（实测 4566→48px）。
    const line = editor.topLineNumber();
    const text = editor.getDoc();
    container.hidden = true;
    const tab = deps.getTab();
    if (tab === null) {
      return;
    }
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
