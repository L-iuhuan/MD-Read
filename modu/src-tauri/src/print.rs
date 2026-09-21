//! M0 spike-2：WebView2 `ICoreWebView2_7::PrintToPdf` 静默直出 POC。
//! 验证通过后本文件改造为正式导出命令；失败则留档死因，D2 退回 window.print 路径。

use std::sync::mpsc;

use tauri::Manager;
use webview2_com::Microsoft::Web::WebView2::Win32::{
    ICoreWebView2, ICoreWebView2Environment6, ICoreWebView2PrintSettings,
    ICoreWebView2PrintToPdfCompletedHandler, ICoreWebView2PrintToPdfCompletedHandler_Impl,
    ICoreWebView2_2, ICoreWebView2_7,
};
use windows_core::{implement, Interface, PCWSTR};

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
