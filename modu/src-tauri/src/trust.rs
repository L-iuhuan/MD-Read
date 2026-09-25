//! 受信路径集合（R-01 / P1-6 路径白名单）—— 信任模型见
//! `docs/tasks/Phase2-前-决策登记-2026-09-23.md` 的 **D-09 / D-10**：
//! 「用户曾经打开过的路径」持久化为受信集合；最近文件直接打开；仅当**缺失/不可读/不在受信集**时才提示。
//!
//! ## 为什么没有任何「渲染层可调的注册命令」
//! 渲染层按"已被攻陷"设防（宪法红线 1）。若存在 `allow_path(path)` 这类命令，攻陷页面
//! 只需先 `allow_path` 再 `read_file` 即可自证授权 —— 白名单退化成日志（设计稿 §7.2 的反例）。
//! 因此**注册只能来自 OS/用户的真实动作**，共四条，全在 Rust 侧：
//!   1. Rust 侧文件对话框（`fs::pick_markdown_files`）—— 用户亲手选的文件；
//!   2. OS 拖放（`WindowEvent::DragDrop`）—— 运行时投递，渲染层伪造不了；
//!   3. 命令行 / 双击文件关联（`setup` 的 argv 与单实例转发的 argv）；
//!   4. 已持久化的受信集合（上次会话打开过的文件/目录）—— 「最近文件」靠它零打扰重开。
//!
//! ## 关键实现约定
//! - **比较用规范化后的绝对路径**（`fs::canonicalize`）：`..`、相对路径、8.3 短名、符号链接/
//!   junction、盘符大小写都收敛到同一形态；`..` 穿越因此不会绕过（例如受信 `C:\docs\a.md`，
//!   查询 `C:\docs\..\secret.md` 规范化成 `C:\secret.md`，不在集合内 → 拒）。
//! - **键统一小写**存集合：Windows 路径大小写不敏感，避免"注册 A、查询 a 都通过"的错配。
//! - **只读已存在的普通 Markdown 文件**才可注册（`.md/.markdown/.mdx`，与
//!   `bundle.fileAssociations` 严格对齐）；目录只作"受信目录"用于将来另存（D-11 文件夹工作区）。
//! - **持久化**用 `serde_json`（已在依赖里，未新增）：写到 app config 目录的 `trusted-paths.json`。
//!   读不到/损坏 ⇒ 空集合继续跑（安全侧默认拒绝，不会因此放行）。

use std::collections::HashSet;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

use serde::{Deserialize, Serialize};

/// 可读写的 Markdown 扩展名（小写比对；与 `tauri.conf.json` 的 fileAssociations 一致）。
pub const MARKDOWN_EXTENSIONS: [&str; 3] = ["md", "markdown", "mdx"];

/// 拒绝原因。文案在 `deny_message` 里统一拼装（面向使用者、中文、不露技术黑话）。
#[derive(Debug, PartialEq, Eq, Clone, Copy)]
pub enum DenyReason {
    /// 相对路径：语义取决于进程 CWD，不可控
    NotAbsolute,
    /// 扩展名不在 Markdown 白名单
    NotMarkdown,
    /// 存在但不是普通文件（目录/设备等）
    NotAFile,
    /// 不存在 / 已不可访问
    Missing,
    /// 规范化后不在受信集合内
    Untrusted,
}

/// 面向使用者的中文文案（不露技术黑话）。`action` 取「读取」「保存」。
pub fn deny_message(action: &str, raw: &str, reason: DenyReason) -> String {
    match reason {
        DenyReason::NotAbsolute => format!("无法{action}文件：{raw}（路径必须是完整路径）"),
        DenyReason::NotMarkdown => {
            format!("无法{action}文件：{raw}（只支持 Markdown 文件：.md / .markdown / .mdx）")
        }
        DenyReason::NotAFile => format!("无法{action}文件：{raw}（不是文件）"),
        DenyReason::Missing => format!("无法{action}文件：{raw}（文件不存在或已被移动）"),
        DenyReason::Untrusted => format!(
            "无法{action}文件：{raw}（该文件不在本次已打开的清单中，请用「打开文件」重新选择）"
        ),
    }
}

/// **纯策略（不碰文件系统）**：绝对路径 + 扩展名白名单。
/// 先判这两条再碰盘，既省一次 IO，也让"非图片/非 Markdown 路径"不产生磁盘探测。
pub fn classify_name(raw: &str) -> Result<&Path, DenyReason> {
    let path = Path::new(raw);
    if !path.is_absolute() {
        return Err(DenyReason::NotAbsolute);
    }
    let extension = path
        .extension()
        .and_then(|ext| ext.to_str())
        .map(str::to_lowercase)
        .unwrap_or_default();
    if !MARKDOWN_EXTENSIONS.contains(&extension.as_str()) {
        return Err(DenyReason::NotMarkdown);
    }
    Ok(path)
}

