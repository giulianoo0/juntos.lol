//! The production into the cache: FFmpeg reads the source over the ss-remux
//! loopback bridge and writes HLS fMP4 straight to disk, one region per
//! start point, in the names the bucket uses. The player on this machine
//! reads the regions as they grow; the upload slices them later.
use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::{Duration, SystemTime};

use anyhow::bail;
use parking_lot::Mutex;
use serde::{Deserialize, Serialize};
use ss_remux::bridge::{Bridge, InputTarget};
use ss_remux::plan::{self, SourcePlan};
use ss_remux::{process, youtube, ByteSource};

use crate::hls::{self, Variant};
use crate::{cache, upload_plan};

/// One local region as the player sees it (the room's region shape).
#[derive(Clone, Debug, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RegionState {
    pub n: u64,
    pub start_ms: u64,
    pub produced_ms: u64,
    pub growing: bool,
}

/// How far ahead of what it wrote a growing region counts as holding a
/// position: the player's own allowance (REGION_AHEAD_MS in Player.tsx).
pub const AHEAD_MS: u64 = 30_000;
pub const BEHIND_MS: u64 = 1_000;

/// Whether some region holds `position_ms`, the way the web player decides it.
pub fn covered(regions: &[RegionState], position_ms: u64) -> bool {
    regions.iter().any(|r| {
        let end = r.start_ms + r.produced_ms + if r.growing { AHEAD_MS } else { 0 };
        position_ms + BEHIND_MS >= r.start_ms && position_ms <= end
    })
}

/// What a run reads: a container probed by FFprobe, or a video yt-dlp
/// already split into streams.
pub enum Input {
    Container(Arc<dyn ByteSource>),
    Youtube(Arc<youtube::Resolver>, String),
}

