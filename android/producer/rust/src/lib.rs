//! The desktop app's producer, for the Android app: the same cache, regions and
//! upload, called from Kotlin through one JSON entry point instead of Tauri commands.
use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::{Arc, OnceLock};

use parking_lot::Mutex;
use serde::Deserialize;
use serde_json::{json, Value};
use ss_remux::youtube;

#[path = "../../../../desktop/src-tauri/src/cache.rs"]
#[allow(dead_code)]
mod cache;
#[path = "../../../../desktop/src-tauri/src/hls.rs"]
#[allow(dead_code)]
mod hls;
#[path = "../../../../desktop/src-tauri/src/local.rs"]
#[allow(dead_code)]
mod local;
#[path = "../../../../desktop/src-tauri/src/upload_plan.rs"]
#[allow(dead_code)]
mod upload_plan;
#[path = "../../../../desktop/src-tauri/src/uploader.rs"]
#[allow(dead_code)]
mod uploader;
#[path = "../../../../desktop/src-tauri/src/torrent.rs"]
mod torrent;

mod jni_bridge;

use local::{Input, Producer};
use torrent::Torrents;
use uploader::{Target, Upload};

pub struct Tools {
    pub ffmpeg: String,
    pub ffprobe: String,
    pub ytdlp: youtube::Config,
}

pub struct State {
    site: String,
    data_dir: PathBuf,
    torrents: tokio::sync::OnceCell<Torrents>,
    producer: Arc<Producer>,
    ytdlp: youtube::Config,
    resolver: tokio::sync::OnceCell<Option<Arc<youtube::Resolver>>>,
    uploads: Mutex<HashMap<String, (String, Arc<Upload>)>>,
}

static STATE: OnceLock<State> = OnceLock::new();

pub fn init(data_dir: PathBuf, site: String, tools: Tools) {
    STATE.get_or_init(|| State {
        site: site.trim_end_matches('/').to_string(),
        data_dir: data_dir.clone(),
        torrents: tokio::sync::OnceCell::new(),
        producer: Producer::new(data_dir.join("cache"), tools.ffmpeg, tools.ffprobe, cache::DEFAULT_CAP_BYTES),
        ytdlp: tools.ytdlp,
        resolver: tokio::sync::OnceCell::new(),
        uploads: Mutex::new(HashMap::new()),
    });
}

/// Runs one call by name with its JSON arguments; the answer is `{"ok": …}` or `{"error": "…"}`.
pub fn call(method: &str, args: &str) -> String {
    let Some(state) = STATE.get() else {
        return json!({ "error": "not initialized" }).to_string();
    };
    let args: Value = serde_json::from_str(args).unwrap_or(Value::Null);
    let result = tauri::async_runtime::runtime().block_on(dispatch(state, method, args));
    match result {
        Ok(value) => json!({ "ok": value }),
        Err(error) => json!({ "error": error }),
    }
    .to_string()
}

fn err(error: impl std::fmt::Display) -> String {
    format!("{error:#}").chars().take(400).collect()
}

fn arg<T: for<'de> Deserialize<'de>>(args: &Value, name: &str) -> Result<T, String> {
    serde_json::from_value(args.get(name).cloned().unwrap_or(Value::Null)).map_err(|e| format!("{name}: {e}"))
}

fn valid_room(room_id: &str) -> bool {
    !room_id.is_empty() && room_id.len() <= 64 && room_id.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')
}

impl State {
    async fn torrents(&self) -> Result<&Torrents, String> {
        self.torrents.get_or_try_init(|| Torrents::new(self.data_dir.join("torrents"))).await.map_err(err)
    }

    async fn resolver(&self) -> Result<Arc<youtube::Resolver>, String> {
        let held = self
            .resolver
            .get_or_init(|| async {
                let resolver = youtube::Resolver::new(self.ytdlp.clone()).await;
                resolver.version.is_some().then(|| Arc::new(resolver))
            })
            .await;
        held.clone().ok_or_else(|| "tools_missing".to_string())
    }
}

