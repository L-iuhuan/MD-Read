//! PDF 导出（M4 正式化；D-20 第二步换载体）。
//! 单路径 = CDP `Page.printToPDF`（`ICoreWebView2::CallDevToolsProtocolMethod`）静默直出：
//! **同一条 Chromium 打印管线，只换了 API 入口**——无对话框、无 `window.print` 的实质约束不变。
//! 换载体的原因：`ICoreWebView2PrintSettings` 的页眉页脚没有分离开关（四者共享一个布尔），
//! 而 CDP 模板可以「`headerTemplate` 置空 = 彻底无页眉 / `footerTemplate` 只放 pageNumber
//! = 只有页码」（见 `cdp.rs`），用户要的「去页眉日期、只留中式页码」由此达成。
//!
//! 红线（Print Studio 尸检）：禁 `@page` margin-box —— **历史上 Chromium 未实现，131+ 已支持；
//! 但本项目经评审决定不使用**（理由：保持打印契约的单一覆盖层，并与 WebView2 `PrintSettings`
//! 的行为一致）。本项目的页码不走 margin-box，走 CDP `footerTemplate`。
//!
//! 正式入口：`pick_save_path`（Rust 侧保存对话框）→ `export_pdf`（A4 + 背景，原子落到用户路径）。
//! spike 命令（spike_log / spike_print_pdf）保留作占位对照，勿删；两者与正式导出同走 CDP 单路径。

mod cdp;

use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::mpsc;
use std::sync::Mutex;

use tauri::Manager;
use tauri_plugin_dialog::DialogExt;

/// 打印回调等待上限（CDP 打多页大文档也远快于此；超时视为引擎卡死）
const PRINT_TIMEOUT_SECS: u64 = 90;

/// ⭐ 导出路径票据（P0 安全修复，2026-09-26 综合审查 B1）：
/// `export_pdf` 原先接受渲染层传入的任意路径——被攻陷的渲染层可覆盖任意用户可写文件
/// （信任模型旁路：渲染层"不能写任意路径"的宪法承诺被打破）。
/// 修复采用 consume-the-picked-ticket 模式：
/// · `pick_save_path`（Rust 侧对话框）返回路径的**同时**在进程内登记一张一次性票据；
/// · `export_pdf` 只消费票据（`ticket: u64`），**不接受路径参数**——渲染层伪造不了票据；
/// · 每张票据只可消费一次（重放无效），30 秒未消费自动过期（防囤积）。
static EXPORT_TICKETS: Mutex<Vec<(u64, PathBuf, std::time::Instant)>> = Mutex::new(Vec::new());
static TICKET_SEQ: AtomicU64 = AtomicU64::new(1);
const TICKET_TTL: std::time::Duration = std::time::Duration::from_secs(30);

/// 签发一张导出票据（pick_save_path 专用，不暴露为命令）。
fn issue_ticket(path: &Path) -> u64 {
    let id = TICKET_SEQ.fetch_add(1, Ordering::Relaxed);
    if let Ok(mut tickets) = EXPORT_TICKETS.lock() {
        tickets.retain(|(_, _, at)| at.elapsed() < TICKET_TTL); // 顺手清过期
        tickets.push((id, path.to_path_buf(), std::time::Instant::now()));
    }
    id
}

/// 消费一张导出票据：有效则返回对应路径（一次性），无效/过期/不存在返回 None。
fn consume_ticket(id: u64) -> Option<PathBuf> {
    EXPORT_TICKETS
        .lock()
        .ok()
        .and_then(|mut tickets| {
            let now = std::time::Instant::now();
            let pos = tickets
                .iter()
                .position(|(tid, _, at)| *tid == id && now.duration_since(*at) < TICKET_TTL);
            pos.map(|i| tickets.remove(i)).map(|(_, path, _)| path)
        })
}

/// 前端把结果回传 stdout（自动化采集用）
#[tauri::command]
pub fn spike_log(msg: String) {
    println!("[spike-js] {msg}");
}

/* ---- spike（占位对照，与正式导出同一条 CDP 链，无第二套打印实现）---- */

/// spike-2 主命令：A4 纵向、带背景，输出到 %TEMP%\modu-spike-print.pdf
#[tauri::command]
pub async fn spike_print_pdf(app: tauri::AppHandle) -> Result<String, String> {
    let pdf = std::env::temp_dir().join("modu-spike-print.pdf");
    let _ = std::fs::remove_file(&pdf);
    let shown_path = pdf.to_string_lossy().to_string();
    match request_cdp_pdf(&app).await? {
        Err(e) => Ok(format!("Page.printToPDF 回调失败：{e}；路径={shown_path}")),
        Ok(bytes) => {
            let size = bytes.len();
            std::fs::write(&pdf, &bytes).map_err(|e| format!("写临时 PDF 失败：{}", crate::fs::io_reason(&e)))?;
            let head = bytes[..bytes.len().min(8)]
                .iter()
                .map(|b| format!("{b:02X}"))
                .collect::<String>();
            Ok(format!(
                "Page.printToPDF 回调数据已落盘；文件存在={}，大小={size}B，头8字节={head}，路径={shown_path}",
                pdf.exists()
            ))
        }
    }
}

