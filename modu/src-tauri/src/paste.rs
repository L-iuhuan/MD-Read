//! 图片粘贴落盘（编辑增强 A3 · 2026-10-12）。
//!
//! **裁决记录：2026-10-12 主人批准；爆炸半径＝仅受信目录内新建图片文件、白名单扩展、永不覆盖。**
//! 新增渲染层可调的写盘命令＝信任面变更（宪法红线的显式豁免类，同 `register_markdown_default`
//! 的先例），故把半径锁到最小：
//! · 目标目录＝doc 的父目录，**必须**是受信目录（`TrustedPaths` 的 `dirs`，或其受信祖先）——
//!   只文件受信而目录未受信 ⇒ 拒绝并引导授权；doc 本身也必须已受信（复用读入口校验）。
//! · 扩展名白名单 png/jpg/jpeg/gif/webp（小写归一），杜绝借道写 .md/.exe 等。
//! · 文件名 `图片-YYYYMMDD-HHMMSS.ext`，冲突追 -2..-99，**绝不覆盖任何已有文件**（硬红线）。
//! · 大小上限 20MB；空内容拒绝。
//! 落盘走保存链既有模式：同目录临时文件 → rename 到位（同 fs.rs `save_file_at` /
//! print.rs 导出链），任何失败路径只清理自己的临时产物。

use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};

use crate::trust::TrustedPaths;

/// 粘贴允许落盘的图片扩展名（小写比对）。比渲染层的 9 种图片白名单窄——
/// 剪贴板位图/截图只产这五种格式，svg 等文本格式不经本命令。
pub const PASTE_IMAGE_EXTENSIONS: [&str; 5] = ["png", "jpg", "jpeg", "gif", "webp"];

/// 单张粘贴图片的大小上限（20MB）。
pub const MAX_PASTE_BYTES: usize = 20 * 1024 * 1024;

/// `save_paste_image` 命令：把渲染层剪贴板里的图片字节落到**文档所在目录**，
/// 返回新文件的绝对路径（canonical 形态，前端据此算相对引用）。
/// 裁决记录：2026-10-12 主人批准；爆炸半径＝仅受信目录内新建图片文件、白名单扩展、永不覆盖。
#[tauri::command]
pub fn save_paste_image(
    state: tauri::State<TrustedPaths>,
    bytes: Vec<u8>,
    ext: String,
    doc_path: String,
) -> Result<String, String> {
    save_paste_image_checked(&state, &bytes, &ext, &doc_path)
}

/// 受信校验 + 落盘（供集成测试直调；命令层只是薄封装——同 fs.rs 的 `*_checked` 惯例）。
pub fn save_paste_image_checked(
    trust: &TrustedPaths,
    bytes: &[u8],
    ext: &str,
    doc_path: &str,
) -> Result<String, String> {
    // 纯策略先判（不碰盘，同 trust::classify_name 的次序哲学）：空内容 / 超限 / 白名单外。
    if bytes.is_empty() {
        return Err("无法保存图片：粘贴的内容为空".to_string());
    }
    if bytes.len() > MAX_PASTE_BYTES {
        return Err(format!(
            "无法保存图片：图片超过 20MB 大小上限（当前约 {} MB）",
            bytes.len().div_ceil(1024 * 1024)
        ));
    }
    // 小写归一 + 容错去点（前端约定传 "png" 这类不带点的扩展名；带了点也能容错）
    let ext = ext.trim().trim_start_matches('.').to_lowercase();
    if !PASTE_IMAGE_EXTENSIONS.contains(&ext.as_str()) {
        return Err(format!(
            "不支持的图片格式：{ext}（粘贴仅支持 png / jpg / jpeg / gif / webp）"
        ));
    }
    // 受信校验①：doc 本身必须是已受信的 Markdown（复用读入口：绝对路径 + md 扩展 + 在集合内）。
    let canonical_doc = trust.allowed_for_read(doc_path)?;
    // 受信校验②：目标目录＝doc 的父目录，必须是受信目录（或其受信祖先）——复用列目录入口的
    // `is_trusted_dir` 判定（允许等值与前缀命中）。只文件受信而目录未受信 ⇒ 拒绝并引导授权。
    let parent = canonical_doc
        .parent()
        .ok_or_else(|| format!("无法保存图片：{doc_path}（取不到文档所在目录）"))?
        .to_path_buf();
    let canonical_dir = trust
        .allowed_for_list_dir(&parent.to_string_lossy())
        .map_err(|_| {
            format!(
                "无法保存图片：{}（图片需保存在文档目录，请先通过打开目录/工作区授权）",
                parent.to_string_lossy()
            )
        })?;
    // 命名：图片-YYYYMMDD-HHMMSS.ext；同名已存在则追 -2..-99，仍冲突报错（绝不覆盖）。
    let dest = unique_image_path(&canonical_dir, &local_stamp(), &ext)?;
    write_image_atomically(&dest, bytes)?;
    Ok(dest.to_string_lossy().into_owned())
}

