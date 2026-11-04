//! `fs.rs` 关联自愈纯函数单测（2026-11-04 关联轮）。
//! 根因场景锚死：重装/换安装器后 UserChoice 仍指向 MoDu.md，但 open command
//! 指着已卸载的旧位置（`C:\Program Files\MoDu\`）——必须判为「需要重写」。

use super::*;

const OLD_MSI_CMD: &str = r#""C:\Program Files\MoDu\modu.exe" "%1""#;
const NEW_NSIS_CMD: &str = r#""C:\Users\u\AppData\Local\MoDu\modu.exe" "%1""#;

#[test]
fn 解析_带引号取首对引号内路径() {
    assert_eq!(
        exe_from_open_command(OLD_MSI_CMD),
        Some(r"C:\Program Files\MoDu\modu.exe")
    );
    assert_eq!(
        exe_from_open_command(NEW_NSIS_CMD),
        Some(r"C:\Users\u\AppData\Local\MoDu\modu.exe")
    );
}

#[test]
fn 解析_无引号取首个空白前段() {
    assert_eq!(
        exe_from_open_command(r"C:\MoDu\modu.exe %1"),
        Some(r"C:\MoDu\modu.exe")
    );
}

#[test]
fn 解析_空值与纯空白返回None() {
    assert_eq!(exe_from_open_command(""), None);
    assert_eq!(exe_from_open_command("   "), None);
}

#[test]
fn 匹配判定_死链场景必须判为需要重写() {
    // 根因场景：注册表里是旧 MSI 位置，当前安装在 NSIS 位置
    assert!(!open_command_matches_install(
        Some(OLD_MSI_CMD),
        r"C:\Users\u\AppData\Local\MoDu\modu.exe"
    ));
}

#[test]
fn 匹配判定_大小写不敏感的相同路径算已匹配() {
    assert!(open_command_matches_install(
        Some(r#""C:\USERS\U\APPDATA\LOCAL\MODU\modu.exe" "%1""#),
        r"C:\Users\u\AppData\Local\MoDu\modu.exe"
    ));
}

#[test]
fn 匹配判定_键无值或空串算需要重写() {
    assert!(!open_command_matches_install(None, r"C:\any\modu.exe"));
    assert!(!open_command_matches_install(Some(""), r"C:\any\modu.exe"));
    assert!(!open_command_matches_install(Some("   "), r"C:\any\modu.exe"));
}
