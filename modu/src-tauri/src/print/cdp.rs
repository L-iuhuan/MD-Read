//! CDP `Page.printToPDF` 调用链（D-20 第二步：去掉页眉的打印日期、只留中式页码）。
//!
//! 为什么不用 `ICoreWebView2PrintSettings`：页眉与页脚**无分离开关**——页眉（日期+标题）
//! 与页脚（URI+页码）四者共享 `ShouldPrintHeaderAndFooter` 一个布尔，`HeaderTitle=""`
//! 只撤标题不撤日期（官方文档 + 本机 webview2-com-sys 0.38.2 绑定双源核实：只有
//! `_1/_2`，不存在 `_3`）。CDP `Page.printToPDF` 的 `headerTemplate`（置空）+
//! `footerTemplate`（只放 pageNumber）才能做到「彻底无页眉、只有页码」。
//!
//! 回包是 `{"data":"<base64 pdf>"}`：本模块负责解析 + 解码成字节；落盘仍由 print.rs
//! 的「同目录临时文件 + 原子改名」收尾（P0-8「失败不毁目标文件」语义不变）。

use std::sync::mpsc;

use webview2_com::Microsoft::Web::WebView2::Win32::{
    ICoreWebView2, ICoreWebView2CallDevToolsProtocolMethodCompletedHandler,
    ICoreWebView2CallDevToolsProtocolMethodCompletedHandler_Impl,
};
use windows_core::{implement, PCWSTR};

/// `Page.printToPDF` 参数（评审定稿，逐项都有理由）：
/// - `displayHeaderFooter:true` 是页眉页脚总闸，必须开（关掉页码也没了）；
/// - `headerTemplate:"<div></div>"` 不含任何占位类 = **彻底无页眉**（打印日期就此消失）；
/// - `footerTemplate` 只放 `pageNumber` = **只有页码**，中式「— 1 —」；
/// - `printBackground:true` 等价旧的 `ShouldPrintBackgrounds(true)`——print.css
///   `print-color-adjust:exact` 颜色保真的物理前提，漏了颜色就不进 PDF；
/// - `preferCSSPageSize:true` 让 print.css 的 `@page{size:A4;margin:18mm}` 继续驱动版式；
///   `paperWidth/Height` 只在它失效时兜底（真 A4 = 210×297mm = 8.27×11.69in）。
const PRINT_TO_PDF_PARAMS: &str = r#"{
  "displayHeaderFooter": true,
  "headerTemplate": "<div></div>",
  "footerTemplate": "<div style=\"width:100%;text-align:center;font-size:9px;color:#666;\">— <span class=\"pageNumber\"></span> —</div>",
  "printBackground": true,
  "preferCSSPageSize": true,
  "paperWidth": 8.27,
  "paperHeight": 11.69
}"#;

/// CDP 完成回调：把回包里的 base64 PDF 解码成字节送进通道
#[implement(ICoreWebView2CallDevToolsProtocolMethodCompletedHandler)]
struct PrintToPdfDone {
    tx: mpsc::Sender<Result<Vec<u8>, String>>,
}

impl ICoreWebView2CallDevToolsProtocolMethodCompletedHandler_Impl for PrintToPdfDone_Impl {
    fn Invoke(
        &self,
        errorcode: windows_core::HRESULT,
        result: &PCWSTR,
    ) -> windows_core::Result<()> {
        let _ = self.tx.send(read_pdf_result(errorcode, result));
        Ok(())
    }
}

/// 回包 JSON → PDF 字节：hr 不合格、缺 `data` 字段、base64 坏，三种都转成中文错误
fn read_pdf_result(errorcode: windows_core::HRESULT, result: &PCWSTR) -> Result<Vec<u8>, String> {
    if !errorcode.is_ok() {
        return Err(format!("打印引擎返回错误：hr={errorcode:?}"));
    }
    let json = String::from_utf16_lossy(unsafe { result.as_wide() });
    let data = serde_json::from_str::<serde_json::Value>(&json)
        .ok()
        .and_then(|value| value.get("data")?.as_str().map(str::to_owned))
        .ok_or_else(|| "导出失败：打印引擎没有返回 PDF 数据".to_string())?;
    decode_base64(&data)
}

/// 提交 `Page.printToPDF`（必须在 UI 线程执行，由 with_webview 闭包调用）。
/// 两个宽串都活到函数末尾：COM 在调用返回前读完参数（与旧 PrintToPdf 路径同款约定）。
pub(super) unsafe fn run_cdp_chain(
    core: ICoreWebView2,
    tx: mpsc::Sender<Result<Vec<u8>, String>>,
) {
    let method = wide("Page.printToPDF");
    let params = wide(PRINT_TO_PDF_PARAMS);
    let handler: ICoreWebView2CallDevToolsProtocolMethodCompletedHandler =
        PrintToPdfDone { tx }.into();
    if let Err(e) = core.CallDevToolsProtocolMethod(
        PCWSTR::from_raw(method.as_ptr()),
        PCWSTR::from_raw(params.as_ptr()),
        &handler,
    ) {
        // tx 已随 handler 移交：提交失败时通道随 handler 析构而关闭，
        // 外层 recv 立即收到 Disconnected 转成错误返回，不会悬挂。
        println!("[export] Page.printToPDF 提交失败: {e}");
    }
}

