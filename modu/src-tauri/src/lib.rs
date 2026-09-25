pub mod fs;
mod print;
mod single;
pub mod trust;

use std::sync::Mutex;
use tauri::{DragDropEvent, Emitter, LogicalPosition, LogicalSize, Manager, State, WindowEvent};
use webview2_com::Microsoft::Web::WebView2::Win32::{
    ICoreWebView2, ICoreWebView2NavigationStartingEventArgs,
    ICoreWebView2NavigationStartingEventHandler, ICoreWebView2NavigationStartingEventHandler_Impl,
};
use windows_core::{implement, PWSTR};

/// 本次启动携带的待打开文件列表。前端就绪后经 `take_pending_files` 一次取走——
/// 消除 setup 阶段 emit 早于前端监听器就绪的竞态（Lane C 遗留 #1 的兜底）。
/// P0-6 起是**列表**：多文件启动（关联/拖到 exe 上/命令行多参）不再只开第一个。
struct PendingFiles(Mutex<Vec<String>>);

/// 接受的 Markdown 扩展名（小写、不含点）。P0-6 唯一事实源之一——
/// 前端同一份清单在 `src/app/md-ext.ts`（跨语言无法共享代码，注释互为引用，
/// 对拍见 tests/md-ext.spec.ts 对 tauri.conf.json 的 fileAssociations.ext）。
const MD_EXTENSIONS: [&str; 3] = ["md", "markdown", "mdx"];

/* ---- 窗口尺寸契约：config / overlay 说什么就是什么，程序只保证「装得下」
   （2026-09-23 第二批修订：只缩不放、不覆盖显式配置）----
   启动时读窗口**当前**逻辑尺寸 —— 它就是 `tauri.conf.json`（或 `--config` overlay）
   声明的 `width`/`height`（Tauri 建窗时已按 `minWidth`/`minHeight` 兜过底）——
   然后**只往下夹**到主屏工作区可用区（宽 −400 / 高 −80），再在该尺寸下于工作区内居中。
   **绝不放大、绝不把它强行置成某个「理想值」**。

   ⚠ 上一版的 `window_placement(area)` 无条件返回「理想尺寸 = min(1680, 工作区−400)」，
   `adjust_window_size` 再无条件 set 上去 —— 等于把 config/overlay 声明的尺寸**覆盖掉**：
   `.verify/dev/tauri.dev-cdp-narrow.conf.json` 声明的 900×750 因此从未生效
   （2026-09-23 实测复现：窄窗 overlay 起来就是 1680×1200），
   AGENTS.md「CDP overlay 各自钉住尺寸」那句当时**是假的**，所有窄窗测试都失去可靠前提。

   本版语义（四种情况）：
   · 配置 1680×1200（默认）              → 本机大工作区仍是 1680×1200；
   · 配置 900×750（窄窗 overlay）        → 真的 900×750（不再被放大到理想值）；
   · 配置 3000×2000（超出工作区）        → 缩到「工作区 − 保留余量」的上限；
   · 读到的请求值不可信（非有限 / ≤0 / 小于兜底下限） → 保留 config 尺寸不动、只摆位置
     （兜底形状见 `fit_requested_size` 返回 None 的分支；本机实测该分支不触发：
     最小化状态下 `inner_size()` 仍返回 config 尺寸）。
   位置**一律由工作区算出**（不赌 `set_size` 的异步时序，也不用 `center()`）。
   契约同步写在 AGENTS.md「默认窗口」条。 */
/// 兜底期望宽度：仅当读不到可信的请求尺寸时使用（历史上也是 config 的 width）
const WIN_W_DEFAULT: u32 = 1680;
/// 兜底期望高度：同上（历史上也是 config 的 height）
const WIN_H_DEFAULT: u32 = 1200;
/// 宽度至少让出的横向余量（工作区宽 − 本值；给屏幕边缘留白）
const WIN_W_RESERVED: f64 = 400.0;
/// 高度至少让出的纵向余量（工作区高 − 本值；给任务栏与窗口边缘留白）
const WIN_H_RESERVED: f64 = 80.0;
/// 兜底下限，与 config 的 minWidth / minHeight 一致（仅极小工作区时生效）
const WIN_W_FLOOR: f64 = 720.0;
/// 兜底下限（高度），同上
const WIN_H_FLOOR: f64 = 480.0;