/* ---- M4 正式导出 ---- */

/// 提交 CDP `Page.printToPDF` 并等回包数据。双层 Result：
/// 外层=调用链没跑起来（找不到窗口/进不了 WebView/任务失败），内层=打印引擎的判定。
/// 内层 Err 不在这里 `?`，而是原样交给 finish_export 决定提交或回滚（P0-8 语义）。
async fn request_cdp_pdf(app: &tauri::AppHandle) -> Result<Result<Vec<u8>, String>, String> {
    let window = app
        .get_webview_window("main")
        .ok_or_else(|| "找不到主窗口".to_string())?;
    let (tx, rx) = mpsc::channel::<Result<Vec<u8>, String>>();
    window
        .with_webview(move |webview| unsafe {
            match webview.controller().CoreWebView2() {
                Ok(core) => cdp::run_cdp_chain(core, tx),
                Err(e) => {
                    let _ = tx.send(Err(format!("取得 WebView2 失败：{}", e)));
                }
            }
        })
        .map_err(|e| format!("进入 WebView 失败：{}", e))?;
    let waited = tauri::async_runtime::spawn_blocking(move || {
        rx.recv_timeout(std::time::Duration::from_secs(PRINT_TIMEOUT_SECS))
    })
    .await
    .map_err(|e| format!("导出任务失败：{}", e))?;
    Ok(waited.unwrap_or_else(|_| {
        Err(format!("导出超时：打印引擎 {PRINT_TIMEOUT_SECS} 秒内未返回"))
    }))
}

/// 临时 PDF 路径计数器：同进程内并发/连续导出的去重因子（配合进程 id 与时钟纳秒）。
static TEMP_SEQ: AtomicU64 = AtomicU64::new(0);

/// 导出写入的临时文件路径：与目标**同目录**（同卷 → 收尾的改名才是原子替换，不跨卷复制）。
/// 命名 `<主名>.tmp-<pid>-<纳秒>-<序号>.<扩展名>`：每次调用都不同（重复导出不互相覆盖），
/// 扩展名沿用目标扩展名（缺省 pdf），故引擎仍按 PDF 落盘。
fn temp_export_path(dest: &Path) -> PathBuf {
    let nanos = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.subsec_nanos())
        .unwrap_or(0);
    let seq = TEMP_SEQ.fetch_add(1, Ordering::Relaxed);
    let stem = dest
        .file_stem()
        .map(|s| s.to_string_lossy().into_owned())
        .unwrap_or_else(|| "export".to_string());
    let ext = dest
        .extension()
        .map(|s| s.to_string_lossy().into_owned())
        .unwrap_or_else(|| "pdf".to_string());
    let name = format!("{stem}.tmp-{}-{nanos}-{seq}.{ext}", std::process::id());
    dest.with_file_name(name)
}

/// 覆盖式改名（收尾提交）。查证结论（Windows / Rust 1.98.1，本机实测 + rust-src 源码核实）：
/// `std::fs::rename` 底层为 `MoveFileExW(.., MOVEFILE_REPLACE_EXISTING)`，**可以覆盖已存在
/// 的文件**（`std::fs::rename` 文档 Platform-specific behavior 对 Windows 亦如此说明），
/// 语义与 `ReplaceFileW` 在本场景等价——故不需要 `ReplaceFileW`（其事务性/ACL 继承/
/// 元数据保留语义此处用不上）。单测 `windows_rename_overwrites_existing_destination` 钉住该行为。
fn replace_file(src: &Path, dest: &Path) -> std::io::Result<()> {
    std::fs::rename(src, dest)
}

/// 删除导出残留的临时文件（失败路径只删自己的临时产物）。
fn cleanup_temp(temp: &Path) {
    let _ = std::fs::remove_file(temp);
}

/// 导出失败时的回滚：只清理临时文件，目标路径**一个字节都不动**（P0-8 数据丢失修复）。
fn rollback_export(temp: &Path, err: String) -> Result<String, String> {
    cleanup_temp(temp);
    Err(format!("{err}（已保留原文件，未覆盖）"))
}

