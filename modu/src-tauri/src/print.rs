//! PDF 导出（M4 正式化）。
//! 单路径 = WebView2 `ICoreWebView2_7::PrintToPdf` 静默直出（D2 裁决；M0 spike-2 已验证 hr=0）。
//! 正式入口：`pick_save_path`（Rust 侧保存对话框）→ `export_pdf`（A4 + 背景，直出用户路径）。
//! spike 命令（spike_log / spike_print_pdf）保留作占位对照，勿删。

use std::sync::mpsc;

use tauri::Manager;
use tauri_plugin_dialog::DialogExt;
use webview2_com::Microsoft::Web::WebView2::Win32::{
    ICoreWebView2, ICoreWebView2Environment6, ICoreWebView2PrintSettings,
    ICoreWebView2PrintToPdfCompletedHandler, ICoreWebView2PrintToPdfCompletedHandler_Impl,
    ICoreWebView2_2, ICoreWebView2_7,
};
use windows_core::{implement, Interface, PCWSTR};

/// 打印回调等待上限（PrintToPdf 对大文档也远快于此；超时视为引擎卡死）
const PRINT_TIMEOUT_SECS: u64 = 90;

/// PDF 页脚（页码）总开关（用户反馈批次：只要页码不要页眉）。
/// 宪法红线：禁 @page margin-box（Chromium 从未实现），页码只能走 WebView2
/// PrintSettings 原生页眉页脚。查证结论（webview2-com-sys 0.38.2 本地绑定
/// 全文核实 + MS Learn 文档双源）：
/// - ICoreWebView2PrintSettings 系只有 **_1/_2 两个版本**（bindings.rs：
///   ICoreWebView2PrintSettings + ICoreWebView2PrintSettings2，无 _3..N）；
/// - 页眉页脚**无分离开关**：仅 ShouldPrintHeaderAndFooter 一个总闸（默认
///   false，置 true 则页眉页脚一并开启，各高 0.5cm）；_2 新增的是
///   PageRanges/PagesPerSide/Copies/Collation/ColorMode/Duplex/MediaSize 等
///   打印机档位，与页眉页脚无关；
/// - 平台限制与取舍：用户要「去页眉留页码」，总闸一关页码也没了，故保持
///   开启并退而求其次——HeaderTitle 置空串（页眉只剩打印日期，文档名撤下；
///   此前是日期+文档名）、FooterUri 置空串（页脚只剩页码，无 URI）。
///   若样张目检连日期都不想要：现无 API 可单独去日期，只能整闸关闭（页码
///   一并消失），属 WebView2 平台能力边界，等上游出分离开关再升级。 */
const PRINT_HEADER_AND_FOOTER: bool = true;

/// 前端把结果回传 stdout（自动化采集用）
#[tauri::command]
pub fn spike_log(msg: String) {
    println!("[spike-js] {msg}");
}

#[implement(ICoreWebView2PrintToPdfCompletedHandler)]
struct SpikePrintDone {
    tx: mpsc::Sender<String>,
}

impl ICoreWebView2PrintToPdfCompletedHandler_Impl for SpikePrintDone_Impl {
    fn Invoke(
        &self,
        errorcode: windows_core::HRESULT,
        result: windows_core::BOOL,
    ) -> windows_core::Result<()> {
        let msg = format!(
            "PrintToPdf 回调: hr={errorcode:?}, success={}",
            result.as_bool()
        );
        let _ = self.tx.send(msg);
        Ok(())
    }
}

/// COM 调用链（必须在 UI 线程执行，由 with_webview 闭包调用）
/// path16：以 NUL 结尾的 UTF-16 路径（Vec 可跨线程送入闭包，PCWSTR 裸指针不可）
unsafe fn run_com_chain(core: ICoreWebView2, path16: Vec<u16>, tx: mpsc::Sender<String>) {
    let pdf_pw = PCWSTR::from_raw(path16.as_ptr());
    macro_rules! bail {
        ($step:expr, $e:expr) => {{
            let _ = tx.send(format!("[error] {}: {}", $step, $e));
            return;
        }};
    }
    let wv7 = match core.cast::<ICoreWebView2_7>() {
        Ok(w) => w,
        Err(e) => bail!("cast ICoreWebView2_7", e),
    };
    let wv2 = match core.cast::<ICoreWebView2_2>() {
        Ok(w) => w,
        Err(e) => bail!("cast ICoreWebView2_2", e),
    };
    let env6 = match wv2
        .Environment()
        .and_then(|env| env.cast::<ICoreWebView2Environment6>())
    {
        Ok(e) => e,
        Err(e) => bail!("Environment→cast ICoreWebView2Environment6", e),
    };
    let settings: ICoreWebView2PrintSettings = match env6.CreatePrintSettings() {
        Ok(s) => s,
        Err(e) => bail!("CreatePrintSettings", e),
    };
    if let Err(e) = settings.SetPageWidth(8.27) {
        bail!("SetPageWidth", e);
    }
    if let Err(e) = settings.SetPageHeight(11.69) {
        bail!("SetPageHeight", e);
    }
    if let Err(e) = settings.SetShouldPrintBackgrounds(true) {
        bail!("SetShouldPrintBackgrounds", e);
    }
    let handler: ICoreWebView2PrintToPdfCompletedHandler = SpikePrintDone { tx }.into();
    match wv7.PrintToPdf(pdf_pw, &settings, &handler) {
        Ok(()) => println!("[spike-rs] PrintToPdf 已提交，等待回调…"),
        Err(e) => println!("[spike-rs] PrintToPdf 调用报错: {e}"),
    }
}

