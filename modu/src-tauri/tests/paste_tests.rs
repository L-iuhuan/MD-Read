//! 图片粘贴落盘（编辑增强 A3）集成测试。
//!
//! 覆盖：受信目录内成功（字节逐一相等、返回绝对路径、命名格式）；只文件受信而目录未受信 ⇒
//! 拒绝（文案含引导语且不写盘）；非白名单扩展名拒绝；空内容拒绝；同名冲突 -2 递增且绝不覆盖；
//! 序号 -2..-99 全占用 ⇒ 报错；20MB 上限拒绝；doc 未受信拒绝。
//! 种入手法与 roundtrip.rs 同款：`TrustedPaths::in_memory()` + `trust_dir` / `trust_existing`。

use std::path::{Path, PathBuf};

use modu_lib::paste::{
    save_paste_image_checked, unique_image_path, MAX_PASTE_BYTES, PASTE_IMAGE_EXTENSIONS,
};
use modu_lib::trust::TrustedPaths;

/// 每个用例独立临时目录（进程 id + 用例名防碰撞；进来先清一遍）。
fn temp_dir_for(name: &str) -> PathBuf {
    let mut p = std::env::temp_dir();
    p.push(format!("modu-a3-paste-{}-{name}", std::process::id()));
    let _ = std::fs::remove_dir_all(&p);
    std::fs::create_dir_all(&p).expect("建临时目录不应失败");
    p
}

/// 在 `dir` 里预置一份 Markdown 并把**目录**登记为受信（等价于工作区/拖放目录授权）。
fn trusted_dir_with_doc(dir: &Path, doc_name: &str) -> (TrustedPaths, PathBuf) {
    let doc = dir.join(doc_name);
    std::fs::write(&doc, "# 文档\n").expect("预置文档不应失败");
    let trust = TrustedPaths::in_memory();
    trust
        .trust_dir(&dir.to_string_lossy())
        .expect("目录登记为受信不应失败");
    (trust, doc)
}

/// 目录里的文件名清单（断言「拒绝时一个文件都不写」用）。
fn dir_names(dir: &Path) -> Vec<String> {
    let mut names: Vec<String> = std::fs::read_dir(dir)
        .expect("应能列出目录")
        .filter_map(|e| e.ok())
        .map(|e| e.file_name().to_string_lossy().into_owned())
        .collect();
    names.sort();
    names
}

/// ① 受信目录内成功：字节逐一相等、返回绝对路径、落在文档目录、命名格式正确、无 tmp 残留。
#[test]
fn trusted_dir_success_writes_exact_bytes_with_expected_name() {
    let dir = temp_dir_for("ok");
    let (trust, doc) = trusted_dir_with_doc(&dir, "a.md");
    let bytes: Vec<u8> = (0..4096u32).map(|i| (i % 251) as u8).collect();

    let saved = save_paste_image_checked(&trust, &bytes, "png", &doc.to_string_lossy())
        .expect("受信目录内粘贴保存应成功");

    let path = Path::new(&saved);
    assert!(path.is_absolute(), "必须返回绝对路径：{saved}");
    assert!(path.is_file(), "返回的路径应已落盘：{saved}");
    let canonical_dir = std::fs::canonicalize(&dir).expect("目录规范化不应失败");
    assert_eq!(path.parent(), Some(canonical_dir.as_path()), "图片应落在文档所在的受信目录");
    let name = path.file_name().expect("应有文件名").to_string_lossy().into_owned();
    assert!(name.starts_with("图片-"), "文件名应以「图片-」开头：{name}");
    assert!(name.ends_with(".png"), "扩展名应归一为小写：{name}");
    let stamp = &name["图片-".len()..name.len() - ".png".len()];
    assert_eq!(stamp.len(), 15, "时间戳段应为 YYYYMMDD-HHMMSS：{name}");
    assert_eq!(stamp.as_bytes()[8], b'-', "日期与时间之间应是连字符：{name}");
    assert!(
        stamp.bytes().enumerate().all(|(i, b)| i == 8 || b.is_ascii_digit()),
        "时间戳段只含数字：{name}"
    );
    assert_eq!(
        std::fs::read(path).expect("读回图片不应失败"),
        bytes,
        "落盘字节应与输入逐一相等"
    );
    let names = dir_names(&dir);
    assert_eq!(names.len(), 2, "只应有文档 + 新图片（无 tmp 中转残留）：{names:?}");
}

