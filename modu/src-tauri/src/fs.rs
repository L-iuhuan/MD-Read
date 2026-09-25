//! 文件读写与编码契约：读取时 BOM 优先、chardetng 兜底检测；写回时保持原编码与
//! 原字节形态（BOM/行尾不丢失）——D7 红线："保持原编码与原字节形态，禁止静默转换"。
//!
//! R-01 / P1-6：读写在**受信路径集合**内才放行（见 `crate::trust` 的信任模型与
//! `docs/tasks/Phase2-前-决策登记-2026-09-23.md` 的 D-09/D-10）。
//! 注册只能由 OS/用户动作触发（Rust 侧对话框 / 拖放 / argv / 持久化清单），
//! **没有任何渲染层可调的注册命令** —— 否则攻陷页面可以自证授权。

use chardetng::{EncodingDetector, Iso2022JpDetection, Utf8Detection};
use encoding_rs::Encoding;
use serde::Serialize;
use tauri::Manager;
use tauri_plugin_dialog::DialogExt;

use crate::trust::{deny_message, DenyReason, TrustedPaths};

/// 读取结果：解码后的文本 + 实际使用的编码名（encoding_rs 规范名，可直接回传 save_file）
/// + BOM/CRLF 保真标志（写回时据此恢复原字节形态）。
#[derive(Serialize, Debug)]
pub struct LoadedFile {
    pub text: String,
    pub encoding: String,
    /// 原文件带 BOM（UTF-8/UTF-16LE/BE）则为 true；写回时按此补回原 BOM。
    pub bom: bool,
    /// CRLF 行数多于纯 LF 行数则为 true；前端据此设置编辑器行尾，防止 \r\n 被静默归一为 \n。
    pub crlf: bool,
}

/// 单次遍历统计行尾，返回 (CRLF 行数, 纯 LF 行数)。
/// \r\n 计入 CRLF；孤立 \n 计入 LF；孤立 \r（经典 Mac）不计。
fn count_line_endings(bytes: &[u8]) -> (usize, usize) {
    let mut crlf = 0usize;
    let mut lf = 0usize;
    for (i, &b) in bytes.iter().enumerate() {
        if b == b'\n' {
            if i > 0 && bytes[i - 1] == b'\r' {
                crlf += 1;
            } else {
                lf += 1;
            }
        }
    }
    (crlf, lf)
}

/// 解码字节流：有 BOM 按 BOM 隐含编码；无 BOM 用 chardetng 全量喂入（last=true）猜测。
/// 坏字节由 encoding_rs 替换为 U+FFFD，不视为失败。
/// 返回 (文本, 编码名, 是否带 BOM)。
fn decode_bytes(bytes: &[u8]) -> (String, String, bool) {
    let (encoding, bom) = match Encoding::for_bom(bytes) {
        Some((encoding, _bom_len)) => (encoding, true),
        None => {
            let mut detector = EncodingDetector::new(Iso2022JpDetection::Deny);
            detector.feed(bytes, true);
            (detector.guess(None, Utf8Detection::Allow), false)
        }
    };
    let (text, _had_errors) = encoding.decode_with_bom_removal(bytes);
    (text.into_owned(), encoding.name().to_string(), bom)
}

/// IO 错误 → 面向使用者的中文原因（**不把 `os error 2` 这类英文塞进 UI**）。
fn io_reason(error: &std::io::Error) -> &'static str {
    match error.kind() {
        std::io::ErrorKind::NotFound => "文件不存在或已被移动",
        std::io::ErrorKind::PermissionDenied => "没有访问权限",
        std::io::ErrorKind::IsADirectory => "不是文件",
        _ => "读取失败（文件可能被占用或已损坏）",
    }
}

/// 读取文件并检测编码与字节形态（BOM/CRLF）。错误信息面向使用者，含路径与原因。
/// 受信校验在命令层（`read_file`）完成，这里只处理已放行的路径。
pub fn read_file_at(path: &str) -> Result<LoadedFile, String> {
    let bytes = std::fs::read(path).map_err(|e| format!("无法读取文件：{path}（{}）", io_reason(&e)))?;
    let (text, encoding, bom) = decode_bytes(&bytes);
    let (crlf_count, lf_count) = count_line_endings(&bytes);
    Ok(LoadedFile {
        text,
        encoding,
        bom,
        crlf: crlf_count > lf_count,
    })
}

/// 读入口：**先过受信校验**（返回规范化路径，读写都用它落盘），再读盘。
pub fn read_file_checked(trust: &TrustedPaths, raw: &str) -> Result<LoadedFile, String> {
    let canonical = trust.allowed_for_read(raw)?;
    read_file_at(&canonical.to_string_lossy())
}

