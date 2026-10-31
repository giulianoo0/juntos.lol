pub mod cache;
pub mod commands;
pub mod hls;
pub mod local;
pub mod screen;
pub mod serve;
pub mod site;
pub mod tools;
pub mod torrent;
pub mod updates;
pub mod upload_plan;
pub mod uploader;

use std::path::PathBuf;

use tauri::ipc::CapabilityBuilder;
use tauri::{Manager, WebviewUrl, WebviewWindowBuilder};
use tauri_plugin_opener::OpenerExt;

use commands::{AppState, Tools};
use site::Navigation;

/// What the drawn title bar needs: drag, double-click to zoom, and the buttons.
const WINDOW_PERMISSIONS: &[&str] = &[
    "core:window:allow-start-dragging",
    "core:window:allow-internal-toggle-maximize",
    "core:window:allow-minimize",
    "core:window:allow-toggle-maximize",
    "core:window:allow-close",
];

/// The permission of each command build.rs declares from commands.txt.
fn site_permissions() -> impl Iterator<Item = String> {
    include_str!("../commands.txt").lines().filter(|line| !line.is_empty()).map(|name| format!("allow-{}", name.replace('_', "-")))
}

/// A bundled sidecar sits beside the app's executable; in dev the one on
/// PATH answers.
fn tool(name: &str) -> String {
    let file = if cfg!(windows) { format!("{name}.exe") } else { name.to_string() };
    std::env::current_exe()
        .ok()
        .and_then(|exe| exe.parent().map(|dir| dir.join(&file)))
        .filter(|path| path.is_file())
        .map(|path| path.to_string_lossy().into_owned())
        .unwrap_or_else(|| name.to_string())
}

/// The log on disk, so a failure on someone's machine can be read later:
/// ~/Library/Logs on macOS, the local app data elsewhere. It starts over past 5 MB.
fn log_file() -> Option<std::fs::File> {
    let dir = if cfg!(target_os = "macos") {
        PathBuf::from(std::env::var_os("HOME")?).join("Library/Logs/lol.juntos.desktop")
    } else if cfg!(windows) {
        PathBuf::from(std::env::var_os("LOCALAPPDATA")?).join("lol.juntos.desktop").join("logs")
    } else {
        PathBuf::from(std::env::var_os("HOME")?).join(".local/state/lol.juntos.desktop")
    };
    std::fs::create_dir_all(&dir).ok()?;
    let path = dir.join(if cfg!(debug_assertions) { "juntos-debug.log" } else { "juntos.log" });
    let big = std::fs::metadata(&path).is_ok_and(|m| m.len() > 5 << 20);
    std::fs::OpenOptions::new().create(true).append(!big).write(true).truncate(big).open(path).ok()
}

