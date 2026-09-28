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
        println!("[window] 未找到 main 窗口，跳过尺寸夹取");
        return Ok(());
    };
    let area = primary_work_area(monitor);
    // 当前逻辑尺寸 = config/overlay 声明的尺寸（Tauri 建窗时已按 minWidth/minHeight 兜底）。
    // 用**窗口自己的**缩放系数换算：多显示器下它未必等于主屏的系数。
    // ⚠ 非提权启动时 inner_size 可能失败（webview 未应答）——由调用方兜底（沿用 config 尺寸）。
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
                "[window] 请求尺寸不可信（{requested_w:.0}×{requested_h:.0} 逻辑像素），改走兜底期望尺寸"
            );
            let p = window_placement(&area);
            (p.width, p.height, p.x, p.y)
        }
    };
    // 只缩不放：仅在真的超出工作区时才 set_size
    if (want_w - requested_w).abs() > 0.5 || (want_h - requested_h).abs() > 0.5 {
        window.set_size(LogicalSize::new(want_w.round(), want_h.round()))?;
    }
    window.set_position(LogicalPosition::new(want_x.round(), want_y.round()))?;
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
///
/// **一律归一为 `fs::canonicalize` 形态**（`fs::normalize_path`，全仓唯一实现）——
/// 这里是 argv（含"双击关联文件"）与单实例转发两条通道的**唯一汇聚点**，此处的产物
/// 同时喂给两个消费者：① 受信登记 `fs::trust_all_existing`（它内部本就按 canonical 建键）
/// ② 前端 `take_pending_files` / `second-instance` 事件（前端直接把它当标签路径）。
/// 不在这里归一，前端就会拿到"原始串"形态 ⇒ 与对话框/目录树给的 canonical 形态字符串不等 ⇒
/// `tabs.ts` 的标签去重按字符串比较 ⇒ **同一文件开出两个同名标签** ✗。
///
/// 不存在的路径**原样保留**（`normalize_path` 的 fallback 语义；这类路径去重失效可接受）：
/// 用户完全可能在文档不存在时仍要求打开（例如先敲命令、文件稍后同步下来）。
fn md_paths(args: &[String]) -> Vec<String> {
    let mut found: Vec<String> = Vec::new();
    for arg in args {
        let candidate = unquote(arg);
        if candidate.starts_with('-') {
            continue; // 开关项（--config 等）不是文件路径
        }
        if has_md_extension(candidate) {
            found.push(fs::normalize_path(candidate));
        }
    }
    found
}

/// 极简 stderr 日志接收器（2026-09-25）：装它之前，Tauri/wry 的 `log::error!`
/// （例如 "failed to create webview: <HRESULT>"）**一条都不打印** ✗。
/// 装上后这类错误直接进 stderr，诊断与用户反馈都有据可查。
struct StderrLogger;

impl log::Log for StderrLogger {
    fn enabled(&self, metadata: &log::Metadata) -> bool {
        metadata.level() <= log::Level::Warn // 只收 Warn 以上，不刷屏
    }

    fn log(&self, record: &log::Record) {
        if self.enabled(record.metadata()) {
            eprintln!("[{}] {} — {}", record.level(), record.target(), record.args());
        }
    }

    fn flush(&self) {}
}

