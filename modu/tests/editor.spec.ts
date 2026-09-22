/**
 * 编辑器（M3-A，F7）：
 * - phrases 全量中文、curated 七语言表、CRLF→lineSeparator、保存载荷组装（bom 透传）
 * - EditSession 状态机（mock EditorHandle：显隐/保位/dirty/保存/键位路由）
 * - Tab 增量：bom/crlf 落标签、编辑器态随标签存取
 */
import { EditorState } from "@codemirror/state";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  CODE_LANGUAGES,
  PHRASES_ZH,
  buildSaveArgs,
  createDocState,
  createEditSession,
  type EditSessionDeps,
  type EditorHandle,
  type EditorHost,
} from "../src/editor/editor";
import {
  createTabManager,
  type Tab,
  type TabManager,
  type TabManagerDeps,
} from "../src/app/tabs";

/* 会话在 document 上挂捕获 keydown，测试间不清理会串台（阅读态 Ctrl+S/H 提示
   被上一个测试的陈旧会话抢先闪）。这里代理注册、afterEach 逐个摘除。 */
interface DocListener {
  type: string;
  listener: EventListener;
  capture: boolean;
}
const docListeners: DocListener[] = [];

beforeAll(() => {
  Element.prototype.scrollIntoView = vi.fn(); // jsdom 未实现，保位落点需要
  const proto = Document.prototype;
  const originalAdd = proto.addEventListener;
  vi.spyOn(proto, "addEventListener").mockImplementation(function (
    this: Document,
    type: string,
    listener: EventListenerOrEventListenerObject,
    options?: boolean | AddEventListenerOptions
  ) {
    if (typeof listener === "function") {
      docListeners.push({
        type,
        listener,
        capture: options === true || (typeof options === "object" && options?.capture === true),
      });
    }
    return originalAdd.call(this, type, listener, options);
  } as typeof proto.addEventListener);
});

afterEach(() => {
  for (const { type, listener, capture } of docListeners.splice(0)) {
    document.removeEventListener(type, listener, { capture });
  }
});

/* ---- 短语表与语言表（纯数据） ---- */

describe("PHRASES_ZH：CM6 界面短语全量汉化", () => {
  const KEYS = [
    "Find", "Replace", "next", "previous", "all", "match case", "regexp",
    "by word", "replace", "replace all", "close", "current match", "on line",
    "replaced $ matches", "replaced match on line $", "Go to line", "go",
  ];

  it("键集与 CM6 search/goto 清单一致（17 键），每条都含汉字", () => {
    expect(Object.keys(PHRASES_ZH).sort()).toEqual([...KEYS].sort());
    for (const value of Object.values(PHRASES_ZH)) {
      expect(/\p{Script=Han}/u.test(value)).toBe(true);
    }
  });
});

describe("CODE_LANGUAGES：围栏代码精选语言表", () => {
  it("恰为七语言：ts/js/python/json/rust/html/css，均为懒加载", () => {
    expect(CODE_LANGUAGES.map((l) => l.name).sort()).toEqual(
      ["css", "html", "javascript", "json", "python", "rust", "typescript"]
    );
    for (const lang of CODE_LANGUAGES) {
      expect(typeof lang.load).toBe("function");
    }
  });
});

/* ---- 坑1 CRLF：建态与读回 ---- */

describe("createDocState：行尾保真（D7）", () => {
  it("crlf=true 设 lineSeparator=\\r\\n，sliceDoc 往返不丢行尾", () => {
    const s = createDocState("一\r\n二\r\n三", true);
    expect(s.facet(EditorState.lineSeparator)).toBe("\r\n");
    expect(s.doc.lines).toBe(3);
    expect(s.sliceDoc()).toBe("一\r\n二\r\n三");
  });

  it("佐证坑1：doc.toString() 恒按 \\n join——读回必须走 sliceDoc", () => {
    expect(createDocState("一\r\n二", true).doc.toString()).toBe("一\n二");
  });

  it("crlf=false 不设分隔符（默认 \\n）", () => {
    const s = createDocState("一\n二", false);
    expect(s.facet(EditorState.lineSeparator)).toBeUndefined();
    expect(s.sliceDoc()).toBe("一\n二");
  });
});

/* ---- 保存载荷 ---- */

function makeTab(over: Partial<Tab> = {}): Tab {
  return {
    path: "D:\\docs\\a.md",
    title: "a.md",
    encoding: "GB18030",
    source: "旧文",
    scroll: 0,
    dirty: false,
    bom: true,
    crlf: true,
    editor: null,
    ...over,
  };
}