/// 规范化键：Windows 路径大小写不敏感 + 统一分隔符形态。
/// `canonicalize` 已在调用方完成（此处只做键化，纯函数、可直测）。
///
/// ⚠️ **键在 Windows 上带 `\\?\` 扩展长度前缀**（例如 `\\?\d:\docs\a.md`），这是**刻意**的：
/// 注册（`trust_existing`）与查询（`allowed_for_read` / `allowed_for_save`）两侧都过同一个
/// `fs::canonicalize`，于是形态天然对齐，集合比较不会因为"一边带前缀、一边不带"而错配。
/// **不要把前缀剥掉、也不要改成人类可读的 `D:\...` 形态** —— 那会引入第二种路径形态，
/// 而"注册 A / 查询 B 都通过"正是白名单最经典的失效方式。持久化清单不面向用户，不必好看。
/// （Lead 2026-09-23 裁决：接受单一规范形态。）
pub fn key_of(canonical: &Path) -> String {
    canonical.to_string_lossy().to_lowercase()
}

/// **纯策略**：候选（已规范化）是否落在受信集合内。
/// 命中规则只有两条：① 精确命中受信文件；② 位于某个受信目录之下（按路径分量，不是字符串前缀）。
pub fn is_trusted(candidate: &Path, files: &HashSet<String>, dirs: &HashSet<String>) -> bool {
    let key = key_of(candidate);
    if files.contains(&key) {
        return true;
    }
    // 目录命中要求是**下级**（目录自身不是文件）
    let candidate_path = Path::new(&key);
    dirs.iter().any(|dir| {
        let dir_path = Path::new(dir);
        dir_path.is_absolute() && candidate_path.starts_with(dir_path) && candidate_path != dir_path
    })
}

/// **纯策略**：该目录本身（或它所在的某个受信目录）是否受信。
/// 与 `is_trusted` 分开：文件查询要把"目录本身"排除（目录不是文件），
/// 而"另存为"判定的对象**就是父目录本身**，必须允许等值命中。
pub fn is_trusted_dir(candidate: &Path, dirs: &HashSet<String>) -> bool {
    let key = key_of(candidate);
    let candidate_path = Path::new(&key);
    dirs.iter().any(|dir| {
        let dir_path = Path::new(dir);
        dir_path.is_absolute() && candidate_path.starts_with(dir_path)
    })
}

/// 「注册」侧校验通过的产物：可写进集合的规范化键 + 回传给前端的原始串。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Trusted {
    pub canonical: PathBuf,
    pub key: String,
}

/// 校验一个**已存在**的 Markdown 文件是否能成为受信路径（供对话框/拖放/CLI 调用）。
/// 纯函数：只做路径形状判断，不访问文件系统（存在性由调用方用 `canonicalize` 保证）。
pub fn trusted_from_canonical(raw: &str, canonical: PathBuf) -> Result<Trusted, DenyReason> {
    classify_name(raw)?;
    let key = key_of(&canonical);
    Ok(Trusted { canonical, key })
}

#[derive(Debug, Default, Serialize, Deserialize)]
struct Store {
    version: u32,
    files: Vec<String>,
    dirs: Vec<String>,
}

/// 受信路径集合（进程内 + 持久化）。`store = None` 表示纯内存（测试/取不到配置目录时）。
pub struct TrustedPaths {
    files: Mutex<HashSet<String>>,
    dirs: Mutex<HashSet<String>>,
    store: Option<PathBuf>,
}

impl TrustedPaths {
    /// 空集合（不落盘）。测试与"取不到配置目录"时使用。
    pub fn in_memory() -> Self {
        Self { files: Mutex::new(HashSet::new()), dirs: Mutex::new(HashSet::new()), store: None }
    }

    /// 从磁盘载入。文件缺失/损坏/版本不符一律**当作空集合**（安全侧默认拒绝）。
    pub fn load(store: PathBuf) -> Self {
        let (files, dirs) = match std::fs::read_to_string(&store) {
            Ok(text) => match serde_json::from_str::<Store>(&text) {
                Ok(parsed) if parsed.version == 1 => {
                    (parsed.files.into_iter().collect(), parsed.dirs.into_iter().collect())
                }
                Ok(_) => {
                    println!("[trust] 受信清单版本不符，按空集合启动：{}", store.display());
                    (HashSet::new(), HashSet::new())
                }
                Err(error) => {
                    println!("[trust] 受信清单解析失败（{error}），按空集合启动");
                    (HashSet::new(), HashSet::new())
                }
            },
            Err(_) => (HashSet::new(), HashSet::new()),
        };
        Self { files: Mutex::new(files), dirs: Mutex::new(dirs), store: Some(store) }
    }

    /// 注册一个**已存在**的 Markdown 文件为受信（对话框/拖放/CLI 用）。
    /// 校验顺序：路径形状 → 规范化（含存在性）→ 是普通文件 → 入库 + 落盘。
    pub fn trust_existing(&self, raw: &str) -> Result<PathBuf, String> {
        classify_name(raw).map_err(|reason| deny_message("读取", raw, reason))?;
        let canonical = std::fs::canonicalize(raw)
            .map_err(|_| deny_message("读取", raw, DenyReason::Missing))?;
        let metadata = std::fs::metadata(&canonical)
            .map_err(|_| deny_message("读取", raw, DenyReason::Missing))?;
        if !metadata.is_file() {
            return Err(deny_message("读取", raw, DenyReason::NotAFile));
        }
        let trusted = trusted_from_canonical(raw, canonical)
            .map_err(|reason| deny_message("读取", raw, reason))?;
        if let Ok(mut files) = self.files.lock() {
            files.insert(trusted.key.clone());
        }
        self.persist();
        Ok(trusted.canonical)
    }