/// ② 只文件受信而目录未受信：拒绝、文案含授权引导语、盘上一个字节都不写。
#[test]
fn file_only_trust_is_rejected_with_guidance_and_writes_nothing() {
    let dir = temp_dir_for("file-only");
    let doc = dir.join("a.md");
    std::fs::write(&doc, "# 文档\n").expect("预置文档不应失败");
    let trust = TrustedPaths::in_memory();
    trust
        .trust_existing(&doc.to_string_lossy())
        .expect("文件登记为受信不应失败");

    let err = save_paste_image_checked(&trust, b"x", "png", &doc.to_string_lossy())
        .expect_err("只文件受信而目录未受信必须拒绝");
    assert!(err.contains("图片需保存在文档目录"), "文案应含授权引导语：{err}");
    assert!(!err.contains("os error"), "不得把英文 OS 错误塞进 UI：{err}");
    assert_eq!(dir_names(&dir), vec!["a.md".to_string()], "被拒时不得写任何文件");
}

/// ③ 扩展名白名单：名单外一律拒绝（含 svg——渲染层图片白名单有它、粘贴白名单没有）；
/// 大写形态归一为小写后放行。白名单本集同锚（爆炸半径的书面口径）。
#[test]
fn non_whitelisted_extension_is_rejected() {
    let dir = temp_dir_for("ext");
    let (trust, doc) = trusted_dir_with_doc(&dir, "a.md");
    assert_eq!(
        PASTE_IMAGE_EXTENSIONS, ["png", "jpg", "jpeg", "gif", "webp"],
        "粘贴白名单只许这五种（爆炸半径口径）"
    );
    for bad in ["svg", "txt", "md", "exe", ""] {
        let err = save_paste_image_checked(&trust, b"x", bad, &doc.to_string_lossy())
            .expect_err("白名单外的扩展名必须拒绝");
        assert!(
            err.contains("不支持的图片格式"),
            "应给出格式不支持的文案（ext={bad:?}）：{err}"
        );
    }
    assert_eq!(dir_names(&dir), vec!["a.md".to_string()], "被拒时不得写任何文件");
    let saved = save_paste_image_checked(&trust, b"ok", "JPEG", &doc.to_string_lossy())
        .expect("扩展名大写应归一为小写后放行");
    assert!(saved.to_lowercase().ends_with(".jpeg"), "落盘扩展名应为小写：{saved}");
}

/// ④ 空内容拒绝。
#[test]
fn empty_bytes_is_rejected() {
    let dir = temp_dir_for("empty");
    let (trust, doc) = trusted_dir_with_doc(&dir, "a.md");
    let err = save_paste_image_checked(&trust, b"", "png", &doc.to_string_lossy())
        .expect_err("空内容必须拒绝");
    assert!(err.contains("内容为空"), "文案应说明内容为空：{err}");
    assert_eq!(dir_names(&dir), vec!["a.md".to_string()], "被拒时不得写任何文件");
}