/// `read_file` 命令：渲染层唯一读入口（受信集合外的路径一律拒，文案见 `trust::deny_message`）。
#[tauri::command]
pub fn read_file(state: tauri::State<TrustedPaths>, path: String) -> Result<LoadedFile, String> {
    read_file_checked(&state, &path)
}

/// 按编码取对应 BOM 字节。GB18030 等无 BOM 概念的编码返回空切片
/// （encoding_rs 的 encode 不会自动写 BOM，UTF-16 也须手动补）。
fn bom_bytes_for(encoding: &Encoding) -> &'static [u8] {
    if encoding == encoding_rs::UTF_8 {
        b"\xEF\xBB\xBF"
    } else if encoding == encoding_rs::UTF_16LE {
        b"\xFF\xFE"
    } else if encoding == encoding_rs::UTF_16BE {
        b"\xFE\xFF"
    } else {
        &[]
    }
}

/// 按原编码写回文件。D7 红线："保持原编码与原字节形态，禁止静默转换"——
/// 编码名必须来自读取时的检测结果；未知编码名直接报错，绝不回退 UTF-8。
/// bom=true 时写回前补原 BOM（UTF-8 → EF BB BF，UTF-16LE/BE → 各自魔数）；
/// GB18030 无 BOM 概念，bom=true 时忽略并按无 BOM 写（仍返回成功）。
pub fn save_file_at(path: &str, text: &str, encoding: &str, bom: bool) -> Result<(), String> {
    let encoding = Encoding::for_label(encoding.as_bytes())
        .ok_or_else(|| format!("无法识别的编码名称：{encoding}"))?;
    let (encoded, _used, _had_errors) = encoding.encode(text);
    let bom_prefix: &[u8] = if bom { bom_bytes_for(encoding) } else { &[] };
    let mut out = Vec::with_capacity(bom_prefix.len() + encoded.len());
    out.extend_from_slice(bom_prefix);
    out.extend_from_slice(encoded.as_ref());
    std::fs::write(path, out).map_err(|e| format!("无法保存文件：{path}（{}）", io_reason(&e)))
}

/// 写入口：**先过受信校验**（未受信的文件一个字节都不写），再落盘。
pub fn save_file_checked(
    trust: &TrustedPaths,
    raw: &str,
    text: &str,
    encoding: &str,
    bom: bool,
) -> Result<(), String> {
    let canonical = trust.allowed_for_save(raw)?;
    save_file_at(&canonical.to_string_lossy(), text, encoding, bom)
}

/// `save_file` 命令：渲染层唯一写入口（autosave / 关窗落盘 / 编辑态保存都经此）。
#[tauri::command]
pub fn save_file(
    state: tauri::State<TrustedPaths>,
    path: String,
    text: String,
    encoding: String,
    bom: bool,
) -> Result<(), String> {
    save_file_checked(&state, &path, &text, &encoding, bom)
}

/// 打开文件对话框（Rust 侧）并把用户**亲手选中**的 Markdown 文件登记为受信。
///
/// 为什么把对话框从渲染层搬到 Rust：`plugin-dialog` 的 JS `open()` 只把结果交给渲染层，
/// Rust 无法判断"这个路径是不是用户选的"；一旦存在渲染层可调的注册命令，攻陷页面就能
/// `注册任意路径 → 读取任意文件`（设计稿 §7.2）。放在 Rust 侧后，受信的唯一来源是
/// **用户在原生对话框里的真实选择**（渲染层最多能让对话框弹出来，弹出来也必须用户点）。
///
/// 取消 → 返回空列表（前端静默结束）；选中了但校验失败 → 返回中文原因（不静默吞掉）。
#[tauri::command]
pub async fn pick_markdown_files(
    app: tauri::AppHandle,
    state: tauri::State<'_, TrustedPaths>,
) -> Result<Vec<String>, String> {
    let dialog_app = app.clone();
    let picked = tauri::async_runtime::spawn_blocking(move || {
        dialog_app
            .dialog()
            .file()
            .set_title("打开 Markdown 文件")
            .add_filter("Markdown", &["md", "markdown", "mdx"])
            .blocking_pick_files()
    })
    .await
    .map_err(|error| format!("打开文件对话框失败：{error}"))?;
    let Some(files) = picked else {
        return Ok(Vec::new()); // 用户取消
    };
    let mut granted: Vec<String> = Vec::new();
    let mut first_error: Option<String> = None;
    for file in files {
        let Ok(path) = file.into_path() else {
            continue;
        };
        let raw = path.to_string_lossy().into_owned();
        match state.trust_existing(&raw) {
            Ok(canonical) => granted.push(canonical.to_string_lossy().into_owned()),
            Err(message) => {
                if first_error.is_none() {
                    first_error = Some(message);
                }
            }
        }
    }
    if granted.is_empty() {
        if let Some(message) = first_error {
            return Err(message);
        }
    }
    Ok(granted)
}

