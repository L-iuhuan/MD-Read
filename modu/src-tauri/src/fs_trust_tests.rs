//! `fs.rs` 的 R-01 单测：受信校验接入读/写后的行为（含"被拒时磁盘一个字节都不动"）。

use super::*;
use crate::trust::TrustedPaths;
use encoding_rs::GB18030;

fn temp_dir(tag: &str) -> std::path::PathBuf {
    let nanos = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    let dir = std::env::temp_dir().join(format!("modu-fs-{}-{tag}-{nanos}", std::process::id()));
    std::fs::create_dir_all(&dir).expect("临时目录应可创建");
    dir
}

#[test]
fn refused_write_does_not_touch_the_file() {
    let dir = temp_dir("拒写");
    let victim = dir.join("别人的.md");
    std::fs::write(&victim, "哨兵内容：不得被改动").expect("写哨兵");
    let trust = TrustedPaths::in_memory();
    let error = save_file_checked(&trust, &victim.to_string_lossy(), "攻击者内容", "UTF-8", false)
        .expect_err("未受信路径必须被拒");
    assert!(error.contains("不在本次已打开的清单中"), "实际：{error}");
    assert_eq!(
        std::fs::read_to_string(&victim).expect("哨兵应仍在"),
        "哨兵内容：不得被改动",
        "被拒的写入不得改动磁盘"
    );
}

#[test]
fn refused_read_returns_chinese_message_without_english_os_error() {
    let dir = temp_dir("拒读");
    let secret = dir.join("机密.md");
    std::fs::write(&secret, "机密").expect("写文件");
    let trust = TrustedPaths::in_memory();
    let error = read_file_checked(&trust, &secret.to_string_lossy()).expect_err("未受信路径必须被拒");
    assert!(error.contains("不在本次已打开的清单中"), "实际：{error}");
    assert!(!error.contains("os error"), "不得把英文 OS 错误塞进 UI：{error}");
    // 缺失文件的读入口：中文原因，同样不含英文
    let missing = dir.join("没有.md");
    let error = read_file_checked(&trust, &missing.to_string_lossy()).expect_err("缺失文件应被拒");
    assert!(error.contains("文件不存在或已被移动") || error.contains("不在本次已打开的清单中"), "实际：{error}");
}

#[test]
fn trusted_read_write_round_trip_keeps_encoding_and_byte_shape() {
    let dir = temp_dir("往返");
    let doc = dir.join("编码.md");
    // GB18030 + CRLF 语料：读出来应报 GB18030、crlf=true，写回字节应与原文完全一致
    let (original, _, _) = GB18030.encode("第一行\r\n金额：1,000 与 2,345.67\r\n");
    std::fs::write(&doc, original.as_ref()).expect("写语料");
    let before = std::fs::read(&doc).expect("读语料");
    let trust = TrustedPaths::in_memory();
    trust.trust_existing(&doc.to_string_lossy()).expect("注册");
    let loaded = read_file_checked(&trust, &doc.to_string_lossy()).expect("受信读应成功");
    assert!(
        matches!(loaded.encoding.to_lowercase().as_str(), "gb18030" | "gbk"),
        "应检出简体中文编码，实际 {}",
        loaded.encoding
    );
    assert!(!loaded.bom);
    assert!(loaded.crlf, "CRLF 形态应被识别");
    save_file_checked(&trust, &doc.to_string_lossy(), &loaded.text, &loaded.encoding, loaded.bom)
        .expect("受信写应成功");
    let after = std::fs::read(&doc).expect("读回");
    assert_eq!(before, after, "受信往返必须逐字节一致（编码与行尾都不丢）");
}