/// ⑤ 同名冲突：两次快速粘贴不得落到同一文件（-2 递增或换秒，均不覆盖）；
/// 确定性直测：预占基础名与 -2 ⇒ 取到 -3，且已占文件原样保留。
#[test]
fn collision_appends_suffix_without_overwriting() {
    let dir = temp_dir_for("collide");
    let (trust, doc) = trusted_dir_with_doc(&dir, "a.md");
    let bytes: Vec<u8> = vec![7; 128];

    let first = save_paste_image_checked(&trust, &bytes, "png", &doc.to_string_lossy())
        .expect("第一次粘贴应成功");
    let second = save_paste_image_checked(&trust, &bytes, "png", &doc.to_string_lossy())
        .expect("第二次粘贴应成功");
    assert_ne!(first, second, "两次粘贴不得覆盖同一文件");
    assert_eq!(std::fs::read(&first).unwrap(), bytes, "第一份内容不变（未被覆盖）");
    assert_eq!(std::fs::read(&second).unwrap(), bytes, "第二份内容完整");

    let canonical_dir = std::fs::canonicalize(&dir).expect("目录规范化不应失败");
    std::fs::write(dir.join("图片-20260101-120000.png"), b"OCCUPIED-BASE")
        .expect("预占基础名不应失败");
    std::fs::write(dir.join("图片-20260101-120000-2.png"), b"OCCUPIED-2")
        .expect("预占 -2 序号不应失败");
    let got = unique_image_path(&canonical_dir, "20260101-120000", "png").expect("应取到 -3");
    assert!(
        got.file_name().unwrap().to_string_lossy().ends_with("图片-20260101-120000-3.png"),
        "序号应递增到 -3：{got:?}"
    );
    assert_eq!(
        std::fs::read(dir.join("图片-20260101-120000.png")).unwrap(),
        b"OCCUPIED-BASE",
        "已存在的文件必须原样保留（永不覆盖）"
    );
}

/// ⑥ 序号 -2..-99 全占用 ⇒ 报错（绝不落到第 100 个名字上去覆盖谁）。
#[test]
fn collision_exhausting_suffixes_errors() {
    let dir = temp_dir_for("exhaust");
    let canonical_dir = std::fs::canonicalize(&dir).expect("目录规范化不应失败");
    std::fs::write(dir.join("图片-20260101-120000.png"), b"x").expect("预占基础名不应失败");
    for n in 2..=99usize {
        std::fs::write(dir.join(format!("图片-20260101-120000-{n}.png")), b"x")
            .expect("预占序号不应失败");
    }
    let err = unique_image_path(&canonical_dir, "20260101-120000", "png")
        .expect_err("序号用尽必须报错");
    assert!(err.contains("无法保存图片"), "文案应中文面向使用者：{err}");
    assert_eq!(
        std::fs::read(dir.join("图片-20260101-120000.png")).unwrap(),
        b"x",
        "全占用时也不得改写任何已有文件"
    );
}

/// ⑦ 大小上限：恰好超 20MB 一个字节也拒绝，且不写盘。
#[test]
fn oversize_bytes_is_rejected() {
    let dir = temp_dir_for("oversize");
    let (trust, doc) = trusted_dir_with_doc(&dir, "a.md");
    let mut bytes = vec![0u8; MAX_PASTE_BYTES];
    bytes.push(1); // 恰好超 1 字节
    let err = save_paste_image_checked(&trust, &bytes, "png", &doc.to_string_lossy())
        .expect_err("超过 20MB 必须拒绝");
    assert!(err.contains("20MB"), "文案应说明大小上限：{err}");
    assert_eq!(dir_names(&dir), vec!["a.md".to_string()], "被拒时不得写任何文件");
}

/// ⑧ doc 本身未受信（存在但不在集合内）：拒绝且不写盘（信任模型的标准拒绝文案）。
#[test]
fn untrusted_doc_is_rejected() {
    let dir = temp_dir_for("no-trust");
    let doc = dir.join("a.md");
    std::fs::write(&doc, "# 文档\n").expect("预置文档不应失败");
    let trust = TrustedPaths::in_memory(); // 什么都不登记
    let err = save_paste_image_checked(&trust, b"x", "png", &doc.to_string_lossy())
        .expect_err("doc 未受信必须拒绝");
    assert!(
        err.contains("不在本次已打开的清单中"),
        "应给出信任模型的标准拒绝文案：{err}"
    );
    assert_eq!(dir_names(&dir), vec!["a.md".to_string()], "被拒时不得写任何文件");
}
