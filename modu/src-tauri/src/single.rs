//! 单实例守卫：第二个实例不再开新窗口，而是把命令行参数送回主实例处理。

use tauri::{Emitter, Manager, Runtime};

/// 初始化单实例插件。
/// 必须是 Builder 链上第一个注册的插件（官方要求：single-instance 需在
/// 其他插件初始化之前挂上，二次实例的参数传递才有保证）。
///
/// R-01：二次启动的 argv 与"用户双击关联文件"是同一个信任来源，故**在 Rust 侧先登记**
/// 再转发给前端——渲染层伪造不了这次登记（它只能影响"要不要去开"）。
pub fn init<R: Runtime>() -> tauri::plugin::TauriPlugin<R> {
    tauri_plugin_single_instance::init(|app, args, _cwd| {
        if let Some(trust) = app.try_state::<crate::trust::TrustedPaths>() {
            let granted = crate::fs::trust_all_existing(&trust, &args);
            println!("[trust] 单实例转发：注册 {granted}/{} 条参数中的 Markdown 路径", args.len());
        }
        // args 含二次启动时传入的文件路径，交由主实例前端响应
        let _ = app.emit("second-instance", args);
    })
}
