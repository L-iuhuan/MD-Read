//! `trust.rs` 的单测：纯策略（不碰盘）+ 临时目录上的集成用例。
//!
//! 覆盖设计稿 §6.1 的边界：同目录不同文件、`..` 穿越、大小写别名、相对路径、
//! 中文路径、非 .md、目录、缺失文件、白名单外写入、`forget` 后失效、持久化往返、
//! 损坏清单的降级（空集合），以及符号链接（建不出来就跳过并打印，不假装通过）。

use super::*;

/// 建一个唯一的临时目录（不引入 tempfile 依赖：进程号 + 纳秒）。
fn temp_dir(tag: &str) -> PathBuf {
    let nanos = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    let dir = std::env::temp_dir().join(format!("modu-trust-{}-{tag}-{nanos}", std::process::id()));
    std::fs::create_dir_all(&dir).expect("临时目录应可创建");
    dir
}

fn write(path: &Path, text: &str) {
    std::fs::write(path, text).expect("测试文件应可写");
}

#[test]
fn classify_rejects_relative_and_non_markdown() {
    assert_eq!(classify_name("sub\\a.md"), Err(DenyReason::NotAbsolute));
    assert_eq!(classify_name("..\\a.md"), Err(DenyReason::NotAbsolute));
    assert_eq!(classify_name("a.md"), Err(DenyReason::NotAbsolute));
    assert_eq!(classify_name("C:\\docs\\a.txt"), Err(DenyReason::NotMarkdown));
    assert_eq!(classify_name("C:\\docs\\a.md.exe"), Err(DenyReason::NotMarkdown));
    assert_eq!(classify_name("C:\\docs\\a"), Err(DenyReason::NotMarkdown));
    assert!(classify_name("C:\\docs\\a.md").is_ok());
    assert!(classify_name("C:\\docs\\a.MARKDOWN").is_ok(), "扩展名比对必须忽略大小写");
    assert!(classify_name("C:\\docs\\a.Mdx").is_ok());
    // UNC 只做形状判断（不触发网络：canonicalize 会打网络，故此处不测）
    assert!(classify_name("\\\\server\\share\\a.md").is_ok(), "UNC 是绝对路径");
}

#[test]
fn classify_rejects_empty_and_trailing_separator() {
    assert_eq!(classify_name(""), Err(DenyReason::NotAbsolute));
    assert_eq!(classify_name("C:\\docs\\"), Err(DenyReason::NotMarkdown));
}

#[test]
fn trusted_set_matches_exact_file_only_not_sibling_or_dir_itself() {
    let files: HashSet<String> = ["c:\\docs\\a.md".to_string()].into_iter().collect();
    let dirs: HashSet<String> = HashSet::new();
    assert!(is_trusted(Path::new("C:\\docs\\a.md"), &files, &dirs), "大小写不同也必须命中");
    assert!(!is_trusted(Path::new("C:\\docs\\b.md"), &files, &dirs), "同目录不同文件不得命中");
    assert!(!is_trusted(Path::new("C:\\docs"), &files, &dirs));
    assert!(!is_trusted(Path::new("C:\\docs\\a.md.bak"), &files, &dirs));
}

#[test]
fn trusted_dir_matches_descendants_by_component_not_string_prefix() {
    let files: HashSet<String> = HashSet::new();
    let dirs: HashSet<String> = ["c:\\books".to_string()].into_iter().collect();
    assert!(is_trusted(Path::new("C:\\books\\a.md"), &files, &dirs));
    assert!(is_trusted(Path::new("C:\\books\\sub\\deep\\b.md"), &files, &dirs));
    assert!(!is_trusted(Path::new("C:\\books-elsewhere\\a.md"), &files, &dirs), "字符串前缀不得算命中");
    assert!(!is_trusted(Path::new("C:\\books"), &files, &dirs), "目录本身不是文件");
    assert!(!is_trusted(Path::new("D:\\books\\a.md"), &files, &dirs), "别的盘符不得命中");
}

