//! The commands the site calls. Each one does one thing on a value the site
//! names; nothing reaches the shell or the file system beyond the cache.
use std::collections::HashMap;
use std::sync::Arc;

use parking_lot::Mutex;
use serde::Deserialize;
use ss_remux::youtube;
use tauri::State;
use tokio::sync::OnceCell;
use url::Url;

use crate::local::{Input, Meta, Producer, RegionState};
use crate::torrent::{Opened, Stats, Torrents};
use crate::uploader::{Target, Upload};
use crate::{cache, site};

pub struct Tools {
    pub ffmpeg: String,
    pub ffprobe: String,
    pub ytdlp: String,
}

pub struct AppState {
    pub site: Url,
    pub data_dir: std::path::PathBuf,
    pub tools: Tools,
    pub producer: Arc<Producer>,
    torrents: OnceCell<Torrents>,
    resolver: OnceCell<Option<Arc<youtube::Resolver>>>,
    uploads: Mutex<HashMap<String, (String, Arc<Upload>)>>,
}

impl AppState {
    pub fn new(site: Url, data_dir: std::path::PathBuf, tools: Tools) -> Self {
        let producer = Producer::new(data_dir.join("cache"), tools.ffmpeg.clone(), tools.ffprobe.clone(), cache::DEFAULT_CAP_BYTES);
        Self {
            site,
            data_dir,
            tools,
            producer,
            torrents: OnceCell::new(),
            resolver: OnceCell::new(),
            uploads: Mutex::new(HashMap::new()),
        }
    }

    async fn torrents(&self) -> Result<&Torrents, String> {
        self.torrents.get_or_try_init(|| Torrents::new(self.data_dir.join("torrents"))).await.map_err(err)
    }

    async fn resolver(&self) -> Result<Arc<youtube::Resolver>, String> {
        let held = self
            .resolver
            .get_or_init(|| async {
                let resolver = youtube::Resolver::new(youtube::Config {
                    ytdlp_path: self.tools.ytdlp.clone(),
                    proxy: None,
                    cookies_file: None,
                    ca_file: None,
                })
                .await;
                resolver.version.is_some().then(|| Arc::new(resolver))
            })
            .await;
        held.clone().ok_or_else(|| "tools_missing".to_string())
    }
}

fn err(error: impl std::fmt::Display) -> String {
    error.to_string().chars().take(400).collect()
}

#[tauri::command]
pub fn app_hello(app: tauri::AppHandle, protocol_version: u32) -> site::Hello {
    site::hello(protocol_version, &app.package_info().version.to_string(), cfg!(windows))
}

#[tauri::command]
pub async fn torrent_open(state: State<'_, AppState>, magnet: String) -> Result<Opened, String> {
    if !magnet.starts_with("magnet:?") || magnet.len() > 8192 {
        return Err("invalid_magnet".into());
    }
    state.torrents().await?.open(&magnet).await.map_err(err)
}

#[tauri::command]
pub async fn torrent_select(state: State<'_, AppState>, id: String, index: usize) -> Result<(), String> {
    state.torrents().await?.select(&id, index).await.map_err(err)
}

#[tauri::command]
pub async fn torrent_stats(state: State<'_, AppState>, id: String) -> Result<Stats, String> {
    Ok(state.torrents().await?.stats(&id))
}

#[tauri::command]
pub async fn youtube_resolve(state: State<'_, AppState>, url: String) -> Result<youtube::Summary, String> {
    let resolver = state.resolver().await?;
    resolver.summary(&url).await.map_err(|e| format!("{}: {}", e.code(), e.detail()))
}

#[derive(Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum PrepareSource {
    Torrent { id: String, index: usize, title: String },
    Youtube { url: String, video_id: String, title: String },
}

/// Understands the source and starts writing it into the cache.
#[tauri::command]
pub async fn local_prepare(state: State<'_, AppState>, source: PrepareSource) -> Result<Meta, String> {
    match source {
        PrepareSource::Torrent { id, index, title } => {
            let torrents = state.torrents().await?;
            torrents.select(&id, index).await.map_err(err)?;
            let bytes = torrents.source(&id, index).map_err(err)?;
            let key = format!("t-{}-{index}", id.to_ascii_lowercase());
            state.producer.prepare(&key, &title, Input::Container(bytes)).await.map_err(err)
        }
        PrepareSource::Youtube { url, video_id, title } => {
            let resolver = state.resolver().await?;
            let key = format!("y-{video_id}");
            state.producer.prepare(&key, &title, Input::Youtube(resolver, url)).await.map_err(err)
        }
    }
}

#[tauri::command]
pub fn local_regions(state: State<'_, AppState>, key: String) -> Vec<RegionState> {
    state.producer.regions(&key)
}

/// The room's position moved: a new region where none holds it, and the
/// upload's queue reordered around it.
#[tauri::command]
pub async fn local_follow(state: State<'_, AppState>, key: String, position_ms: u64) -> Result<(), String> {
    for (held, upload) in state.uploads.lock().values() {
        if *held == key {
            upload.seek(position_ms);
        }
    }
    state.producer.follow(&key, position_ms).await.map_err(err)
}

#[tauri::command]
pub async fn local_stop(state: State<'_, AppState>, key: String) -> Result<(), String> {
    state.producer.stop(&key).await;
    Ok(())
}

/// Starts sending the cache to the room with the claim the site got from
/// `local/promote`; a new claim for the same room replaces the upload.
#[tauri::command]
pub fn upload_start(
    state: State<'_, AppState>,
    key: String,
    room_id: String,
    claim: String,
    media_generation: u64,
    position_ms: u64,
) -> Result<(), String> {
    if state.producer.meta(&key).is_none() {
        return Err("unknown source".into());
    }
    if room_id.is_empty() || room_id.len() > 64 || !room_id.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_') {
        return Err("invalid room".into());
    }
    let run_id = format!("run_{:016x}", rand::random::<u64>());
    let target = Target {
        api_base: state.site.as_str().trim_end_matches('/').to_string(),
        room_id: room_id.clone(),
        claim,
        media_generation,
        run_id,
    };
    let upload = Upload::start(state.producer.clone(), key.clone(), target, position_ms);
    if let Some((_, previous)) = state.uploads.lock().insert(room_id, (key, upload)) {
        previous.stop();
    }
    Ok(())
}

#[tauri::command]
pub fn upload_stop(state: State<'_, AppState>, room_id: String) {
    if let Some((_, upload)) = state.uploads.lock().remove(&room_id) {
        upload.stop();
    }
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UploadStatus {
    active: bool,
    sent: u64,
    error: Option<String>,
}

#[tauri::command]
pub fn upload_status(state: State<'_, AppState>, room_id: String) -> UploadStatus {
    match state.uploads.lock().get(&room_id) {
        Some((_, upload)) => UploadStatus { active: !upload.stopped(), sent: upload.sent(), error: upload.error() },
        None => UploadStatus { active: false, sent: 0, error: None },
    }
}