/// CDP 回包解码出的字节落进同目录临时文件。
/// 与旧路径的差别：那时引擎自己写文件，现在文件由本进程写——写失败同样只清临时产物。
fn write_temp(temp: &Path, bytes: &[u8]) -> Result<(), String> {
    std::fs::write(temp, bytes).map_err(|e| format!("导出失败：无法写入临时文件（{}）", crate::fs::io_reason(&e)))
}

/// 临时产物收尾（可在无 WebView2 环境下直接测试）：
/// - 提交后按目标真实大小返回结果；大小为 0 视为失败并回滚；
/// - 打印失败/超时/取消/提交改名失败同样只清理临时文件，绝不删目标。
fn finish_export(temp: &Path, dest: &Path, verdict: Result<(), String>) -> Result<String, String> {
    if let Err(e) = verdict {
        return rollback_export(temp, e);
    }
    let size = match std::fs::metadata(temp) {
        Ok(m) => m.len(),
        Err(e) => {
            return rollback_export(temp, format!("导出失败：找不到打印结果：{}", crate::fs::io_reason(&e)));
        }
    };
    if size == 0 {
        return rollback_export(temp, "导出失败：PDF 是空文件".into());
    }
    if let Err(e) = replace_file(temp, dest) {
        let kept = temp.display().to_string();
        eprintln!("[export] 替换目标失败（保留临时文件 {kept}）：{e}");
        return Err(format!("导出失败：无法写入 {}（{e}）", dest.display()));
    }
    let kb = size.div_ceil(1024); // 向上取整，避免 1B 显示 0 KB
    Ok(format!("已导出（{kb} KB）"))
}

/// 导出 PDF（pick_save_path 票据消费制，2026-09-26 安全修复）。
/// ⚠ 签名变更：不再接受 `path: String`——改收 `ticket: u64`（`pick_save_path` 签发的一次性票据），
/// 路径在 Rust 侧由票据取回。被攻陷的渲染层**无法**伪造票据 ⇒ 无法指定任意写入路径。
/// 前端调用方（main.ts 的 onExportClick）已同步改为两步：先 invoke pick_save_path 拿
/// `{path, ticket}`，再 invoke export_pdf 传 ticket。
/// P0-8 语义保留：临时文件→成功才改名替换→失败只清临时（原文件任何路径上都原样保留）。
#[tauri::command]
pub async fn export_pdf(app: tauri::AppHandle, ticket: u64) -> Result<String, String> {
    let dest = consume_ticket(ticket).ok_or_else(|| {
        "导出会话已过期（超过 30 秒），请重新选择保存位置后再试".to_string()
    })?;
    let temp = temp_export_path(&dest);
    cleanup_temp(&temp); // 清掉同名的陈旧残留（正常不命中），确保从零开始写
    let verdict = request_cdp_pdf(&app)
        .await?
        .and_then(|bytes| write_temp(&temp, &bytes));
    finish_export(&temp, &dest, verdict)
}

/// 系统保存对话框（Rust 侧）。返回 `{path, ticket}`（None = 用户取消时 path 为 null）。
/// ⭐ ticket 是一次性导出票据：export_pdf 只认票据不收路径（安全修复 B1）。
///
/// blocking 查证结论（tauri-plugin-dialog 官方文档，v2）：
/// `blocking_save_file` 等 blocking_* 系列会阻塞调用线程直到对话框关闭，文档明确
/// **不得在主线程调用**（macOS 上主线程阻塞违反 AppKit 规则、会死锁；Windows 上也会
/// 卡住事件循环），要求放在独立线程执行。规范上下文即 `spawn_blocking`
/// （tauri::async_runtime 的 tokio 阻塞线程池）——异步命令本体虽不在主线程，
/// 直接 block 也会占死一个执行器线程，故统一包进 spawn_blocking。
#[derive(serde::Serialize)]
pub struct SavePathWithTicket {
    pub path: Option<String>,
    pub ticket: Option<u64>,
}

#[tauri::command]
pub async fn pick_save_path(
    app: tauri::AppHandle,
    default_name: String,
) -> Result<SavePathWithTicket, String> {
    let dialog_app = app.clone();
    let picked = tauri::async_runtime::spawn_blocking(move || {
        dialog_app
            .dialog()
            .file()
            .add_filter("PDF 文件", &["pdf"])
            .set_file_name(default_name)
            .blocking_save_file()
    })
    .await
    .map_err(|e| format!("打开保存对话框失败：{}", e))?;
    match picked.and_then(|file| file.into_path().ok()) {
        Some(path) => {
            let ticket = issue_ticket(&path);
            Ok(SavePathWithTicket {
                path: Some(path.to_string_lossy().into_owned()),
                ticket: Some(ticket),
            })
        }
        None => Ok(SavePathWithTicket { path: None, ticket: None }),
    }
}

#[cfg(test)]
mod print_tests;