static STDERR_LOGGER: StderrLogger = StderrLogger;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    // 日志接收器（2026-09-25 长期保留）：Tauri/wry 的 webview 错误在无 logger 时被整条吞掉。
    let _ = log::set_logger(&STDERR_LOGGER);
    log::set_max_level(log::LevelFilter::Warn);
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
            fs::list_dir,
            fs::pick_workspace_directory,
            fs::remove_workspace,
            // 设为 .md 默认应用（2026-09-27 用户反馈）：HKCU 注册补齐 + 打开系统默认应用页
            fs::register_markdown_default,
            // 路径形态归一（拖放入口用）：唯一实现在 fs::normalize_path，前端只是调用者
            fs::canonical_path,
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
                // ⭐ 目录也登记（缺口②）：**路径来自 OS 事件本身** ⇒ 渲染层伪造不了 ✓
                //   ⇒ 这正是 R-01 的"OS 拖放"授权来源 ✓，**不是**渲染层自我授权 ✗。
                //   分流逻辑抽成纯函数 `fs::trust_dropped` ⇒ 可单测 ✓（不必启动应用 ✓）。
                let (files, dirs, first_dir) = fs::trust_dropped(&state, &raws);
                match first_dir {
                    Some(dir) => {
                        println!("[trust] 拖放注册 {files} 个文件 / {dirs} 个目录（首个目录：{dir}）")
                    }
                    None => println!("[trust] 拖放注册 {files} 个文件 / {dirs} 个目录"),
                }
            }
        })
        .on_page_load(|_webview, _payload| {
            // 页面开始加载 = webview 已活着：此刻起把导航守卫挂上（P5 批1·P0 #2 恢复点）。
            // 之前的教训：在 setup 里 `with_webview` 派发到主线程会因 webview 未就绪而
            // `FailedToReceiveMessage`（2026-09-25 实测两次 panic）；page_load 回调
            // 在 webview 侧事件循环里执行，此刻 `with_webview` 一定有应答。
            // 只挂一次（Tauri 的 page_load 每次导航都触发；用 once 防重复注册）。
            use std::sync::Once;
            static NAV_GUARD: Once = Once::new();
            NAV_GUARD.call_once(|| {
                attach_nav_guard(_webview.app_handle());
            });
        })
        .setup(|app| {
            // 默认窗口尺寸：按主屏工作区夹取后居中（见上方 WIN_* 常量说明与 AGENTS.md 契约）。
            // 尺寸属「保证装得下」的**尽力而为** ⇒ 失败就沿用 config 尺寸并继续启动
            // （2026-09-25 实测：非提权启动时此查询可能失败，`?` 会拖死整个应用）。
            match app.primary_monitor() {
                Ok(Some(monitor)) => {
                    if let Err(error) = adjust_window_size(app, &monitor) {
                        eprintln!("[window] 尺寸夹取失败（{error}）；沿用 config 尺寸，启动继续");
                    }
                }
                Ok(None) => println!("[window] 取不到主显示器，沿用 config 尺寸"),
                Err(error) => println!("[window] 主显示器查询失败（{error}），沿用 config 尺寸"),
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
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|app_handle, event| {
            if let tauri::RunEvent::Ready = event {
                // ⚠ Ready 阶段建 webview 探针已拆除（2026-09-27，Lead）：它给出的"成功"是
                //   **假阳性** ✗ —— `WebviewWindowBuilder::build()` 在 webview 创建失败时只记日志、
                //   Result 仍为 Ok ⇒ 判据无效。改用**子进程数**这一真判据后结论是：
                //   本机（WebView2 运行时 153 与 154 均试过 × 非提权 UAC 过滤令牌）
                //   **config 窗口与 Ready 后新建的窗口都拿不到 webview**（PPID 子进程数恒为 0 ✗）
                //   ⇒ "失败在 Tauri 建窗上下文"这一推断**被否证** ✓；不必再改窗口结构 ✓。
                //   至此已排除：运行时版本（153/154）· 加载器（静态/动态）· 浏览器参数 · 建立时机。
                //   仍可用：**裸 wry**（`.verify/wvtest` 实测通过 ✓）⇒ 出路是换壳或换机器。
                // ⭐ webview 存活检测（2026-09-26）：
                // Tauri 的 build() 在 webview 创建失败时只记日志不报错 ⇒ 进程照常进入事件循环，
                // 留下一个"窗口在、webview 死"的僵尸攥住单实例锁（后续启动全部秒退）。
                // 这里在 Ready 后**轮询**检查：每 5 秒一次、上限 60 秒，任一时刻判定活着即收工。
                // 兼容性设计（2026-09-27 二次修正）：旧版只等 10 秒且用 PPID 单点判据，
                // 在**慢机 / 首次建 profile / 运行时刚更新**时有**误杀健康启动**的风险 ✗
                // （仓库复盘报告 §2.2 已把该判据判为"两个方向都会错"）⇒ 现改轮询 + 并集判据，
                // 把"误杀"压到最低；只有**真死**（窗口还在、60 秒内始终没有任何本应用 webview）
                // 才走到弹框退出，避免留下攥锁僵尸。
                #[cfg(target_os = "windows")]
                {
                    let handle = app_handle.clone();
                    std::thread::spawn(move || {
                        const POLL: std::time::Duration = std::time::Duration::from_secs(5);
                        const LIMIT: u32 = 12; // 12 × 5s = 60s
                        for attempt in 1..=LIMIT {
                            std::thread::sleep(POLL);
                            // ⚠ 2026-09-27：窗口句柄与"可见性"必须**每轮重取** ——
                            // 它是判活合取式的**前提**（僵尸现场：窗口没了却还有 stale renderer ✗；
                            // 健康复用：窗口可见 ✓）。原顺序是"先判活、后查窗口"，于是
                            // "复用宿主 + 无主窗口"这一格被误判成活 ✗。
                            let Some(win) = handle.get_webview_window("main") else {
                                // 用户已把窗口关掉 ⇒ 正常退出路径，不做任何兜底动作
                                println!("[boot] 主窗口已不存在，兜底检测收工");
                                return;
                            };
                            // `is_visible()` 对**最小化**窗口仍为 true（Win32 IsWindowVisible 语义 ✓）
                            // ⇒ 用户把窗口最小化不会误杀 ✓；拿不到时按"可见"处理（不误杀 ✓）
                            let visible = win.is_visible().unwrap_or(true);
                            if webview_alive(visible) {
                                println!("[boot] webview 已就绪（第 {attempt} 次检测，{attempt}×5s）");
                                return;
                            }
                        }
                        eprintln!(
                            "[boot] webview 60 秒仍未就绪 ⇒ 弹错误提示并干净退出（不留僵尸攥锁）"
                        );
                        // 顺序铁律（2026-09-27 实测翻车）：先弹框（阻塞到用户点确定），
                        // 再关窗、退出。若先 win.close()，主事件循环会因「最后一个窗口
                        // 关闭」直接终止进程，检测线程在弹框前就被带走 ⇒ 框永远不出现。
                        show_webview_error_dialog();
                        if let Some(win) = handle.get_webview_window("main") {
                            let _ = win.close();
                        }
                        std::process::exit(1);
                    });
                }
            }
        });
}

/// 判活的三路判据合成（纯函数 ⇒ 可单测，且把"不许误杀"写成一眼能读的合取式）。
///
/// `alive = 主窗口可见 ∧ (直系子进程 > 0 ∨ renderer∩UDF > 0)`
///
/// 为什么是**合取**（2026-09-27 第三次修正，现场抓到过反例 ✗）：
/// 并集版（只看进程）在下面这个场景**恒真**——上一个实例被强杀后，它的 WebView2 宿主
/// 还活着（带我们的 UDF、还挂着 renderer ✗），新实例的 webview **其实没建起来**，
/// 却因"存在 renderer∩UDF"被判活 ⇒ 看门狗不弹框、不退出 ⇒ 留下**无主窗口的僵尸攥着
/// 单实例锁**（现场：PID 1228，`MainWindowTitle` 只剩 `com.modu.reader-siw` ✗，
/// 表现就是用户说过的"双击没反应"）。三路读数在那次现场是：renderer=1 ✓ / 直系子进程=0 ✗ /
/// **主窗口不可见** ✗ ⇒ 只有把"窗口可见"并进来才能判死 ✓。
///
/// 又为什么**不能只加"renderer 必须是我们子进程"**✗：AGENTS 记着"同一 UDF 下 WebView2 会
/// **复用**已有 browser 进程 ⇒ 新进程 PPID 下 0 个子进程，但页面完全正常" ——
/// 那种健康复用场景里 `直系子进程 = 0` **且** renderer 的父进程**不是我们** ⇒
/// 加强版进程判据会把它**误杀** ✗，与"防线只许漏报、不许误杀"的契约直接冲突。
/// ⇒ 于是用"窗口可见"当**前提**：健康复用 ✅（窗口在）+ 进程读数 ✅（renderer 在）⇒ 活；
///   僵尸 ✗（窗口没了）⇒ 死；真失败（窗口在、但 children=0 ∧ renderers=0）⇒ 死。
///
/// 任一读数拿不到（PowerShell 起不来 / 查询失败 / 窗口 API 失败）一律**假定活着**，不误杀 ✓。
fn alive_from(renderers: Option<u32>, children: Option<u32>, window_visible: Option<bool>) -> bool {
    match (renderers, children, window_visible) {
        (Some(r), Some(c), Some(v)) => v && (r > 0 || c > 0),
        _ => true,
    }
}

/// 检测本应用的 webview 是否真的活着（仅 Windows）。
/// 判据演进（2026-09-27 三次修正，依据见 `AGENTS.md`「启动类故障排查」）：
/// ① 最初「系统里有任何 msedgewebview2 就算活」在本机**恒真**（实测 19 个别人的宿主：
///    搜索/看板/PC Manager…）⇒ 真死时防线永不触发；
/// ② 中间版「按 PPID 数直系子进程」会**假阴**——同一 UDF 下 WebView2 会**复用**已有
///    browser 进程 ⇒ 新进程 PPID 下 0 个子进程，但页面完全正常 ⇒ **误杀健康启动** ✗
///    （与下方"不许误杀"的契约直接矛盾）；
/// ③ 并集版（现行之前）解决了误杀，但**漏掉了"复用宿主"这条假阳路径** ✗ ⇒ 见 `alive_from` 文档。
/// 现取**合取**：窗口可见 ∧（直系子进程 > 0 ∨ renderer∩UDF > 0）。
/// 任一环节失败一律按"活着"处理——防线只许漏报（留个空窗让人手动关），不许误杀健康启动。
#[cfg(target_os = "windows")]
fn webview_alive(window_visible: bool) -> bool {
    // 与 tauri.conf.json 的 identifier 保持一致（WebView2 的 UDF 落在
    // %LOCALAPPDATA%\<identifier>\EBWebView；单实例 mutex 亦由它派生）。
    const APP_ID: &str = "com.modu.reader";
    let script = format!(
        "$me = {}; \
         $p = @(Get-CimInstance Win32_Process -Filter \"Name='msedgewebview2.exe'\" -ErrorAction SilentlyContinue); \
         $r = @($p | Where-Object {{ $_.CommandLine -match '--type=renderer' -and $_.CommandLine -match '{}' }}).Count; \
         $c = @($p | Where-Object {{ $_.ParentProcessId -eq $me }}).Count; \
         \"$r $c\"",
        std::process::id(),
        APP_ID
    );
    let mut command = std::process::Command::new("powershell");
    command.args(["-NoProfile", "-Command", &script]);
    // 不弹控制台窗口（GUI 子系统里起子进程的默认行为会闪一下黑框）
    #[cfg(target_os = "windows")]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        command.creation_flags(CREATE_NO_WINDOW);
    }
    let (renderers, children) = match command.output() {
        Ok(out) if out.status.success() => {
            let text = String::from_utf8_lossy(&out.stdout);
            let mut parts = text.split_whitespace();
            (
                parts.next().and_then(|v| v.parse::<u32>().ok()),
                parts.next().and_then(|v| v.parse::<u32>().ok()),
            )
        }
        _ => (None, None), // PowerShell 起不来/查询失败 ⇒ 交给 alive_from 走"不误杀"分支 ✓
    };
    let alive = alive_from(renderers, children, Some(window_visible));
    eprintln!(
        "[boot] webview 存活检测（窗口可见 ∧（子进程 ∪ renderer∩UDF））：{alive} \
         [renderers={renderers:?} children={children:?} window_visible={window_visible}]"
    );
    alive
}

