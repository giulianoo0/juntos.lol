//! Windows: what can be shared, as the picker shows it.

use std::collections::HashMap;
use std::ffi::c_void;
use std::sync::OnceLock;

use base64::Engine;
use parking_lot::Mutex;
use windows::core::{BOOL, PCWSTR, PWSTR};
use windows::Win32::Foundation::{CloseHandle, HWND, LPARAM, RECT};
use windows::Win32::Graphics::Dwm::{DwmGetWindowAttribute, DWMWA_CLOAKED};
use windows::Win32::Graphics::Gdi::{
    BitBlt, CreateCompatibleBitmap, CreateCompatibleDC, DeleteDC, DeleteObject, EnumDisplayMonitors, GetDC, GetDIBits, GetMonitorInfoW,
    ReleaseDC, SelectObject, BITMAPINFO, BITMAPINFOHEADER, BI_RGB, DIB_RGB_COLORS, HBITMAP, HDC, HMONITOR, MONITORINFO, MONITORINFOEXW,
    SRCCOPY,
};
use windows::Win32::Storage::Xps::{PrintWindow, PRINT_WINDOW_FLAGS};
use windows::Win32::Storage::FileSystem::{GetFileVersionInfoSizeW, GetFileVersionInfoW, VerQueryValueW};
use windows::Win32::System::Threading::{OpenProcess, QueryFullProcessImageNameW, PROCESS_NAME_WIN32, PROCESS_QUERY_LIMITED_INFORMATION};
use windows::Win32::UI::Shell::SHDefExtractIconW;
use windows::Win32::UI::WindowsAndMessaging::{
    DestroyIcon, EnumWindows, GetIconInfo, GetWindow, GetWindowLongW, GetWindowRect, GetWindowTextLengthW, GetWindowTextW,
    GetWindowThreadProcessId, IsIconic, IsWindowVisible, GWL_EXSTYLE, GW_OWNER, HICON, ICONINFO,
    WS_EX_TOOLWINDOW,
};

use super::{AudioApp, Display, Sources, Target, TargetKind, Window};

pub use super::win_audio::Audio;
pub use super::win_video::Video;

const PW_RENDERFULLCONTENT: u32 = 2;

pub fn sources() -> Result<Sources, String> {
    let displays = monitors()
        .into_iter()
        .enumerate()
        .map(|(n, (_, info))| Display {
            id: device_name(&info),
            name: format!("Tela {}", n + 1),
            width: (info.monitorInfo.rcMonitor.right - info.monitorInfo.rcMonitor.left) as u32,
            height: (info.monitorInfo.rcMonitor.bottom - info.monitorInfo.rcMonitor.top) as u32,
        })
        .collect();
    let windows = shareable_windows()
        .into_iter()
        .map(|(hwnd, title, exe)| Window {
            id: (hwnd.0 as isize).to_string(),
            title,
            app: exe.as_deref().map(app_name).unwrap_or_default(),
            icon: exe.as_deref().and_then(icon),
        })
        .collect();
    Ok(Sources { displays, windows })
}

pub fn thumbnail(target: &Target, width: u32) -> Result<String, String> {
    let (bgra, w, h) = match target.kind {
        TargetKind::Display => {
            let (_, info) = monitor(&target.id).ok_or("not_found: display")?;
            grab_screen(info.monitorInfo.rcMonitor)
        }
        TargetKind::Window => grab_window(window(&target.id).ok_or("not_found: window")?),
    }
    .ok_or("capture_failed: thumbnail")?;
    let image = image::RgbaImage::from_raw(w, h, bgra_to_rgba(bgra, true)).ok_or("capture_failed: thumbnail")?;
    let height = ((h as f32) * (width as f32) / (w.max(1) as f32)).round().max(1.0) as u32;
    let small = image::imageops::thumbnail(&image, width, height);
    let mut out = Vec::new();
    image::codecs::jpeg::JpegEncoder::new_with_quality(&mut out, 72)
        .encode_image(&image::DynamicImage::ImageRgba8(small).to_rgb8())
        .map_err(|e| format!("capture_failed: {e}"))?;
    Ok(format!("data:image/jpeg;base64,{}", base64::engine::general_purpose::STANDARD.encode(out)))
}

