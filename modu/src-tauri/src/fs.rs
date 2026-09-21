//! 文件读写与编码契约：读取时 BOM 优先、chardetng 兜底检测；写回时保持原编码（D7 红线）。

use chardetng::{EncodingDetector, Iso2022JpDetection, Utf8Detection};
use encoding_rs::Encoding;
use serde::Serialize;

/// 读取结果：解码后的文本 + 实际使用的编码名（encoding_rs 规范名，可直接回传 save_file）
#[derive(Serialize)]
pub struct LoadedFile {
    pub text: String,
    pub encoding: String,
}

/// 解码字节流：有 BOM 按 BOM 隐含编码；无 BOM 用 chardetng 全量喂入（last=true）猜测。
/// 坏字节由 encoding_rs 替换为 U+FFFD，不视为失败。
fn decode_bytes(bytes: &[u8]) -> (String, String) {
    let encoding = match Encoding::for_bom(bytes) {
        Some((encoding, _bom_len)) => encoding,
        None => {
            let mut detector = EncodingDetector::new(Iso2022JpDetection::Deny);
            detector.feed(bytes, true);
            detector.guess(None, Utf8Detection::Allow)
        }
    };
    let (text, _had_errors) = encoding.decode_with_bom_removal(bytes);
    (text.into_owned(), encoding.name().to_string())
}

/// 读取文件并检测编码。错误信息面向使用者，含路径与原因。
#[tauri::command]
pub fn read_file(path: String) -> Result<LoadedFile, String> {
    let bytes = std::fs::read(&path).map_err(|e| format!("无法读取文件：{path}（{e}）"))?;
    let (text, encoding) = decode_bytes(&bytes);
    Ok(LoadedFile { text, encoding })
}

/// 按原编码写回文件。D7 红线：保持原编码，禁止静默转 UTF-8——
/// 编码名必须来自读取时的检测结果；未知编码名直接报错，绝不回退 UTF-8。
#[tauri::command]
pub fn save_file(path: String, text: String, encoding: String) -> Result<(), String> {
    let encoding = Encoding::for_label(encoding.as_bytes())
        .ok_or_else(|| format!("无法识别的编码名称：{encoding}"))?;
    let (bytes, _used, _had_errors) = encoding.encode(&text);
    std::fs::write(&path, bytes.as_ref()).map_err(|e| format!("无法写入文件：{path}（{e}）"))
}
