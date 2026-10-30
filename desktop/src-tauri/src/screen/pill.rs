use std::time::{Duration, Instant};

use objc2::rc::autoreleasepool;
use objc2_core_foundation::CFRetained;
use objc2_core_graphics::{
    CGDisplayBounds, CGMainDisplayID, CGPreflightScreenCaptureAccess, CGRequestScreenCaptureAccess, CGWindowListCopyWindowInfo,
    CGWindowListOption,
};
use objc2_foundation::{ns_string, NSArray, NSDictionary, NSNumber, NSString};
use tauri::{AppHandle, LogicalPosition, Manager, WebviewUrl, WebviewWindow, WebviewWindowBuilder};
use tauri_plugin_opener::OpenerExt;

const LABEL: &str = "permission";
const SIZE: (f64, f64) = (320.0, 84.0);
const PANE: &str = "x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture";
const SETTINGS: &str = "com.apple.systempreferences";
/// How long the Settings window gets to show up before the pill gives up on it.
const SETTINGS_WAIT: Duration = Duration::from_secs(10);

pub fn permitted() -> bool {
    CGPreflightScreenCaptureAccess()
}

/// Opens Screen Recording in Settings, with a pill under its window saying what to turn on.
pub fn guide(app: &AppHandle) -> Result<(), String> {
    if permitted() {
        return Ok(());
    }
    // Puts Juntos in the list, so there is a switch to turn on.
    CGRequestScreenCaptureAccess();
    app.opener().open_url(PANE, None::<&str>).map_err(|e| e.to_string())?;
    if app.get_webview_window(LABEL).is_some() {
        return Ok(());
    }
    let window = WebviewWindowBuilder::new(app, LABEL, WebviewUrl::App("permission.html".into()))
        .title("Juntos")
        .transparent(true)
        .decorations(false)
        .shadow(false)
        .resizable(false)
        .always_on_top(true)
        .skip_taskbar(true)
        .focused(false)
        .visible(false)
        .visible_on_all_workspaces(true)
        .inner_size(SIZE.0, SIZE.1)
        .build()
        .map_err(|e| e.to_string())?;
    std::thread::spawn(move || follow(window));
    Ok(())
}

/// Keeps the pill under the Settings window until the switch is on or Settings closes.
fn follow(window: WebviewWindow) {
    let started = Instant::now();
    let mut seen = false;
    loop {
        if permitted() {
            let _ = window.eval("granted()");
            std::thread::sleep(Duration::from_millis(1300));
            let _ = window.close();
            return;
        }
        match autoreleasepool(|_| settings_bounds()) {
            Some(bounds) => {
                seen = true;
                let (x, y) = place(bounds, screen_height());
                let _ = window.set_position(LogicalPosition::new(x, y));
                let _ = window.show();
            }
            None if seen || started.elapsed() > SETTINGS_WAIT => {
                let _ = window.close();
                return;
            }
            None => {}
        }
        std::thread::sleep(Duration::from_millis(250));
    }
}

/// Centered just below the window, or inside its bottom edge when the screen ends first.
fn place((x, y, width, height): (f64, f64, f64, f64), screen_height: f64) -> (f64, f64) {
    let left = x + (width - SIZE.0) / 2.0;
    let below = y + height + 4.0;
    if below + SIZE.1 <= screen_height {
        (left, below)
    } else {
        (left, y + height - SIZE.1 - 12.0)
    }
}

fn screen_height() -> f64 {
    CGDisplayBounds(CGMainDisplayID()).size.height
}

/// Where the Settings window is, in points from the top left of the main display.
fn settings_bounds() -> Option<(f64, f64, f64, f64)> {
    let list = CGWindowListCopyWindowInfo(CGWindowListOption::OptionOnScreenOnly | CGWindowListOption::ExcludeDesktopElements, 0)?;
    // CFArray and NSArray are the same object.
    let list: &NSArray<NSDictionary<NSString, objc2::runtime::AnyObject>> = unsafe { &*(CFRetained::as_ptr(&list).as_ptr().cast()) };
    let number = |info: &NSDictionary<NSString, objc2::runtime::AnyObject>, key: &NSString| {
        info.objectForKey(key).and_then(|v| v.downcast::<NSNumber>().ok()).map(|n| n.doubleValue())
    };
    list.iter().find_map(|info| {
        if number(&info, ns_string!("kCGWindowLayer"))? != 0.0 {
            return None;
        }
        let pid = number(&info, ns_string!("kCGWindowOwnerPID"))? as u32;
        let app = super::macos::running(pid)?;
        if app.bundleIdentifier()?.to_string() != SETTINGS {
            return None;
        }
        let bounds = info.objectForKey(ns_string!("kCGWindowBounds"))?.downcast::<NSDictionary>().ok()?;
        // The bounds dictionary is keyed by strings.
        let bounds = unsafe { objc2::rc::Retained::cast_unchecked::<NSDictionary<NSString, objc2::runtime::AnyObject>>(bounds) };
        Some((
            number(&bounds, ns_string!("X"))?,
            number(&bounds, ns_string!("Y"))?,
            number(&bounds, ns_string!("Width"))?,
            number(&bounds, ns_string!("Height"))?,
        ))
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_pill_sits_centered_under_the_settings_window() {
        assert_eq!(place((100.0, 50.0, 720.0, 600.0), 1000.0), (100.0 + 200.0, 654.0));
    }

    #[test]
    fn the_pill_moves_inside_when_the_screen_ends_below_the_window() {
        assert_eq!(place((0.0, 300.0, 720.0, 650.0), 1000.0), (200.0, 300.0 + 650.0 - 84.0 - 12.0));
    }
}