/// 主显示器工作区（物理像素）与缩放系数；缩放系数非法时按 1 处理。
struct WorkArea {
    x: f64,
    y: f64,
    width: f64,
    height: f64,
    scale: f64,
}

/// 窗口目标几何（逻辑像素）：尺寸 + 工作区内的居中位置
struct WinPlacement {
    width: f64,
    height: f64,
    x: f64,
    y: f64,
}

/// 缩放系数清洗：非有限 / 非正一律按 1（避免除零 → 无穷 → NaN 尺寸）
fn safe_scale(scale: f64) -> f64 {
    if scale.is_finite() && scale > 0.0 {
        scale
    } else {
        1.0
    }
}

/// 单轴「只缩不放」（纯函数）：
/// · 请求值可信（有限且不低于兜底下限）→ `min(请求, 工作区上限)`；
/// · 请求值退化（非有限 / ≤0 / 小于兜底下限）→ `None`（调用方保留 config 尺寸不动）。
/// 工作区上限 = max(可用 − 保留余量, 兜底下限)：极小工作区下宁可略微超边，
/// 也不把窗口压到读不了字（与上一版同一取舍）。
fn fit_axis(requested: f64, avail: f64, reserved: f64, floor: f64) -> Option<f64> {
    if !requested.is_finite() || requested < floor {
        return None;
    }
    Some(requested.min((avail - reserved).max(floor)))
}

/// 「只缩不放」尺寸解算（纯函数，可单测）：入参是 config/overlay 声明的逻辑尺寸。
/// 返回 `None` 表示两个轴里至少有一个读不到可信值 —— 调用方**不得**据此放大窗口，
/// 只保留 config 尺寸并照常居中。
fn fit_requested_size(requested_w: f64, requested_h: f64, area: &WorkArea) -> Option<(f64, f64)> {
    let s = safe_scale(area.scale);
    let width = fit_axis(requested_w, area.width / s, WIN_W_RESERVED, WIN_W_FLOOR)?;
    let height = fit_axis(requested_h, area.height / s, WIN_H_RESERVED, WIN_H_FLOOR)?;
    Some((width, height))
}

/// 把 w×h（逻辑像素）在工作区内居中（纯函数）：位置一律算出来，不用 `center()`。
fn centered_position(area: &WorkArea, w: f64, h: f64) -> (f64, f64) {
    let s = safe_scale(area.scale);
    (
        area.x / s + (area.width / s - w) / 2.0,
        area.y / s + (area.height / s - h) / 2.0,
    )
}

/// 兜底 / 对照用：把「兜底期望尺寸」按工作区夹一次并居中。
/// ⚠ 生产路径**只在** `fit_requested_size` 返回 None（读不到可信请求值）时才用它；
/// 正常启动一律走「当前尺寸只缩不放」。保留它是因为既有单测以它为对照锚，
/// 且它把「期望尺寸 + 三层夹取」这条老语义完整固化下来（防回归）。
fn window_placement(area: &WorkArea) -> WinPlacement {
    let (width, height) = (
        f64::from(WIN_W_DEFAULT)
            .min((area.width / safe_scale(area.scale) - WIN_W_RESERVED).max(WIN_W_FLOOR))
            .max(WIN_W_FLOOR),
        f64::from(WIN_H_DEFAULT)
            .min((area.height / safe_scale(area.scale) - WIN_H_RESERVED).max(WIN_H_FLOOR))
            .max(WIN_H_FLOOR),
    );
    let (x, y) = centered_position(area, width, height);
    WinPlacement {
        width,
        height,
        x,
        y,
    }
}

/// 取主显示器的工作区读数（物理像素 + 缩放系数）。
fn primary_work_area(monitor: &tauri::Monitor) -> WorkArea {
    let work = monitor.work_area();
    WorkArea {
        x: f64::from(work.position.x),
        y: f64::from(work.position.y),
        width: f64::from(work.size.width),
        height: f64::from(work.size.height),
        scale: monitor.scale_factor(),
    }
}

