/// Every command the site may call; each becomes an `allow-<name>`
/// permission that the runtime capability grants to the site's origin only.
const COMMANDS: &[&str] = &[
    "app_hello",
    "torrent_open",
    "torrent_select",
    "torrent_stats",
    "youtube_resolve",
    "local_prepare",
    "local_regions",
    "local_follow",
    "local_stop",
    "upload_start",
    "upload_stop",
    "upload_status",
];

fn main() {
    tauri_build::try_build(tauri_build::Attributes::new().app_manifest(tauri_build::AppManifest::new().commands(COMMANDS)))
        .expect("tauri build");
}