#[test]
fn utf8_bom_round_trip_is_preserved() {
    let dir = temp_dir("BOM");
    let doc = dir.join("带BOM.md");
    let mut bytes = vec![0xEF, 0xBB, 0xBF];
    bytes.extend_from_slice("# 标题\n正文".as_bytes());
    std::fs::write(&doc, &bytes).expect("写语料");
    let trust = TrustedPaths::in_memory();
    trust.trust_existing(&doc.to_string_lossy()).expect("注册");
    let loaded = read_file_checked(&trust, &doc.to_string_lossy()).expect("读");
    assert!(loaded.bom, "BOM 应被识别");
    assert_eq!(loaded.encoding.to_uppercase().replace('_', "-"), "UTF-8");
    save_file_checked(&trust, &doc.to_string_lossy(), &loaded.text, &loaded.encoding, loaded.bom)
        .expect("写");
    assert_eq!(std::fs::read(&doc).expect("读回"), bytes, "BOM 必须补回");
}

/// D-11 提交②：列目录的三条断言 —— **单遍收满即停** / **顺序确定（目录在前、码位序）** / **零内容读取**。
#[test]
fn list_dir_is_single_pass_ordered_and_reads_no_content() {
    let dir = temp_dir("列目录命令");
    for name in ["b.md", "a.txt", "z.md"] {
        std::fs::write(dir.join(name), "内容").expect("测试文件应可写");
    }
    std::fs::create_dir_all(dir.join("子目录")).expect("子目录应可创建");
    // 故意放一个**内容为空字节**的文件：若实现读了内容，这里是最可能出问题的地方
    std::fs::write(dir.join("空.md"), "").expect("空文件应可写");
    let trust = TrustedPaths::in_memory();
    trust.trust_dir(&dir.to_string_lossy()).expect("注册受信目录应成功");

    let all = list_dir_at(&trust, &dir.to_string_lossy(), None).expect("受信目录应可列");
    assert!(!all.truncated, "未给 limit 时不应截断");
    assert_eq!(all.total, None, "total 必须保持 None（不许为它多遍历一遍）");
    assert_eq!(all.entries.len(), 5, "四项文件 + 一个子目录");
    assert!(all.entries[0].is_dir, "目录必须排在前面");
    let names: Vec<&str> = all.entries.iter().map(|e| e.name.as_str()).collect();
    assert_eq!(names, vec!["子目录", "a.txt", "b.md", "z.md", "空.md"], "顺序必须确定：目录在前 → 再按名称码位序");
    assert!(all.entries.iter().find(|e| e.name == "b.md").unwrap().is_markdown, ".md 应标为 markdown");
    assert!(!all.entries.iter().find(|e| e.name == "a.txt").unwrap().is_markdown);

    // 单遍收满即停：limit=2 ⇒ 只收 2 项 + truncated=true（**不**为了 total 再走一遍）
    let cut = list_dir_at(&trust, &dir.to_string_lossy(), Some(2)).expect("受信目录应可列");
    assert_eq!(cut.entries.len(), 2, "收满 limit 必须停止收集");
    assert!(cut.truncated, "被截断时必须置 truncated ✓（供 UI 显示 还有 N 项）");
    assert_eq!(cut.total, None);
}

/// D-11 提交②：命令边界 —— 直接调 `list_dir_at` 传**越界路径** ⇒ 必须拒（判据测试证明不了命令用它 ✗）。
#[test]
fn list_dir_refuses_outside_the_trusted_set() {
    let dir = temp_dir("列目录拒绝");
    let inside = dir.join("工作区");
    std::fs::create_dir_all(&inside).expect("工作区应可创建");
    let outside = dir.join("外面");
    std::fs::create_dir_all(&outside).expect("外面应可创建");
    let trust = TrustedPaths::in_memory();
    trust.trust_dir(&inside.to_string_lossy()).expect("注册受信目录应成功");

    let err = list_dir_at(&trust, &outside.to_string_lossy(), None).expect_err("受信目录外必须被拒");
    assert!(!err.contains("No such file"), "拒绝文案不得含英文 OS 错误：{err}");
    // 存在性不泄露：受信目录外**不存在**的路径给出同一类答复（都走 DenyReason::Untrusted）
    let ghost = dir.join("不存在");
    let err2 = list_dir_at(&trust, &ghost.to_string_lossy(), None).expect_err("目录外一律拒");
    assert!(!err2.contains("No such file"), "不得泄露存在性：{err2}");
}