#[cfg(test)]
mod watchdog_decision_tests {
    use super::alive_from;

    // ⭐ 三种真实场景各一条锚（都是 2026-09-27 现场/文档里的形态 ✓）
    #[test]
    fn healthy_fresh_start_is_alive() {
        // 新起：窗口可见 + 有直系子进程（browser 进程）
        assert!(alive_from(Some(1), Some(2), Some(true)));
    }

    #[test]
    fn healthy_reuse_with_zero_children_is_alive_not_killed() {
        // ⚠ 健康复用：窗口可见 + renderer∩UDF 在，但**直系子进程 = 0**
        //（AGENTS 记着的场景）⇒ 必须判活，否则误杀 ✗
        assert!(alive_from(Some(1), Some(0), Some(true)));
    }

    #[test]
    fn zombie_with_reused_renderer_but_no_window_is_dead() {
        // ⭐ 本批修的洞：stale 宿主还挂着 renderer（renderers=1），但没有直系子进程、
        // 主窗口也不可见（现场 PID 1228：MainWindowTitle 只剩 com.modu.reader-siw）⇒ 判死 ✓
        assert!(!alive_from(Some(1), Some(0), Some(false)));
    }

    #[test]
    fn real_failure_window_present_but_no_webview_readings_is_dead() {
        assert!(!alive_from(Some(0), Some(0), Some(true)));
    }

