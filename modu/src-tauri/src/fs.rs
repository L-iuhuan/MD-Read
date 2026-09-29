//! 文件读写与编码契约：读取时 BOM 优先、chardetng 兜底检测；写回时保持原编码与
//! 原字节形态（BOM/行尾不丢失）——D7 红线："保持原编码与原字节形态，禁止静默转换"。
//!
//! R-01 / P1-6：读写在**受信路径集合**内才放行（见 `crate::trust` 的信任模型与
//! `docs/tasks/Phase2-前-决策登记-2026-09-23.md` 的 D-09/D-10）。
//! 注册只能由 OS/用户动作触发（Rust 侧对话框 / 拖放 / argv / 持久化清单），
//! **没有任何渲染层可调的注册命令** —— 否则攻陷页面可以自证授权。

use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};

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
/// pub 供 lib.rs / print.rs 统一复用（P1-4 错误文案泄漏修复，2026-09-26）。
pub fn io_reason(error: &std::io::Error) -> &'static str {
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

/// **路径归一的唯一实现**（全仓只此一份，两侧都调它：Rust 直接调、渲染层经
/// `canonical_path` 命令调 ⇒ 不存在第二份归一逻辑）。
///
/// 为什么需要它：同一文件会以**不同字符串形态**进来 —— argv/文件关联是"用户/系统给的
/// 原始串"（可能是相对路径、含 `..`、8.3 短名、大小写不同、`/` 与 `\` 混用），而原生
/// 对话框（`pick_markdown_files`）与目录树（`list_dir`）给的是 `fs::canonicalize` 形态。
/// 标签层按**字符串**去重（`tabs.ts` 的 `find`，路径是标签的身份），两种形态就是两个标签 ⇒
/// 开出两个同名标签 ✗。故**在渲染层拿到路径之前**把全局收敛到 canonical 形态。
///
/// ⚠ `canonicalize` 失败（不存在 / 不可读 / 无权限 / 网络 UNC 打不通）⇒ **保留原样返回**：
/// 这不是错误路径 —— 文件可以是"刚被移走""稍后才出现"，而"这个串去重不生效"是**可接受**的
/// 退化（顶多多一个标签），远好过在这里报错把打开流程打断。同理，本函数**不产生任何用户可见
/// 文案**，纯粹是路径形态整理。
pub fn normalize_path(raw: &str) -> String {
    std::fs::canonicalize(raw)
        .map(|p| p.to_string_lossy().into_owned())
        .unwrap_or_else(|_| raw.to_string())
}

/// `canonical_path` 命令（IPC 名）：**渲染层的拖放入口**用它（OS 拖放给的是原始串，
/// 不经对话框也不经 argv ⇒ 必须单独归一）。
///
/// ⚠ **命令名只能与函数名不同**：Rust 的函数与 `#[tauri::command]` 展开出的宏
/// 共用值命名空间 ⇒ 与上面那个 `pub fn normalize_path` 同名会 `E0428 定义多次`（实测）。
/// 命令名面向渲染层（与 `read_file` / `list_dir` 同族，动词_名词），实现体仍**只有一份**
/// —— 就是 `normalize_path`，本函数只做转发。
///
/// ⚠ 这不是授权入口：它**只整理路径形态**，不做任何受信判定、不写盘、不登记 ——
/// 所以攻陷页面拿它得不到任何新能力（受信登记仍在 `trust_all_existing` 里按 canonical 做）。
#[tauri::command]
pub fn canonical_path(raw: &str) -> String {
    normalize_path(raw)
}

/// 目录项（D-11 文件夹工作区）：**只有名字与类型** —— **不读文件内容** ✓
/// `is_markdown` **只看扩展名**（不打开文件、不嗅探内容）⇒ 属性级，性能与隐私双属性 ✓
#[derive(serde::Serialize, Debug)]
pub struct DirEntryOut {
    pub name: String,
    pub is_dir: bool,
    pub is_markdown: bool,
}

/// 目录列表（D-11）：`truncated`/`total` 供 UI 显示「还有 N 项」✓
/// ⚠ `total` 允许为 `None`：**绝不为填它再遍历一遍目录** ✗（上限由提交④实测决定）
#[derive(serde::Serialize, Debug)]
pub struct DirListing {
    pub path: String,
    pub entries: Vec<DirEntryOut>,
    pub truncated: bool,
    pub total: Option<usize>,
}

