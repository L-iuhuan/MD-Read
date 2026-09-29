//! M3-B 往返保真集成测试：read → save 后与原文件字节级对拍。
//! D7 红线：保持原编码与原字节形态，禁止静默转换（BOM/CRLF 不得丢失或改写）。
//!
//! R-01 起读写要过受信集合：本测试用内存集合，并模拟"用户打开过该文件"（`trust_existing`），
//! 于是往返用例同时覆盖新信任层；"未受信的写入不得改磁盘"另有 `fs_trust_tests` 专项断言。
//! ⑤⑥ 为保存链的原子替换锚：正常路径逐字节落盘、失败路径目标原样且无中转残留。

use modu_lib::fs::{read_file_checked, save_file_at, save_file_checked};
use modu_lib::trust::TrustedPaths;

/// 每个 用例独立临时文件（进程 id + 用例名防碰撞）。
fn temp_path(name: &str) -> std::path::PathBuf {
    let mut p = std::env::temp_dir();
    p.push(format!("modu-m3b-{}-{name}.md", std::process::id()));
    p
}

/// 预置文件后登记为受信（等价于"用户打开过它"）。
fn trust_for(path: &std::path::Path) -> TrustedPaths {
    let trust = TrustedPaths::in_memory();
    trust
        .trust_existing(&path.to_string_lossy())
        .expect("预置的 .md 应可登记为受信");
    trust
}

fn read(trust: &TrustedPaths, path: &std::path::Path) -> modu_lib::fs::LoadedFile {
    read_file_checked(trust, &path.to_string_lossy()).expect("read_file 不应失败")
}

fn save(trust: &TrustedPaths, path: &std::path::Path, text: String, encoding: String, bom: bool) {
    save_file_checked(trust, &path.to_string_lossy(), &text, &encoding, bom)
        .expect("save_file 不应失败");
}

/// ① UTF-8 带 BOM + CRLF：读出 {bom:true, crlf:true}，带 BOM 存回后与原文件字节一致。
#[test]
fn utf8_bom_crlf_roundtrip() {
    let path = temp_path("utf8-bom-crlf");
    let text = "# 标题\r\n正文第一行\r\nbody line\r\n";
    let original = [b"\xEF\xBB\xBF".as_slice(), text.as_bytes()].concat();
    std::fs::write(&path, &original).expect("预置文件不应失败");

    let trust = trust_for(&path);
    let loaded = read(&trust, &path);
    assert_eq!(loaded.encoding, "UTF-8");
    assert!(loaded.bom, "应检测到 UTF-8 BOM");
    assert!(loaded.crlf, "CRLF 行占多数应置 crlf=true");
    assert_eq!(loaded.text, text, "解码文本应保留 CRLF 行尾");

    save(&trust, &path, loaded.text, loaded.encoding, true);
    assert_eq!(
        std::fs::read(&path).expect("读回应成功").as_slice(),
        original.as_slice(),
        "往返后应与原文件字节一致（BOM 与 CRLF 均不丢失）"
    );
}

/// ② UTF-8 无 BOM + LF：读出 {bom:false, crlf:false}，存回字节一致。
#[test]
fn utf8_nobom_lf_roundtrip() {
    let path = temp_path("utf8-lf");
    let text = "# 无 BOM\n纯 LF 行尾\nanother\n";
    std::fs::write(&path, text).expect("预置文件不应失败");

    let trust = trust_for(&path);
    let loaded = read(&trust, &path);
    assert_eq!(loaded.encoding, "UTF-8");
    assert!(!loaded.bom);
    assert!(!loaded.crlf);

    save(&trust, &path, loaded.text, loaded.encoding, false);
    assert_eq!(
        std::fs::read(&path).expect("读回应成功").as_slice(),
        text.as_bytes(),
        "无 BOM + LF 往返应字节一致"
    );
}

/// ③ GB18030 中文 + CRLF：往返字节一致；且 bom=true 被忽略（无 BOM 概念），写盘无 BOM、不报错。
/// 注：chardetng 对简体中文可能猜 gbk（GB18030 子集，encoding_rs 规范名）——
/// 契约是"按检出名写回"，故断言家族而非具体名；文本取 GB2312 常用字以保证子集编码字节一致。
#[test]
fn gb18030_crlf_roundtrip_and_bom_ignored() {
    let path = temp_path("gb18030");
    let text = "# 财务报表\r\n金额：一千元与两千元，税后合计三千五百元。\r\n";
    let (original, _used, _had_errors) = encoding_rs::GB18030.encode(&text);
    std::fs::write(&path, original.as_ref()).expect("预置文件不应失败");

    let trust = trust_for(&path);
    let loaded = read(&trust, &path);
    assert!(
        matches!(loaded.encoding.to_lowercase().as_str(), "gb18030" | "gbk"),
        "应检出简体中文编码，实际 {}",
        loaded.encoding
    );
    assert!(!loaded.bom);
    assert!(loaded.crlf, "GB18030 中文文件的 CRLF 应被检出");
    assert_eq!(loaded.text, text);

    save(&trust, &path, loaded.text.clone(), loaded.encoding.clone(), false);
    assert_eq!(
        std::fs::read(&path).expect("读回应成功").as_slice(),
        original.as_ref(),
        "GB18030 往返应与原文件字节一致"
    );

    // GB18030 无 BOM 概念：bom=true 应被忽略并按无 BOM 写，调用仍成功
    save(&trust, &path, loaded.text, loaded.encoding, true);
    assert_eq!(
        std::fs::read(&path).expect("读回应成功").as_slice(),
        original.as_ref(),
        "GB18030 应忽略补 BOM 请求，不产生 BOM 字节"
    );
}