describe("buildSaveArgs：save_file 载荷组装", () => {
  it("path/text/encoding/bom 逐项透传", () => {
    expect(buildSaveArgs(makeTab(), "新文")).toEqual({
      path: "D:\\docs\\a.md",
      text: "新文",
      encoding: "GB18030",
      bom: true,
    });
    expect(buildSaveArgs(makeTab({ bom: false, encoding: "UTF-8" }), "x")).toEqual({
      path: "D:\\docs\\a.md",
      text: "x",
      encoding: "UTF-8",
      bom: false,
    });
  });
});

/* ---- EditSession（注入替身编辑器） ---- */

interface StubEditor extends EditorHandle {
  calls: string[];
  host: EditorHost | null;
  doc: string;
}

function stubEditor(): StubEditor {
  const stub: StubEditor = {
    calls: [],
    host: null,
    doc: "编辑后文本",
    dom: document.createElement("div"),
    setDoc(text: string, crlf: boolean) {
      stub.calls.push(`setDoc(${text},${crlf})`);
    },
    getDoc: () => stub.doc,
    saveState: () => ({ state: createDocState("存档", false), scrollTop: 42 }),
    restoreState(saved) {
      stub.calls.push(`restore(${saved.scrollTop})`);
    },
    reveal(target) {
      stub.calls.push(`reveal(${target.line ?? target.scrollTop ?? "-"})`);
    },
    scrollToLine(line: number) {
      stub.calls.push(`line(${line})`);
    },
    topLineNumber: () => 7,
    openSearch() {
      stub.calls.push("search");
    },
    focus() {
      stub.calls.push("focus");
    },
  };
  return stub;
}

interface SessionHarness {
  session: ReturnType<typeof createEditSession>;
  stub: StubEditor;
  tab: Tab;
  saveFile: ReturnType<typeof vi.fn>;
  setDirty: ReturnType<typeof vi.fn>;
  rerenderRead: ReturnType<typeof vi.fn>;
  onModeChange: ReturnType<typeof vi.fn>;
  container: HTMLElement;
  docEl: HTMLElement;
}

function setupSession(): SessionHarness {
  document.body.innerHTML =
    '<main id="content"><article id="doc"><p data-line="3">三</p><p data-line="9">九</p></article>' +
    '<div id="editor-pane" hidden></div></main><span id="st-saved" hidden></span>';
  const tab = makeTab();
  const saveFile = vi.fn(async (): Promise<void> => {});
  const setDirty = vi.fn();
  const rerenderRead = vi.fn();
  const onModeChange = vi.fn();
  const stub = stubEditor();
  const container = document.getElementById("editor-pane") as HTMLElement;
  const deps: EditSessionDeps = {
    container,
    docEl: document.getElementById("doc") as HTMLElement,
    contentEl: document.getElementById("content") as HTMLElement,
    getTab: () => tab,
    saveFile,
    setDirty,
    rerenderRead,
    onModeChange,
    makeEditor: (_c, host) => {
      stub.host = host;
      return stub;
    },
  };
  return { session: createEditSession(deps), stub, tab, saveFile, setDirty, rerenderRead, onModeChange, container, docEl: deps.docEl };
}

function press(key: string): void {
  document.dispatchEvent(
    new KeyboardEvent("keydown", { key, ctrlKey: true, bubbles: true, cancelable: true })
  );
}

describe("EditSession：阅读 ⇄ 编辑切换", () => {
  it("toEdit：正文让位、装载源文（含 crlf）、按视口首块行号定位", () => {
    const h = setupSession();
    h.session.toEdit();
    expect(h.docEl.hidden).toBe(true);
    expect(h.container.hidden).toBe(false);
    expect(h.stub.calls).toContain("setDoc(旧文,true)");
    expect(h.stub.calls).toContain("reveal(3)"); // 视口内首个 data-line 块
  });

  it("重复 toEdit 幂等（编辑态中不再翻页）", () => {
    const h = setupSession();
    h.session.toEdit();
    const before = h.stub.calls.length;
    h.session.toEdit();
    expect(h.stub.calls.length).toBe(before);
  });

  it("toRead：重渲新文本、tab.source 同步、滚到最近上方块", () => {
    const h = setupSession();
    h.session.toEdit();
    const p3 = document.querySelector('[data-line="3"]') as Element;
    const spy = vi.spyOn(p3, "scrollIntoView");
    h.session.toRead();
    expect(h.container.hidden).toBe(true);
    expect(h.docEl.hidden).toBe(false);
    expect(h.rerenderRead).toHaveBeenCalledWith(h.tab, "编辑后文本");
    expect(h.tab.source).toBe("编辑后文本");
    expect(spy).toHaveBeenCalled(); // 顶行 7 → 最近上方块 data-line=3
  });

  it("loadEditorState：换档仍在编辑态时正文继续让位并恢复滚动", () => {
    const h = setupSession();
    h.session.toEdit();
    h.docEl.hidden = false; // 模拟 mountRendered 又把正文挂出来
    h.session.loadEditorState(null);
    expect(h.stub.calls).toContain("setDoc(旧文,true)");
    expect(h.docEl.hidden).toBe(true);
    expect(h.container.hidden).toBe(false);
    expect(h.stub.calls).toContain("reveal(0)");
  });

  it("saveEditorState / loadEditorState：编辑器态随标签存取", () => {
    const h = setupSession();
    expect(h.session.saveEditorState()).toBeNull(); // 编辑器未同步到当前标签：不动旧档
    h.session.loadEditorState(null); // 标签激活：同步源文
    const saved = h.session.saveEditorState();
    expect(saved?.scrollTop).toBe(42);
    h.session.loadEditorState(saved);
    expect(h.stub.calls).toContain("restore(42)");
  });
});