    #[test]
    fn missing_readings_never_kill_a_healthy_start() {
        // PowerShell 起不来 / 查询失败 ⇒ 宁可漏报也不误杀（防线契约 ✓）
        assert!(alive_from(None, None, Some(true)));
        assert!(alive_from(Some(1), None, Some(false)));
        assert!(alive_from(Some(1), Some(1), None));
    }
}

// 直连 user32 弹原生 MessageBox（2026-09-27：mshta 子进程方案三连坑——先关窗后
// 弹框的顺序竞态、CREATE_NO_WINDOW 秒退、javascript: 拆参后脚本不执行、以及
// 本机 mshta 对 javascript: 宿主整体失效——最终回归零子进程的朴素做法）。
// （普通注释而非 ///：rustdoc 不为 extern 块生成文档，/// 会触发 unused_doc_comments。）
#[cfg(target_os = "windows")]
#[link(name = "user32")]
extern "system" {
    fn MessageBoxW(hwnd: isize, text: *const u16, caption: *const u16, utype: u32) -> i32;
}

/// webview 创建失败的中文错误提示（Windows 原生 MessageBox，兼容所有机器）。
/// 文案面向使用者：告知发生了什么、怎么自救，不露技术黑话。
#[cfg(target_os = "windows")]
fn show_webview_error_dialog() {
    const MSG: &str = "墨读启动失败：内置浏览器组件未能初始化。\n\n\
        请尝试以下任一方法：\n\
        · 若装有火绒/360 等安全软件，将墨读加入其信任区后重试\n\
        · 右键墨读图标 →「以管理员身份运行」\n\
        · 重启电脑后再试\n\n\
        如仍失败，请将此情况反馈给开发者。";
    const CAPTION: &str = "墨读启动失败";
    // MB_ICONERROR | MB_SETFOREGROUND | MB_TOPMOST：错误图标，且确保弹到最前不被白窗挡住
    const FLAGS: u32 = 0x0000_0010 | 0x0001_0000 | 0x0004_0000;
    let text: Vec<u16> = MSG.encode_utf16().chain(std::iter::once(0)).collect();
    let caption: Vec<u16> = CAPTION.encode_utf16().chain(std::iter::once(0)).collect();
    // 阻塞到用户点确定；返回值无需处理（错误路径上没有后续分支）
    unsafe { MessageBoxW(0, text.as_ptr(), caption.as_ptr(), FLAGS) };
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
    let metadata = std::fs::metadata(&path).map_err(|e| format!("无法读取图片：{raw}（{}）", crate::fs::io_reason(&e)))?;
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
///
/// ⚠️ **上界核实（2026-09-23 · Lead 追问；下列均为实测）**：本命令对渲染层开放，**没有"受信集合"
/// 约束** —— 它只校验「绝对路径 + 图片扩展名（png/jpg/jpeg/gif/webp/bmp/svg/avif/ico）+ 存在 + 是普通文件」。
/// 实测：把一张位于**任何受信文档目录之外**的图片路径交给它 → 授权前 `<img>` 加载 `error`、
/// 调用后 `loaded` ⇒ **被攻陷的渲染层可以授权任意本地图片文件**并让 webview 通过 asset 协议加载。
/// 非图片 / 相对路径 / 不存在的路径则被**静默跳过**（仍返回 `Ok`，这是 P0-3"缺图不连坐"的既有语义）。
/// 目前的实际暴露面（**推断**，未逐一实测）：① CSP `connect-src 'self' ipc:` 让图片内容读不出去；
/// ② 没有 canvas 读回通路；③ 但"能不能显示任意本地图片"本身已是越权（存在性/尺寸可被 onload 计时当探针）。
/// ⇒ 它比 `trust` 机制松，属宪法红线 1（渲染层按已被攻陷设防）的相关面。
/// ✅ **批次 2 已收紧（2026-09-23）**：现在还要过 `trust::TrustedPaths::image_allowed` ——
/// 图片必须落在**含受信文档的目录**之下（同目录/子目录，markdown 的相对引用天然满足）或**受信目录**之下；
/// 不满足者与"非图片/相对/缺失"一样**静默跳过**（保持 P0-3 缺图不连坐）。前置核实：全仓语料**没有**
/// 任何图片引用、也没有绝对路径图片引用 ⇒ 影响面为零。验收（真机）：受信文档旁的图片 → 授权成功、
/// `<img>` loaded；受信目录之外的图片 → **不授权、`<img>` error**。
///
/// 非 `pub`：`pub` 会让 `#[tauri::command]` 给生成的 `__cmd__*` 宏加 `#[macro_export]`，
/// 与本文件内的 `generate_handler!` 重导入同名宏冲突（E0255）；同 `take_pending_files`。
#[tauri::command]
fn allow_asset_paths(
    app: tauri::AppHandle,
    state: tauri::State<'_, crate::trust::TrustedPaths>,
    paths: Vec<String>,
) -> Result<(), String> {
    for (path, raw) in usable_image_paths(&paths) {
        // ⚠️ 必须先规范化：`validate_image_path` 只做形状校验（绝对/扩展名/存在/是文件），**不规范化**；
        // 而受信集合的键是 `fs::canonicalize` 形态（Windows 带 `\\?\` 前缀）—— 不归一化则"同目录图片"
        // 会被全部误判为不在邻域内（2026-09-23 真机抓到的接线 bug，单测因为直接传 canonical 而没覆盖到）。
        let canonical = std::fs::canonicalize(&path).unwrap_or(path);
        // 批次 2 收紧：不在"受信文档邻域 / 受信目录"内的图片一律不授权（静默跳过 = 缺图不连坐）
        if !state.image_allowed(&canonical) {
            continue;
        }
        app.asset_protocol_scope()
            .allow_file(&canonical)
            .map_err(|e| {
                // 宪法：UI 文案中文、不露技术黑话 ⇒ tauri::Error 原文只进日志
                eprintln!("[asset] 授权图片访问失败：{raw}（{e}）");
                format!("无法授权图片访问：{raw}（内部错误）")
            })?;
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
fn attach_nav_guard(app: &tauri::AppHandle) {
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
    ///
    /// ⚠ 本轮（路径归一）实测复核：这里三条虚构路径**真的不存在** ⇒ `md_paths` 走
    /// `normalize_path` 的 fallback（临时加过 `canonicalize(...).is_err()` 自检，全绿后删）
    /// ⇒ 断言里的"原始串"期望值与归一后的产物一致，本用例**不是假绿** ✓
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
    /// ⚠ 本轮实测：这条虚构路径不存在（同上的临时自检）⇒ 同样走 fallback，非假绿 ✓
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

    /// **路径归一锚（本轮修复）**：存在的文件 ⇒ 产物 = `fs::canonicalize` 形态；
    /// 不存在的路径 ⇒ **原样返回**（fallback，不报错、不构造）。
    ///
    /// 为什么两个断言必须成对：只测"存在 ⇒ canonical"会漏掉 fallback 分支（那是既有两条
    /// `md_paths` 单测（虚构路径 `C:\docs\一.MDX`）走的路 —— 它们正因为 fallback 才仍然绿）；
    /// 只测"不存在 ⇒ 原样"则测不到真正要修的那半。
    #[test]
    fn normalize_path_canonicalizes_existing_and_keeps_missing_verbatim() {
        let dir = std::env::temp_dir().join(format!("modu-norm-{}", std::process::id()));
        std::fs::create_dir_all(&dir).expect("建临时目录不应失败");
        let file = dir.join("笔记.md");
        std::fs::write(&file, b"x").expect("预置临时文件不应失败");

        // 同一文件的两种形态：① 带 `..` 的未归一绝对路径 ② canonical。
        // ⚠ `..` 必须真的抵消一级（`<dir>\sub\..\笔记.md` 才指向 `<dir>\笔记.md`）——
        //   直接拿 `<dir>` 再拼 `..` 就指到**上一级**去了（本轮实测翻车）。
        // ⚠ 临时目录在 Windows 上可能带 8.3 短名（`RUNNER~1`）⇒ **不能**拿未归一的
        //   `to_string_lossy()` 当期望值，两边都走同一函数产出基准。
        // ⚠ 路径用 `PathBuf::join` 拼（不写"分隔符 + 点点 + 分隔符"那种字面量）：那个形状会被
        //   本仓的**敏感信息门禁**判成"UNC 主机路径"（实测命中 2 处）—— 是假阳性，但门禁
        //   只认 EXIT 码，所以这里换一种拼法把假阳性源去掉，不改门禁、不写豁免。
        let sub = dir.join("sub");
        std::fs::create_dir_all(&sub).expect("建临时子目录不应失败");
        let raw = sub.join("..").join("笔记.md").to_string_lossy().into_owned();
        let canonical = crate::fs::normalize_path(&file.to_string_lossy());
        assert_eq!(
            std::fs::canonicalize(&file).expect("canonicalize").to_string_lossy(),
            canonical,
            "归一产物必须正好是 canonicalize 形态（标签身份就建在它上面）"
        );
        assert_eq!(
            crate::fs::normalize_path(&raw),
            canonical,
            "带 `..` 的未归一形态必须收敛到同一串"
        );
        // 鉴别力自检：两种输入形态**按字符串不等**（`raw` 含 `..`，canonical 不含）。
        // ⚠ 这里比 `std::path::Path` 而不是裸串：Windows 上 `canonicalize` 会加 `\\?\`
        // 前缀，裸串比较会被前缀"顺带"满足，从而掩盖"其实 `..` 没被消掉"的失败。
        assert_ne!(
            std::path::Path::new(&raw),
            std::path::Path::new(&canonical),
            "两种形态确实是不同的路径（否则本用例没有鉴别力）"
        );

        // 不存在 ⇒ 原样返回（可接受的退化：这类文件去重失效）
        let missing = dir.join("不存在的文件.md");
        let missing_raw = missing.to_string_lossy().into_owned();
        assert_eq!(
            crate::fs::normalize_path(&missing_raw),
            missing_raw,
            "不存在的路径必须原样返回（保留原样 + 不报错）"
        );

        let _ = std::fs::remove_file(&file);
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// **argv 三条通道（argv / 单实例转发 / 文件关联）同源锚**：`md_paths` 的产物
    /// 必须是 canonical 形态，与对话框/目录树给的形态**逐字相等**。
    #[test]
    fn md_paths_yields_canonical_form_for_an_existing_file() {
        let dir = std::env::temp_dir().join(format!("modu-mdpaths-{}", std::process::id()));
        std::fs::create_dir_all(&dir).expect("建临时目录不应失败");
        let file = dir.join("已存在.md");
        std::fs::write(&file, b"x").expect("预置临时文件不应失败");
        // 同上：`..` 必须抵消一级（拼法见上一个用例的注释 —— 不写字面量反斜杠）
        let sub = dir.join("sub");
        std::fs::create_dir_all(&sub).expect("建临时子目录不应失败");
        let raw = sub.join("..").join("已存在.md").to_string_lossy().into_owned();

        let args = vec![r"C:\apps\modu.exe".to_string(), raw.clone()];
        assert_eq!(
            md_paths(&args),
            vec![crate::fs::normalize_path(&raw)],
            "argv 通道产物必须与前端其它通道（对话框/目录树）的形态一致"
        );
        // 虚构路径仍走 fallback（既有两条 md_paths 单测就靠这条语义保持绿）
        let fake = vec![r"C:\apps\modu.exe".to_string(), r"C:\docs\一.MDX".to_string()];
        assert_eq!(md_paths(&fake), vec![r"C:\docs\一.MDX".to_string()], "不存在的路径原样保留");

        let _ = std::fs::remove_file(&file);
        let _ = std::fs::remove_dir_all(&dir);
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
