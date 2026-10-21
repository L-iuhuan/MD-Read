//! 任务栏 / Alt-Tab 的窗口图标（多尺寸，按任务栏实际尺寸取 ICO 原生帧）。
//!
//! 背景（2026-10-20 用户实测：任务栏图标明显比 Word / DSH 糊）：
//! · Tauri codegen 的 `default_window_icon` 取 `icons/icon.ico` 的**第一个条目**
//!   （本仓 ICO 按 16/20/…/256 升序写，第一个 = **16×16**）；
//! · tao 的 `set_window_icon` 只写 `WM_SETICON(ICON_SMALL)`，**不设 ICON_BIG**
//!   ⇒ 任务栏拿窗口的 16px 图标放大 = 糊。
//!
//! 第一版修复（0.2.10）按 `SM_CXICON` 取 32px 设 `ICON_BIG`，但 **Win11 任务栏实际只画 24px**
//! （100%；托盘厚度 48 = 24 图标 + 上下各 12 内边距），外壳把 32→24 再缩一次 ⇒ 仍然偏软
//! （2026-10-21 用户复测："和别的任务栏图标比还是糊"）。
//! ⇒ 现在按**任务栏厚度**反算它真正要的像素：`icon = thickness − round(24 × dpi/96)`
//!   （100%→24、125%→30、150%→36、200%→48；小任务栏 40→16、大任务栏 56→32），
//!   从**本进程模块内嵌的 RT_GROUP_ICON** 取该尺寸**原生帧**设 `ICON_BIG` ⇒ 任务栏 1:1 绘制。
//!   这些尺寸都在 ICO 的 12 档里（16/20/24/30/32/36/40/48/64/96/128/256）。
//!
//! ⚠ 为什么不是 `LoadImageW(LR_LOADFROMFILE, exe 路径)`：那要求目标是独立图片文件；
//!   exe 内嵌资源必须走「模块句柄 + 资源 id」。资源 id 不写死（tauri-build/winres 的 id 是实现细节），
//!   用 `EnumResourceNamesW(RT_GROUP_ICON)` 取第一个组 id——实测本仓为 32512。
//!
//! ⚠ 权衡：`ICON_BIG` 同时会被 Alt-Tab 等场景使用；设成任务栏尺寸后，Alt-Tab 若按更大尺寸绘制
//!   会做一次放大（可接受：用户实际看的是任务栏）。若将来 Alt-Tab 体验变差，再评估
//!   改为「任务栏用 ICON_BIG=24 + 另一个尺寸留给 Alt-Tab」的方案（WM_SETICON 只有一个 BIG 槽）。
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

#[link(name = "shell32")]
extern "system" {
    fn SHAppBarMessage(msg: u32, data: *mut AppBarData) -> usize;
}

const RT_GROUP_ICON: isize = 14;
const IMAGE_ICON: u32 = 1;
const WM_SETICON: u32 = 0x0080;
const ICON_BIG: usize = 1;
const ABM_GETTASKBARPOS: u32 = 5;

#[repr(C)]
#[derive(Default)]
struct Rect {
    left: i32,
    top: i32,
    right: i32,
    bottom: i32,
}

#[repr(C)]
#[derive(Default)]
struct AppBarData {
    cb_size: u32,
    hwnd: isize,
    callback_message: u32,
    edge: u32,
    rect: Rect,
    lparam: isize,
}

/// 最近一次由本模块设置的 ICON_BIG（DPI/任务栏变化时替换并销毁上一枚，避免句柄累积）。
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

/// 由任务栏厚度反算它实际绘制的图标尺寸（纯函数，便于单测）。
///
/// Win11 任务栏：厚度 48 → 图标 24（上下各 12）；125% 厚度 60 → 30；150% 72 → 36；
/// 200% 96 → 48；小任务栏 40 → 16；大任务栏 56 → 32。即 `icon = thickness − 24×scale`。
pub(crate) fn taskbar_icon_from_thickness(thickness: i32, dpi: u32) -> i32 {
    let base = icon_slot_px(24, dpi); // 24px 图标 + 12px×2 内边距
    let px = if thickness > base { thickness - base } else { base };
    px.clamp(16, 64)
}

/// 读任务栏厚度；读不到时返回 0（调用方按 DPI 兜底 24×scale）。
fn taskbar_thickness() -> i32 {
    let mut data = AppBarData::default();
    data.cb_size = std::mem::size_of::<AppBarData>() as u32;
    let ok = unsafe { SHAppBarMessage(ABM_GETTASKBARPOS, &mut data) };
    if ok == 0 {
        return 0;
    }
    let w = (data.rect.right - data.rect.left).max(0);
    let h = (data.rect.bottom - data.rect.top).max(0);
    w.min(h) // 横向任务栏取高度、竖向取宽度
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
    let thickness = taskbar_thickness();
    let big = taskbar_icon_from_thickness(thickness, dpi);

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
    println!(
        "[window-icon] ICON_BIG={big}px group={group_id} dpi={dpi} taskbar_thickness={thickness}"
    );
}

#[cfg(test)]
mod tests {
    use super::{icon_slot_px, taskbar_icon_from_thickness};

    /// 任务栏实际绘制的图标尺寸必须与我们 ICO 的档位一致（任务栏 1:1，不缩放）。
    /// Win11：厚度 48/60/72/96 对应 100/125/150/200% 的 24/30/36/48。
    #[test]
    fn taskbar_slots_hit_native_ico_frames() {
        assert_eq!(taskbar_icon_from_thickness(48, 96), 24);
        assert_eq!(taskbar_icon_from_thickness(60, 120), 30);
        assert_eq!(taskbar_icon_from_thickness(72, 144), 36);
        assert_eq!(taskbar_icon_from_thickness(96, 192), 48);
        // 小/大任务栏（TaskbarSi 0/2）
        assert_eq!(taskbar_icon_from_thickness(40, 96), 16);
        assert_eq!(taskbar_icon_from_thickness(56, 96), 32);
        // 读不到任务栏时按 24×scale 兜底（100%=24、125%=30）
        assert_eq!(taskbar_icon_from_thickness(0, 96), 24);
        assert_eq!(taskbar_icon_from_thickness(0, 120), 30);
        // 异常厚度不产生非法尺寸
        assert_eq!(taskbar_icon_from_thickness(8, 96), 24);
        assert_eq!(taskbar_icon_from_thickness(400, 96), 64);
    }

    /// 槽位公式本身：SM_CXICON 等系统尺寸仍按 MulDiv 取整。
    #[test]
    fn dpi_slots_hit_native_ico_frames() {
        assert_eq!(icon_slot_px(32, 96), 32);
        assert_eq!(icon_slot_px(32, 120), 40);
        assert_eq!(icon_slot_px(32, 144), 48);
        assert_eq!(icon_slot_px(32, 192), 64);
        assert_eq!(icon_slot_px(32, 0), 32);
        assert_eq!(icon_slot_px(32, 104), 35);
    }
}