// ————— 切片③ 撤销路径（设计 §3.2）：`forget_dir` 的五条锚 —————
// ⚠ **绝不碰真实数据**：全部用 `temp_dir` ✓，落盘那条用**临时 store** ✓
//（真实 `%APPDATA%\…\trusted-paths.json` 的 sha 在跑锚前后应一致 —— 由流程核对，不进单测 ✓）

/// 护栏 4：撤销后**新路径立即被拒** ✓（命令边界负对照口径）
#[test]
fn removing_a_trusted_dir_immediately_denies_new_paths() {
    let dir = temp_dir("撤销生效");
    let ws = dir.join("工作区");
    std::fs::create_dir_all(&ws).expect("工作区应可创建");
    let trust = TrustedPaths::in_memory();
    trust.trust_dir(&ws.to_string_lossy()).expect("注册受信目录应成功");
    list_dir_at(&trust, &ws.to_string_lossy(), None).expect("撤销前应可列（正对照）");
    trust.forget_dir(&ws.to_string_lossy()).expect("撤销应成功");
    let err = list_dir_at(&trust, &ws.to_string_lossy(), None).expect_err("撤销后必须被拒");
    assert!(!err.contains("No such file"), "拒绝文案不得含英文 OS 错误：{err}");
}

/// 护栏 2：**未受信目录 ⇒ 拒绝**（不是静默 no-op ✓）
#[test]
fn removing_an_untrusted_dir_is_refused() {
    let dir = temp_dir("撤销未受信");
    let trust = TrustedPaths::in_memory();
    let err = trust.forget_dir(&dir.to_string_lossy()).expect_err("未受信目录必须拒绝");
    assert!(!err.contains("No such file"), "文案不得含英文 OS 错误：{err}");
}

/// 护栏 1 ⭐ **正对照**：撤目录**不动 `files`** ✓（与设计"已打开标签保留"一致 ✓）
#[test]
fn removing_a_dir_keeps_trusted_files() {
    let dir = temp_dir("撤销不动文件");
    let ws = dir.join("工作区");
    std::fs::create_dir_all(&ws).expect("工作区应可创建");
    let doc = ws.join("a.md");
    std::fs::write(&doc, "# a\n").expect("测试文件应可写");
    let trust = TrustedPaths::in_memory();
    trust.trust_existing(&doc.to_string_lossy()).expect("注册文件应成功");
    trust.trust_dir(&ws.to_string_lossy()).expect("注册目录应成功");
    let (files_before, dirs_before) = trust.counts();
    trust.forget_dir(&ws.to_string_lossy()).expect("撤销应成功");
    let (files_after, dirs_after) = trust.counts();
    assert_eq!(files_before, 1, "前置：应有一个受信文件");
    assert_eq!(files_after, 1, "护栏 1：撤目录不得动 files ✓");
    assert_eq!(dirs_before, 1, "前置：应有一个受信目录");
    assert_eq!(dirs_after, 0, "dirs 应减一 ✓");
}

/// 护栏 3 ⭐ **落盘**：临时 store 走 `load → 撤销 → 重新 load` ⇒ **不得复活** ✗
#[test]
fn removing_a_dir_is_persisted_across_reload() {
    let dir = temp_dir("撤销落盘");
    let ws = dir.join("工作区");
    std::fs::create_dir_all(&ws).expect("工作区应可创建");
    let store = dir.join("trusted-paths.json"); // ⚠ 临时 store ✓ 绝不碰真实清单 ✓
    {
        let trust = TrustedPaths::load(store.clone());
        trust.trust_dir(&ws.to_string_lossy()).expect("注册应成功");
        trust.forget_dir(&ws.to_string_lossy()).expect("撤销应成功");
    }
    let reloaded = TrustedPaths::load(store);
    assert!(
        list_dir_at(&reloaded, &ws.to_string_lossy(), None).is_err(),
        "护栏 3：撤销后重新 load 不得复活 ✗（只改内存 = 重启复活）"
    );
}

