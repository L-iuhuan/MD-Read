//! 单实例守卫：第二个实例不再开新窗口，而是把命令行参数送回主实例处理。

use tauri::{Emitter, Runtime};

/// 初始化单实例插件。
/// 必须是 Builder 链上第一个注册的插件（官方要求：single-instance 需在
/// 其他插件初始化之前挂上，二次实例的参数传递才有保证）。
pub fn init<R: Runtime>() -> tauri::plugin::TauriPlugin<R> {
    tauri_plugin_single_instance::init(|app, args, _cwd| {
        // args 含二次启动时传入的文件路径，交由主实例前端响应
        let _ = app.emit("second-instance", args);
    })
}