describe("EditSession：dirty 与保存", () => {
  it("docChanged 仅编辑态计脏（setDoc 换档由 silent 屏蔽）", () => {
    const h = setupSession();
    expect(h.stub.host).not.toBeNull();
    h.stub.host?.onDocChanged(); // 阅读态：不打扰
    expect(h.setDirty).not.toHaveBeenCalled();
    h.session.toEdit();
    h.stub.host?.onDocChanged();
    expect(h.setDirty).toHaveBeenCalledWith("D:\\docs\\a.md", true);
  });

  it("保存成功：载荷 bom 透传、清 dirty、闪「已保存」、source 同步", async () => {
    const h = setupSession();
    h.session.toEdit();
    await h.session.save();
    expect(h.saveFile).toHaveBeenCalledWith(buildSaveArgs(h.tab, "编辑后文本"));
    expect(h.saveFile).toHaveBeenLastCalledWith(
      expect.objectContaining({ bom: true, encoding: "GB18030" })
    );
    expect(h.setDirty).toHaveBeenLastCalledWith("D:\\docs\\a.md", false);
    const status = document.getElementById("st-saved") as HTMLElement;
    expect(status.hidden).toBe(false);
    expect(status.textContent).toBe("已保存");
    expect(h.tab.source).toBe("编辑后文本");
  });

  it("保存失败：闪中文错误、dirty 不清", async () => {
    const h = setupSession();
    (h.saveFile as ReturnType<typeof vi.fn>).mockRejectedValue(new Error("盘被写保护"));
    h.session.toEdit();
    await h.session.save();
    const status = document.getElementById("st-saved") as HTMLElement;
    expect(status.textContent).toBe("保存失败：盘被写保护");
    expect(h.setDirty).not.toHaveBeenCalledWith("D:\\docs\\a.md", false);
  });

  it("阅读态保存空转（不落盘）", async () => {
    const h = setupSession();
    await h.session.save();
    expect(h.saveFile).not.toHaveBeenCalled();
  });
});

describe("EditSession：键位路由", () => {
  it("Ctrl+E 切换、Ctrl+S 保存、编辑态 Ctrl+F 走 CM 面板、阅读态不拦", async () => {
    const h = setupSession();
    press("e");
    expect(h.container.hidden).toBe(false);
    press("f");
    expect(h.stub.calls).toContain("search");
    press("s");
    await vi.waitFor(() => expect(h.saveFile).toHaveBeenCalled());
    press("e");
    expect(h.container.hidden).toBe(true);
    const searches = h.stub.calls.filter((c) => c === "search").length;
    press("f"); // 阅读态：不拦截，由既有 findbar 处理（此处无 findbar 即无动作）
    expect(h.stub.calls.filter((c) => c === "search").length).toBe(searches);
  });

  it("阅读态 Ctrl+S：不落盘，闪 warn 提示（P5 批2 alpha 反直觉项）", async () => {
    const h = setupSession();
    press("s");
    expect(h.saveFile).not.toHaveBeenCalled();
    const status = document.getElementById("st-saved") as HTMLElement;
    expect(status.textContent).toBe("阅读态无需保存，按 Ctrl+E 进入编辑");
    expect(status.className).toBe("st-warn");
    expect(status.hidden).toBe(false);
  });

  it("阅读态 Ctrl+H 闪提示；编辑态 Ctrl+H 放行（不拦，交给 CM 面板）", () => {
    const h = setupSession();
    press("h");
    const status = document.getElementById("st-saved") as HTMLElement;
    expect(status.textContent).toBe("阅读态无替换，按 Ctrl+E 进入编辑");
    expect(status.className).toBe("st-warn");
    h.session.toEdit();
    status.hidden = true;
    status.textContent = "";
    press("h"); // 编辑态：session 不再接管，事件放行
    expect(status.textContent).toBe("");
  });
});

