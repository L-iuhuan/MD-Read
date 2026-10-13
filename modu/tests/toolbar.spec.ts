/**
 * 编辑态格式工具栏（编辑增强 B2）——DOM 级锚：插位 / 按钮面 / 缺键隐藏 /
 * 命令分发 / 禁用同步 / 折叠把手 / 卸载不泄漏。
 * 命令全用 fake 记录器：本文件只验「工具栏 → 注册表」的调用面，
 * 不碰 CM 真行为（那是 markdown-commands.spec.ts 的锚）。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { EditorView } from "@codemirror/view";
import { mountEditorToolbar, type EditorToolbarHandle } from "../src/editor/toolbar";

/** 按钮清单的注册表键（与 toolbar.ts 的 ITEMS 表一一对应；改动 = 过评审） */
const ALL_KEYS = [
  "toggleBold",
  "toggleItalic",
  "toggleStrikethrough",
  "toggleInlineCode",
  "toggleLink",
  "toggleHeading1",
  "toggleHeading2",
  "toggleHeading3",
  "toggleTaskItem",
  "toggleBlockquote",
  "insertTable",
  "tidySpacing",
] as const;

type Cmd = (view: EditorView) => boolean;

interface Recorder {
  cmds: Record<string, Cmd>;
  /** 每键的调用轨迹（每次点击 push 一次入参） */
  calls: Record<string, EditorView[]>;
}

function recorder(keys: readonly string[]): Recorder {
  const calls: Record<string, EditorView[]> = {};
  const cmds: Record<string, Cmd> = {};
  for (const key of keys) {
    cmds[key] = (view: EditorView): boolean => {
      (calls[key] ??= []).push(view);
      return true;
    };
  }
  return { cmds, calls };
}

/** 命令参数只被透传（外加读 composing 标志，P1-4），空壳转换即可（不引 CM 真实现） */
function fakeView(composing = false): EditorView {
  return { composing } as unknown as EditorView;
}

let container: HTMLElement;
let handle: EditorToolbarHandle | null = null;

function rootEl(): HTMLElement {
  return container.firstElementChild as HTMLElement;
}

function button(cmd: string): HTMLButtonElement {
  return container.querySelector(`[data-cmd="${cmd}"]`) as HTMLButtonElement;
}

beforeEach(() => {
  document.body.innerHTML = "";
  container = document.createElement("div");
  container.id = "editor-pane";
  container.append(document.createElement("div")); // 占位：模拟先行就位的 .cm-editor
  document.body.append(container);
});

afterEach(() => {
  handle?.unmount();
  handle = null;
  document.body.innerHTML = "";
});

describe("挂载与按钮面", () => {
  it("工具栏是容器首子元素；12 命令钮 + 折叠把手 + 3 条分隔线全部就位", () => {
    const { cmds } = recorder(ALL_KEYS);
    handle = mountEditorToolbar(container, cmds, () => fakeView());
    const root = rootEl();
    expect(root.classList.contains("md-toolbar")).toBe(true);
    expect(root.getAttribute("role")).toBe("toolbar");
    expect(root.querySelectorAll(".md-toolbar-btn")).toHaveLength(12);
    expect(root.querySelector(".md-toolbar-handle")).not.toBeNull();
    expect(root.querySelectorAll(".md-toolbar-sep")).toHaveLength(3);
  });

  it("tooltip = 名称＋快捷键（title 与 aria-label 双写）；无键位的钮只给名称", () => {
    const { cmds } = recorder(ALL_KEYS);
    handle = mountEditorToolbar(container, cmds, () => fakeView());
    const bold = button("toggleBold");
    expect(bold.title).toBe("粗体 Ctrl+B");
    expect(bold.getAttribute("aria-label")).toBe("粗体 Ctrl+B");
    expect(bold.getAttribute("aria-keyshortcuts")).toBe("Control+B");
    expect(button("toggleStrikethrough").title).toBe("删除线 Ctrl+Shift+X");
    expect(button("insertTable").title).toBe("表格"); // A1 无键位：只给名称
  });

  it("注册表缺键 ⇒ 该钮不渲染（B1 契约收窄不崩 UI）", () => {
    const { cmds } = recorder(["toggleBold", "toggleItalic"]);
    handle = mountEditorToolbar(container, cmds, () => fakeView());
    expect(rootEl().querySelectorAll(".md-toolbar-btn")).toHaveLength(2);
    expect(rootEl().querySelector('[data-cmd="insertTable"]')).toBeNull();
    expect(rootEl().querySelectorAll(".md-toolbar-sep")).toHaveLength(0); // 同组不插线
  });
});