/// What the site needs to open the room once the source is understood.
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Meta {
    pub key: String,
    pub title: String,
    pub duration_ms: u64,
    pub audio_langs: Vec<String>,
    pub video_codecs: Option<String>,
    #[serde(default)]
    pub regions: Vec<RegionStart>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RegionStart {
    pub n: u64,
    pub start_ms: u64,
}

struct Running {
    n: u64,
    process: process::Supervised,
    caps: Vec<String>,
}

struct Production {
    dir: PathBuf,
    sources: Vec<Arc<dyn ByteSource>>,
    plan: SourcePlan,
    meta: Mutex<Meta>,
    running: Mutex<Option<Running>>,
    used: Mutex<SystemTime>,
}

/// Every source this machine prepared, by cache key.
pub struct Producer {
    root: PathBuf,
    ffmpeg: String,
    ffprobe: String,
    cap_bytes: u64,
    bridge: tokio::sync::OnceCell<Arc<Bridge>>,
    entries: Mutex<HashMap<String, Arc<Production>>>,
    busy: Mutex<HashSet<String>>,
}

impl Producer {
    pub fn new(root: PathBuf, ffmpeg: String, ffprobe: String, cap_bytes: u64) -> Arc<Self> {
        Arc::new(Self {
            root,
            ffmpeg,
            ffprobe,
            cap_bytes,
            bridge: tokio::sync::OnceCell::new(),
            entries: Mutex::new(HashMap::new()),
            busy: Mutex::new(HashSet::new()),
        })
    }

    pub fn root(&self) -> &Path {
        &self.root
    }

    async fn bridge(&self) -> anyhow::Result<Arc<Bridge>> {
        Ok(self.bridge.get_or_try_init(Bridge::start).await?.clone())
    }

    /// Understands the source and starts its first region, unless the cache
    /// already has it. Calling it again for a known key is free.
    pub async fn prepare(self: &Arc<Self>, key: &str, title: &str, input: Input) -> anyhow::Result<Meta> {
        if !cache::valid_key(key) {
            bail!("invalid cache key");
        }
        if let Some(existing) = self.entries.lock().get(key).cloned() {
            *existing.used.lock() = SystemTime::now();
            return Ok(existing.meta.lock().clone());
        }
        let bridge = self.bridge().await?;
        let (sources, plan): (Vec<Arc<dyn ByteSource>>, SourcePlan) = match input {
            Input::Container(bytes) => {
                let (url, cap) = bridge.register_input(InputTarget { source: bytes.clone(), reader: format!("probe:{key}") });
                let args: Vec<String> = ["-v", "error", "-print_format", "json", "-show_format", "-show_streams", "-show_chapters", &url]
                    .iter()
                    .map(|s| s.to_string())
                    .collect();
                let probed = process::run_capture(&self.ffprobe, &args, Duration::from_secs(120)).await;
                bridge.revoke(&cap, "");
                (vec![bytes], plan::plan_streams(&probed?)?)
            }
            Input::Youtube(resolver, url) => {
                let materialized = resolver.materialize(&youtube::Request { url }).await?;
                let sources = materialized.streams.into_iter().map(|s| s as Arc<dyn ByteSource>).collect();
                (sources, materialized.plan)
            }
        };
        let dir = self.root.join(key).join("hls");
        std::fs::create_dir_all(&dir)?;
        let stored: Option<Meta> =
            std::fs::read(self.root.join(key).join("meta.json")).ok().and_then(|raw| serde_json::from_slice(&raw).ok());
        let meta = Meta {
            key: key.to_string(),
            title: title.to_string(),
            duration_ms: plan.duration_ms,
            audio_langs: plan.audios.iter().map(|a| a.language.clone()).collect(),
            video_codecs: plan.video_codecs.clone(),
            regions: stored.map(|m| m.regions).unwrap_or_default(),
        };
        let production = Arc::new(Production {
            dir,
            sources,
            plan,
            meta: Mutex::new(meta.clone()),
            running: Mutex::new(None),
            used: Mutex::new(SystemTime::now()),
        });
        self.entries.lock().insert(key.to_string(), production);
        self.evict();
        self.follow(key, 0).await?;
        Ok(meta)
    }

    /// The room's position moved: a position no region holds starts a new
    /// one there, replacing the region FFmpeg was writing.
    pub async fn follow(self: &Arc<Self>, key: &str, position_ms: u64) -> anyhow::Result<()> {
        let Some(production) = self.entries.lock().get(key).cloned() else { bail!("unknown source") };
        *production.used.lock() = SystemTime::now();
        if covered(&self.regions(key), position_ms) {
            return Ok(());
        }
        self.start_region(key, &production, position_ms).await
    }

    async fn start_region(self: &Arc<Self>, key: &str, production: &Arc<Production>, position_ms: u64) -> anyhow::Result<()> {
        let bridge = self.bridge().await?;
        self.stop_running(production, &bridge).await;
        let n = production.meta.lock().regions.iter().map(|r| r.n + 1).max().unwrap_or(0);

        let mut start_seconds = 0.0;
        if position_ms > 0 {
            let target = position_ms as f64 / 1000.0;
            let (url, cap) = bridge.register_input(InputTarget { source: production.sources[0].clone(), reader: format!("key:{key}") });
            let args: Vec<String> = [
                "-v", "error", "-select_streams", "v:0", "-skip_frame", "nokey", "-show_entries", "frame=pts_time",
                "-print_format", "json", "-read_intervals", &format!("{target:.3}%+#1"), &url,
            ]
            .iter()
            .map(|s| s.to_string())
            .collect();
            let keyframe = process::run_capture(&self.ffprobe, &args, Duration::from_secs(120)).await.ok().and_then(|out| first_frame_pts(&out));
            bridge.revoke(&cap, "");
            start_seconds = keyframe.map(|pts| pts.min(target)).unwrap_or(target);
        }
        let start_ms = (start_seconds * 1000.0) as u64;

        let mut urls = Vec::new();
        let mut caps = Vec::new();
        for (index, source) in production.sources.iter().enumerate() {
            let (url, cap) = bridge.register_input(InputTarget { source: source.clone(), reader: format!("local:{key}:{n}:{index}") });
            urls.push(url);
            caps.push(cap);
        }
        let prefix = upload_plan::region_prefix(n);
        let base = production.dir.to_string_lossy().into_owned();
        let args = plan::ffmpeg_args(&urls, &base, &prefix, &production.plan, start_seconds, None, None);
        let process = process::spawn(&self.ffmpeg, &args)?;
        {
            let mut meta = production.meta.lock();
            meta.regions.push(RegionStart { n, start_ms });
            let _ = std::fs::write(self.root.join(key).join("meta.json"), serde_json::to_vec(&*meta)?);
        }
        *production.running.lock() = Some(Running { n, process, caps });
        tracing::info!(key, n, start_ms, "local region started");

        let watched = production.clone();
        let bridge_held = bridge.clone();
        tokio::spawn(async move {
            loop {
                tokio::time::sleep(Duration::from_millis(500)).await;
                let mut held = watched.running.lock();
                let Some(running) = held.as_mut() else { return };
                if running.n != n {
                    return;
                }
                match running.process.child_try_wait() {
                    Ok(None) => continue,
                    Ok(Some(status)) => {
                        if !status.success() {
                            tracing::warn!(n, stderr = %running.process.stderr_tail.lock().chars().take(400).collect::<String>(), "local region ffmpeg failed");
                        }
                    }
                    Err(_) => {}
                }
                if let Some(done) = held.take() {
                    for cap in &done.caps {
                        bridge_held.revoke(cap, "");
                    }
                }
                return;
            }
        });
        Ok(())
    }

    async fn stop_running(&self, production: &Production, bridge: &Bridge) {
        let running = production.running.lock().take();
        if let Some(mut running) = running {
            running.process.kill().await;
            for cap in &running.caps {
                bridge.revoke(cap, "");
            }
        }
    }

    /// The source's regions as the player reads them.
    pub fn regions(&self, key: &str) -> Vec<RegionState> {
        let Some(production) = self.entries.lock().get(key).cloned() else { return Vec::new() };
        let growing = production.running.lock().as_ref().map(|r| r.n);
        let starts = production.meta.lock().regions.clone();
        starts
            .iter()
            .map(|start| {
                let video = read_variant(&production.dir, start.n, 0);
                RegionState {
                    n: start.n,
                    start_ms: start.start_ms,
                    produced_ms: video.duration_ms(),
                    growing: growing == Some(start.n),
                }
            })
            .collect()
    }

    /// The source's regions with every variant, for the upload plan.
    pub fn local_regions(&self, key: &str) -> Vec<upload_plan::LocalRegion> {
        let Some(production) = self.entries.lock().get(key).cloned() else { return Vec::new() };
        let variants = 1 + production.plan.audios.len();
        let starts = production.meta.lock().regions.clone();
        starts
            .iter()
            .map(|start| upload_plan::LocalRegion {
                n: start.n,
                start_ms: start.start_ms,
                variants: (0..variants).map(|v| read_variant(&production.dir, start.n, v)).collect(),
            })
            .collect()
    }

    pub fn meta(&self, key: &str) -> Option<Meta> {
        self.entries.lock().get(key).map(|p| p.meta.lock().clone())
    }

    pub fn hls_dir(&self, key: &str) -> PathBuf {
        self.root.join(key).join("hls")
    }

    /// A key a room plays or uploads from never leaves the cache.
    pub fn hold(&self, key: &str, held: bool) {
        let mut busy = self.busy.lock();
        if held {
            busy.insert(key.to_string());
        } else {
            busy.remove(key);
        }
    }

    pub async fn stop(&self, key: &str) {
        let production = self.entries.lock().get(key).cloned();
        if let (Some(production), Ok(bridge)) = (production, self.bridge().await) {
            self.stop_running(&production, &bridge).await;
        }
    }

    fn evict(&self) {
        let Ok(dirs) = std::fs::read_dir(&self.root) else { return };
        let entries: Vec<cache::Entry> = dirs
            .filter_map(Result::ok)
            .filter_map(|dir| {
                let key = dir.file_name().to_str()?.to_string();
                let used = std::fs::metadata(dir.path().join("meta.json")).and_then(|m| m.modified()).ok()?;
                Some(cache::Entry { bytes: dir_bytes(&dir.path()), key, used })
            })
            .collect();
        let mut busy = self.busy.lock().clone();
        busy.extend(self.entries.lock().keys().cloned());
        for key in cache::evictions(&entries, self.cap_bytes, &busy) {
            tracing::info!(key, "cache entry evicted");
            let _ = std::fs::remove_dir_all(self.root.join(key));
        }
    }
}

fn read_variant(dir: &Path, n: u64, variant: usize) -> Variant {
    let name = hls::playlist_name(&upload_plan::region_prefix(n), variant);
    std::fs::read_to_string(dir.join(name)).map(|body| Variant::parse(&body)).unwrap_or_default()
}

fn dir_bytes(path: &Path) -> u64 {
    let Ok(read) = std::fs::read_dir(path) else { return 0 };
    read.filter_map(Result::ok)
        .map(|entry| match entry.metadata() {
            Ok(meta) if meta.is_dir() => dir_bytes(&entry.path()),
            Ok(meta) => meta.len(),
            Err(_) => 0,
        })
        .sum()
}

fn first_frame_pts(probe_json: &str) -> Option<f64> {
    let doc: serde_json::Value = serde_json::from_str(probe_json).ok()?;
    doc["frames"].as_array()?.first()?["pts_time"].as_str()?.parse().ok()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn region(n: u64, start_ms: u64, produced_ms: u64, growing: bool) -> RegionState {
        RegionState { n, start_ms, produced_ms, growing }
    }

    #[test]
    fn nothing_covers_an_empty_cache() {
        assert!(!covered(&[], 0));
    }

    #[test]
    fn a_sealed_region_covers_what_it_wrote() {
        let regions = [region(0, 0, 60_000, false)];
        assert!(covered(&regions, 0));
        assert!(covered(&regions, 60_000));
        assert!(!covered(&regions, 60_001));
    }

    #[test]
    fn a_growing_region_covers_the_window_ahead() {
        let regions = [region(1, 100_000, 10_000, true)];
        assert!(covered(&regions, 99_000));
        assert!(!covered(&regions, 98_999));
        assert!(covered(&regions, 140_000));
        assert!(!covered(&regions, 140_001));
    }
}