pub fn audio_apps() -> Result<Vec<AudioApp>, String> {
    let sessions = super::win_audio::sessions().map_err(|e| format!("audio_failed: {e}"))?;
    let procs = super::win_audio::processes();
    let paths: HashMap<String, String> = sessions.iter().filter_map(|p| Some((p.id.clone(), exe_path(p.pid)?))).collect();
    Ok(super::audible(&sessions, &procs)
        .into_iter()
        .map(|app| {
            let path = paths.get(&app.id);
            AudioApp { name: path.map(|p| app_name(p)).unwrap_or(app.name), icon: path.and_then(|p| icon(p)), id: app.id }
        })
        .collect())
}

pub(super) fn monitors() -> Vec<(HMONITOR, MONITORINFOEXW)> {
    unsafe extern "system" fn each(monitor: HMONITOR, _: HDC, _: *mut RECT, data: LPARAM) -> BOOL {
        let list = &mut *(data.0 as *mut Vec<(HMONITOR, MONITORINFOEXW)>);
        let mut info = MONITORINFOEXW::default();
        info.monitorInfo.cbSize = std::mem::size_of::<MONITORINFOEXW>() as u32;
        if GetMonitorInfoW(monitor, &mut info as *mut MONITORINFOEXW as *mut MONITORINFO).as_bool() {
            list.push((monitor, info));
        }
        BOOL(1)
    }
    let mut list: Vec<(HMONITOR, MONITORINFOEXW)> = Vec::new();
    unsafe {
        let _ = EnumDisplayMonitors(None, None, Some(each), LPARAM(&mut list as *mut _ as isize));
    }
    // The primary display first: it is the one people mean by "the screen".
    list.sort_by_key(|(_, info)| (info.monitorInfo.dwFlags & 1) == 0);
    list
}

fn device_name(info: &MONITORINFOEXW) -> String {
    let len = info.szDevice.iter().position(|&c| c == 0).unwrap_or(info.szDevice.len());
    String::from_utf16_lossy(&info.szDevice[..len])
}

pub(super) fn monitor(id: &str) -> Option<(HMONITOR, MONITORINFOEXW)> {
    monitors().into_iter().find(|(_, info)| device_name(info) == id)
}

pub(super) fn window(id: &str) -> Option<HWND> {
    let raw: isize = id.parse().ok()?;
    let hwnd = HWND(raw as *mut c_void);
    unsafe { IsWindowVisible(hwnd).as_bool() }.then_some(hwnd)
}

fn shareable_windows() -> Vec<(HWND, String, Option<String>)> {
    unsafe extern "system" fn each(hwnd: HWND, data: LPARAM) -> BOOL {
        let list = &mut *(data.0 as *mut Vec<HWND>);
        list.push(hwnd);
        BOOL(1)
    }
    let mut all: Vec<HWND> = Vec::new();
    unsafe {
        let _ = EnumWindows(Some(each), LPARAM(&mut all as *mut _ as isize));
    }
    let me = std::process::id();
    all.into_iter()
        .filter_map(|hwnd| unsafe {
            if !IsWindowVisible(hwnd).as_bool() || GetWindow(hwnd, GW_OWNER).is_ok_and(|owner| !owner.is_invalid()) {
                return None;
            }
            if (GetWindowLongW(hwnd, GWL_EXSTYLE) as u32) & WS_EX_TOOLWINDOW.0 != 0 {
                return None;
            }
            let mut cloaked = 0u32;
            let _ = DwmGetWindowAttribute(hwnd, DWMWA_CLOAKED, &mut cloaked as *mut u32 as *mut c_void, 4);
            if cloaked != 0 {
                return None;
            }
            let len = GetWindowTextLengthW(hwnd);
            if len == 0 {
                return None;
            }
            let mut buf = vec![0u16; len as usize + 1];
            let got = GetWindowTextW(hwnd, &mut buf);
            let title = String::from_utf16_lossy(&buf[..got as usize]);
            let mut pid = 0u32;
            GetWindowThreadProcessId(hwnd, Some(&mut pid));
            if pid == me {
                return None;
            }
            let exe = exe_path(pid);
            // Shell surfaces with a title but nothing to watch.
            if exe.as_deref().map(super::app_id).is_some_and(|id| id == "textinputhost" || id == "applicationframehost" && title.is_empty()) {
                return None;
            }
            Some((hwnd, title, exe))
        })
        .collect()
}