/// spike-2 主命令：A4 纵向、带背景，输出到 %TEMP%\modu-spike-print.pdf
#[tauri::command]
pub async fn spike_print_pdf(app: tauri::AppHandle) -> Result<String, String> {
    let window = app
        .get_webview_window("main")
        .ok_or_else(|| "找不到主窗口".to_string())?;
    let pdf = std::env::temp_dir().join("modu-spike-print.pdf");
    let _ = std::fs::remove_file(&pdf);
    let path16: Vec<u16> = std::os::windows::ffi::OsStrExt::encode_wide(pdf.as_os_str())
        .chain(std::iter::once(0))
        .collect();
    let shown_path = pdf.to_string_lossy().to_string();

    let (tx, rx) = mpsc::channel::<String>();
    window
        .with_webview(move |webview| unsafe {
            match webview.controller().CoreWebView2() {
                Ok(core) => run_com_chain(core, path16, tx),
                Err(e) => println!("[spike-rs] 拿 CoreWebView2 失败: {e}"),
            }
        })
        .map_err(|e| format!("with_webview: {e}"))?;

    let waited = tauri::async_runtime::spawn_blocking(move || {
        rx.recv_timeout(std::time::Duration::from_secs(90))
    })
    .await
    .map_err(|e| format!("任务 join 失败: {e}"))?
    .map_err(|e| format!("等待回调失败: {e}"))?;

    let exists = pdf.exists();
    let size = std::fs::metadata(&pdf).map(|m| m.len()).unwrap_or(0);
    let head = std::fs::read(&pdf)
        .map(|b| {
            b[..b.len().min(8)]
                .iter()
                .map(|x| format!("{x:02X}"))
                .collect::<String>()
        })
        .unwrap_or_else(|_| "读不到".into());
    Ok(format!(
        "{waited}；文件存在={exists}，大小={size}B，头8字节={head}，路径={shown_path}"
    ))
}

/* ---- M4 正式导出 ---- */

/// PrintToPdf 完成回调：hr 成功且 result=true 才算落盘成功
#[implement(ICoreWebView2PrintToPdfCompletedHandler)]
struct ExportPdfDone {
    tx: mpsc::Sender<Result<(), String>>,
}

impl ICoreWebView2PrintToPdfCompletedHandler_Impl for ExportPdfDone_Impl {
    fn Invoke(
        &self,
        errorcode: windows_core::HRESULT,
        result: windows_core::BOOL,
    ) -> windows_core::Result<()> {
        let verdict = if errorcode.is_ok() && result.as_bool() {
            Ok(())
        } else {
            Err(format!(
                "打印回调未成功：hr={errorcode:?}，success={}",
                result.as_bool()
            ))
        };
        let _ = self.tx.send(verdict);
        Ok(())
    }
}

