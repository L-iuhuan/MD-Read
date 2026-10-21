//! 任务栏 / Alt-Tab 的窗口图标（多尺寸，按窗口 DPI 取 ICO 原生帧）。
//!
//! 背景（2026-10-20 用户实测：任务栏图标明显比 Word / DSH 糊）：
//! · Tauri codegen 的 `default_window_icon` 取 `icons/icon.ico` 的**第一个条目**
//!   （本仓 ICO 按 16/20/…/256 升序写，第一个 = **16×16**）；
//! · tao 的 `set_window_icon` 只写 `WM_SETICON(ICON_SMALL)`，**不设 ICON_BIG**
//!   ⇒ 任务栏（32px 槽位）拿窗口的 16px 图标放大 = 糊。
//!
//! 修复：启动后按当前窗口 DPI 算系统图标槽位尺寸（96dpi→32、120dpi→40、144dpi→48、192dpi→64），
//! 从**本进程模块内嵌的 RT_GROUP_ICON**（tauri-build 把 icon.ico 整组嵌进 exe）取该尺寸的
//! **原生帧**，`WM_SETICON(ICON_BIG)`；窗口 DPI 变化（跨屏/改缩放）时重投。
//! 常见 DPI 的槽位尺寸（32/40/48/64）都在我们 ICO 的 10 档里 ⇒ 像素级 1:1，不缩放。
//!
//! ⚠ 为什么不是 `LoadImageW(LR_LOADFROMFILE, exe 路径)`：那要求目标是独立图片文件；
//!   exe 内嵌资源必须走「模块句柄 + 资源 id」。资源 id 不写死（tauri-build/winres 的 id 是实现细节），
//!   用 `EnumResourceNamesW(RT_GROUP_ICON)` 取第一个组 id——实测本仓为 32512，且 32px 帧与
//!   `icon.ico` 的 32px 帧逐像素一致（0 diff）。
//!
//! ⚠ 这不改图标视觉语言：只是把"16px 放大"换成"原生尺寸帧"。图标本身仍只来自已批准的纸页稿。
#![cfg(target_os = "windows")]

use std::sync::atomic::{AtomicIsize, Ordering};
use tauri::WebviewWindow;

#[link(name = "user32")]
extern "system" {
    fn LoadImageW(hinst: isize, name: *const u16, typ: u32, cx: i32, cy: i32, flags: u32) -> isize;
    fn SendMessageW(hwnd: isize, msg: u32, wparam: usize, lparam: isize) -> isize;
    fn DestroyIcon(icon: isize) -> i32;
    fn GetDpiForWindow(hwnd: isize) -> u32;
}

#[link(name = "kernel32")]
extern "system" {
    fn GetModuleHandleW(name: *const u16) -> isize;
    fn EnumResourceNamesW(
        hmodule: isize,
        lptype: isize,
        callback: Option<unsafe extern "system" fn(isize, isize, isize, isize) -> i32>,
        lparam: isize,
    ) -> i32;
}

const RT_GROUP_ICON: isize = 14;
const IMAGE_ICON: u32 = 1;
const WM_SETICON: u32 = 0x0080;
const ICON_BIG: usize = 1;

/// 最近一次由本模块设置的 ICON_BIG（DPI 变化时替换并销毁上一枚，避免句柄累积）。
static LAST_BIG: AtomicIsize = AtomicIsize::new(0);
/// 枚举到的 RT_GROUP_ICON 整数 id（`MAKEINTRESOURCE` 形态；0 = 未找到）。
static GROUP_ID: AtomicIsize = AtomicIsize::new(0);

/// 枚举回调：资源名若为整数 id（高 16 位为 0）就记住第一个并停止枚举。
unsafe extern "system" fn find_group_id(_m: isize, _t: isize, name: isize, _l: isize) -> i32 {
    if (name as usize) >> 16 == 0 {
        GROUP_ID.store(name, Ordering::SeqCst);
        return 0; // FALSE = 停止
    }
    1 // 字符串资源名，继续
}

/// DPI → 系统图标槽位像素（与 `GetSystemMetricsForDpi` 的 MulDiv 取整语义一致：
/// round(base × dpi / 96)，正数下用 `+48` 做四舍五入）。
pub(crate) fn icon_slot_px(base: i32, dpi: u32) -> i32 {
    let dpi = if dpi == 0 { 96 } else { dpi as i32 };
    (base * dpi + 48) / 96
}

/// 给指定窗口装多尺寸任务栏图标；失败只打日志，不阻断启动。
pub(crate) fn apply(window: &WebviewWindow) {
    let Ok(hwnd) = window.hwnd() else {
        eprintln!("[window-icon] 取窗口句柄失败，跳过多尺寸任务栏图标");
        return;
    };
    let hwnd = hwnd.0 as isize;
    let dpi = unsafe { GetDpiForWindow(hwnd) };
    let dpi = if dpi == 0 { 96 } else { dpi };
    let big = icon_slot_px(32, dpi);

    let module = unsafe { GetModuleHandleW(std::ptr::null()) };
    if module == 0 {
        eprintln!("[window-icon] 取模块句柄失败，跳过多尺寸任务栏图标");
        return;
    }
    let mut group_id = GROUP_ID.load(Ordering::SeqCst);
    if group_id == 0 {
        unsafe {
            let _ = EnumResourceNamesW(module, RT_GROUP_ICON, Some(find_group_id), 0);
        }
        group_id = GROUP_ID.load(Ordering::SeqCst);
    }
    if group_id == 0 {
        eprintln!("[window-icon] 未找到 RT_GROUP_ICON 图标组，任务栏退回系统缩放");
        return;
    }
    let name = group_id as usize as *const u16; // MAKEINTRESOURCE(id)
    let hicon = unsafe { LoadImageW(module, name, IMAGE_ICON, big, big, 0) };
    if hicon == 0 {
        eprintln!("[window-icon] LoadImageW 失败（{big}px，group={group_id}，dpi={dpi}）");
        return;
    }
    unsafe {
        let _ = SendMessageW(hwnd, WM_SETICON, ICON_BIG, hicon);
    }
    let prev = LAST_BIG.swap(hicon, Ordering::SeqCst);
    if prev != 0 {
        unsafe { DestroyIcon(prev) };
    }
    println!("[window-icon] ICON_BIG={big}px group={group_id} dpi={dpi}");
}

#[cfg(test)]
mod tests {
    use super::icon_slot_px;

    /// 常见 Windows 缩放的槽位必须落在我们 ICO 的 10 档里（32/40/48/64）；
    /// 96/120/144/192 分别对应 100%/125%/150%/200%，是任务栏最常请求的尺寸。
    #[test]
    fn dpi_slots_hit_native_ico_frames() {
        assert_eq!(icon_slot_px(32, 96), 32);
        assert_eq!(icon_slot_px(32, 120), 40);
        assert_eq!(icon_slot_px(32, 144), 48);
        assert_eq!(icon_slot_px(32, 192), 64);
        // dpi 读不到时按 100% 兜底
        assert_eq!(icon_slot_px(32, 0), 32);
        // 125% 的自定义值（如 104）会得到 35：ICO 无 35 档时 LoadImage 会取最近帧缩放，
        // 仍远好于旧行为（16 → 35 放大）。
        assert_eq!(icon_slot_px(32, 104), 35);
    }
}