pub(super) fn exe_path(pid: u32) -> Option<String> {
    unsafe {
        let process = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid).ok()?;
        let mut buf = [0u16; 1024];
        let mut len = buf.len() as u32;
        let ok = QueryFullProcessImageNameW(process, PROCESS_NAME_WIN32, PWSTR(buf.as_mut_ptr()), &mut len).is_ok();
        let _ = CloseHandle(process);
        ok.then(|| String::from_utf16_lossy(&buf[..len as usize]))
    }
}

fn wide(s: &str) -> Vec<u16> {
    s.encode_utf16().chain(Some(0)).collect()
}

/// What people call an app: the file description its executable carries,
/// else its product name, else the file's name.
pub(super) fn app_name(exe: &str) -> String {
    static NAMES: OnceLock<Mutex<HashMap<String, String>>> = OnceLock::new();
    let names = NAMES.get_or_init(Default::default);
    if let Some(name) = names.lock().get(exe) {
        return name.clone();
    }
    let name = version_string(exe, "FileDescription")
        .or_else(|| version_string(exe, "ProductName"))
        .filter(|n| !n.trim().is_empty())
        .unwrap_or_else(|| {
            let file = exe.rsplit(['\\', '/']).next().unwrap_or(exe);
            file.rsplit_once('.').map(|(stem, _)| stem).unwrap_or(file).to_string()
        });
    names.lock().insert(exe.to_string(), name.clone());
    name
}

fn version_string(exe: &str, key: &str) -> Option<String> {
    unsafe {
        let path = wide(exe);
        let size = GetFileVersionInfoSizeW(PCWSTR(path.as_ptr()), None);
        if size == 0 {
            return None;
        }
        let mut data = vec![0u8; size as usize];
        GetFileVersionInfoW(PCWSTR(path.as_ptr()), None, size, data.as_mut_ptr() as *mut c_void).ok()?;
        let mut ptr: *mut c_void = std::ptr::null_mut();
        let mut len = 0u32;
        let translation = wide("\\VarFileInfo\\Translation");
        let lang = if VerQueryValueW(data.as_ptr() as *const c_void, PCWSTR(translation.as_ptr()), &mut ptr, &mut len).as_bool() && len >= 4 {
            let pair = std::slice::from_raw_parts(ptr as *const u16, 2);
            format!("{:04x}{:04x}", pair[0], pair[1])
        } else {
            "040904b0".to_string()
        };
        let query = wide(&format!("\\StringFileInfo\\{lang}\\{key}"));
        if !VerQueryValueW(data.as_ptr() as *const c_void, PCWSTR(query.as_ptr()), &mut ptr, &mut len).as_bool() || len == 0 {
            return None;
        }
        let text = std::slice::from_raw_parts(ptr as *const u16, len as usize);
        let end = text.iter().position(|&c| c == 0).unwrap_or(text.len());
        Some(String::from_utf16_lossy(&text[..end]).trim().to_string())
    }
}

/// The executable's own icon at 64 px, as a PNG data URL.
pub(super) fn icon(exe: &str) -> Option<String> {
    static ICONS: OnceLock<Mutex<HashMap<String, Option<String>>>> = OnceLock::new();
    let icons = ICONS.get_or_init(Default::default);
    if let Some(icon) = icons.lock().get(exe) {
        return icon.clone();
    }
    let icon = extract_icon(exe);
    icons.lock().insert(exe.to_string(), icon.clone());
    icon
}

fn extract_icon(exe: &str) -> Option<String> {
    unsafe {
        let path = wide(exe);
        let mut large = HICON::default();
        if SHDefExtractIconW(PCWSTR(path.as_ptr()), 0, 0, Some(&mut large), None, 64).is_err() || large.is_invalid() {
            return None;
        }
        let pixels = icon_pixels(large);
        let _ = DestroyIcon(large);
        let (bgra, w, h) = pixels?;
        let image = image::RgbaImage::from_raw(w, h, bgra_to_rgba(bgra, false))?;
        let mut out = std::io::Cursor::new(Vec::new());
        image.write_to(&mut out, image::ImageFormat::Png).ok()?;
        Some(format!("data:image/png;base64,{}", base64::engine::general_purpose::STANDARD.encode(out.into_inner())))
    }
}

