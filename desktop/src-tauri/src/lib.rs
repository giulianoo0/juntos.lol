pub mod cache;
pub mod commands;
pub mod hls;
pub mod local;
pub mod serve;
pub mod site;
pub mod torrent;
pub mod upload_plan;
pub mod uploader;

use std::path::PathBuf;

use tauri::ipc::CapabilityBuilder;
use tauri::{Manager, WebviewUrl, WebviewWindowBuilder};
use tauri_plugin_opener::OpenerExt;
use tauri_plugin_updater::UpdaterExt;

use commands::{AppState, Tools};
use site::Navigation;

const COMMANDS: &[&str] = &[
    "app-hello",
    "torrent-open",
    "torrent-select",
    "torrent-stats",
    "youtube-resolve",
    "local-prepare",
    "local-regions",
    "local-follow",
    "local-stop",
    "upload-start",
    "upload-stop",
    "upload-status",
];

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
            commands::local_stop,
            commands::upload_start,
            commands::upload_stop,
            commands::upload_status,
        ])
        .setup(move |app| {
            let data_dir = app.path().app_data_dir()?;
            let tools = Tools { ffmpeg: tool("ffmpeg"), ffprobe: tool("ffprobe"), ytdlp: tool("yt-dlp") };
            app.manage(AppState::new(site.clone(), data_dir, tools));

            // The IPC answers the site's origin and nothing else.
            let mut capability = CapabilityBuilder::new("site").remote(format!("{}*", site.as_str())).window("main");
            for command in COMMANDS {
                capability = capability.permission(format!("allow-{command}"));
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

            if !cfg!(debug_assertions) {
                let handle = app.handle().clone();
                tauri::async_runtime::spawn(async move {
                    let Ok(updater) = handle.updater() else { return };
                    match updater.check().await {
                        // Lands on disk now and runs from the next launch.
                        Ok(Some(update)) => {
                            if let Err(e) = update.download_and_install(|_, _| {}, || {}).await {
                                tracing::warn!(error = %e, "update install failed");
                            }
                        }
                        Ok(None) => {}
                        Err(e) => tracing::warn!(error = %e, "update check failed"),
                    }
                });
            }
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("tauri");
}
