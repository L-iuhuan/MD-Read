pub mod fs;
mod print;
mod single;

use std::sync::Mutex;
use tauri::{Emitter, Manager, State};

/// 启动参数携带的待打开文件。前端就绪后经 `take_pending_file` 取走——
/// 消除 setup 阶段 emit 早于前端监听器就绪的竞态（Lane C 遗留 #1 的兜底）。
struct PendingFile(Mutex<Option<String>>);

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        // single-instance 必须第一个注册（见 single.rs 注释）
        .plugin(single::init())
        .plugin(tauri_plugin_dialog::init())
        .invoke_handler(tauri::generate_handler![
            fs::read_file,
            fs::save_file,
            take_pending_file,
            print::spike_log,
            print::spike_print_pdf
        ])
        .setup(|app| {
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
