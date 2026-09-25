//! M3-B 往返保真集成测试：read → save 后与原文件字节级对拍。
//! D7 红线：保持原编码与原字节形态，禁止静默转换（BOM/CRLF 不得丢失或改写）。
//!
//! R-01 起读写要过受信集合：本测试用内存集合，并模拟"用户打开过该文件"（`trust_existing`），
//! 于是往返用例同时覆盖新信任层；"未受信的写入不得改磁盘"另有 `fs_trust_tests` 专项断言。

use modu_lib::fs::{read_file_checked, save_file_checked};
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