/// ④ 带 BOM 文件 save(bom:false)：前端显式去 BOM 的合法路径，写盘不含 BOM。
#[test]
fn bom_file_save_without_bom_strips_bom() {
    let path = temp_path("bom-strip");
    let text = "带 BOM 的文件\r\n前端显式去 BOM 保存\r\n";
    let original = [b"\xEF\xBB\xBF".as_slice(), text.as_bytes()].concat();
    std::fs::write(&path, &original).expect("预置文件不应失败");

    let trust = trust_for(&path);
    let loaded = read(&trust, &path);
    assert!(loaded.bom, "预置文件带 BOM 应被检出");

    save(&trust, &path, loaded.text, loaded.encoding, false);
    assert_eq!(
        std::fs::read(&path).expect("读回应成功").as_slice(),
        text.as_bytes(),
        "bom=false 应按无 BOM 写回"
    );
}

/// 断言目标同目录没有本文件的 .tmp-/.bak- 中转残留（成功与失败路径都必须清干净）。
/// 只按「本用例的完整主名 + 标记」过滤：别的用例、别的进程（pid 不同）的产物不算命中。
fn assert_no_staging_leftover(target: &std::path::Path) {
    let stem = target
        .file_stem()
        .and_then(|s| s.to_str())
        .expect("目标文件应有主名");
    let dir = target.parent().expect("目标文件应有父目录");
    let leftovers: Vec<String> = std::fs::read_dir(dir)
        .expect("应能列出目标所在目录")
        .filter_map(|entry| entry.ok())
        .map(|entry| entry.file_name().to_string_lossy().into_owned())
        .filter(|name| {
            name.starts_with(&format!("{stem}.tmp-")) || name.starts_with(&format!("{stem}.bak-"))
        })
        .collect();
    assert!(leftovers.is_empty(), "不应残留临时/备份中转文件：{leftovers:?}");
}

/// ⑤ 原子保存（正常路径）：覆盖已存在的目标后，落盘内容与输入逐字节相同
/// （语料复用 ① 的 UTF-8 BOM + CRLF 形态），且同目录不残留 .tmp-/.bak- 中转产物。
#[test]
fn atomic_save_overwrite_matches_input_and_cleans_staging() {
    let path = temp_path("atomic-ok");
    let text = "# 标题\r\n正文第一行\r\nbody line\r\n";
    let original = [b"\xEF\xBB\xBF".as_slice(), text.as_bytes()].concat();
    std::fs::write(&path, &original).expect("预置文件不应失败");

    let trust = trust_for(&path);
    let loaded = read(&trust, &path);
    let edited = loaded.text.replace("正文第一行", "编辑后的正文行");
    save(&trust, &path, edited.clone(), loaded.encoding, true);
    let expected = [b"\xEF\xBB\xBF".as_slice(), edited.as_bytes()].concat();
    assert_eq!(
        std::fs::read(&path).expect("读回应成功").as_slice(),
        expected.as_slice(),
        "覆盖保存后应与输入逐字节相同（BOM 与 CRLF 均保留）"
    );
    assert_no_staging_leftover(&path);
}

/// ⑥ 原子保存（失败路径）：独占句柄（share_mode(0)）锁住目标 ⇒ Windows 上对目标的任何
/// 改名都撞共享冲突 ⇒ 备份让位一步必然失败。断言：目标内容逐字节未变、同目录无
/// .tmp-/.bak- 残留、错误文案是面向使用者的中文（不漏 os error 黑话）。
///
/// ⚠ 直测 `save_file_at`（磁盘替换层）而不走受信入口：独占句柄会让信任层的 canonicalize
/// 同样撞共享冲突而先被拒——那样红的就不是替换回滚这条路径（信任拒绝另有 `fs_trust_tests` 锚）。
/// 句柄在断言前显式 drop：独占期间本测试自己也无法读回目标。
#[test]
#[cfg(windows)]
fn atomic_save_failure_keeps_target_bytes_and_cleans_staging() {
    use std::os::windows::fs::OpenOptionsExt;
    let path = temp_path("atomic-fail");
    let text = "# 原文\r\n这一份内容不允许被半截替换\r\n";
    let original = [b"\xEF\xBB\xBF".as_slice(), text.as_bytes()].concat();
    std::fs::write(&path, &original).expect("预置文件不应失败");

    let _lock = std::fs::OpenOptions::new()
        .read(true)
        .write(true)
        .share_mode(0) // 不许任何共享 ⇒ 后续对目标的 rename 必然失败
        .open(&path)
        .expect("应以独占句柄打开目标文件");

    let err = save_file_at(&path.to_string_lossy(), "半截新内容", "UTF-8", false)
        .expect_err("目标被独占时保存必须失败");
    assert!(err.contains("无法保存文件"), "错误文案应沿用既有中文风格：{err}");
    assert!(!err.contains("os error"), "不得把英文 OS 错误塞进 UI：{err}");

    drop(_lock); // 先放开独占，再核对盘上内容
    assert_eq!(
        std::fs::read(&path).expect("读回应成功").as_slice(),
        original.as_slice(),
        "失败的保存必须保持目标文件逐字节不变"
    );
    assert_no_staging_leftover(&path);
}