#[test]
fn read_write_round_trip_respects_trust_and_aliases() {
    let dir = temp_dir("基本");
    let doc = dir.join("笔记.md");
    let sibling = dir.join("别的.md");
    let sub = dir.join("子目录");
    std::fs::create_dir_all(&sub).expect("子目录应可创建");
    write(&doc, "受信内容");
    write(&sibling, "不该被读到");

    let trust = TrustedPaths::in_memory();
    // 未注册：拒，且文案是"不在清单中"
    let denied = trust.allowed_for_read(&sibling.to_string_lossy()).unwrap_err();
    assert!(denied.contains("不在本次已打开的清单中"), "实际文案：{denied}");
    // 注册后：允许（返回规范化路径）
    let canonical = trust.trust_existing(&doc.to_string_lossy()).expect("注册应成功");
    assert_eq!(trust.allowed_for_read(&doc.to_string_lossy()).unwrap(), canonical);
    assert_eq!(trust.counts().0, 1);
    assert_eq!(trust.allowed_for_read(&doc.to_string_lossy()).unwrap().file_name().unwrap(), "笔记.md");
    // 别名：`..` 穿越回同一文件 → 命中；大小写别名 → 命中
    let dotted = format!("{}\\子目录\\..\\笔记.md", dir.to_string_lossy());
    assert_eq!(trust.allowed_for_read(&dotted).expect(".. 别名应命中同一文件"), canonical);
    let upper = doc.to_string_lossy().to_uppercase();
    if upper != doc.to_string_lossy() {
        assert_eq!(trust.allowed_for_read(&upper).expect("大小写别名应命中"), canonical);
    }
    // `..` 逃逸到同目录的兄弟文件 → 拒
    let escape = format!("{}\\子目录\\..\\别的.md", dir.to_string_lossy());
    assert!(trust.allowed_for_read(&escape).is_err(), ".. 不能把未受信文件变成受信");
    // 子目录里的文件未注册 → 拒
    let deep = sub.join("深层.md");
    write(&deep, "x");
    assert!(trust.allowed_for_read(&deep.to_string_lossy()).is_err());
    // forget 后失效
    trust.forget(&doc.to_string_lossy());
    assert!(trust.allowed_for_read(&doc.to_string_lossy()).is_err(), "forget 后必须失效");
}

#[test]
fn missing_directory_and_non_markdown_get_their_own_messages() {
    let dir = temp_dir("文案");
    let trust = TrustedPaths::in_memory();
    let missing = dir.join("没有这个.md");
    let message = trust.allowed_for_read(&missing.to_string_lossy()).unwrap_err();
    assert!(message.contains("文件不存在或已被移动"), "实际：{message}");
    let txt = dir.join("a.txt");
    write(&txt, "x");
    let message = trust.allowed_for_read(&txt.to_string_lossy()).unwrap_err();
    assert!(message.contains("只支持 Markdown 文件"), "实际：{message}");
    let message = trust.allowed_for_read(&dir.to_string_lossy()).unwrap_err();
    assert!(message.contains("只支持 Markdown 文件") || message.contains("不是文件"), "实际：{message}");
    let message = trust.allowed_for_read("相对路径.md").unwrap_err();
    assert!(message.contains("路径必须是完整路径"), "实际：{message}");
    // 注册目录本身：不是文件 → 拒
    let message = trust.trust_existing(&dir.to_string_lossy()).unwrap_err();
    assert!(message.contains("只支持 Markdown 文件") || message.contains("不是文件"), "实际：{message}");
}

#[test]
fn save_requires_trusted_file_or_trusted_parent_dir() {
    let dir = temp_dir("写");
    let doc = dir.join("已打开.md");
    write(&doc, "哨兵内容");
    let fresh = dir.join("新文件.md");
    let trust = TrustedPaths::in_memory();
    // 未受信、已存在 → 拒
    assert!(trust.allowed_for_save(&doc.to_string_lossy()).is_err());
    // 未受信、不存在、父目录也未受信 → 拒
    assert!(trust.allowed_for_save(&fresh.to_string_lossy()).is_err());
    // 受信文件 → 允许
    trust.trust_existing(&doc.to_string_lossy()).expect("注册");
    assert_eq!(trust.allowed_for_save(&doc.to_string_lossy()).unwrap(), std::fs::canonicalize(&doc).unwrap());
    // 父目录受信 → 该目录下的新文件允许（"另存为"路径；今天无此流程，仅机制）
    let target_dir = temp_dir("工作区");
    trust.trust_dir(&target_dir.to_string_lossy()).expect("注册目录");
    let new_doc = target_dir.join("另存.md");
    assert!(trust.allowed_for_save(&new_doc.to_string_lossy()).is_ok(), "受信目录下的新文件应可另存");
    // 受信目录之外的新文件仍拒
    let outside = temp_dir("外部").join("别处.md");
    assert!(trust.allowed_for_save(&outside.to_string_lossy()).is_err());
}

