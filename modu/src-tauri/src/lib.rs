pub mod fs;
mod print;
mod single;

use std::sync::Mutex;
use tauri::{Emitter, Manager, State};
use webview2_com::Microsoft::Web::WebView2::Win32::{
    ICoreWebView2, ICoreWebView2NavigationStartingEventArgs,
    ICoreWebView2NavigationStartingEventHandler, ICoreWebView2NavigationStartingEventHandler_Impl,
};
use windows_core::{implement, PWSTR};

/// 启动参数携带的待打开文件。前端就绪后经 `take_pending_file` 取走——
/// 消除 setup 阶段 emit 早于前端监听器就绪的竞态（Lane C 遗留 #1 的兜底）。
struct PendingFile(Mutex<Option<String>>);

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        // single-instance 必须第一个注册（见 single.rs 注释）
        .plugin(single::init())
        .plugin(tauri_plugin_dialog::init())
        // 外链交系统浏览器（P5 批1·P0 #1）：渲染层 links.ts 拦截后经此插件打开
        .plugin(tauri_plugin_opener::init())
        .invoke_handler(tauri::generate_handler![
            fs::read_file,
            fs::save_file,
            take_pending_file,
            print::spike_log,
            print::spike_print_pdf,
            print::export_pdf,
            print::pick_save_path
        ])
        .setup(|app| {
            attach_nav_guard(app); // 整窗导航兜底：趁启动挂上 WebView2 事件（见函数注释）
            let pending = md_arg();
            app.manage(PendingFile(Mutex::new(pending.clone())));
            // 事件照发（供未来多标签等场景）；竞态由 take_pending_file 兜底
            if let Some(path) = pending {
                app.emit("open-file", path)?;
            }
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

/// 取走启动参数携带的 .md 路径（一次性消费）。
#[tauri::command]
fn take_pending_file(state: State<PendingFile>) -> Option<String> {
    match state.0.lock() {
        Ok(mut guard) => guard.take(),
        Err(_) => None,
    }
}

/// 取命令行参数中第一个 .md 文件路径（跳过 exe 自身；扩展名大小写不敏感）。
fn md_arg() -> Option<String> {
    std::env::args()
        .skip(1)
        .find(|arg| arg.to_lowercase().ends_with(".md"))
}

/// 导航兜底（P5 批1·P0 #2）。查证结论：Tauri 2 的 `on_navigation` 只存在于
/// `WebviewWindowBuilder`，config 声明的主窗口无法事后挂回调（无运行时 API）；
/// setup 内「destroy + 同标签重建」实测撞 `a webview with label main already exists`
/// （destroy 异步销毁，注册表未及清理），换标签则牵连 print.rs 的
/// `get_webview_window("main")`。故改挂 WebView2 原生 NavigationStarting 事件：
/// 仅放行 devUrl 与 tauri 内部协议，其余整窗导航一律取消——
/// 「点击外链整窗被导航走」的最后防线（渲染层 links.ts 为第一道）。
fn attach_nav_guard(app: &tauri::App) {
    let Some(window) = app.get_webview_window("main") else {
        return; // 无 main 窗口：无可挂对象，渲染层拦截仍在
    };
    // 放行清单：生产前端（Windows 映射为 http://tauri.localhost）、asset 协议（相对图）、
    // IPC；开发期另放行 devUrl（如 http://localhost:1420）
    let mut allowed_sites: Vec<String> = vec![
        "http://tauri.localhost".into(),
        "tauri://localhost".into(),
        "http://asset.localhost".into(),
        "asset://localhost".into(),
        "http://ipc.localhost".into(),
        "ipc://localhost".into(),
    ];
    if let Some(dev) = &app.config().build.dev_url {
        allowed_sites.push(dev.origin().ascii_serialization());
    }
    let outcome = window.with_webview(move |webview| unsafe {
        let core = match webview.controller().CoreWebView2() {
            Ok(core) => core,
            Err(error) => {
                eprintln!("[nav-guard] 拿 CoreWebView2 失败，兜底未挂上：{error}");
                return;
            }
        };
        let handler: ICoreWebView2NavigationStartingEventHandler =
            NavGuard { allowed_sites }.into();
        let mut token: i64 = 0;
        if let Err(error) = core.add_NavigationStarting(&handler, &mut token) {
            eprintln!("[nav-guard] 事件注册失败，兜底未挂上：{error}");
        }
    });
    if let Err(error) = outcome {
        eprintln!("[nav-guard] with_webview 失败，兜底未挂上：{error}");
    }
}

/// 导航拦截器：URI 不在放行清单 → SetCancel(true) 取消导航
#[implement(ICoreWebView2NavigationStartingEventHandler)]
struct NavGuard {
    /// 放行站点（scheme://host[:port] 形态，无尾斜杠）
    allowed_sites: Vec<String>,
}

impl ICoreWebView2NavigationStartingEventHandler_Impl for NavGuard_Impl {
    fn Invoke(
        &self,
        _sender: windows_core::Ref<'_, ICoreWebView2>,
        args: windows_core::Ref<'_, ICoreWebView2NavigationStartingEventArgs>,
    ) -> windows_core::Result<()> {
        let args = match args.ok() {
            Ok(args) => args,
            Err(_) => return Ok(()), // 事件参数缺席：无从判定（理论不可达）
        };
        let uri = read_uri(args)?;
        let pass = uri.starts_with("about:") // WebView2 内部空白页
            || self.allowed_sites.iter().any(|site| {
                // 站点串后必须跟 / 或恰好相等：防 http://tauri.localhost.evil.com 前缀碰瓷
                uri == *site || uri.starts_with(&format!("{site}/"))
            });
        if !pass {
            unsafe { args.SetCancel(true)? }; // true = 取消本次整窗导航
            eprintln!("[nav-guard] 已拦截整窗导航：{uri}");
        }
        Ok(())
    }
}

/// 读事件 Uri；字符串由 WebView2 分配，读完即释放（windows-core 内部同款 imp::CoTaskMemFree）
fn read_uri(args: &ICoreWebView2NavigationStartingEventArgs) -> windows_core::Result<String> {
    unsafe {
        let mut raw = PWSTR::null();
        args.Uri(&mut raw)?;
        let text = raw.to_string().unwrap_or_default();
        windows_core::imp::CoTaskMemFree(raw.as_ptr() as *const std::ffi::c_void);
        Ok(text)
    }
}
