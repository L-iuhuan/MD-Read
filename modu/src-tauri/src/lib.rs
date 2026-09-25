pub mod fs;
mod print;
mod single;

use std::sync::Mutex;
use tauri::{Emitter, LogicalPosition, LogicalSize, Manager, State};
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

/* ---- 默认窗口尺寸（按主屏工作区 clamp，2026-09-23 批）----
   阅读应用原默认 1100×750 太小（每次都要手动拖大），但直接写 1680×1200 会在
   小屏 / 高 DPI / 远程会话里开到工作区之外。故：config 声明期望尺寸，启动时按
   **主显示器工作区**（已扣任务栏）夹取一遍，再在工作区内居中——
   位置一律由工作区算出，不硬编码相对屏幕的某一点。
   契约同步写在 AGENTS.md「默认窗口」条；CDP overlay 各自钉住尺寸。 */
/// 期望宽度（= tauri.conf.json 的 window.width，也是宽度上界）
const WIN_W_DEFAULT: u32 = 1680;
/// 期望高度（= tauri.conf.json 的 window.height，也是高度上界）
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

/// 夹取函数（纯函数，可单测）：把工作区（物理像素）换算成逻辑像素后求目标尺寸与居中位置。
/// 尺寸三层夹取：① 不超期望上界；② 工作区 − 保留余量（首选）；③ 兜底下限——
/// 极小工作区下宁可略微超出，也不把窗口压到读不了字。
fn window_placement(area: &WorkArea) -> WinPlacement {
    let s = if area.scale.is_finite() && area.scale > 0.0 {
        area.scale
    } else {
        1.0
    };
    let avail_w = area.width / s;
    let avail_h = area.height / s;
    let width = f64::from(WIN_W_DEFAULT)
        .min((avail_w - WIN_W_RESERVED).max(WIN_W_FLOOR))
        .max(WIN_W_FLOOR);
    let height = f64::from(WIN_H_DEFAULT)
        .min((avail_h - WIN_H_RESERVED).max(WIN_H_FLOOR))
        .max(WIN_H_FLOOR);
    WinPlacement {
        width,
        height,
        x: area.x / s + (avail_w - width) / 2.0,
        y: area.y / s + (avail_h - height) / 2.0,
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

/// 把窗口调整到目标尺寸并在主屏工作区内居中。尺寸已相符时不重复 set（免得每次
/// 启动都触发一次无谓的重排）；位置**总是**显式给——Tauri 的 `center()` 依赖
/// 窗口当前尺寸在事件循环里的更新时机（set_size 是异步派发），显式给位置不赌时序。
fn adjust_window_size(app: &tauri::App, monitor: &tauri::Monitor) -> tauri::Result<()> {
    let Some(window) = app.get_webview_window("main") else {
        println!("[window] GATHER 未找到 main 窗口，跳过尺寸夹取");
        return Ok(());
    };
    let area = primary_work_area(monitor);
    let target = window_placement(&area);
    println!(
        "[window] GATHER 主屏工作区=({},{} {}×{}) scale={} → 目标逻辑尺寸={}×{} 位置=({},{})",
        area.x,
        area.y,
        area.width,
        area.height,
        area.scale,
        target.width,
        target.height,
        target.x.round(),
        target.y.round()
    );
    let current = window.inner_size()?;
    let want_w = target.width.round();
    let want_h = target.height.round();
    if f64::from(current.width) != want_w || f64::from(current.height) != want_h {
        window.set_size(LogicalSize::new(want_w, want_h))?;
    }
    window.set_position(LogicalPosition::new(target.x.round(), target.y.round()))?;
    let now = window.inner_size()?;
    println!(
        "[window] GATHER 夹取完成：set={}×{} 现行物理={}×{}",
        want_w, want_h, now.width, now.height
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
            take_pending_files,
            allow_asset_paths,
            print::spike_log,
            print::spike_print_pdf,
            print::export_pdf,
            print::pick_save_path
        ])
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
        has_md_extension, md_paths, usable_image_paths, validate_image_path, window_placement,
        WorkArea,
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
}