/// 保证窗口「装得下」并在主屏工作区内居中（**只缩不放**，见文件上方契约）。
/// 尺寸不变时不重复 set（免得每次启动都触发一次无谓的重排）；
/// 位置**总是**显式给——Tauri 的 `center()` 依赖窗口当前尺寸在事件循环里的更新时机
/// （set_size 是异步派发），显式给位置不赌时序。
fn adjust_window_size(app: &tauri::App, monitor: &tauri::Monitor) -> tauri::Result<()> {
    let Some(window) = app.get_webview_window("main") else {
        println!("[window] GATHER 未找到 main 窗口，跳过尺寸夹取");
        return Ok(());
    };
    let area = primary_work_area(monitor);
    // 当前逻辑尺寸 = config/overlay 声明的尺寸（Tauri 建窗时已按 minWidth/minHeight 兜底）。
    // 用**窗口自己的**缩放系数换算：多显示器下它未必等于主屏的系数。
    let current = window.inner_size()?;
    let win_scale = safe_scale(window.scale_factor().unwrap_or(area.scale));
    let requested_w = f64::from(current.width) / win_scale;
    let requested_h = f64::from(current.height) / win_scale;
    let fitted = fit_requested_size(requested_w, requested_h, &area);
    // 兜底：读不到可信请求值 → 各轴回到「兜底期望尺寸」那条老路（绝不凭空放大合法请求）
    let (want_w, want_h, want_x, want_y) = match fitted {
        Some((w, h)) => {
            let (x, y) = centered_position(&area, w, h);
            (w, h, x, y)
        }
        None => {
            println!(
                "[window] GATHER 请求尺寸不可信（{requested_w:.0}×{requested_h:.0} 逻辑像素），改走兜底期望尺寸"
            );
            let p = window_placement(&area);
            (p.width, p.height, p.x, p.y)
        }
    };
    println!(
        "[window] GATHER 主屏工作区=({},{} {}×{}) scale={} · 配置请求={}×{} → 目标={}×{} 位置=({},{})",
        area.x,
        area.y,
        area.width,
        area.height,
        area.scale,
        requested_w.round(),
        requested_h.round(),
        want_w.round(),
        want_h.round(),
        want_x.round(),
        want_y.round()
    );
    // 只缩不放：仅在真的超出工作区时才 set_size
    if (want_w - requested_w).abs() > 0.5 || (want_h - requested_h).abs() > 0.5 {
        window.set_size(LogicalSize::new(want_w.round(), want_h.round()))?;
    }
    window.set_position(LogicalPosition::new(want_x.round(), want_y.round()))?;
    let now = window.inner_size()?;
    println!(
        "[window] GATHER 收工：请求={}×{} 现行物理={}×{}（缩过={}）",
        requested_w.round(),
        requested_h.round(),
        now.width,
        now.height,
        (want_w - requested_w).abs() > 0.5 || (want_h - requested_h).abs() > 0.5
    );
    Ok(())
}

/// 是否是 Markdown 路径：取文件名比对扩展名，大小写不敏感（只看扩展名，不碰文件系统）。
/// 先切文件名再取扩展名：`C:\a.md\file` 这类「目录名带点」的路径不能误判。
fn has_md_extension(arg: &str) -> bool {
    let name = arg
        .rsplit(['\\', '/'])
        .next()
        .unwrap_or(arg)
        .to_lowercase();
    MD_EXTENSIONS
        .iter()
        .any(|ext| name.ends_with(&format!(".{ext}")))
}

/// 去掉单层成对引号（Windows 把带空格的关联路径以 `"C:\a b.md"` 形式送进来）。
fn unquote(arg: &str) -> &str {
    let trimmed = arg.trim();
    let bytes = trimmed.as_bytes();
    if bytes.len() >= 2 {
        let first = bytes[0];
        let last = bytes[bytes.len() - 1];
        if (first == b'"' && last == b'"') || (first == b'\'' && last == b'\'') {
            return &trimmed[1..trimmed.len() - 1];
        }
    }
    trimmed
}