describe("命令分发与禁用态", () => {
  it("点击粗体 → 取 view 并调 cmds.toggleBold（命令自 dispatch）", () => {
    const { cmds, calls } = recorder(ALL_KEYS);
    const view = fakeView();
    let fetched = 0;
    handle = mountEditorToolbar(container, cmds, () => {
      fetched += 1;
      return view;
    });
    button("toggleBold").click();
    expect(calls.toggleBold).toHaveLength(1);
    expect(calls.toggleBold?.[0]).toBe(view);
    expect(fetched).toBeGreaterThan(0);
  });

  it("mousedown 一律阻止默认（连续点击不丢编辑器焦点；查找条 ↑↓✕ 同款）", () => {
    const { cmds } = recorder(ALL_KEYS);
    handle = mountEditorToolbar(container, cmds, () => fakeView());
    const event = new MouseEvent("mousedown", { bubbles: true, cancelable: true });
    button("toggleBold").dispatchEvent(event);
    expect(event.defaultPrevented).toBe(true);
  });

  it("P1-4：view.composing（IME 组词期）点击命令钮 → no-op，不发命令", () => {
    const { cmds, calls } = recorder(ALL_KEYS);
    const composingView = fakeView(true); // jsdom 置 composing 标志（真实 CM 为组词态）
    handle = mountEditorToolbar(container, cmds, () => composingView);
    for (const key of ALL_KEYS) {
      button(key).click();
    }
    expect(Object.values(calls).flat()).toHaveLength(0); // 一个命令都不发
    // 组词结束后恢复：composing=false 的 view 照常发
    const idleView = fakeView(false);
    handle.unmount();
    handle = mountEditorToolbar(container, cmds, () => idleView);
    button("toggleBold").click();
    expect(calls.toggleBold).toHaveLength(1);
    expect(calls.toggleBold?.[0]).toBe(idleView);
  });

  it("getView()=null ⇒ 命令钮全 disabled、点不动；恢复后 focusin 重新同步", () => {
    const { cmds, calls } = recorder(ALL_KEYS);
    let view: EditorView | null = null;
    handle = mountEditorToolbar(container, cmds, () => view);
    const buttons = Array.from(container.querySelectorAll<HTMLButtonElement>(".md-toolbar-btn"));
    expect(buttons.every((b) => b.disabled)).toBe(true);
    buttons[0].click();
    expect(Object.values(calls).flat()).toHaveLength(0); // 禁用态不发命令
    const handleBtn = container.querySelector(".md-toolbar-handle") as HTMLButtonElement;
    expect(handleBtn.disabled).toBe(false); // 把手是视图开关，不随命令禁用
    view = fakeView();
    rootEl().dispatchEvent(new Event("focusin"));
    expect(buttons.every((b) => !b.disabled)).toBe(true);
  });
});

describe("折叠把手与卸载", () => {
  it("收起 / 展开：根类、宿主类、aria-expanded、title 四处同步", () => {
    const { cmds } = recorder(ALL_KEYS);
    handle = mountEditorToolbar(container, cmds, () => fakeView());
    const handleBtn = container.querySelector(".md-toolbar-handle") as HTMLButtonElement;
    expect(handleBtn.title).toBe("收起格式工具栏");
    handleBtn.click();
    expect(rootEl().classList.contains("is-collapsed")).toBe(true);
    expect(container.classList.contains("md-toolbar-host--collapsed")).toBe(true);
    expect(handleBtn.getAttribute("aria-expanded")).toBe("false");
    expect(handleBtn.title).toBe("展开格式工具栏");
    handleBtn.click();
    expect(rootEl().classList.contains("is-collapsed")).toBe(false);
    expect(container.classList.contains("md-toolbar-host--collapsed")).toBe(false);
    expect(handleBtn.getAttribute("aria-expanded")).toBe("true");
  });

  it("卸载：无残留、宿主类摘除、document 级监听 add/remove 平衡", () => {
    const addSpy = vi.spyOn(document, "addEventListener");
    const removeSpy = vi.spyOn(document, "removeEventListener");
    const before = { add: addSpy.mock.calls.length, remove: removeSpy.mock.calls.length };
    const h = mountEditorToolbar(container, recorder(ALL_KEYS).cmds, () => fakeView());
    expect(container.querySelector(".md-toolbar")).not.toBeNull();
    h.unmount();
    expect(container.querySelector(".md-toolbar")).toBeNull();
    expect(container.classList.contains("md-toolbar-host")).toBe(false);
    expect(container.children).toHaveLength(1); // 只剩原占位（模拟的 .cm-editor）
    expect(addSpy.mock.calls.length - before.add).toBe(removeSpy.mock.calls.length - before.remove);
    addSpy.mockRestore();
    removeSpy.mockRestore();
  });
});