/// 列目录（受信校验后）：**单遍** `read_dir`、**收满 `limit` 即停止收集** ✓
/// · **零内容读取**：只调 `read_dir` / `file_type` / `file_name` ✓（by construction）
/// · **顺序确定**：目录在前，再按名称的**码位序**（Rust `Ord`，**不是本地化排序** ✗）
///   ⇒ 顺序不依赖文件系统返回次序，UI 不抖动、测试不 flaky ✓
/// · 符号链接**不跟随**（`file_type` 给的是链接自身）⇒ 不会因链接越界 ✓
pub fn list_dir_at(trust: &TrustedPaths, raw: &str, limit: Option<usize>) -> Result<DirListing, String> {
    let canonical = trust.allowed_for_list_dir(raw)?;
    let read = std::fs::read_dir(&canonical)
        .map_err(|e| format!("无法列出目录：{raw}（{}）", io_reason(&e)))?;
    let mut entries: Vec<DirEntryOut> = Vec::new();
    let mut truncated = false;
    for item in read {
        let Ok(entry) = item else { continue };
        if let Some(max) = limit {
            if entries.len() >= max {
                truncated = true;
                break; // 单遍：收满即停，**不**为了 total 再走一遍 ✗
            }
        }
        let file_type = match entry.file_type() {
            Ok(kind) => kind,
            Err(_) => continue, // 类型读不到就跳过（不因为一项不可达而整体失败）
        };
        let name = entry.file_name().to_string_lossy().into_owned();
        let is_dir = file_type.is_dir();
        let is_markdown = !is_dir && {
            let lower = name.to_lowercase();
            lower.ends_with(".md") || lower.ends_with(".markdown") || lower.ends_with(".mdx")
        };
        entries.push(DirEntryOut { name, is_dir, is_markdown });
    }
    entries.sort_by(|a, b| b.is_dir.cmp(&a.is_dir).then_with(|| a.name.cmp(&b.name)));
    Ok(DirListing {
        path: canonical.to_string_lossy().into_owned(),
        entries,
        truncated,
        total: None, // ⚠ 不为了填它多遍历一遍 ✓
    })
}

/// `list_dir` 命令：渲染层展开目录树时调用。**校验在命令内部**（`allowed_for_list_dir`）✓
#[tauri::command]
pub fn list_dir(
    state: tauri::State<TrustedPaths>,
    path: String,
    limit: Option<usize>,
) -> Result<DirListing, String> {
    list_dir_at(&state, &path, limit)
}

/// 移除工作区（设计 §3.2「移除工作区」）：把该目录**从受信目录集合里删掉** ⇒ **立即生效** ✓。
///
/// ⚠ 这是**渲染层唯一**被允许的受信集合写操作 ✓，且方向**只可能收窄** ✗⇒✓：
/// 它**不能授予**任何访问 ✗（命令里没有"加目录"的能力 ✓）；最坏情形只是"用户自己的授权被静默删掉" ✓
/// ⇒ 那是**便利性损失，不是越权** ✓（R-01 的本意是防"渲染层**自我授权**"✗，与此不冲突 ✓ —— 见 `AGENTS.md` 模型澄清）
/// 护栏落在 `TrustedPaths::forget_dir` 里 ✓：只动 `dirs` ✓ · **必须已受信**否则拒绝 ✓ · 删后立即落盘 ✓ ·
/// ⚠ 目录**已消失**时回退为**全等匹配**撤销 ✓（绝不前缀 ✗）
#[tauri::command]
pub fn remove_workspace(state: tauri::State<TrustedPaths>, path: String) -> Result<String, String> {
    state
        .forget_dir(&path)
        .map(|canonical| canonical.to_string_lossy().into_owned())
}

