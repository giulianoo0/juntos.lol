use std::sync::Arc;

use parking_lot::Mutex;
use tauri::{Manager, PhysicalPosition, PhysicalSize, State, WebviewWindow, WindowEvent};

/// Neither web view opens a picture-in-picture of its own, so the app's window
/// becomes it: small, on top, in the corner, and back where it was after.
#[derive(Default)]
pub struct PipState(Arc<Mutex<Option<Saved>>>);

struct Saved {
    position: PhysicalPosition<i32>,
    size: PhysicalSize<u32>,
    maximized: bool,
    aspect: f64,
}

const WIDTH: f64 = 480.0;
const MARGIN: f64 = 24.0;

fn shape(aspect: f64) -> f64 {
    if aspect.is_finite() { aspect.clamp(0.42, 2.39) } else { 16.0 / 9.0 }
}

/// The height a resized floating window takes to keep the video's shape; None when it already has it.
pub fn reshaped(size: PhysicalSize<u32>, aspect: f64) -> Option<u32> {
    let height = (size.width as f64 / shape(aspect)).round() as u32;
    (height.abs_diff(size.height) > 2).then_some(height)
}

/// Resizing the floating window keeps it as the video's shape, the width leading.
pub fn keep_shape(window: &WebviewWindow) {
    let held = window.state::<PipState>().0.clone();
    let target = window.clone();
    window.on_window_event(move |event| {
        let WindowEvent::Resized(size) = event else { return };
        let Some(aspect) = held.lock().as_ref().map(|saved| saved.aspect) else { return };
        if let Some(height) = reshaped(*size, aspect) {
            let _ = target.set_size(PhysicalSize::new(size.width, height));
        }
    });
}

/// The floating window in the work area's bottom-right corner, as the video's
/// shape: `(x, y, width, height)` in physical pixels.
pub fn corner(area: (i32, i32, u32, u32), scale: f64, aspect: f64) -> (i32, i32, u32, u32) {
    let aspect = shape(aspect);
    let width = (WIDTH * scale).round();
    let height = (width / aspect).round();
    let margin = (MARGIN * scale).round() as i32;
    let (x, y, w, h) = area;
    (x + w as i32 - width as i32 - margin, y + h as i32 - height as i32 - margin, width as u32, height as u32)
}

#[tauri::command]
pub fn pip_window(window: WebviewWindow, state: State<'_, PipState>, on: bool, aspect: f64) -> Result<(), String> {
    let err = |e: tauri::Error| e.to_string();
    let mut saved = state.0.lock();
    if on {
        if saved.is_none() {
            *saved = Some(Saved {
                position: window.outer_position().map_err(err)?,
                size: window.inner_size().map_err(err)?,
                maximized: window.is_maximized().map_err(err)?,
                aspect,
            });
        }
        if let Some(saved) = saved.as_mut() {
            saved.aspect = aspect;
        }
        drop(saved);
        let monitor = window.current_monitor().map_err(err)?.ok_or("no monitor")?;
        let area = monitor.work_area();
        let (x, y, w, h) = corner((area.position.x, area.position.y, area.size.width, area.size.height), monitor.scale_factor(), aspect);
        window.unmaximize().map_err(err)?;
        window.set_min_size(None::<tauri::Size>).map_err(err)?;
        window.set_size(PhysicalSize::new(w, h)).map_err(err)?;
        window.set_position(PhysicalPosition::new(x, y)).map_err(err)?;
        window.set_always_on_top(true).map_err(err)?;
    } else if let Some(back) = saved.take() {
        drop(saved);
        window.set_always_on_top(false).map_err(err)?;
        window.set_min_size(Some(tauri::LogicalSize::new(crate::MIN_WINDOW.0, crate::MIN_WINDOW.1))).map_err(err)?;
        window.set_size(back.size).map_err(err)?;
        window.set_position(back.position).map_err(err)?;
        if back.maximized {
            window.maximize().map_err(err)?;
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_window_floats_in_the_corner_as_the_video_shape() {
        assert_eq!(corner((0, 0, 1920, 1040), 1.0, 16.0 / 9.0), (1416, 746, 480, 270));
        assert_eq!(corner((0, 25, 2880, 1775), 2.0, 4.0 / 3.0), (1872, 1032, 960, 720));
        assert_eq!(corner((1920, 0, 1920, 1080), 1.0, 10.0), (3336, 855, 480, 201));
        assert_eq!(corner((0, 0, 1920, 1080), 1.0, f64::NAN).3, 270);
    }

    #[test]
    fn a_resize_takes_the_height_of_the_video_shape_from_the_width() {
        assert_eq!(reshaped(PhysicalSize::new(640, 300), 16.0 / 9.0), Some(360));
        assert_eq!(reshaped(PhysicalSize::new(640, 361), 16.0 / 9.0), None);
        assert_eq!(reshaped(PhysicalSize::new(400, 400), 4.0 / 3.0), Some(300));
    }
}