/// 在 `dir` 里为 `stamp`（YYYYMMDD-HHMMSS）挑一个不存在的图片文件名。
/// 基础名被占 ⇒ 追加 -2、-3 … -99；全部被占 ⇒ 报错。**任何成功路径都不会指向已存在的文件**。
pub fn unique_image_path(dir: &Path, stamp: &str, ext: &str) -> Result<PathBuf, String> {
    let base = format!("图片-{stamp}");
    for n in 1..=99usize {
        let name = if n == 1 {
            format!("{base}.{ext}")
        } else {
            format!("{base}-{n}.{ext}")
        };
        let candidate = dir.join(name);
        if !candidate.exists() {
            return Ok(candidate);
        }
    }
    Err(format!(
        "无法保存图片：{base}.{ext} 已存在，且 -2 至 -99 的序号也都占用，请稍后重试"
    ))
}

/// 粘贴链的去重序号（同 fs.rs 的 SAVE_SEQ / print.rs 的 TEMP_SEQ）。
static PASTE_SEQ: AtomicU64 = AtomicU64::new(0);

/// 同目录临时文件路径：命名沿用保存链 `fs::staged_save_path` 的风格
/// （`<主名>.tmp-<pid>-<纳秒>-<序号>.<扩展名>`），同进程内每次调用互不相同。
fn temp_paste_path(dest: &Path) -> PathBuf {
    let nanos = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.subsec_nanos())
        .unwrap_or(0);
    let seq = PASTE_SEQ.fetch_add(1, Ordering::Relaxed);
    let stem = dest
        .file_stem()
        .map(|s| s.to_string_lossy().into_owned())
        .unwrap_or_else(|| "paste".to_string());
    let ext = dest
        .extension()
        .map(|s| s.to_string_lossy().into_owned())
        .unwrap_or_else(|| "png".to_string());
    let name = format!("{stem}.tmp-{}-{nanos}-{seq}.{ext}", std::process::id());
    dest.with_file_name(name)
}

/// 原子落盘：先写同目录临时文件，再 rename 到**新名**目标（复用保存链模式）。
/// 本场景目标必为新名（`unique_image_path` 已确认不存在）⇒ 直接 rename 即可；
/// 改名前再补一眼存在性，兜住「命名与改名之间被人抢注同名」的极端并发——绝不覆盖（硬红线）。
fn write_image_atomically(dest: &Path, bytes: &[u8]) -> Result<(), String> {
    let temp = temp_paste_path(dest);
    if let Err(e) = std::fs::write(&temp, bytes) {
        cleanup_paste_temp(&temp);
        return Err(format!("无法保存图片：{}（{}）", dest.display(), crate::fs::io_reason(&e)));
    }
    if dest.exists() {
        cleanup_paste_temp(&temp);
        return Err(format!(
            "无法保存图片：{}（同名文件刚被创建，请重试）",
            dest.display()
        ));
    }
    if let Err(e) = std::fs::rename(&temp, dest) {
        cleanup_paste_temp(&temp);
        return Err(format!("无法保存图片：{}（{}）", dest.display(), crate::fs::io_reason(&e)));
    }
    Ok(())
}

/// 清掉粘贴链自己的临时产物（失败路径只删自己造的文件，一个字节都不碰别人）。
fn cleanup_paste_temp(staged: &Path) {
    let _ = std::fs::remove_file(staged);
}

/// 本地时间戳 `YYYYMMDD-HHMMSS`（零新依赖：不引 chrono，std/Win32 手工格式化）。
/// Windows 用 kernel32 的 `GetLocalTime`（自带时区与夏令时）；其余平台退化为 UTC
/// （本项目只面向 Windows，退化分支只为让模块可独立编译）。
#[cfg(windows)]
fn local_stamp() -> String {
    #[repr(C)]
    #[allow(dead_code)] // FFI 结构须保留完整 16 字节布局；day_of_week/milliseconds 本命令用不到
    struct WinSystemTime {
        year: u16,
        month: u16,
        day_of_week: u16,
        day: u16,
        hour: u16,
        minute: u16,
        second: u16,
        milliseconds: u16,
    }
    #[link(name = "kernel32")]
    extern "system" {
        fn GetLocalTime(system_time: *mut WinSystemTime);
    }
    let mut t = WinSystemTime {
        year: 0,
        month: 0,
        day_of_week: 0,
        day: 0,
        hour: 0,
        minute: 0,
        second: 0,
        milliseconds: 0,
    };
    unsafe { GetLocalTime(&mut t) };
    format!(
        "{:04}{:02}{:02}-{:02}{:02}{:02}",
        t.year, t.month, t.day, t.hour, t.minute, t.second
    )
}

/// 非 Windows 的 UTC 退化实现（儒略日换算，Howard Hinnant 的 civil_from_days 算法）。
#[cfg(not(windows))]
fn local_stamp() -> String {
    let secs = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0);
    let days = secs.div_euclid(86_400);
    let rem = secs.rem_euclid(86_400);
    let (hour, minute, second) = (rem / 3_600, (rem % 3_600) / 60, rem % 60);
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z.rem_euclid(146_097);
    let yoe = (doe - doe / 1_460 + doe / 36_524 - doe / 146_096) / 365;
    let year = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let day = doy - (153 * mp + 2) / 5 + 1;
    let month = if mp < 10 { mp + 3 } else { mp - 9 };
    let year = if month <= 2 { year + 1 } else { year };
    format!("{year:04}{month:02}{day:02}-{hour:02}{minute:02}{second:02}")
}
