pub mod cache;
pub mod commands;
pub mod hls;
pub mod local;
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

pub fn run() {
    tracing_subscriber::fmt()
        .with_env_filter(tracing_subscriber::EnvFilter::try_from_default_env().unwrap_or_else(|_| "info".into()))
        .init();
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
            commands::upload_stop,
            commands::upload_status,
            commands::update_status,
            commands::update_restart,
            commands::update_now,
        ])
        .setup(move |app| {
            let data_dir = app.path().app_data_dir()?;
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
            for permission in site_permissions() {
                capability = capability.permission(permission);
            }
            app.add_capability(capability)?;

            let handle = app.handle().clone();
            let held_site = site.clone();
            WebviewWindowBuilder::new(app, "main", WebviewUrl::App("index.html".into()))
                .title("Juntos")
                .inner_size(1280.0, 800.0)
                .min_inner_size(720.0, 520.0)
                .initialization_script(format!("window.__JUNTOS_SITE__ = {};", serde_json::to_string(site.as_str())?))
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
                .build()?;

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
                updates::install_pending(app);
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
        assert_eq!(granted.len(), 16);
        assert_eq!(granted[0], "allow-app-hello");
        assert!(granted.contains(&"allow-local-prepare".to_string()));
        assert!(granted.iter().all(|p| !p.contains('_')));
    }
}