unsafe fn icon_pixels(icon: HICON) -> Option<(Vec<u8>, u32, u32)> {
    let mut info = ICONINFO::default();
    GetIconInfo(icon, &mut info).ok()?;
    let result = bitmap_pixels(info.hbmColor);
    let _ = DeleteObject(info.hbmColor.into());
    let _ = DeleteObject(info.hbmMask.into());
    result
}

unsafe fn bitmap_pixels(bitmap: HBITMAP) -> Option<(Vec<u8>, u32, u32)> {
    let dc = CreateCompatibleDC(None);
    let mut header = BITMAPINFO { bmiHeader: BITMAPINFOHEADER { biSize: std::mem::size_of::<BITMAPINFOHEADER>() as u32, ..Default::default() }, ..Default::default() };
    // First call fills in the size.
    GetDIBits(dc, bitmap, 0, 0, None, &mut header, DIB_RGB_COLORS);
    let (w, h) = (header.bmiHeader.biWidth.unsigned_abs(), header.bmiHeader.biHeight.unsigned_abs());
    if w == 0 || h == 0 {
        let _ = DeleteDC(dc);
        return None;
    }
    header.bmiHeader.biBitCount = 32;
    header.bmiHeader.biCompression = BI_RGB.0;
    header.bmiHeader.biHeight = -(h as i32);
    let mut pixels = vec![0u8; (w * h * 4) as usize];
    let lines = GetDIBits(dc, bitmap, 0, h, Some(pixels.as_mut_ptr() as *mut c_void), &mut header, DIB_RGB_COLORS);
    let _ = DeleteDC(dc);
    (lines > 0).then_some((pixels, w, h))
}

/// BGRA to RGBA; `opaque` for screen grabs, whose alpha byte means nothing.
fn bgra_to_rgba(mut pixels: Vec<u8>, opaque: bool) -> Vec<u8> {
    let any_alpha = !opaque && pixels.chunks_exact(4).any(|p| p[3] != 0);
    for p in pixels.chunks_exact_mut(4) {
        p.swap(0, 2);
        if !any_alpha {
            p[3] = 255;
        }
    }
    pixels
}

// Still pictures for the picker.

fn grab_screen(rect: RECT) -> Option<(Vec<u8>, u32, u32)> {
    let (w, h) = ((rect.right - rect.left) as i32, (rect.bottom - rect.top) as i32);
    unsafe {
        let screen = GetDC(None);
        let dc = CreateCompatibleDC(Some(screen));
        let bitmap = CreateCompatibleBitmap(screen, w, h);
        let old = SelectObject(dc, bitmap.into());
        let ok = BitBlt(dc, 0, 0, w, h, Some(screen), rect.left, rect.top, SRCCOPY).is_ok();
        SelectObject(dc, old);
        let pixels = if ok { bitmap_pixels(bitmap) } else { None };
        let _ = DeleteObject(bitmap.into());
        let _ = DeleteDC(dc);
        ReleaseDC(None, screen);
        pixels
    }
}

fn grab_window(hwnd: HWND) -> Option<(Vec<u8>, u32, u32)> {
    unsafe {
        if IsIconic(hwnd).as_bool() {
            return None;
        }
        let mut rect = RECT::default();
        GetWindowRect(hwnd, &mut rect).ok()?;
        let (w, h) = (rect.right - rect.left, rect.bottom - rect.top);
        if w <= 0 || h <= 0 {
            return None;
        }
        let screen = GetDC(None);
        let dc = CreateCompatibleDC(Some(screen));
        let bitmap = CreateCompatibleBitmap(screen, w, h);
        let old = SelectObject(dc, bitmap.into());
        let ok = PrintWindow(hwnd, dc, PRINT_WINDOW_FLAGS(PW_RENDERFULLCONTENT)).as_bool();
        SelectObject(dc, old);
        let pixels = if ok { bitmap_pixels(bitmap) } else { None };
        let _ = DeleteObject(bitmap.into());
        let _ = DeleteDC(dc);
        ReleaseDC(None, screen);
        pixels
    }
}