/// UTF-16 + NUL 结尾（`PCWSTR` 只借指针，调用点必须让这个 Vec 活过整次调用）
fn wide(text: &str) -> Vec<u16> {
    text.encode_utf16().chain(std::iter::once(0)).collect()
}

/// 标准表 base64 解码（纯 std）。依据查证：`Cargo.lock` 里的 base64 0.21.7/0.22.1/0.23.1
/// 全是 tauri / reqwest 一侧的**传递依赖**，不是 modu 的直接依赖；AGENTS.md「依赖新增须过评审
/// （8MB 门禁）」，而这里只有 20 余行，故自写、不动依赖图。
/// 表外字符、换行与空白：空白（CDP 偶发折行）跳过，其余一律报错（不静默产出坏 PDF）。
fn decode_base64(input: &str) -> Result<Vec<u8>, String> {
    let mut out = Vec::with_capacity(input.len() / 4 * 3);
    let mut acc: u32 = 0;
    let mut bits: u32 = 0;
    for byte in input.bytes() {
        let value = match byte {
            b'A'..=b'Z' => byte - b'A',
            b'a'..=b'z' => byte - b'a' + 26,
            b'0'..=b'9' => byte - b'0' + 52,
            b'+' => 62,
            b'/' => 63,
            b'=' | b'\r' | b'\n' | b' ' | b'\t' => continue,
            _ => return Err("导出失败：PDF 数据无法解码".to_string()),
        } as u32;
        acc = ((acc << 6) | value) & 0x00ff_ffff;
        bits += 6;
        if bits >= 8 {
            bits -= 8;
            out.push((acc >> bits) as u8);
        }
    }
    Ok(out)
}

#[cfg(test)]
mod cdp_tests {
    use super::{decode_base64, read_pdf_result, wide};
    use windows_core::{HRESULT, PCWSTR};

    /// 回调回包里的 PDF 字节原样取出（带补位与不带补位的 base64 都要能解）。
    #[test]
    fn base64_decodes_padded_and_unpadded() {
        assert_eq!(decode_base64("SGVsbG8=").expect("Hello 应可解"), b"Hello");
        assert_eq!(decode_base64("TWFu").expect("Man 应可解"), b"Man");
        assert_eq!(decode_base64("").expect("空串应可解"), b"");
    }

    /// base64 的二进制安全：0x00/0xFF 这类字节经编码解码必须逐字节往返。
    #[test]
    fn base64_survives_binary_bytes_round_trip() {
        // "AAECAwT/AA==" 是 [0x00,0x01,0x02,0x03,0x04,0xFF,0x00] 的标准表编码
        let decoded = decode_base64("AAECAwT/AA==").expect("二进制应可解");
        assert_eq!(decoded, vec![0x00, 0x01, 0x02, 0x03, 0x04, 0xFF, 0x00]);
    }

    /// 折行/空白（CDP 回包可能折行）跳过；表外字符必须报错，不静默产出坏 PDF。
    #[test]
    fn base64_skips_whitespace_and_rejects_foreign_chars() {
        let wrapped = decode_base64("SGVs\nbG8=\r\n").expect("折行应可解");
        assert_eq!(wrapped, b"Hello");
        let err = decode_base64("SGVs*G8=").expect_err("表外字符必须报错");
        assert!(err.contains("无法解码"), "错误信息应中文面向使用者：{err}");
    }

    /// 回包解析：hr 失败报错；正常 hr 但缺 data / data 坏都要报错；正常回包给出字节。
    #[test]
    fn read_pdf_result_parses_data_or_reports_chinese_error() {
        let call = |json: &str, hr: i32| {
            let buffer = wide(json);
            read_pdf_result(HRESULT(hr), &PCWSTR::from_raw(buffer.as_ptr()))
        };
        let ok = call(r#"{"data":"SGVsbG8="}"#, 0).expect("正常回包应解出字节");
        assert_eq!(ok, b"Hello");

        let failed = call(r#"{"data":"SGVsbG8="}"#, 0x8000_4004u32 as i32)
            .expect_err("hr 失败必须转错");
        assert!(failed.contains("hr="), "应带上 hr：{failed}");

        let missing = call("{}", 0).expect_err("缺 data 必须转错");
        assert!(missing.contains("没有返回 PDF 数据"), "应说明缺数据：{missing}");

        let broken = call(r#"{"data":"%%%"}"#, 0).expect_err("坏 base64 必须转错");
        assert!(broken.contains("无法解码"), "应说明解码失败：{broken}");

        let not_json = call("not-json", 0).expect_err("非 JSON 必须转错");
        assert!(not_json.contains("没有返回 PDF 数据"), "应说明缺数据：{not_json}");
    }
}
