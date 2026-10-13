/**
 * 粘贴双通道（编辑增强 B1）。
 * · 图片通道：clipboardData 含**白名单内 MIME**（png/jpg/jpeg/gif/webp，按此
 *   优先序取第一个命中，fix-23 P1-5）→ Rust `save_paste_image` 落到文档所在目录
 *   （受信邻域 / 扩展白名单 / 永不覆盖全在 Rust 侧，A3 裁决 2026-10-12），成功后拿返回的
 *   canonical 绝对路径与文档目录求差得相对引用，光标处插入 `![图片](相对路径)`；
 *   失败走 flashStatus(error)，文档不动。超 4MB 前端先拒（fix-23 P1-2，防 IPC 冻结）。
 * · HTML 通道：无白名单图片且含 text/html → turndown 转 Markdown 作文本插入；
 *   src 为 data: 的 base64 img 直接丢弃（fix-23 P1-1），其余 img 照转；
 *   转换失败静默回退默认纯文本通道（CM 原生粘贴，不吞内容）。
 * · IME 组词期（view.composing）一律放行默认，不拦粘贴。
 * 授权链核实（B1 结论）：新落盘图片**无需**前端补调 allow_asset_paths——回阅读态重渲时
 * mountRendered → resolveRelativeImages 会按引用逐张授权；而 Rust 侧 image_allowed 对
 * 「受信文档邻域内的图片」必过，save_paste_image 的落点恰是文档所在目录（A3 受信校验②）。
 */
import { invoke } from "@tauri-apps/api/core";
import TurndownService from "turndown";
import { EditorSelection, type Extension } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { flashStatus } from "./editor";

/** turndown 单例（模块级：纯配置无状态；标题 ATX、代码围栏、列表 - 与本项目源码风格一致） */
const TURNDOWN = new TurndownService({
  headingStyle: "atx",
  codeBlockStyle: "fenced",
  bulletListMarker: "-",
});

/** P1-1（fix-23）：src 为 data:（base64 内联）的 img 一律丢弃——HTML 粘贴通道
 *  不允许把兆级 base64 串灌进文档。filter 为函数且非 data: img 返回 false ⇒
 *  turndown 继续走内置 img 规则（其余图片照转，转义口径零变化）。 */
TURNDOWN.addRule("dropDataImages", {
  filter: (node: HTMLElement): boolean =>
    node.nodeName === "IMG" &&
    (node.getAttribute("src") ?? "").trim().toLowerCase().startsWith("data:"),
  replacement: (): string => "",
});

/** 相对引用：新图绝对路径（canonical，Windows 带 \\?\ 与反斜杠）剥掉文档目录前缀，
 *  剥不动（形态异常）退整路径；分隔符统一转 /（joinRelativeToDoc 两种分隔符都认）。 */
export function relativeImageRef(imagePath: string, docPath: string): string {
  const image = imagePath.replace(/\\/g, "/");
  const sep = Math.max(docPath.lastIndexOf("/"), docPath.lastIndexOf("\\"));
  if (sep < 0) {
    return image;
  }
  const dirPrefix = docPath.slice(0, sep).replace(/\\/g, "/").toLowerCase() + "/";
  return image.toLowerCase().startsWith(dirPrefix) ? image.slice(dirPrefix.length) : image;
}

/** 光标处插入文本（有选区则替换；光标落插入末尾）。
 *  CRLF 档位归一（D7）：入参文本的换行一律是 \n，这里按 state.lineBreak 转档——
 *  否则 \r\n 文档里会落进字面 \n 字符；光标长度取 toText 后的 Text 长度（\r\n 只计 1 行位）。 */
function insertAtCursor(view: EditorView, raw: string): void {
  const { state } = view;
  const text = state.toText(raw.split("\n").join(state.lineBreak));
  const { from, to } = state.selection.main;
  view.dispatch({
    changes: { from, to, insert: text },
    selection: EditorSelection.cursor(from + text.length),
  });
}