/// 正式导出的 COM 调用链（UI 线程，with_webview 闭包内）。
/// 物理页 A4 = 210×297mm = 8.27×11.69in（与 spike 验证值一致；11.65 并非真 A4，不采）。
/// ShouldPrintBackgrounds=true 是 print.css「print-color-adjust:exact 颜色保真」的物理前提。
/// 页眉页脚取舍见 PRINT_HEADER_AND_FOOTER 常量注释（无分离开关：留页码、页眉仅剩日期）。
/// CSS 侧版式契约（@page A4/18mm、行级分页）在 src/typography/print.css。
unsafe fn run_export_chain(
    core: ICoreWebView2,
    path16: Vec<u16>,
    tx: mpsc::Sender<Result<(), String>>,
) {
    let pdf_pw = PCWSTR::from_raw(path16.as_ptr());
    macro_rules! bail {
        ($step:expr, $e:expr) => {{
            let _ = tx.send(Err(format!("打印引擎步骤失败——{}：{}", $step, $e)));
            return;
        }};
    }
    let wv7 = match core.cast::<ICoreWebView2_7>() {
        Ok(w) => w,
        Err(e) => bail!("取得 ICoreWebView2_7", e),
    };
    let wv2 = match core.cast::<ICoreWebView2_2>() {
        Ok(w) => w,
        Err(e) => bail!("取得 ICoreWebView2_2", e),
    };
    let env6 = match wv2
        .Environment()
        .and_then(|env| env.cast::<ICoreWebView2Environment6>())
    {
        Ok(e) => e,
        Err(e) => bail!("取得 ICoreWebView2Environment6", e),
    };
    let settings: ICoreWebView2PrintSettings = match env6.CreatePrintSettings() {
        Ok(s) => s,
        Err(e) => bail!("CreatePrintSettings", e),
    };
    if let Err(e) = settings.SetPageWidth(8.27) {
        bail!("SetPageWidth", e);
    }
    if let Err(e) = settings.SetPageHeight(11.69) {
        bail!("SetPageHeight", e);
    }
    if let Err(e) = settings.SetShouldPrintBackgrounds(true) {
        bail!("SetShouldPrintBackgrounds", e);
    }
    if PRINT_HEADER_AND_FOOTER {
        if let Err(e) = settings.SetShouldPrintHeaderAndFooter(true) {
            bail!("SetShouldPrintHeaderAndFooter", e);
        }
        // 空串 FooterUri = 页脚不带 URI、只剩页码（查证结论见常量注释）
        if let Err(e) = settings.SetFooterUri(&windows_core::HSTRING::from("")) {
            bail!("SetFooterUri", e);
        }
        // 空串 HeaderTitle = 页眉撤下文档名、只剩打印日期（用户反馈批次：
        // 只要页码不要页眉；无分离开关，见常量注释的平台限制与取舍）
        if let Err(e) = settings.SetHeaderTitle(&windows_core::HSTRING::from("")) {
            bail!("SetHeaderTitle", e);
        }
    }
    let handler: ICoreWebView2PrintToPdfCompletedHandler = ExportPdfDone { tx }.into();
    if let Err(e) = wv7.PrintToPdf(pdf_pw, &settings, &handler) {
        // tx 已随 handler 移交：提交失败时通道随 handler 析构而关闭，
        // 外层 recv 立即收到 Disconnected 转成错误返回，不会悬挂。
        println!("[export] PrintToPdf 提交失败: {e}");
    }
}

/// 导出 PDF 到指定路径（pick_save_path 的产物）。成功返回中文结果（含字节数）。
#[tauri::command]
pub async fn export_pdf(app: tauri::AppHandle, path: String) -> Result<String, String> {
    if path.trim().is_empty() {
        return Err("导出路径为空".into());
    }
    let pdf = std::path::PathBuf::from(&path);
    // 覆盖语义已由保存对话框确认；先清旧文件，避免引擎对已存在目标行为不定
    let _ = std::fs::remove_file(&pdf);
    let path16: Vec<u16> = std::os::windows::ffi::OsStrExt::encode_wide(pdf.as_os_str())
        .chain(std::iter::once(0))
        .collect();

    let window = app
        .get_webview_window("main")
        .ok_or_else(|| "找不到主窗口".to_string())?;
    let (tx, rx) = mpsc::channel::<Result<(), String>>();
    window
        .with_webview(move |webview| unsafe {
            match webview.controller().CoreWebView2() {
                Ok(core) => run_export_chain(core, path16, tx),
                Err(e) => {
                    let _ = tx.send(Err(format!("取得 WebView2 失败：{e}")));
                }
            }
        })
        .map_err(|e| format!("进入 WebView 失败：{e}"))?;

    let verdict = tauri::async_runtime::spawn_blocking(move || {
        rx.recv_timeout(std::time::Duration::from_secs(PRINT_TIMEOUT_SECS))
    })
    .await
    .map_err(|e| format!("导出任务失败：{e}"))?
    .map_err(|_| format!("导出超时：打印引擎 {PRINT_TIMEOUT_SECS} 秒内未返回"))?;
    verdict?;

    let size = std::fs::metadata(&pdf)
        .map(|m| m.len())
        .map_err(|e| format!("读取导出结果失败：{e}"))?;
    if size == 0 {
        return Err("导出失败：PDF 是空文件".into());
    }
    let kb = size.div_ceil(1024); // 向上取整，避免 1B 显示 0 KB
    Ok(format!("已导出（{kb} KB）"))
}

/// 系统保存对话框（Rust 侧）。返回 None = 用户取消。
///
/// blocking 查证结论（tauri-plugin-dialog 官方文档，v2）：
/// `blocking_save_file` 等 blocking_* 系列会阻塞调用线程直到对话框关闭，文档明确
/// **不得在主线程调用**（macOS 上主线程阻塞违反 AppKit 规则、会死锁；Windows 上也会
/// 卡住事件循环），要求放在独立线程执行。规范上下文即 `spawn_blocking`
/// （tauri::async_runtime 的 tokio 阻塞线程池）——异步命令本体虽不在主线程，
/// 直接 block 也会占死一个执行器线程，故统一包进 spawn_blocking。
#[tauri::command]
pub async fn pick_save_path(
    app: tauri::AppHandle,
    default_name: String,
) -> Result<Option<String>, String> {
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
    .map_err(|e| format!("打开保存对话框失败：{e}"))?;
    Ok(picked.and_then(|file| {
        // FilePath 可能是 Path 或 Url（沙箱校验统一走 into_path）
        file.into_path()
            .ok()
            .map(|p| p.to_string_lossy().into_owned())
    }))
}
