/**
 * 导出 PDF（M4 接线，2026-11-02 从 main.ts 外移：main.ts 行数棘轮已到 707 硬上限）。
 *
 * 流程：切回阅读态 → 清纸面缩放 / 临时亮色重渲 mermaid → 等渲染完备 → 宽表标记 →
 * 存路径（票据制）→ CDP `Page.printToPDF` 直出。正文渲染与打印逻辑分别留在
 * render/print-ready 与 Rust print.rs —— 本模块只做接线与失败提示。
 *
 * 外移契约：本模块不碰 main.ts 的模块级状态，改动全部经 `ExportDeps` 注入；
 * 失败提示、导出冻结层（html.exporting）与主题还原语义与拆前逐字一致。
 */
import { invoke } from "@tauri-apps/api/core";
import { awaitPrintReady, markPrintBlocks } from "../render/print-ready";
import { refreshMermaidTheme } from "../render/view";
import { clearPaperZoom, restorePaperZoom } from "../app/zoom";
import { readThemePref, resolvedTheme } from "../ui/theme";
import { flashStatus, type EditSession } from "../editor/editor";
import type { TabManager } from "../app/tabs";

/** 接线依赖：查找条关闭、编辑会话读取都由 main.ts 注入（本模块不背模块级状态）。 */
export interface ExportDeps {
  /** 查找条关闭（查找 mark 不进 PDF）；无查找条时为空操作 */
  closeFindbar: () => void;
  /** 当前编辑会话（编辑态导出前先切回阅读态）；无会话时返回 null */
  getEditor: () => EditSession | null;
}

/** 默认存档名：当前文件名去 .md/.markdown 扩展 + .pdf */
export function defaultPdfName(path: string): string {
  const name = path.split(/[\\/]/).pop() ?? "";
  const stem = name.replace(/\.(md|markdown)$/i, "");
  return `${stem === "" ? "文档" : stem}.pdf`;
}

interface SaveResult {
  path: string | null;
  ticket: number | null;
}

/** 导出当前标签为 PDF（⇩ 按钮与 Ctrl+P 共用）。 */
export async function exportActivePdf(tabs: TabManager, deps: ExportDeps): Promise<void> {
  deps.closeFindbar(); // P5 批2：查找 mark 不进 PDF
  const tab = tabs.activeTab();
  if (tab === null) {
    return; // 无文档：按钮本应禁用，双保险
  }
  const editor = deps.getEditor();
  if (editor?.isEditing() === true) {
    editor.toRead(); // beta 席 D2 条款：编辑态导出先切回阅读态（含重渲正文）
  }
  const doc = document.getElementById("doc");
  if (doc === null) {
    return;
  }
  // C1+C4 导出版式归一：暗色近白不可读、纸面缩放让量宽漂移 ⇒ 清纸面缩放、临时切亮色重渲
  // mermaid，finally 无条件还原。H 静默化：冻结层与归一同一同步块；F6（fix-22）：冻结/变亮/
  // 重渲三行在 try 内，refreshMermaidTheme 抛异常时 finally 仍揭幕还原。
  // J2（2026-09-30）：缩放目标从根元素换成纸面（#doc/.cm-editor）——清空/还原语义不变，
  // 持久化档位即「保存值」，restorePaperZoom 按它重投。
  const savedThemePref = readThemePref(); // 权威来源（theme.ts），不自己摸 localStorage
  clearPaperZoom();
  try {
    document.documentElement.classList.add("exporting"); // 与下行同一同步块：先遮屏再变亮，中间不得有异步断点
    document.documentElement.dataset.theme = "light"; // 不落盘：崩溃后偏好不被改成亮色
    refreshMermaidTheme("light");
    const failed = doc.querySelectorAll(".mermaid[data-mmd-error]").length;
    if (failed > 0) {
      flashStatus(`有 ${failed} 张图渲染失败，将按占位导出`, "warn"); // 告警不阻断（P5 批2）
    }
    const ready = await awaitPrintReady(doc);
    if (ready.timedOut) {
      flashStatus("部分图表未渲染完成，将按当前版式导出", "warn");
    }
    // P1-4 补：字体/图片没在时限内就绪时提示（此前只有 mermaid 有等待与提示）
    if (ready.fontsTimedOut) {
      flashStatus("字体加载超时，部分字形可能按回退字体导出", "warn");
    } else if (ready.imageFailures.length > 0) {
      flashStatus(`有 ${ready.imageFailures.length} 张图片未就绪，将按当前版式导出`, "warn");
    }
    // P1-4(b)+宽表：竖版放不下的表自动横排，连横版都放不下再压列换行（用户裁决 ④）。
    // 「可能被截」提醒已撤：压列不丢列、图片限宽、pre 换行 ⇒ 无静默丢内容，留着就是撒谎。
    markPrintBlocks(doc);
    // 票据制（P0 安全修复 B1）：pick_save_path 返回 {path, ticket}，export_pdf 只认 ticket ⇒ 渲染层无法指定任意写入路径。
    let saveResult: SaveResult;
    try {
      saveResult = await invoke<SaveResult>("pick_save_path", {
        defaultName: defaultPdfName(tab.path),
      });
    } catch (error) {
      flashStatus(`导出失败：${String(error)}`, "error");
      return;
    }
    if (saveResult.path === null || saveResult.path === "" || saveResult.ticket === null) {
      return; // 用户取消：静默结束
    }
    try {
      // 页眉已按平台限制取舍清空（用户反馈批次：PDF 只要页码不要页眉，print.rs 查证注释）
      flashStatus(await invoke<string>("export_pdf", { ticket: saveResult.ticket }), "ok");
    } catch (error) {
      flashStatus(`导出失败：${String(error)}`, "error");
    }
  } finally {
    const restored = resolvedTheme(savedThemePref); // auto 档解析回系统值
    document.documentElement.dataset.theme = restored;
    refreshMermaidTheme(restored);
    restorePaperZoom(); // J2：纸面缩放还原（旧根 zoom 时代的 style.zoom = savedZoom 已退役）
    document.documentElement.classList.remove("exporting"); // 揭幕放最后：先还原主题后揭幕，同一同步块（顺序反了会闪亮）
  }
}