describe("EditSession：onModeChange（P5 批2 状态栏行号回填钩子）", () => {
  it("toEdit 上报进入行（视口首块 data-line=3），toRead 上报编辑器顶行 7", () => {
    const h = setupSession();
    h.session.toEdit();
    expect(h.onModeChange).toHaveBeenLastCalledWith(true, 3);
    h.session.toRead();
    expect(h.onModeChange).toHaveBeenLastCalledWith(false, 7);
  });

  it("阅读态与重复切态不重复上报（编辑态中 toEdit 幂等）", () => {
    const h = setupSession();
    expect(h.onModeChange).not.toHaveBeenCalled();
    h.session.toEdit();
    h.session.toEdit();
    expect(h.onModeChange).toHaveBeenCalledTimes(1);
  });
});

describe("EditSession：toRead dirty 分支（P5 批2 未变不白渲）", () => {
  it("内容未变：rerenderRead 不调用、tab.source 不动、正文复显", () => {
    const h = setupSession();
    h.session.loadEditorState(null); // 激活挂载：domText ← tab.source（旧文）
    h.stub.doc = "旧文"; // 编辑器一字未改
    h.session.toEdit();
    h.session.toRead();
    expect(h.rerenderRead).not.toHaveBeenCalled();
    expect(h.tab.source).toBe("旧文");
    expect(h.docEl.hidden).toBe(false);
  });

  it("内容已变：走重渲管线并同步 tab.source", () => {
    const h = setupSession();
    h.session.loadEditorState(null);
    h.session.toEdit();
    h.session.toRead();
    expect(h.rerenderRead).toHaveBeenCalledWith(h.tab, "编辑后文本");
    expect(h.tab.source).toBe("编辑后文本");
  });

  it("未进过激活流程（domText 空）：视为已变，照常重渲", () => {
    const h = setupSession();
    h.session.toEdit();
    h.session.toRead();
    expect(h.rerenderRead).toHaveBeenCalledWith(h.tab, "编辑后文本");
  });
});

/* ---- Tab 增量：bom/crlf 与编辑器态随标签 ---- */

function setupTabs(): { manager: TabManager; saveState: ReturnType<typeof vi.fn>; loadState: ReturnType<typeof vi.fn> } {
  document.body.innerHTML = '<div id="tabbar"><div id="tab-list"></div></div>';
  const savedPayload = { state: createDocState("存档", false), scrollTop: 42 };
  const saveState = vi.fn(() => savedPayload);
  const loadState = vi.fn();
  const deps: TabManagerDeps = {
    render: (src: string) => ({ html: `<p>${src}</p>`, outline: [] }),
    mountDoc: () => {},
    getScroll: () => 0,
    setScroll: () => {},
    onEmpty: () => {},
    confirmClose: () => true,
    saveEditorState: saveState,
    loadEditorState: loadState,
  };
  return { manager: createTabManager(document.getElementById("tabbar") as HTMLElement, deps), saveState, loadState };
}

describe("tabs × 编辑器态（M3-A 接口）", () => {
  it("openTab：bom/crlf 按真值判定落标签（缺省容忍为 false）", () => {
    const { manager } = setupTabs();
    manager.openTab("a.md", { text: "A", encoding: "UTF-8" });
    expect(manager.activeTab()?.bom).toBe(false);
    expect(manager.activeTab()?.crlf).toBe(false);
    manager.openTab("b.md", { text: "B", encoding: "UTF-8", bom: true, crlf: true });
    expect(manager.activeTab()?.bom).toBe(true);
    expect(manager.activeTab()?.crlf).toBe(true);
  });

  it("切走保存编辑器态、切回恢复；同路径重开作废旧态", () => {
    const { manager, saveState, loadState } = setupTabs();
    manager.openTab("a.md", { text: "A", encoding: "UTF-8" });
    manager.openTab("b.md", { text: "B", encoding: "UTF-8" });
    expect(saveState).toHaveBeenCalled(); // 离开 a 时把编辑器态存回 a
    expect(loadState).toHaveBeenLastCalledWith(null); // b 从未进过编辑态
    manager.activateTab("a.md");
    expect(loadState).toHaveBeenLastCalledWith(expect.objectContaining({ scrollTop: 42 }));
    manager.openTab("a.md", { text: "刷新", encoding: "UTF-8" }); // 同路径重开
    expect(loadState).toHaveBeenLastCalledWith(null); // 旧编辑器态已作废
  });
});