/// `pick_workspace_directory` 命令：**授权**入口（D-11）。
/// ⚠ **不接受路径参数** —— 路径只能来自用户在**原生对话框**里的真实选择 ✓
/// （渲染层最多能让对话框弹出来，弹出来也必须用户点 ⇒ 不存在"传路径即授权"的命令 ✓）
/// **取消 ⇒ `Ok(None)`**（取消不是错误 ✓）；选中后登记失败 ⇒ 返回中文原因（不静默吞）✓
#[tauri::command]
pub async fn pick_workspace_directory(
    app: tauri::AppHandle,
    state: tauri::State<'_ , TrustedPaths>,
) -> Result<Option<String>, String> {
    let dialog_app = app.clone();
    let picked = tauri::async_runtime::spawn_blocking(move || {
        dialog_app
            .dialog()
            .file()
            .set_title("选择文件夹作为工作区")
            .blocking_pick_folder()
    })
    .await
    .map_err(|error| format!("打开文件夹对话框失败：{}", error))?;
    let Some(folder) = picked else {
        return Ok(None); // 用户取消 ✓
    };
    let Ok(path) = folder.into_path() else {
        return Err("选择的文件夹不可用".to_string());
    };
    let raw = path.to_string_lossy().into_owned();
    state.trust_dir(&raw)?;
    Ok(Some(raw))
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
///
/// 落盘**不**直接 `std::fs::write` 目标——那等于先截断再写：自动保存默认每 2s 一次，
/// 「截断到写完」之间的窗口里进程崩溃/断电/被强杀 ⇒ 用户的 .md 只剩半截且无备份。
/// 改为「同目录临时文件 → `commit_save` 原子替换」（同 print.rs 导出链的思路），
/// 任何失败路径只清理自己的临时产物，目标文件保持原内容逐字节不变。
pub fn save_file_at(path: &str, text: &str, encoding: &str, bom: bool) -> Result<(), String> {
    let encoding = Encoding::for_label(encoding.as_bytes())
        .ok_or_else(|| format!("无法识别的编码名称：{encoding}"))?;
    let (encoded, _used, _had_errors) = encoding.encode(text);
    let bom_prefix: &[u8] = if bom { bom_bytes_for(encoding) } else { &[] };
    let mut out = Vec::with_capacity(bom_prefix.len() + encoded.len());
    out.extend_from_slice(bom_prefix);
    out.extend_from_slice(encoded.as_ref());
    let dest = Path::new(path);
    // 只读目标 ⇒ 直接拒绝（与旧 std::fs::write 路径同判：写只读文件必被拒）。
    // 若放行，下面的改名三步会成功、只读标记被顺带丢掉——崩溃安全改造不得顺带改保存策略。
    // 文案「没有访问权限」与 io_reason 的 PermissionDenied 分支同源。
    if std::fs::metadata(dest).map(|m| m.permissions().readonly()).unwrap_or(false) {
        return Err(format!("无法保存文件：{path}（没有访问权限）"));
    }
    let temp = temp_save_path(dest);
    if let Err(e) = std::fs::write(&temp, &out) {
        cleanup_temp(&temp);
        return Err(format!("无法保存文件：{path}（{}）", io_reason(&e)));
    }
    commit_save(&temp, dest).map_err(|e| format!("无法保存文件：{path}（{}）", io_reason(&e)))
}

/// 保存链的去重序号：同进程内并发/连续保存的临时、备份名互不覆盖（同 print.rs 的 TEMP_SEQ）。
static SAVE_SEQ: AtomicU64 = AtomicU64::new(0);

/// 保存链的中转文件路径（`tmp`/`bak` 两用）：与目标**同目录**（同卷 ⇒ 收尾的改名才是
/// 原子替换，不跨卷复制）。命名沿用 print.rs::temp_export_path 的风格：
/// `<主名>.<marker>-<pid>-<纳秒>-<序号>.<扩展名>`——每次调用都不同（2s 一次的自动保存
/// 也不互相覆盖），扩展名沿用目标扩展名（缺省 md）。
fn staged_save_path(dest: &Path, marker: &str) -> PathBuf {
    let nanos = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.subsec_nanos())
        .unwrap_or(0);
    let seq = SAVE_SEQ.fetch_add(1, Ordering::Relaxed);
    let stem = dest
        .file_stem()
        .map(|s| s.to_string_lossy().into_owned())
        .unwrap_or_else(|| "save".to_string());
    let ext = dest
        .extension()
        .map(|s| s.to_string_lossy().into_owned())
        .unwrap_or_else(|| "md".to_string());
    let name = format!("{stem}.{marker}-{}-{nanos}-{seq}.{ext}", std::process::id());
    dest.with_file_name(name)
}

/// 保存的临时文件：新内容先完整落在这里，目标文件此期间保持原内容。
fn temp_save_path(dest: &Path) -> PathBuf {
    staged_save_path(dest, "tmp")
}

