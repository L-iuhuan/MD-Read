/**
 * 粘贴双通道（编辑增强 B1）：真实 EditorView + 手造 ClipboardEvent（jsdom 的
 * DataTransfer 构造器不可靠，clipboardData 用 defineProperty 挂裸 Event 上）。
 * 覆盖：图片→invoke 参数契约（bytes/ext/docPath）＋相对引用插入；HTML→turndown
 * 转 Markdown 插入；纯文本→不拦截（默认通道）；图片失败→error 闪显且文档不动；
 * relativeImageRef 前缀剥离/回退两形态。
 */
import { invoke } from "@tauri-apps/api/core";
import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { editorPasteHandlers, relativeImageRef } from "../src/editor/paste";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
const invokeMock = vi.mocked(invoke);

/** 文档路径（canonical 形态：Windows \\?\ 前缀 + 反斜杠，与 tab.path 同源） */
const DOC_PATH = "\\\\?\\e:\\docs\\笔记.md";

let host: HTMLElement;
let view: EditorView | null = null;

/** 模拟剪贴板条目（jsdom 无 DataTransferItemList 构造路径） */
interface FakeItem {
  kind: string;
  type: string;
  blob?: Blob;
}

function clipboard(items: FakeItem[], html = ""): DataTransfer {
  return {
    items: items.map((it) => ({
      kind: it.kind,
      type: it.type,
      getAsFile: (): Blob | null => it.blob ?? null,
    })),
    getData: (type: string): string => (type === "text/html" ? html : ""),
  } as unknown as DataTransfer;
}

/** 裸 Event + 挂 clipboardData：CM 的 domEventHandlers 只读这两个面 */
function pasteEvent(data: DataTransfer): Event {
  const ev = new Event("paste", { bubbles: true, cancelable: true });
  Object.defineProperty(ev, "clipboardData", { value: data });
  return ev;
}

function makeView(doc = ""): EditorView {
  view = new EditorView({
    parent: host,
    state: EditorState.create({ doc, extensions: [editorPasteHandlers(() => DOC_PATH)] }),
  });
  return view;
}

const PNG_BYTES = new Uint8Array([0x89, 0x50, 0x4e, 0x47]);
const pngBlob: Blob = {
  type: "image/png",
  arrayBuffer: () => Promise.resolve(PNG_BYTES.buffer as ArrayBuffer),
} as unknown as Blob;

beforeEach(() => {
  document.body.innerHTML = '<div id="st-saved" hidden></div>'; // flashStatus 单槽
  host = document.createElement("div");
  document.body.append(host);
  invokeMock.mockReset();
});

afterEach(() => {
  view?.destroy();
  view = null;
});

describe("图片通道：invoke 契约与相对引用插入", () => {
  it("image/png → save_paste_image(bytes/ext/docPath)，成功后插 ![图片](相对路径)", async () => {
    invokeMock.mockResolvedValue("\\\\?\\e:\\docs\\图片-20261012-120000.png");
    const v = makeView("正文");
    v.contentDOM.dispatchEvent(pasteEvent(clipboard([{ kind: "file", type: "image/png", blob: pngBlob }])));
    await vi.waitFor(() => {
      expect(v.state.sliceDoc()).toContain("![图片](图片-20261012-120000.png)");
    });
    expect(invokeMock).toHaveBeenCalledWith("save_paste_image", {
      bytes: [0x89, 0x50, 0x4e, 0x47],
      ext: "png",
      docPath: DOC_PATH,
    });
  });

  it("image/jpeg 的 ext 从 MIME 剥出小写 jpeg（Rust 白名单同词）", async () => {
    invokeMock.mockResolvedValue("\\\\?\\e:\\docs\\图片-x.jpeg");
    const v = makeView();
    v.contentDOM.dispatchEvent(pasteEvent(clipboard([{ kind: "file", type: "image/jpeg", blob: pngBlob }])));
    await vi.waitFor(() => {
      expect(invokeMock).toHaveBeenCalled();
    });
    expect(invokeMock.mock.calls[0]?.[1]).toMatchObject({ ext: "jpeg", docPath: DOC_PATH });
  });

  it("落盘失败：error 级闪显（6s 档），文档保持不动", async () => {
    invokeMock.mockRejectedValue("不支持的图片格式：svg+xml");
    const v = makeView("原文");
    v.contentDOM.dispatchEvent(pasteEvent(clipboard([{ kind: "file", type: "image/svg+xml", blob: pngBlob }])));
    await vi.waitFor(() => {
      expect(document.getElementById("st-saved")?.textContent).toContain("粘贴图片失败");
    });
    expect(document.getElementById("st-saved")?.className).toBe("st-error");
    expect(v.state.sliceDoc()).toBe("原文");
  });
});

describe("HTML 通道与纯文本回退", () => {
  it("text/html → turndown 转 Markdown 作文本插入（不调 invoke）", () => {
    const v = makeView("前");
    v.contentDOM.dispatchEvent(
      pasteEvent(clipboard([], "<h2>标题乙</h2><p>这是<strong>重点</strong>内容</p>")),
    );
    expect(v.state.sliceDoc()).toContain("## 标题乙");
    expect(v.state.sliceDoc()).toContain("**重点**");
    expect(invokeMock).not.toHaveBeenCalled();
  });

  it("纯文本（无图片无 html）→ 不拦截：文档不变、不调 invoke（默认通道语义）", () => {
    const v = makeView("原");
    v.contentDOM.dispatchEvent(pasteEvent(clipboard([])));
    expect(v.state.sliceDoc()).toBe("原");
    expect(invokeMock).not.toHaveBeenCalled();
  });
});

describe("relativeImageRef：前缀剥离与回退", () => {
  it("文档目录前缀剥离，反斜杠转 /", () => {
    expect(relativeImageRef("\\\\?\\e:\\docs\\sub\\图片-1.png", "\\\\?\\e:\\docs\\笔记.md")).toBe(
      "sub/图片-1.png",
    );
  });

  it("前缀不匹配（形态异常）→ 退整路径（/ 分隔）", () => {
    expect(relativeImageRef("D:\\other\\图片-1.png", "\\\\?\\e:\\docs\\笔记.md")).toBe("D:/other/图片-1.png");
  });
});