/// 注册受信目录（工作区/另存为父目录）。**当前无渲染层入口**：留给 D-11 文件夹工作区
/// 与将来的「另存为」接线；此处不放 `#[tauri::command]`，避免出现"渲染层可自证授权"的洞。
pub fn trust_directory(state: &TrustedPaths, raw: &str) -> Result<(), String> {
    state.trust_dir(raw).map(|_| ())
}

/// 撤销受信（关标签时尽力而为；不调也安全——能进集合的前提就是用户真打开过）。
pub fn forget_trusted(state: &TrustedPaths, raw: &str) {
    state.forget(raw);
}

/// 供 `lib.rs` 的拖放/argv 处理器使用的批量注册：返回成功注册的文件数（失败逐条忽略）。
pub fn trust_all_existing(state: &TrustedPaths, paths: &[String]) -> usize {
    paths.iter().filter(|raw| state.trust_existing(raw).is_ok()).count()
}

/// 把 OS 传来的路径转成面向使用者的中文提示（拖放失败时用）。
pub fn untrusted_hint(raw: &str) -> String {
    deny_message("读取", raw, DenyReason::Untrusted)
}

/// 取不到应用配置目录时的兜底：内存集合（本次会话仍可用，重启后重来）。
pub fn load_trusted_store(app: &tauri::AppHandle) -> TrustedPaths {
    match app.path().app_config_dir() {
        Ok(dir) => TrustedPaths::load(dir.join("trusted-paths.json")),
        Err(error) => {
            println!("[trust] 取不到配置目录（{error}），受信清单仅存在于本次会话");
            TrustedPaths::in_memory()
        }
    }
}

/// 安全收口的配置回归锁（P1-6 子项 1/2）。放在 fs.rs 而非 lib.rs：lib.rs 由其它车道持有，
/// 且本组断言的主题正是「渲染层可触达面」——fs 命令所在模块顺手看守最省。
/// 断言对象是**随包发布的** `tauri.conf.json` 原文（不是合并后的运行时配置）：
///   1. `withGlobalTauri` 必须为 false —— 关掉 window.__TAURI__，渲染层只能走
///      `@tauri-apps/api` 模块导入（与 src/ 现状一致，已全量 grep 核实无 __TAURI__ 引用）；
///   2. CSP 里不得再出现 `localhost:1420` —— 开发期 ws/http 只活在 `.verify/dev/` 的
///      dev overlay 里，随包配置不带 dev 端点。
/// 这是防"手滑改回去"的静态锁，不替代实机 CDP 验收。
#[cfg(test)]
mod shipped_config_guard {
    /// 随包配置原文。
    fn shipped_config() -> String {
        let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("tauri.conf.json");
        std::fs::read_to_string(&path).expect("随包 tauri.conf.json 应可读")
    }

    #[test]
    fn global_tauri_is_off_in_shipped_config() {
        let text = shipped_config();
        assert!(
            text.contains("\"withGlobalTauri\": false"),
            "随包配置必须显式关掉 withGlobalTauri（渲染层不应拿到 window.__TAURI__）"
        );
        assert!(
            !text.contains("\"withGlobalTauri\": true"),
            "随包配置不得重新打开 withGlobalTauri"
        );
    }

    #[test]
    fn shipped_csp_has_no_dev_endpoints() {
        let text = shipped_config();
        // 只锁 CSP 这一串（不能用「全文不含 localhost:1420」——`build.devUrl` 本来就是
        // http://localhost:1420，那是开发期地址，与安全策略无关）。
        const EXPECTED_CSP: &str = concat!(
            "default-src 'self'; connect-src 'self' ipc: http://ipc.localhost; ",
            "img-src 'self' asset: http://asset.localhost data: blob:; ",
            "style-src 'self' 'unsafe-inline'; font-src 'self' data:; ",
            "script-src 'self'; object-src 'none'; base-uri 'self'"
        );
        assert!(
            text.contains(EXPECTED_CSP),
            "随包 CSP 与冻结值不一致——开发期端点（ws://localhost:1420 等）只允许出现在 .verify/dev/ overlay"
        );
        let csp_line = text
            .lines()
            .find(|line| line.contains("\"csp\""))
            .expect("随包配置应显式声明 CSP（宪法红线 1）");
        assert!(
            !csp_line.contains("localhost:1420"),
            "CSP 里不得残留开发期端点：{csp_line}"
        );
    }
}

/// R-01：读写接入受信校验后的行为（含"被拒时不改磁盘"）。
#[cfg(test)]
#[path = "fs_trust_tests.rs"]
mod fs_trust_tests;