/// 从命令行参数里筛出全部 Markdown 文件路径（跳过 exe 自身与开关项，保持原顺序）。
/// P0-6 前是 `md_arg()`：`find` 只取第一个 `.md`，多文件启动后面几个全丢。
fn md_paths(args: &[String]) -> Vec<String> {
    let mut found: Vec<String> = Vec::new();
    for arg in args {
        let candidate = unquote(arg);
        if candidate.starts_with('-') {
            continue; // 开关项（--config 等）不是文件路径
        }
        if has_md_extension(candidate) {
            found.push(candidate.to_string());
        }
    }
    found
}

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
            fs::pick_markdown_files,
            take_pending_files,
            allow_asset_paths,
            print::spike_log,
            print::spike_print_pdf,
            print::export_pdf,
            print::pick_save_path
        ])
        // R-01：OS 拖放是**不可伪造**的注册入口之一（渲染层无法自证），在 Rust 侧收口。
        .on_window_event(|window, event| {
            if let WindowEvent::DragDrop(DragDropEvent::Drop { paths, .. }) = event {
                let Some(state) = window.app_handle().try_state::<trust::TrustedPaths>() else {
                    return;
                };
                let raws: Vec<String> =
                    paths.iter().map(|p| p.to_string_lossy().into_owned()).collect();
                let granted = fs::trust_all_existing(&state, &raws);
                println!("[trust] 拖放注册 {granted}/{} 个 Markdown 文件", raws.len());
            }
        })
        .setup(|app| {
            attach_nav_guard(app); // 整窗导航兜底：趁启动挂上 WebView2 事件（见函数注释）
            // 默认窗口尺寸：按主屏工作区夹取后居中（见上方 WIN_* 常量说明与 AGENTS.md 契约）
            match app.primary_monitor() {
                Ok(Some(monitor)) => adjust_window_size(app, &monitor)?,
                Ok(None) => println!("[window] GATHER 取不到主显示器，沿用 config 尺寸"),
                Err(error) => println!("[window] GATHER 主显示器查询失败（{error}），沿用 config 尺寸"),
            }
            let pending = md_paths(&std::env::args().collect::<Vec<String>>());
            app.manage(PendingFiles(Mutex::new(pending.clone())));
            // R-01：受信清单（持久化）。argv/文件关联进来的路径**在 Rust 侧登记**——
            // 渲染层调不调 allow 都改变不了"这个文件是不是用户双击/命令行给的"。
            app.manage(fs::load_trusted_store(app.handle()));
            if let Some(trust) = app.try_state::<trust::TrustedPaths>() {
                let granted = fs::trust_all_existing(&trust, &pending);
                let (files, dirs) = trust.counts();
                println!(
                    "[trust] 启动：argv 注册 {granted}/{}，清单现有 {files} 文件 / {dirs} 目录",
                    pending.len()
                );
            }
            // 事件照发（供未来多标签等场景）；竞态由 take_pending_files 兜底。
            // 载荷是**筛过的 Markdown 列表**：前端监听器直接按列表逐个开标签。
            if !pending.is_empty() {
                app.emit("second-instance", pending)?;
            }
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

/// 取走启动参数携带的 Markdown 路径列表（一次性消费；无则空列表）。
/// P0-6 前是 `take_pending_file`（`Option<String>`，只取第一个）——多文件启动会静默
/// 丢掉其余文件，故整体迁到列表：本仓调用方只有 main.ts，已一并改。
#[tauri::command]
fn take_pending_files(state: State<PendingFiles>) -> Vec<String> {
    match state.0.lock() {
        Ok(mut guard) => std::mem::take(&mut *guard),
        Err(_) => Vec::new(),
    }
}

/// 图片扩展名白名单（小写；比对时把扩展名转小写）。
const IMAGE_EXTENSIONS: [&str; 9] = [
    "png", "jpg", "jpeg", "gif", "webp", "bmp", "svg", "avif", "ico",
];

/// 校验单条待授权路径：必须绝对路径、扩展名在图片白名单内、存在且是普通文件。
/// 先查扩展名再碰文件系统：非图片路径不产生任何磁盘探测。
/// 校验失败的错误信息面向使用者（中文、不含技术黑话）；成功返回原路径。
pub fn validate_image_path(raw: &str) -> Result<std::path::PathBuf, String> {
    let path = std::path::PathBuf::from(raw);
    if !path.is_absolute() {
        return Err(format!("无法读取图片：{raw}（路径必须是绝对路径）"));
    }
    let extension = path
        .extension()
        .and_then(|ext| ext.to_str())
        .map(str::to_lowercase)
        .unwrap_or_default();
    if !IMAGE_EXTENSIONS.contains(&extension.as_str()) {
        return Err(format!("不支持的图片格式：{raw}"));
    }
    let metadata = std::fs::metadata(&path).map_err(|e| format!("无法读取图片：{raw}（{e}）"))?;
    if !metadata.is_file() {
        return Err(format!("无法读取图片：{raw}（不是文件）"));
    }
    Ok(path)
}

/// 逐条过滤出可授权路径（(校验后的路径, 原始串)），校验失败的路径单独跳过。
/// 关键：一篇文档里缺一张图，不能连坐其余图片——否则正文所有相对图一起 404
/// （P0-3 e2e 实锤：corpus 故意含 img-missing.png）。
pub fn usable_image_paths(paths: &[String]) -> Vec<(std::path::PathBuf, String)> {
    paths
        .iter()
        .filter_map(|raw| validate_image_path(raw).ok().map(|path| (path, raw.clone())))
        .collect()
}

/// 按文档实际引用的图片逐个授权 asset 协议（P0-3）。静态 scope 为空列表——
/// 不做 `**` 全盘放行，只把渲染层解析出的、通过白名单校验的具体文件加进运行时 scope。
/// 永不为「某张图缺失/不合法」返回 Err：缺图由渲染层 error 监听补中文提示，
/// 单张失败不影响同批其余图片。
/// 非 `pub`：`pub` 会让 `#[tauri::command]` 给生成的 `__cmd__*` 宏加 `#[macro_export]`，
/// 与本文件内的 `generate_handler!` 重导入同名宏冲突（E0255）；同 `take_pending_files`。
#[tauri::command]
fn allow_asset_paths(app: tauri::AppHandle, paths: Vec<String>) -> Result<(), String> {
    for (path, raw) in usable_image_paths(&paths) {
        app.asset_protocol_scope()
            .allow_file(&path)
            .map_err(|e| format!("无法授权图片访问：{raw}（{e}）"))?;
    }
    Ok(())
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

#[cfg(test)]
mod asset_path_tests {
    use super::{
        centered_position, fit_requested_size, has_md_extension, md_paths, usable_image_paths,
        validate_image_path, window_placement, WorkArea,
    };

    /// 建一个临时文件用于「存在且是普通文件」的正例。
    fn temp_file(name: &str) -> std::path::PathBuf {
        let mut path = std::env::temp_dir();
        path.push(format!("modu-p0-3-{}-{name}", std::process::id()));
        std::fs::write(&path, b"x").expect("预置临时文件不应失败");
        path
    }

    #[test]
    fn validates_absolute_existing_image_only() {
        let png = temp_file("a.png");
        let upper = temp_file("B.JPEG");
        assert!(validate_image_path(&png.to_string_lossy()).is_ok());
        assert!(validate_image_path(&upper.to_string_lossy()).is_ok(), "扩展名应大小写不敏感");

        let relative = "sub/pic.png";
        assert!(validate_image_path(relative).is_err(), "相对路径必须拒绝");

        let dir = std::env::temp_dir();
        let as_dir = dir.join(format!("modu-p0-3-dir-{}.png", std::process::id()));
        std::fs::create_dir_all(&as_dir).expect("建临时目录不应失败");
        assert!(validate_image_path(&as_dir.to_string_lossy()).is_err(), "目录必须拒绝");
        let _ = std::fs::remove_dir_all(&as_dir);

        let missing = dir.join(format!("modu-p0-3-missing-{}.png", std::process::id()));
        let missing_err =
            validate_image_path(&missing.to_string_lossy()).expect_err("不存在的文件必须拒绝");
        assert!(
            missing_err.starts_with("无法读取图片"),
            "错误信息应中文面向使用者：{missing_err}"
        );

        let not_image = temp_file("c.txt");
        let err = validate_image_path(&not_image.to_string_lossy()).expect_err("非图片扩展名必须拒绝");
        assert!(err.starts_with("不支持的图片格式"), "错误信息应中文面向使用者：{err}");
        let _ = std::fs::remove_file(&not_image);
        let _ = std::fs::remove_file(&png);
        let _ = std::fs::remove_file(&upper);
    }

    /// 缺图不连坐：一批路径里混入不存在/非法项时，仍返回其余可授权路径。
    #[test]
    fn missing_image_does_not_block_its_siblings() {
        let good = temp_file("good.png");
        let mut missing = std::env::temp_dir();
        missing.push(format!("modu-p0-3-absent-{}.png", std::process::id()));
        let batch = vec![
            good.to_string_lossy().into_owned(),
            missing.to_string_lossy().into_owned(),
            "sub/relative.png".to_string(),
        ];
        let usable = usable_image_paths(&batch);
        assert_eq!(usable.len(), 1, "只有存在的图片应进入授权清单");
        assert_eq!(usable[0].0, good);
        assert_eq!(usable[0].1, good.to_string_lossy());
        let _ = std::fs::remove_file(&good);
    }

    /// P0-6：扩展名判据与前端 md-ext.ts / tauri.conf.json 的关联清单同集，
    /// 大小写不敏感，且只看文件名（目录名带点不误判）。
    #[test]
    fn md_extension_accepts_the_shared_three_case_insensitively() {
        assert!(has_md_extension("a.md"));
        assert!(has_md_extension("a.markdown"));
        assert!(has_md_extension("a.mdx"));
        assert!(has_md_extension("A.MD"), "大小写不敏感");
        assert!(has_md_extension(r"C:\文档\报告.MarkDown"), "目录带点 + 大小写混写");

        assert!(!has_md_extension("a.txt"));
        assert!(!has_md_extension("a.mdown"), "mdown 不在关联清单里");
        assert!(!has_md_extension(r"C:\a.md\file"), "目录名以 .md 结尾不是文件扩展名");
        assert!(!has_md_extension("md"));
        assert!(!has_md_extension(""));
    }

    /// P0-6 回归：多文件启动必须全部解析出来（旧实现 find() 只取第一个）。
    #[test]
    fn md_paths_keeps_every_markdown_argument_in_order() {
        let args = vec![
            r"C:\apps\modu.exe".to_string(),
            r"C:\docs\一.MDX".to_string(),
            r"C:\docs\two.markdown".to_string(),
            "C:/docs/three.md".to_string(),
        ];
        assert_eq!(
            md_paths(&args),
            vec![
                r"C:\docs\一.MDX".to_string(),
                r"C:\docs\two.markdown".to_string(),
                "C:/docs/three.md".to_string(),
            ],
            "全部 Markdown 参数都要保留，顺序不变，exe 自身要跳过"
        );
    }

    /// P0-6：非 Markdown 参数、开关项、带引号的关联路径三种边界。
    #[test]
    fn md_paths_skips_non_markdown_and_unquotes_paths() {
        let args = vec![
            r"C:\apps\modu.exe".to_string(),
            "--config".to_string(),
            r"D:\a\b.txt".to_string(),
            r#""D:\带 空格\笔记.md""#.to_string(),
            r"D:\尾部\无关.png".to_string(),
        ];
        assert_eq!(md_paths(&args), vec![r"D:\带 空格\笔记.md".to_string()]);

        let none = vec![r"C:\apps\modu.exe".to_string(), "--no-watch".to_string()];
        assert!(md_paths(&none).is_empty(), "无 Markdown 参数时为空列表");
    }

    /// 默认窗口（2026-09-23 批）：本机 2560×1392 工作区（100% 缩放）→ 1680×1200。
    #[test]
    fn window_targets_default_size_on_a_large_work_area() {
        let area = WorkArea { x: 0.0, y: 0.0, width: 2560.0, height: 1392.0, scale: 1.0 };
        let p = window_placement(&area);
        assert_eq!((p.width, p.height), (1680.0, 1200.0), "大工作区取期望上界");
        assert_eq!((p.x, p.y), (440.0, 96.0), "工作区内居中：(2560-1680)/2, (1392-1200)/2");
    }

    /// 小工作区：宽度吃「工作区 − 400」、高度吃「工作区 − 80」，绝不超出工作区。
    #[test]
    fn window_shrinks_to_work_area_minus_reserved_margins() {
        let area = WorkArea { x: 0.0, y: 0.0, width: 1280.0, height: 800.0, scale: 1.0 };
        let p = window_placement(&area);
        assert_eq!((p.width, p.height), (880.0, 720.0), "1280-400 / 800-80");
        assert_eq!((p.x, p.y), (200.0, 40.0), "仍居中");
        assert!(p.width <= area.width && p.height <= area.height, "不得超出工作区");
    }

    /// 高 DPI：物理像素先除缩放系数再夹取（2560 物理 / 1.5 = 1706.67 逻辑宽）。
    #[test]
    fn window_scales_physical_work_area_before_clamping() {
        let area = WorkArea { x: 0.0, y: 0.0, width: 2560.0, height: 1440.0, scale: 1.5 };
        let p = window_placement(&area);
        // 逻辑可用 1706.67×960 → 宽 min(1680, 1306.67)=1306.67，高 min(1200, 880)=880
        assert!((p.width - 1306.6667).abs() < 0.01, "实测 {}", p.width);
        assert_eq!(p.height, 880.0);
        assert!(p.width <= 1706.67 && p.height <= 960.0);
    }

    /// 第二显示器：工作区原点非零时，居中位置必须跟着工作区走（不贴回主屏原点）。
    #[test]
    fn window_centers_inside_a_shifted_work_area() {
        let area = WorkArea { x: 2560.0, y: 0.0, width: 1920.0, height: 1080.0, scale: 1.0 };
        let p = window_placement(&area);
        assert_eq!((p.width, p.height), (1520.0, 1000.0), "1920-400 / 1080-80");
        assert_eq!((p.x, p.y), (2760.0, 40.0), "2560+(1920-1520)/2, 0+(1080-1000)/2");
    }

    /// 极小工作区：三层夹取的最后一道是兜底下限（宁可靠边也不压到读不了字）。
    #[test]
    fn window_keeps_the_floor_on_a_tiny_work_area() {
        let area = WorkArea { x: 0.0, y: 0.0, width: 640.0, height: 400.0, scale: 1.0 };
        let p = window_placement(&area);
        assert_eq!((p.width, p.height), (720.0, 480.0), "兜底下限 = config 的 minWidth/minHeight");
    }

    /// 缩放系数非法（0 / NaN / 负 / 无穷）按 1 处理，不得出现除零 → 无穷 → NaN 尺寸。
    #[test]
    fn window_falls_back_to_scale_one_on_a_bad_scale_factor() {
        for scale in [0.0, -2.0, f64::NAN, f64::INFINITY] {
            let area = WorkArea { x: 0.0, y: 0.0, width: 2560.0, height: 1392.0, scale };
            let p = window_placement(&area);
            assert!(p.width.is_finite() && p.height.is_finite(), "scale={scale} 尺寸必须有限");
            assert!(p.width >= 720.0 && p.width <= 1680.0, "scale={scale} 宽度越界：{}", p.width);
            assert!(p.height >= 480.0 && p.height <= 1200.0, "scale={scale} 高度越界：{}", p.height);
            assert!(p.x.is_finite() && p.y.is_finite(), "scale={scale} 位置必须是有限数");
        }
        for scale in [0.0, -2.0] {
            let area = WorkArea { x: 0.0, y: 0.0, width: 2560.0, height: 1392.0, scale };
            assert_eq!(
                (window_placement(&area).width, window_placement(&area).height),
                (1680.0, 1200.0),
                "scale={scale} 应退化为 1"
            );
        }
    }

    /* ---- 2026-09-23 第二批：只缩不放、不覆盖显式配置 ---- */

    /// 本机工作区（2560×1392 / 100%）：请求 1680×1200 → 原样保留（不放大也不缩）。
    #[test]
    fn requested_size_is_kept_when_it_fits() {
        let area = WorkArea { x: 0.0, y: 0.0, width: 2560.0, height: 1392.0, scale: 1.0 };
        assert_eq!(fit_requested_size(1680.0, 1200.0, &area), Some((1680.0, 1200.0)));
        // 窄窗 overlay 的 900×750：**绝不能被放大**到「理想值 1680×1200」
        assert_eq!(fit_requested_size(900.0, 750.0, &area), Some((900.0, 750.0)));
        // 位置按「被保留的尺寸」居中，不是按理想尺寸居中
        assert_eq!(centered_position(&area, 900.0, 750.0), (830.0, 321.0));
        assert_eq!(centered_position(&area, 1680.0, 1200.0), (440.0, 96.0));
    }

    /// 超出工作区才缩：3000×2000 → 各轴吃「工作区 − 保留余量」。
    #[test]
    fn requested_size_shrinks_only_when_it_overflows_the_work_area() {
        let area = WorkArea { x: 0.0, y: 0.0, width: 2560.0, height: 1392.0, scale: 1.0 };
        assert_eq!(fit_requested_size(3000.0, 2000.0, &area), Some((2160.0, 1312.0)), "2560-400 / 1392-80");
        assert_eq!(fit_requested_size(2161.0, 1200.0, &area), Some((2160.0, 1200.0)), "只缩到上限，不缩到理想值");
        // 小工作区 1280×800：请求 1680×1200 缩到 880×720
        let small = WorkArea { x: 0.0, y: 0.0, width: 1280.0, height: 800.0, scale: 1.0 };
        assert_eq!(fit_requested_size(1680.0, 1200.0, &small), Some((880.0, 720.0)));
        // 极小工作区：兜底下限当下限用（宁可超边也不压到读不了字）
        let tiny = WorkArea { x: 0.0, y: 0.0, width: 640.0, height: 400.0, scale: 1.0 };
        assert_eq!(fit_requested_size(900.0, 750.0, &tiny), Some((720.0, 480.0)));
    }

    /// 高 DPI：物理工作区先除缩放系数再算上限；请求值本身是逻辑像素，不参与换算。
    #[test]
    fn requested_size_clamps_against_a_scaled_work_area() {
        let area = WorkArea { x: 0.0, y: 0.0, width: 2560.0, height: 1440.0, scale: 1.5 };
        // 逻辑可用 1706.67×960 → 上限 1306.67×880
        assert_eq!(fit_requested_size(900.0, 750.0, &area), Some((900.0, 750.0)), "窄窗请求在 1.5 缩放下仍原样保留");
        let (w, h) = fit_requested_size(1600.0, 1000.0, &area).expect("合法请求");
        assert!((w - 1306.6667).abs() < 0.01, "实测 {w}");
        assert_eq!(h, 880.0);
        // 缩放系数非法时按 1：2560×1440 → 上限 2160×1360
        let bad = WorkArea { x: 0.0, y: 0.0, width: 2560.0, height: 1440.0, scale: f64::NAN };
        assert_eq!(fit_requested_size(3000.0, 3000.0, &bad), Some((2160.0, 1360.0)));
    }

    /// 退化请求值（非有限 / ≤0 / 小于兜底下限）→ None：调用方保留 config 尺寸、绝不放大。
    #[test]
    fn degenerate_requested_size_yields_none_instead_of_a_guess() {
        let area = WorkArea { x: 0.0, y: 0.0, width: 2560.0, height: 1392.0, scale: 1.0 };
        for (w, h) in [
            (f64::NAN, 750.0),
            (900.0, f64::NAN),
            (0.0, 750.0),
            (-100.0, 750.0),
            (f64::INFINITY, 750.0),
            (719.0, 750.0),
            (900.0, 479.0),
        ] {
            assert_eq!(fit_requested_size(w, h, &area), None, "请求 {w}×{h} 应判为不可信");
        }
        // 正好落在兜底下限上：可信（Tauri 的 minWidth/minHeight 就是这两个值）
        assert_eq!(fit_requested_size(720.0, 480.0, &area), Some((720.0, 480.0)));
    }

    /// 只缩不放的性质：任何可信请求下，结果既不大于请求、也不大于工作区上限。
    #[test]
    fn fitted_size_never_exceeds_the_request() {
        let area = WorkArea { x: 0.0, y: 0.0, width: 2560.0, height: 1392.0, scale: 1.0 };
        for w in [720.0, 900.0, 1680.0, 2160.0, 2161.0, 4000.0] {
            for h in [480.0, 750.0, 1200.0, 1312.0, 1313.0, 3000.0] {
                let (fw, fh) = fit_requested_size(w, h, &area).expect("合法请求");
                assert!(fw <= w && fh <= h, "{w}×{h} 被放大了：{fw}×{fh}");
                assert!(fw <= 2160.0 && fh <= 1312.0, "{w}×{h} 超出工作区上限：{fw}×{fh}");
            }
        }
    }
}