pub fn run() {
    use tracing_subscriber::fmt::writer::MakeWriterExt;
    let filter = || tracing_subscriber::EnvFilter::try_from_default_env().unwrap_or_else(|_| "info".into());
    match log_file() {
        Some(file) => tracing_subscriber::fmt()
            .with_env_filter(filter())
            .with_ansi(false)
            .with_writer(std::io::stdout.and(std::sync::Mutex::new(file)))
            .init(),
        None => tracing_subscriber::fmt().with_env_filter(filter()).init(),
    }
    let site = site::site_origin(std::env::var("JUNTOS_URL").ok().as_deref());

    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .register_asynchronous_uri_scheme_protocol(serve::SCHEME, |ctx, request, responder| {
            let root: PathBuf = ctx.app_handle().state::<AppState>().producer.root().to_path_buf();
            let path = request.uri().path().to_string();
            let range = request.headers().get(tauri::http::header::RANGE).cloned();
            tauri::async_runtime::spawn_blocking(move || responder.respond(serve::serve(&root, &path, range.as_ref())));
        })
        .invoke_handler(tauri::generate_handler![
            commands::app_hello,
            commands::torrent_open,
            commands::torrent_select,
            commands::torrent_stats,
            commands::youtube_resolve,
            commands::local_prepare,
            commands::local_regions,
            commands::local_follow,
            commands::local_low,
            commands::local_stop,
            commands::upload_start,
            commands::local_subtitles,
            commands::e2e_log,
            commands::upload_stop,
            commands::upload_status,
            commands::update_status,
            commands::update_restart,
            commands::update_now,
            screen::screen_sources,
            screen::screen_thumbnail,
            screen::audio_apps,
            screen::screen_start,
            screen::screen_switch,
            screen::screen_quality,
            screen::screen_stop,
            screen::audio_start,
            screen::audio_set,
            screen::audio_stop,
            screen::screen_permission,
            screen::screen_permission_guide,
        ])
        .manage(screen::ScreenState::default())
        .setup(move |app| {
            // An end-to-end run (debug builds only) keeps out of the way of the
            // app in daily use on the same machine: its own data, a private
            // web store, and no focus taken.
            let e2e = cfg!(debug_assertions) && std::env::var_os("JUNTOS_E2E_SCRIPT").is_some();
            let data_dir = app.path().app_data_dir()?;
            let data_dir = if e2e { data_dir.join("e2e") } else { data_dir };
            #[cfg(target_os = "macos")]
            if e2e {
                app.set_activation_policy(tauri::ActivationPolicy::Accessory);
            }
            let bundled_ytdlp = tool("yt-dlp");
            let ytdlp = if std::path::Path::new(&bundled_ytdlp).is_absolute() {
                tools::writable_copy(std::path::Path::new(&bundled_ytdlp), &data_dir.join("bin"))
                    .map(|copy| copy.to_string_lossy().into_owned())
                    .unwrap_or(bundled_ytdlp)
            } else {
                bundled_ytdlp
            };
            let tools = Tools { ffmpeg: tool("ffmpeg"), ffprobe: tool("ffprobe"), ytdlp };
            app.manage(AppState::new(site.clone(), data_dir, tools));

            // The IPC answers the site's origin and nothing else.
            let mut capability = CapabilityBuilder::new("site").remote(format!("{}*", site.as_str())).window("main");
            for permission in site_permissions().chain(WINDOW_PERMISSIONS.iter().map(|p| p.to_string())) {
                capability = capability.permission(permission);
            }
            app.add_capability(capability)?;
            // The offline page, served by the app itself, moves and closes the window too.
            let mut offline = CapabilityBuilder::new("offline").window("main");
            for permission in WINDOW_PERMISSIONS {
                offline = offline.permission(*permission);
            }
            app.add_capability(offline)?;

            let handle = app.handle().clone();
            let held_site = site.clone();
            let window = WebviewWindowBuilder::new(app, "main", WebviewUrl::App("index.html".into()));
            // The site draws the title bar: the traffic lights sit in its header
            // on macOS, and it draws the window buttons on Windows.
            #[cfg(target_os = "macos")]
            let window = window
                .title_bar_style(tauri::TitleBarStyle::Overlay)
                .hidden_title(true)
                .traffic_light_position(tauri::LogicalPosition::new(20.0, 32.0));
            #[cfg(windows)]
            let window = window.decorations(false);
            #[allow(unused_mut)]
            let mut init = format!("window.__JUNTOS_SITE__ = {};", serde_json::to_string(site.as_str())?);
            // Debug builds only: a script the end-to-end tests drive the page with.
            #[cfg(debug_assertions)]
            if let Some(extra) = std::env::var("JUNTOS_E2E_SCRIPT").ok().and_then(|path| std::fs::read_to_string(path).ok()) {
                init.push('\n');
                init.push_str(&extra);
            }
            let window = if e2e { window.incognito(true).focused(false) } else { window };
            window
                .title("Juntos")
                .inner_size(1280.0, 800.0)
                .min_inner_size(720.0, 520.0)
                .initialization_script(init)
                .on_page_load(|_, payload| {
                    if matches!(payload.event(), tauri::webview::PageLoadEvent::Finished) {
                        tracing::info!(url = %payload.url(), "page loaded");
                    }
                })
                .on_navigation(move |url| match site::navigation(url, &held_site) {
                    Navigation::Allow => true,
                    Navigation::External => {
                        let _ = handle.opener().open_url(url.as_str(), None::<&str>);
                        false
                    }
                    Navigation::Block => false,
                })
                .build()?
                .with_webview(serve::mark_secure)?;

            app.manage(updates::AppUpdates::default());
            if !cfg!(debug_assertions) || std::env::var("JUNTOS_UPDATE_URL").is_ok() {
                updates::spawn_checks(app.handle().clone());
            }
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("tauri")
        .run(|app, event| {
            // An update the person did not restart for goes in as the app closes.
            if let tauri::RunEvent::Exit = event {
                let _ = updates::install_pending(app);
            }
        });
}

#[cfg(test)]
mod tests {
    use super::*;

    // build.rs turns each name in commands.txt into the permission allow-<name>, in kebab case.
    #[test]
    fn the_site_is_granted_each_command_the_build_declares() {
        let granted: Vec<String> = site_permissions().collect();
        assert_eq!(granted.len(), 30);
        assert_eq!(granted[0], "allow-app-hello");
        assert!(granted.contains(&"allow-local-prepare".to_string()));
        assert!(granted.contains(&"allow-screen-start".to_string()));
        assert!(granted.iter().all(|p| !p.contains('_')));
    }

    // A command the handler takes but the list leaves out is refused to the
    // site at run time, which no other test sees.
    #[test]
    fn every_command_the_app_handles_is_granted_to_the_site() {
        let source = include_str!("lib.rs");
        let start = source.find("generate_handler![").unwrap();
        let end = start + source[start..].find("])").unwrap();
        let granted: Vec<String> = site_permissions().collect();
        let handled: Vec<&str> = source[start..end]
            .split(|c: char| c == ',' || c == '[' || c.is_whitespace())
            .filter_map(|item| item.rsplit("::").next().filter(|_| item.contains("::")))
            .collect();
        assert!(handled.len() >= 30, "{handled:?}");
        for command in handled {
            assert!(granted.contains(&format!("allow-{}", command.replace('_', "-"))), "{command} is handled but not granted");
        }
    }
}