#[test]
fn persistence_round_trip_and_corrupt_store_falls_back_to_empty() {
    let store = temp_dir("持久化").join("trusted-paths.json");
    let doc_dir = temp_dir("持久化文档");
    let doc = doc_dir.join("记住我.md");
    write(&doc, "x");

    let first = TrustedPaths::load(store.clone());
    first.trust_existing(&doc.to_string_lossy()).expect("注册");
    assert!(first.allowed_for_read(&doc.to_string_lossy()).is_ok());

    // 重新载入（模拟重启）→ 仍然受信（D-10：最近文件零打扰重开的前提）
    let second = TrustedPaths::load(store.clone());
    assert!(second.allowed_for_read(&doc.to_string_lossy()).is_ok(), "持久化后重开必须仍受信");
    assert_eq!(second.counts().0, 1);

    // 损坏的清单 → 空集合，不 panic、不放行
    std::fs::write(&store, "{ 这不是 JSON").expect("写坏清单");
    let broken = TrustedPaths::load(store.clone());
    assert_eq!(broken.counts(), (0, 0));
    assert!(broken.allowed_for_read(&doc.to_string_lossy()).is_err());

    // 版本不符同样按空集合
    std::fs::write(&store, r#"{"version":99,"files":["c:\\x.md"],"dirs":[]}"#).expect("写版本");
    let future = TrustedPaths::load(store);
    assert_eq!(future.counts(), (0, 0));
}

#[test]
fn symlink_alias_cannot_escape_the_trusted_set() {
    let dir = temp_dir("链接");
    let target_dir = temp_dir("链接目标");
    let real = target_dir.join("真身.md");
    write(&real, "真身内容");
    let link = dir.join("别名.md");
    if std::os::windows::fs::symlink_file(&real, &link).is_err() {
        println!("[trust_tests] 本机无权限创建符号链接（需开发者模式/管理员）→ 跳过符号链接用例");
        return;
    }
    let trust = TrustedPaths::in_memory();
    // 注册"真身"后，通过链接访问解析到同一 canonical → 命中（同一个文件，正确）
    trust.trust_existing(&real.to_string_lossy()).expect("注册真身");
    assert!(trust.allowed_for_read(&link.to_string_lossy()).is_ok(), "链接指向受信文件应命中");
    // 反过来：注册"链接"会让 canonical 落到真身 —— 仍是同一个文件，不算绕过
    let other_target = target_dir.join("另一个.md");
    write(&other_target, "x");
    let other_link = dir.join("另一个别名.md");
    if std::os::windows::fs::symlink_file(&other_target, &other_link).is_ok() {
        let fresh = TrustedPaths::in_memory();
        fresh.trust_existing(&other_link.to_string_lossy()).expect("注册链接");
        assert!(fresh.allowed_for_read(&other_target.to_string_lossy()).is_ok(), "注册链接=注册其真身");
        assert!(fresh.allowed_for_read(&real.to_string_lossy()).is_err(), "不得因此放行无关文件");
    }
}

#[test]
fn chinese_paths_and_spaces_survive_trust_round_trip() {
    let dir = temp_dir("中文 带空格");
    let doc = dir.join("季度 复盘（第三季）.md");
    write(&doc, "内容");
    let trust = TrustedPaths::in_memory();
    trust.trust_existing(&doc.to_string_lossy()).expect("中文路径应可注册");
    assert!(trust.allowed_for_read(&doc.to_string_lossy()).is_ok());
    let (files, dirs) = trust.counts();
    assert_eq!((files, dirs), (1, 0));
}

#[test]
fn image_allowed_only_beside_a_trusted_document_or_under_a_trusted_dir() {
    let doc_dir = temp_dir("图片同目录");
    let doc = doc_dir.join("笔记.md");
    write(&doc, "x");
    let beside = doc_dir.join("同目录图.png");
    write(&beside, "png");
    let sub = doc_dir.join("assets");
    std::fs::create_dir_all(&sub).expect("子目录");
    let in_sub = sub.join("深层图.png");
    write(&in_sub, "png");
    let outside_dir = temp_dir("图片外部");
    let outside = outside_dir.join("别处图.png");
    write(&outside, "png");
    let prefix_sibling = temp_dir("图片同目录-后缀");
    let in_prefix_sibling = prefix_sibling.join("前缀相似图.png");
    write(&in_prefix_sibling, "png");

    let canon = |p: &Path| std::fs::canonicalize(p).expect("canonicalize");
    let trust = TrustedPaths::in_memory();
    // 还没有任何受信文档 → 一律不放行
    assert!(!trust.image_allowed(&canon(&beside)), "无受信文档时不得放行任何图片");
    trust.trust_existing(&doc.to_string_lossy()).expect("注册文档");
    assert!(trust.image_allowed(&canon(&beside)), "受信文档**同目录**的图片应放行");
    assert!(trust.image_allowed(&canon(&in_sub)), "受信文档**子目录**的图片应放行");
    assert!(!trust.image_allowed(&canon(&outside)), "受信文档目录**之外**的图片不得放行");
    assert!(
        !trust.image_allowed(&canon(&in_prefix_sibling)),
        "目录名仅前缀相同（`X` vs `X-后缀`）不得命中"
    );
    // 文档仍可正常读写（确认收紧没改坏原有集合语义）
    assert!(trust.allowed_for_read(&doc.to_string_lossy()).is_ok());
    // ⚠️ 口径锚：**非规范化**路径不得命中 —— 调用方（`allow_asset_paths`）必须先 `canonicalize`，
    //    否则"文档同目录的图片"会被全部误拒（2026-09-23 真机抓到的接线 bug）。
    assert!(
        !trust.image_allowed(&beside),
        "非 canonical 路径不得命中：集合键是 canonical 形态（Windows 带 \\\\?\\ 前缀）"
    );
    // 受信目录也能放行（D-11 文件夹工作区/另存的落点）
    trust.trust_dir(&outside_dir.to_string_lossy()).expect("注册受信目录");
    assert!(trust.image_allowed(&canon(&outside)), "受信目录之内的图片应放行");
}