/** 图片 MIME 白名单（P1-5，fix-23）：按此**优先序**取第一个命中项——多 MIME
 *  剪贴板（如 emf+png 的 Office 复制）不再「先到先赢」被白名单外格式抢通道；
 *  白名单外（emf/svg 等）不拦，无任何白名单命中则放行默认粘贴。
 *  与 Rust 侧 PASTE_IMAGE_EXTENSIONS（png/jpg/jpeg/gif/webp）同词表。 */
const IMAGE_MIME_PRIORITY: readonly string[] = ["image/png", "image/jpg", "image/jpeg", "image/gif", "image/webp"];

/** 前端尺寸闸（P1-2，fix-23）：Tauri 2.11 brownfield 的 JSON IPC 通道对命名参数
 *  里的字节仍会摊开成数字数组（process-ipc-message-fn.js 的 JSON.stringify
 *  replacer 对 Uint8Array 做 Array.from）——兆级图片会把主线程冻在序列化上。
 *  超过 4MB 直接拒绝并提示压缩（保守防冻结；Rust 侧 20MB 上限不动，双保险）。 */
const MAX_PASTE_BYTES = 4 * 1024 * 1024;

/** 图片通道主体：blob 字节 → Rust 落盘 → 相对引用插入；任何失败只闪错误不碰文档 */
async function saveClipboardImage(view: EditorView, blob: Blob, mime: string, docPath: string): Promise<void> {
  try {
    if (blob.size > MAX_PASTE_BYTES) {
      flashStatus("图片超过 4MB，请先压缩", "error");
      return;
    }
    const bytes = new Uint8Array(await blob.arrayBuffer());
    const ext = mime.slice("image/".length).trim().toLowerCase();
    // 直接传 Uint8Array（P1-2）：不自行 Array.from 摊开数字数组；jsdom 锚断言
    // invoke 收到的是 typed array（见 paste.spec.ts「invoke 契约」）。
    const saved = await invoke<string>("save_paste_image", { bytes, ext, docPath });
    insertAtCursor(view, `![图片](${relativeImageRef(saved, docPath)})`);
  } catch (error) {
    flashStatus(`粘贴图片失败：${error instanceof Error ? error.message : String(error)}`, "error");
  }
}

/** 粘贴双通道扩展。getDocPath：当前文档绝对路径（canonical 形态，随标签走）；
 *  返回 null（无文档）时图片通道放弃，HTML / 纯文本通道不受影响。 */
export function editorPasteHandlers(getDocPath: () => string | null): Extension {
  return EditorView.domEventHandlers({
    paste(event: ClipboardEvent, view: EditorView): boolean {
      if (view.composing) {
        return false; // IME 组词期：放行默认
      }
      const data = event.clipboardData;
      if (data === null) {
        return false;
      }
      const docPath = getDocPath();
      if (docPath !== null) {
        // P1-5：白名单内 MIME 按优先序取第一个命中（emf 等白名单外格式不抢通道）；
        // 无白名单命中（如纯 emf/svg）→ 不拦，落到下方 HTML / 默认纯文本通道。
        const items = Array.from(data.items);
        for (const mime of IMAGE_MIME_PRIORITY) {
          const item = items.find((it) => it.kind === "file" && it.type === mime);
          if (item === undefined) {
            continue;
          }
          const blob = item.getAsFile();
          if (blob === null) {
            continue; // 拿不到字节：试下一优先级 MIME
          }
          event.preventDefault();
          void saveClipboardImage(view, blob, mime, docPath);
          return true;
        }
      }
      const html = data.getData("text/html");
      if (html !== "") {
        try {
          const md = TURNDOWN.turndown(html);
          if (md.trim() !== "") {
            event.preventDefault();
            insertAtCursor(view, md);
            return true;
          }
        } catch {
          // 转换失败：静默回退默认纯文本通道（放行）
        }
      }
      return false;
    },
  });
}
