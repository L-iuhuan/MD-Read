//! P0-8 原子导出回归测试（`print.rs` 的 `#[cfg(test)] mod print_tests;` 子模块）。
//! 无 WebView2 可拉，故对打印引擎做**替身**：用 `std::fs::write` 往 `temp_export_path`
//! 推导出的临时路径写字节，再调 `finish_export`（与命令成功/失败路径完全同一条收尾代码），
//! 从而验证「任何失败都不动用户原文件」这一核心契约。

use super::{finish_export, temp_export_path};
use std::path::{Path, PathBuf};

/// 用例专用目录（进程 id + 用例名防碰撞）。先整目录删除再建：
/// 上一轮运行可能故意留下临时产物，此处一并清干净。
fn case_dir(case: &str) -> PathBuf {
    let dir = std::env::temp_dir().join(format!("modu-p08-{}-{case}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).expect("建临时目录不应失败");
    dir
}

/// 替身导出：把 PDF 字节写进临时路径（等价 PrintToPdf 落盘产物）。
fn fake_print(temp: &Path, bytes: &[u8]) {
    std::fs::write(temp, bytes).expect("写临时文件不应失败");
}

fn bytes_of(path: &Path) -> Vec<u8> {
    std::fs::read(path).expect("读文件不应失败")
}

/// ① 临时路径推导：与目标同目录（同卷才谈得上原子改名）、不等于目标、扩展名沿用。
#[test]
fn temp_path_is_sibling_and_distinct() {
    let dest = case_dir("derive").join("报告 终稿.pdf");
    let temp = temp_export_path(&dest);
    assert_eq!(temp.parent(), dest.parent(), "临时文件必须与目标同目录");
    assert_ne!(temp, dest, "临时路径不得等于目标路径");
    assert_eq!(temp.extension().and_then(|e| e.to_str()), Some("pdf"));
}

/// ② 连续调用/重试同一路径不得互相踩临时文件。
#[test]
fn temp_paths_do_not_collide_between_calls() {
    let dest = case_dir("collide").join("same.pdf");
    let mut seen = std::collections::HashSet::new();
    for _ in 0..200 {
        assert!(seen.insert(temp_export_path(&dest)), "临时路径必须互不相同");
    }
}

/// ③ 成功路径：目标已存在时被替换（Windows rename 覆盖语义的端到端验证）。
#[test]
fn export_commit_replaces_existing_destination() {
    let dest = case_dir("replace").join("existing.pdf");
    let temp = temp_export_path(&dest);
    std::fs::write(&dest, b"OLD").expect("预置目标不应失败");
    fake_print(&temp, b"NEW-CONTENT");

    let verdict = finish_export(&temp, &dest, Ok(()));

    assert!(verdict.is_ok(), "成功导出应返回 Ok：{verdict:?}");
    assert_eq!(bytes_of(&dest), b"NEW-CONTENT", "目标应被新内容替换");
    assert!(!temp.exists(), "提交后临时文件应消失（已改名）");
}

/// ④ 失败路径（P0-8 原始复现场景）：原文件字节不动、临时文件清掉。
#[test]
fn export_failure_keeps_destination_bytes() {
    let dest = case_dir("rollback").join("precious.pdf");
    let temp = temp_export_path(&dest);
    let original = b"%PDF-1.4\noriginal-bytes-must-survive\n".to_vec();
    std::fs::write(&dest, &original).expect("预置目标不应失败");
    fake_print(&temp, b"half-written-garbage"); // 引擎写一半就失败

    let err = finish_export(&temp, &dest, Err("打印回调未成功：hr=0x80004004".into()))
        .expect_err("失败判定必须转成 Err");

    assert!(
        err.contains("已保留原文件"),
        "提示应说明原文件未覆盖：{err}"
    );
    assert_eq!(bytes_of(&dest), original, "原文件必须字节级不变");
    assert!(!temp.exists(), "失败后必须删除临时文件");
}

/// ⑤ 取消路径：只敢清临时文件，原 PDF 原样在。
#[test]
fn export_cancel_keeps_destination_bytes() {
    let dest = case_dir("cancel").join("keep-me.pdf");
    let temp = temp_export_path(&dest);
    let original = b"OLD-PDF".to_vec();
    std::fs::write(&dest, &original).expect("预置目标不应失败");

    let err = finish_export(&temp, &dest, Err("导出任务失败：打印已取消".into()))
        .expect_err("取消必须转成 Err");

    assert!(
        err.contains("已保留原文件"),
        "取消提示应说明原文件未覆盖：{err}"
    );
    assert_eq!(bytes_of(&dest), original);
    assert!(!temp.exists(), "取消后不得残留临时文件");
}

/// ⑥ 目标路径只读（Windows 只读属性）：改名替换失败时不得动原文件。
#[test]
fn export_failure_when_destination_is_read_only() {
    let dest = case_dir("readonly").join("readonly.pdf");
    let temp = temp_export_path(&dest);
    let original = b"READONLY-PDF".to_vec();
    std::fs::write(&dest, &original).expect("预置目标不应失败");
    fake_print(&temp, b"NEW-PDF");
    let mut perms = std::fs::metadata(&dest)
        .expect("读目标属性不应失败")
        .permissions();
    perms.set_readonly(true);
    std::fs::set_permissions(&dest, perms).expect("置只读属性不应失败");

    let err = finish_export(&temp, &dest, Ok(())).expect_err("目标只读时必须报错");

    assert!(err.contains("无法写入"), "错误信息应说明写不进去：{err}");
    assert_eq!(bytes_of(&dest), original, "目标只读时原文件仍不得被删改");
    // 复原属性 + 清理（该分支按设计保留临时产物供排查，用例末尾清掉）
    let mut perms = std::fs::metadata(&dest)
        .expect("读目标属性不应失败")
        .permissions();
    perms.set_readonly(false);
    let _ = std::fs::set_permissions(&dest, perms);
    let _ = std::fs::remove_file(&temp);
}

/// ⑦ 打印「成功」但落盘 0 字节：按失败回滚，不得用 0 字节文件盖掉用户 PDF。
#[test]
fn empty_temp_is_treated_as_failure() {
    let dest = case_dir("empty").join("dest.pdf");
    let temp = temp_export_path(&dest);
    let original = b"REAL-PDF".to_vec();
    std::fs::write(&dest, &original).expect("预置目标不应失败");
    fake_print(&temp, b"");

    let err = finish_export(&temp, &dest, Ok(())).expect_err("0 字节必须报错");

    assert!(err.contains("空文件"), "应报空文件：{err}");
    assert_eq!(bytes_of(&dest), original);
    assert!(!temp.exists(), "失败后必须删除临时文件");
}

/// ⑧ 中文 + 空格路径全链路（推导 → 替身打印 → 收尾替换）。
#[test]
fn chinese_and_space_path_roundtrip() {
    let dest = case_dir("中文 空格").join("2026 年度 财务报告 终稿.pdf");
    let temp = temp_export_path(&dest);
    fake_print(&temp, b"PDFX");

    let verdict = finish_export(&temp, &dest, Ok(()));

    assert!(verdict.is_ok(), "中文空格路径应可导出：{verdict:?}");
    assert_eq!(bytes_of(&dest), b"PDFX");
    assert!(!temp.exists(), "提交后不应残留临时文件");
}

/// ⑨ Windows `std::fs::rename` 覆盖语义独立实测（不经过本模块逻辑）。
/// 标准库文档：Windows 上目标存在时**替换**而非报 AlreadyExists
/// （实现为 `MoveFileExW` + `MOVEFILE_REPLACE_EXISTING`，已在本机 rust-src 源码核实）；
/// 本用例把该结论钉住——若标准库改语义，这里先红，收尾提交就必须改走 ReplaceFileW。
#[test]
fn windows_rename_overwrites_existing_destination() {
    let dir = case_dir("rename-semantics");
    let src = dir.join("src.dat");
    let dst = dir.join("dst.dat");
    std::fs::write(&src, b"SOURCE").expect("写源文件不应失败");
    std::fs::write(&dst, b"DESTINATION-OLD").expect("写目标文件不应失败");

    std::fs::rename(&src, &dst).expect("Windows 上 rename 覆盖已存在目标应成功");

    assert_eq!(bytes_of(&dst), b"SOURCE", "目标应被源文件取代");
    assert!(!src.exists(), "源文件应已消失（移动语义）");
}