async fn dispatch(state: &State, method: &str, args: Value) -> Result<Value, String> {
    match method {
        "youtube_resolve" => {
            let url: String = arg(&args, "url")?;
            let resolver = state.resolver().await?;
            let summary = resolver.summary(&url).await.map_err(|e| format!("{}: {}", e.code(), e.detail()))?;
            serde_json::to_value(summary).map_err(err)
        }
        "torrent_open" => {
            let magnet: String = arg(&args, "magnet")?;
            if !magnet.starts_with("magnet:?") || magnet.len() > 8192 {
                return Err("invalid_magnet".into());
            }
            serde_json::to_value(state.torrents().await?.open(&magnet).await.map_err(err)?).map_err(err)
        }
        "torrent_select" => {
            let id: String = arg(&args, "id")?;
            state.torrents().await?.select(&id, arg(&args, "index")?).await.map_err(err)?;
            Ok(Value::Null)
        }
        "torrent_stats" => {
            let id: String = arg(&args, "id")?;
            serde_json::to_value(state.torrents().await?.stats(&id)).map_err(err)
        }
        "local_prepare" => {
            let source: Value = arg(&args, "source")?;
            let field = |name: &str| arg::<String>(&source, name);
            let (key, title, input) = match source.get("kind").and_then(Value::as_str) {
                Some("torrent") => {
                    let id = field("id")?;
                    let index: usize = arg(&source, "index")?;
                    let torrents = state.torrents().await?;
                    torrents.select(&id, index).await.map_err(err)?;
                    let bytes = torrents.source(&id, index).map_err(err)?;
                    (format!("t-{}-{index}", id.to_ascii_lowercase()), field("title")?, Input::Container(bytes))
                }
                Some("youtube") => {
                    let resolver = state.resolver().await?;
                    (format!("y-{}", field("videoId")?), field("title")?, Input::Youtube(resolver, field("url")?))
                }
                _ => return Err("unknown source kind".into()),
            };
            serde_json::to_value(state.producer.prepare(&key, &title, input).await.map_err(err)?).map_err(err)
        }
        "local_regions" => {
            let key: String = arg(&args, "key")?;
            serde_json::to_value(state.producer.regions(&key)).map_err(err)
        }
        "local_low" => {
            let key: String = arg(&args, "key")?;
            state.producer.want_low(&key, arg(&args, "on")?, arg(&args, "positionMs")?).await.map_err(err)?;
            Ok(Value::Null)
        }
        "local_follow" => {
            let key: String = arg(&args, "key")?;
            let position_ms: u64 = arg(&args, "positionMs")?;
            for (held, upload) in state.uploads.lock().values() {
                if *held == key {
                    upload.seek(position_ms);
                }
            }
            state.producer.follow(&key, position_ms).await.map_err(err)?;
            Ok(Value::Null)
        }
        "local_stop" => {
            let key: String = arg(&args, "key")?;
            state.producer.stop(&key).await;
            Ok(Value::Null)
        }
        "local_subtitles" => {
            let key: String = arg(&args, "key")?;
            let room_id: String = arg(&args, "roomId")?;
            let member_id: String = arg(&args, "memberId")?;
            let capability: String = arg(&args, "capability")?;
            if !valid_room(&room_id) {
                return Err("invalid room".into());
            }
            if member_id.is_empty() || capability.is_empty() {
                return Err("no member".into());
            }
            let auth = ss_remux::subs::PublishAuth::Producer { member_id, capability };
            state
                .producer
                .subtitles(&key, state.site.clone(), room_id, arg(&args, "mediaGeneration")?, auth)
                .await
                .map_err(|e| e.to_string())?;
            Ok(Value::Null)
        }
        "upload_start" => {
            let key: String = arg(&args, "key")?;
            let room_id: String = arg(&args, "roomId")?;
            if state.producer.meta(&key).is_none() {
                return Err("unknown source".into());
            }
            if !valid_room(&room_id) {
                return Err("invalid room".into());
            }
            let target = Target {
                api_base: state.site.clone(),
                room_id: room_id.clone(),
                claim: arg(&args, "claim")?,
                media_generation: arg(&args, "mediaGeneration")?,
                run_id: format!("run_{:016x}", rand::random::<u64>()),
            };
            let upload = Upload::start(state.producer.clone(), key.clone(), target, arg(&args, "positionMs")?);
            if let Some((_, previous)) = state.uploads.lock().insert(room_id, (key, upload)) {
                previous.stop();
            }
            Ok(Value::Null)
        }
        "upload_stop" => {
            let room_id: String = arg(&args, "roomId")?;
            if let Some((_, upload)) = state.uploads.lock().remove(&room_id) {
                upload.stop();
            }
            Ok(Value::Null)
        }
        "upload_status" => {
            let room_id: String = arg(&args, "roomId")?;
            Ok(match state.uploads.lock().get(&room_id) {
                Some((_, upload)) => json!({ "active": !upload.stopped(), "sent": upload.sent(), "error": upload.error() }),
                None => json!({ "active": false, "sent": 0, "error": null }),
            })
        }
        "local_master" => {
            // A region's master as the desktop serves it (serve.rs local_master): FFmpeg's own leaves the video out.
            let key: String = arg(&args, "key")?;
            let n: u64 = arg(&args, "n")?;
            let meta = state.producer.meta(&key).ok_or("unknown source")?;
            let prefix = ss_remux::plan::region_prefix(n);
            if !meta.regions.iter().any(|r| r.n == n) || !state.producer.hls_dir(&key).join(hls::playlist_name(&prefix, 0)).exists() {
                return Err("region not ready".into());
            }
            let info = hls::MasterInfo { audio_langs: meta.audio_langs, video_codecs: meta.video_codecs, bandwidth: 0, low_resolution: None };
            Ok(json!(hls::master(&prefix, &info, None)))
        }
        "hls_dir" => {
            let key: String = arg(&args, "key")?;
            Ok(json!(state.producer.hls_dir(&key)))
        }
        _ => Err(format!("unknown method {method}")),
    }
}