/// ⭐ (a) 回退：目录**已从盘上消失**时也要能撤销（否则该授权**永远删不掉** ✗）＋ **非前缀反例**
#[test]
fn vanished_dir_is_still_revocable_by_exact_match_only() {
    let dir = temp_dir("撤销已消失");
    let ws = dir.join("工作区");
    std::fs::create_dir_all(&ws).expect("工作区应可创建");
    let raw = ws.to_string_lossy().into_owned();
    let trust = TrustedPaths::in_memory();
    trust.trust_dir(&raw).expect("注册应成功");
    std::fs::remove_dir_all(&ws).expect("把目录从盘上删掉");
    // 回退：canonicalize 必失败 ⇒ 用 raw 的规范化键做【全等】匹配 ⇒ 必须成功 ✓
    trust.forget_dir(&raw).expect("目录已消失也必须能撤销 ✓");
    assert_eq!(trust.counts().1, 0, "该授权应已被删掉 ✓");
    // 反例：**前缀相似但不同**的路径 ⇒ 必须拒绝 ✓（证明不是前缀匹配 ✗）
    let sibling = dir.join("工作区-sibling");
    std::fs::create_dir_all(&sibling).expect("兄弟目录应可创建");
    trust.trust_dir(&sibling.to_string_lossy()).expect("注册兄弟目录应成功");
    let not_it = format!("{}-不是它", sibling.to_string_lossy());
    trust.forget_dir(&not_it).expect_err("前缀相似但不同 ⇒ 必须拒绝（不得前缀匹配）");
    assert_eq!(trust.counts().1, 1, "反例不得删掉任何授权 ✓");
}

/// ② 不可读/不可列 ⇒ **显示中文原因、不崩** ✓
///
/// **免 ACL 夹具**（Lead 给的口径 ✓）：在**受信目录之内**放一个**普通文件** ⇒
/// 用它的路径调 `list_dir` ⇒ 受信判定通过 ✓（在受信目录之下 ✓）但底层 `read_dir` 必然失败（不是目录 ✗）
/// ⇒ **不需要造权限/ACL 夹具** ✓（Windows 上省事 ✓）
///
/// ⚠ 红线（本项目既有口径 ✓）：错误信息**中文、面向使用者** ⇒ **不得泄露英文 OS 原串** ✗
/// （如 `The directory name is invalid` / `os error …` / `Os { … }` 之类；既有锚就是这个口径 ✓）
#[test]
fn listing_a_non_directory_reports_a_chinese_reason_without_os_text() {
    let dir = temp_dir("列非目录");
    let ws = dir.join("工作区");
    std::fs::create_dir_all(&ws).expect("工作区应可创建");
    let doc = ws.join("not-a-dir.txt");
    std::fs::write(&doc, "x\n").expect("测试文件应可写");
    let trust = TrustedPaths::in_memory();
    trust.trust_dir(&ws.to_string_lossy()).expect("注册受信目录应成功");

    let err = list_dir_at(&trust, &doc.to_string_lossy(), None).expect_err("列一个非目录必须失败");

    // ① 面向使用者的中文文案 ✓
    assert!(
        err.contains("无法") || err.contains("目录") || err.contains("文件"),
        "文案应为中文、面向使用者：{err}"
    );
    // ② 不得含英文 OS 原串 ✓（逐条列全，避免只挡一种写法 ✗）
    for needle in [
        "The directory name is invalid",
        "The system cannot find",
        "Access is denied",
        "os error",
        "Os {",
        "No such file",
        "Not a directory",
        "拒绝访问",
    ] {
        assert!(!err.contains(needle), "不得泄露英文 OS 原串（{needle}）：{err}");
    }
}