    /// 注册一个受信目录（用户经对话框选择的工作区；机制就位，当前只有测试/将来功能会调）。
    pub fn trust_dir(&self, raw: &str) -> Result<PathBuf, String> {
        let path = Path::new(raw);
        if !path.is_absolute() {
            return Err(deny_message("读取", raw, DenyReason::NotAbsolute));
        }
        let canonical =
            std::fs::canonicalize(raw).map_err(|_| deny_message("读取", raw, DenyReason::Missing))?;
        if !canonical.is_dir() {
            return Err(deny_message("读取", raw, DenyReason::NotAFile));
        }
        if let Ok(mut dirs) = self.dirs.lock() {
            dirs.insert(key_of(&canonical));
        }
        self.persist();
        Ok(canonical)
    }

    /// 撤销授权（关标签时尽力而为；不调也安全，见设计稿 §2.5）。
    pub fn forget(&self, raw: &str) {
        let Ok(canonical) = std::fs::canonicalize(raw) else {
            if let Ok(mut files) = self.files.lock() {
                files.remove(&key_of(Path::new(raw)));
            }
            self.persist();
            return;
        };
        if let Ok(mut files) = self.files.lock() {
            files.remove(&key_of(&canonical));
        }
        self.persist();
    }

    /// 读入口校验：返回**规范化后的路径**（读写都用它落盘，避免 TOCTOU 二次解析）。
    pub fn allowed_for_read(&self, raw: &str) -> Result<PathBuf, String> {
        self.allowed(raw, "读取")
    }

    /// 写入口校验：已存在的文件必须受信；**不存在**的新文件要求父目录是受信目录
    /// （今天没有 md 另存流程，故实际恒拒；机制留给将来的"另存为"/文件夹工作区）。
    pub fn allowed_for_save(&self, raw: &str) -> Result<PathBuf, String> {
        self.allowed(raw, "保存")
    }

    fn allowed(&self, raw: &str, action: &str) -> Result<PathBuf, String> {
        classify_name(raw).map_err(|reason| deny_message(action, raw, reason))?;
        let files = self.files.lock().map_err(|_| "授权清单暂时不可用，请稍后重试".to_string())?;
        let dirs = self.dirs.lock().map_err(|_| "授权清单暂时不可用，请稍后重试".to_string())?;
        match std::fs::canonicalize(raw) {
            Ok(canonical) => {
                if is_trusted(&canonical, &files, &dirs) {
                    Ok(canonical)
                } else {
                    Err(deny_message(action, raw, DenyReason::Untrusted))
                }
            }
            // 规范化失败 = 文件不存在/已不可访问（或不是普通文件）。
            // 这里给"不存在或已被移动"而不是"不在清单中"：前者对用户更可行动（D-10 的提示语义）。
            Err(_) => {
                let parent = Path::new(raw)
                    .parent()
                    .and_then(|p| std::fs::canonicalize(p).ok());
                match parent {
                    // 父目录受信 → 允许写新文件（"另存为"路径；今天没有 md 另存流程，仅机制就位）
                    Some(parent_canonical) if is_trusted_dir(&parent_canonical, &dirs) => {
                        Ok(Path::new(raw).to_path_buf())
                    }
                    _ => Err(deny_message(action, raw, DenyReason::Missing)),
                }
            }
        }
    }

    /// 当前受信条目数（诊断用：报告与实际拒绝行为对账）。
    pub fn counts(&self) -> (usize, usize) {
        let files = self.files.lock().map(|guard| guard.len()).unwrap_or(0);
        let dirs = self.dirs.lock().map(|guard| guard.len()).unwrap_or(0);
        (files, dirs)
    }

    /// 落盘（尽力而为：失败只打印，不影响本次会话的读写授权）。
    fn persist(&self) {
        let Some(store) = self.store.as_ref() else {
            return;
        };
        let (files, dirs) = (
            self.files.lock().map(|g| g.iter().cloned().collect::<Vec<_>>()).unwrap_or_default(),
            self.dirs.lock().map(|g| g.iter().cloned().collect::<Vec<_>>()).unwrap_or_default(),
        );
        let payload = Store { version: 1, files, dirs };
        match serde_json::to_string_pretty(&payload) {
            Ok(text) => {
                if let Some(parent) = store.parent() {
                    let _ = std::fs::create_dir_all(parent);
                }
                if let Err(error) = std::fs::write(store, text) {
                    println!("[trust] 受信清单写入失败（{error}）：{}", store.display());
                }
            }
            Err(error) => println!("[trust] 受信清单序列化失败：{error}"),
        }
    }
}

/// `trust.rs` 的边界与持久化单测（独立文件，同项目 `print_tests.rs` 风格）。
#[cfg(test)]
#[path = "trust_tests.rs"]
mod trust_tests;