/// 替换期间的备份：原内容暂存处；提交后删除，失败时改回原名。
fn backup_save_path(dest: &Path) -> PathBuf {
    staged_save_path(dest, "bak")
}

/// 清掉保存链自己的中转产物（失败路径只删自己造的文件，目标一个字节都不动）。
fn cleanup_temp(staged: &Path) {
    let _ = std::fs::remove_file(staged);
}

/// 保存收尾（Windows 覆盖语义三步走，思路同 print.rs 的原子导出链）：
/// ① 原文件改名让位（内容仍在同目录备份里）→ ② 临时文件原子改名到位 → ③ 删除备份。
/// 任一步失败 ⇒ 清理临时产物、把备份改回原名——目标要么是完整旧内容、要么是完整新内容，
/// 绝无「半截文件」形态。目标不存在（新文件）时直接改名到位；异常目标（目录等）让改名
/// 自然失败、原样保留，不做任何搬动。
fn commit_save(temp: &Path, dest: &Path) -> Result<(), std::io::Error> {
    if !dest.is_file() {
        return std::fs::rename(temp, dest).map_err(|e| {
            cleanup_temp(temp);
            e
        });
    }
    let backup = backup_save_path(dest);
    // ① 原文件 → 备份：让出目标名，原内容仍在盘上；失败 ⇒ 目标未动，只清临时产物
    if let Err(e) = std::fs::rename(dest, &backup) {
        cleanup_temp(temp);
        return Err(e);
    }
    // ② 临时文件 → 目标：同目录改名即原子生效，此后本次保存视为已提交
    if let Err(e) = std::fs::rename(temp, dest) {
        let _ = std::fs::rename(&backup, dest); // 回滚：备份改回原名，恢复原文件（同卷改名，正常必成）
        cleanup_temp(temp);
        return Err(e);
    }
    // ③ 删除备份（此刻保存已成功；删不掉也只是残留一个备份文件，不损数据）
    cleanup_temp(&backup);
    Ok(())
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
    .map_err(|error| format!("打开文件对话框失败：{}", error))?;
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
/// 拖放注册（**纯函数** ✓ ⇒ 可直接单测，不必启动应用 ✓）：拖入项按【文件 / 目录】分流登记。
///
/// ⚠ 为什么**只有这里**登记目录（R-01 第一条 ✓）：**OS 拖放**是四个授权来源之一 ✓，
/// 且**路径来自 OS 事件本身** ⇒ 渲染层**伪造不了** ✓。
/// ⇒ ⛔ **绝不**新增「渲染层传路径」的命令（如 `trust_workspace_dir(path)` ✗）——
///    那等于让被攻陷的渲染层**自我授权任意目录** ✗（本会话已为此挡过一次 ✓）。
///
/// 文件 ⇒ 复用下面那个 `trust_all_existing`（只登记**存在的 Markdown 文件** ✓ 语义不变 ✓）；
/// 目录 ⇒ `canonicalize` ⇒ `is_dir` ⇒ 以 **canonical 小写 + \\?\** 键入 `dirs` ⇒ `persist()` ✓。
/// 返回 `(文件登记数, 目录登记数, 首个被登记的目录)` ✓（供日志/前端提示用 ✓）。
pub fn trust_dropped(trust: &TrustedPaths, raws: &[String]) -> (usize, usize, Option<String>) {
    let mut dirs = 0usize;
    let mut first_dir: Option<String> = None;
    for raw in raws {
        let Ok(canonical) = std::fs::canonicalize(raw) else {
            continue; // 不存在 ⇒ 跳过（不登记 ✓）
        };
        if canonical.is_dir() {
            // trust_dir 内部再做 canonicalize + is_dir + 入 dirs + persist ✓（幂等 ✓）
            if let Ok(dir) = trust.trust_dir(&canonical.to_string_lossy()) {
                dirs += 1;
                if first_dir.is_none() {
                    first_dir = Some(dir.to_string_lossy().into_owned());
                }
            }
        }
    }
    let files = trust_all_existing(trust, raws);
    (files, dirs, first_dir)
}
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

// ==========================================================================
// 注册表：设为 .md 默认应用（2026-09-27 用户反馈「默认打开方式里选不到墨读」）
// ==========================================================================

/// 把墨读注册为 .md/.markdown/.mdx 的默认打开候选（HKCU 用户级，无需管理员）。
///
/// 背景：MSI 安装器写了 ProgID（`MoDu.md` 等）与扩展默认值，但扩展的
/// `OpenWithProgids` 链接键缺失——本机实测（火绒 HIPS 对扩展关联键重点防护，
/// 拦掉了安装器的写入），导致系统「打开方式 / 默认应用」列表里看不到墨读。
/// 这里按**当前 exe 路径**补齐全部注册项，随后打开系统默认应用页，
/// 用户点选「墨读」即完成默认设置。
///
/// 实现走 `reg.exe` 子进程（零依赖；HKCU 写入不需提权）。
/// 安全软件可能弹窗询问关联变更——这是预期的用户确认动作。
#[tauri::command]
pub fn register_markdown_default() -> Result<(), String> {
    let exe = std::env::current_exe()
        .map_err(|e| format!("无法确定程序路径：{}", io_reason(&e)))?;
    let exe_str = exe.to_string_lossy().into_owned();
    let icon = format!("\"{exe_str}\",0");
    let open_cmd = format!("\"{exe_str}\" \"%1\"");
    const EXTS: [(&str, &str); 3] = [
        (".md", "MoDu.md"),
        (".markdown", "MoDu.markdown"),
        (".mdx", "MoDu.mdx"),
    ];
    for (ext, progid) in EXTS {
        // ProgID：图标 + 打开命令（用户级副本；HKLM 那份不受影响）
        reg_set_default(&format!(r"HKCU\Software\Classes\{progid}\DefaultIcon"), &icon)?;
        reg_set_default(
            &format!(r"HKCU\Software\Classes\{progid}\shell\open\command"),
            &open_cmd,
        )?;
        // 扩展 → ProgID 链接：**「打开方式」候选列表的来源**（安装器缺的正是这个键）
        reg_set_named(
            &format!(r"HKCU\Software\Classes\{ext}\OpenWithProgids"),
            progid,
            "",
        )?;
        // Capabilities\FileAssociations：让「设置 → 默认应用」页面能列出墨读
        reg_set_named(r"HKCU\Software\MoDu\Capabilities\FileAssociations", ext, progid)?;
    }
    reg_set_named(r"HKCU\Software\MoDu\Capabilities", "ApplicationName", "墨读 MoDu")?;
    reg_set_named(
        r"HKCU\Software\MoDu\Capabilities",
        "ApplicationDescription",
        "本地 Markdown 阅读器",
    )?;
    reg_set_named(
        r"HKCU\Software\RegisteredApplications",
        "MoDu",
        r"Software\MoDu\Capabilities",
    )?;
    // 打开系统默认应用页——注册完成后用户点选墨读即可（UserChoice 受系统哈希保护，
    // 应用不能代写，打开设置页是 Windows 允许的引导方式）
    let _ = std::process::Command::new("explorer.exe")
        .arg("ms-settings:defaultapps")
        .spawn();
    Ok(())
}

/// reg add <key> /ve /d <value> /f —— 写「默认」值（DefaultIcon / open\command 的用法）
fn reg_set_default(key: &str, value: &str) -> Result<(), String> {
    run_reg(&["add", key, "/ve", "/d", value, "/f"])
}

/// reg add <key> /v <name> /t REG_SZ /d <data> /f —— 写具名值
fn reg_set_named(key: &str, name: &str, data: &str) -> Result<(), String> {
    run_reg(&["add", key, "/v", name, "/t", "REG_SZ", "/d", data, "/f"])
}

/// 执行 reg.exe 并把失败翻译成中文（面向使用者，不露 OS 黑话）
fn run_reg(args: &[&str]) -> Result<(), String> {
    let out = std::process::Command::new("reg.exe")
        .args(args)
        .output()
        .map_err(|e| format!("无法启动注册表写入：{}", io_reason(&e)))?;
    if out.status.success() {
        Ok(())
    } else {
        let stderr = String::from_utf8_lossy(&out.stderr);
        let reason = if stderr.is_empty() {
            String::from_utf8_lossy(&out.stdout).trim().to_owned()
        } else {
            stderr.trim().to_owned()
        };
        Err(format!("无法写入打开方式注册（{reason}）"))
    }
}


