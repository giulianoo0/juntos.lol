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
use ss_remux::{process, subs, youtube, ByteSource};

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
    /// The region also writes the 480p variant.
    pub low: bool,
}

/// How far ahead of what it wrote a growing region counts as holding a
/// position: the player's own allowance (REGION_AHEAD_MS in Player.tsx).
pub const AHEAD_MS: u64 = 30_000;
pub const BEHIND_MS: u64 = 1_000;
/// How short of the container's duration a remux may end and still be whole.
pub const END_SLACK_MS: u64 = 10_000;

/// Whether some region holds `position_ms`, the way the web player decides it.
/// With `need_low`, a region without the 480p variant does not count. A
/// region that reached the end holds whatever lies past it: the room's clock
/// can sit a few frames beyond the last one.
pub fn covered(regions: &[RegionState], position_ms: u64, need_low: bool, duration_ms: u64) -> bool {
    regions.iter().filter(|r| r.low || !need_low).any(|r| {
        let written = r.start_ms + r.produced_ms;
        let end = if r.growing {
            written + AHEAD_MS
        } else if duration_ms > 0 && written + END_SLACK_MS >= duration_ms {
            u64::MAX
        } else {
            written
        };
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
    /// The 480p variant's size, for the masters the upload writes.
    #[serde(default)]
    pub low_resolution: Option<(u32, u32)>,
    #[serde(default)]
    pub regions: Vec<RegionStart>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RegionStart {
    pub n: u64,
    pub start_ms: u64,
    #[serde(default)]
    pub low: bool,
}

struct Running {
    n: u64,
    process: process::Supervised,
    caps: Vec<String>,
}

/// The subtitles a video's page offers, and the client that reaches them.
struct PageSubtitles {
    client: reqwest::Client,
    picks: Vec<youtube::SubtitlePick>,
}

/// Closes a bridge input however its reader ends, aborted included.
struct Revoke(Arc<Bridge>, String);

impl Drop for Revoke {
    fn drop(&mut self) {
        self.0.revoke(&self.1, "");
    }
}

/// The subtitle pass for one room's source: one per room and generation.
struct Subtitles {
    room_id: String,
    generation: u64,
    task: tokio::task::JoinHandle<()>,
}

struct Production {
    dir: PathBuf,
    sources: Vec<Arc<dyn ByteSource>>,
    plan: SourcePlan,
    page_subtitles: Option<PageSubtitles>,
    subtitles: Mutex<Option<Subtitles>>,
    meta: Mutex<Meta>,
    running: Mutex<Option<Running>>,
    used: Mutex<SystemTime>,
    /// A guest on a thin link needs 480p: new regions encode it too.
    low: Mutex<bool>,
    /// One region starts at a time: two follows at once would both take the
    /// same number and write over each other's files.
    starting: tokio::sync::Mutex<()>,
}

impl Production {
    fn new(dir: PathBuf, sources: Vec<Arc<dyn ByteSource>>, plan: SourcePlan, page_subtitles: Option<PageSubtitles>, meta: Meta) -> Arc<Self> {
        Arc::new(Production {
            dir,
            sources,
            plan,
            page_subtitles,
            subtitles: Mutex::new(None),
            meta: Mutex::new(meta),
            running: Mutex::new(None),
            used: Mutex::new(SystemTime::now()),
            low: Mutex::new(false),
            starting: tokio::sync::Mutex::new(()),
        })
    }
}

/// The 480p encoder: the GPU's on a Mac, x264 elsewhere.
fn low_encoder() -> plan::Encoder {
    if cfg!(target_os = "macos") { plan::Encoder::VideoToolbox } else { plan::Encoder::X264 }
}

/// Every source this machine prepared, by cache key.
pub struct Producer {
    root: PathBuf,
    ffmpeg: String,
    ffprobe: String,
    cap_bytes: u64,
    bridge: tokio::sync::OnceCell<Arc<Bridge>>,
    client: reqwest::Client,
    subtitle_rooms: subs::Rooms,
    entries: Mutex<HashMap<String, Arc<Production>>>,
    /// One prepare per key at a time: a second one waits and reuses the first.
    preparing: Mutex<HashMap<String, Arc<tokio::sync::Mutex<()>>>>,
}

impl Producer {
    pub fn new(root: PathBuf, ffmpeg: String, ffprobe: String, cap_bytes: u64) -> Arc<Self> {
        Arc::new(Self {
            root,
            ffmpeg,
            ffprobe,
            cap_bytes,
            bridge: tokio::sync::OnceCell::new(),
            client: reqwest::Client::new(),
            subtitle_rooms: subs::new_rooms(),
            entries: Mutex::new(HashMap::new()),
            preparing: Mutex::new(HashMap::new()),
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
        let gate = self.preparing.lock().entry(key.to_string()).or_default().clone();
        let _preparing = gate.lock().await;
        if let Some(existing) = self.entries.lock().get(key).cloned() {
            *existing.used.lock() = SystemTime::now();
            return Ok(existing.meta.lock().clone());
        }
        let bridge = self.bridge().await?;
        let (sources, plan, page_subtitles): (Vec<Arc<dyn ByteSource>>, SourcePlan, Option<PageSubtitles>) = match input {
            Input::Container(bytes) => {
                let (url, cap) = bridge.register_input(InputTarget { source: bytes.clone(), reader: format!("probe:{key}") });
                let args: Vec<String> = ["-v", "error", "-print_format", "json", "-show_format", "-show_streams", "-show_chapters", &url]
                    .iter()
                    .map(|s| s.to_string())
                    .collect();
                let probed = process::run_capture(&self.ffprobe, &args, Duration::from_secs(120)).await;
                bridge.revoke(&cap, "");
                (vec![bytes], plan::plan_streams(&probed?)?, None)
            }
            Input::Youtube(resolver, url) => {
                let materialized = resolver.materialize(&youtube::Request { url }).await?;
                let sources = materialized.streams.into_iter().map(|s| s as Arc<dyn ByteSource>).collect();
                let page = PageSubtitles { client: resolver.client.clone(), picks: materialized.subtitles };
                (sources, materialized.plan, Some(page))
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
            low_resolution: plan::low_resolution(&plan),
            regions: stored.map(|m| m.regions).unwrap_or_default(),
        };
        let production = Production::new(dir, sources, plan, page_subtitles, meta.clone());
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
        let _starting = production.starting.lock().await;
        let need_low = *production.low.lock();
        let duration_ms = production.meta.lock().duration_ms;
        if covered(&self.regions(key), position_ms, need_low, duration_ms) {
            return Ok(());
        }
        self.start_region(key, &production, position_ms).await
    }

    /// The room asked for 480p (or stopped): from `position_ms` on, the
    /// regions carry it. Turning it off keeps what was already written.
    pub async fn want_low(self: &Arc<Self>, key: &str, on: bool, position_ms: u64) -> anyhow::Result<()> {
        let Some(production) = self.entries.lock().get(key).cloned() else { bail!("unknown source") };
        let changed = std::mem::replace(&mut *production.low.lock(), on) != on;
        if changed && on {
            return self.follow(key, position_ms).await;
        }
        Ok(())
    }

    /// Called with `production.starting` held.
    async fn start_region(self: &Arc<Self>, key: &str, production: &Arc<Production>, position_ms: u64) -> anyhow::Result<()> {
        let n = production.meta.lock().regions.iter().map(|r| r.n + 1).max().unwrap_or(0);
        let bridge = self.bridge().await?;
        self.stop_running(production, &bridge).await;

        let mut keyframe = None;
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
            keyframe = process::run_capture(&self.ffprobe, &args, Duration::from_secs(120)).await.ok().and_then(|out| plan::first_frame_pts(&out));
            bridge.revoke(&cap, "");
        }
        let start = plan::Start::seek(position_ms, keyframe);
        let start_ms = start.offset_ms;

        let mut urls = Vec::new();
        let mut caps = Vec::new();
        for (index, source) in production.sources.iter().enumerate() {
            let (url, cap) = bridge.register_input(InputTarget { source: source.clone(), reader: format!("local:{key}:{n}:{index}") });
            urls.push(url);
            caps.push(cap);
        }
        let prefix = upload_plan::region_prefix(n);
        let base = production.dir.to_string_lossy().into_owned();
        let encoder = start.low(production.low.lock().then(low_encoder));
        let low = encoder.is_some();
        let args = plan::ffmpeg_args(&urls, &base, &prefix, &production.plan, start, None, encoder);
        let process = process::spawn(&self.ffmpeg, &args)?;
        {
            let mut meta = production.meta.lock();
            meta.regions.push(RegionStart { n, start_ms, low });
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
                    low: start.low,
                }
            })
            .collect()
    }

    /// The source's regions with every variant, for the upload plan.
    pub fn local_regions(&self, key: &str) -> Vec<upload_plan::LocalRegion> {
        let Some(production) = self.entries.lock().get(key).cloned() else { return Vec::new() };
        let full = 1 + production.plan.audios.len();
        let starts = production.meta.lock().regions.clone();
        starts
            .iter()
            .map(|start| {
                // The 480p variant is numbered right after the audios.
                let variants = full + usize::from(start.low);
                upload_plan::LocalRegion {
                    n: start.n,
                    start_ms: start.start_ms,
                    variants: (0..variants).map(|v| read_variant(&production.dir, start.n, v)).collect(),
                }
            })
            .collect()
    }

    pub fn meta(&self, key: &str) -> Option<Meta> {
        self.entries.lock().get(key).map(|p| p.meta.lock().clone())
    }

    pub fn hls_dir(&self, key: &str) -> PathBuf {
        self.root.join(key).join("hls")
    }

    pub async fn stop(&self, key: &str) {
        let production = self.entries.lock().get(key).cloned();
        if let Some(subtitles) = production.as_ref().and_then(|p| p.subtitles.lock().take()) {
            subtitles.task.abort();
        }
        if let (Some(production), Ok(bridge)) = (production, self.bridge().await) {
            self.stop_running(&production, &bridge).await;
        }
    }

    /// Publishes the source's subtitles to the room, where every member reads
    /// them: the container's own tracks, pulled once the first frames are
    /// out so the pass does not hold the picture back, or the page's. Once
    /// per room and generation; a new one replaces the pass before it.
    pub async fn subtitles(
        self: &Arc<Self>,
        key: &str,
        api_base: String,
        room_id: String,
        generation: u64,
        auth: subs::PublishAuth,
    ) -> anyhow::Result<()> {
        let Some(production) = self.entries.lock().get(key).cloned() else { bail!("unknown source") };
        let bridge = self.bridge().await?;
        let mut held = production.subtitles.lock();
        if held.as_ref().is_some_and(|s| s.room_id == room_id && s.generation == generation) {
            return Ok(());
        }
        if let Some(previous) = held.take() {
            previous.task.abort();
        }
        let this = self.clone();
        let source = production.clone();
        let (room, key) = (room_id.clone(), key.to_string());
        let task = tokio::spawn(async move {
            let run_id = format!("local_{key}");
            if let Some(page) = &source.page_subtitles {
                if page.picks.is_empty() {
                    return;
                }
                let publisher = youtube::subs::Publisher {
                    client: page.client.clone(),
                    api: this.client.clone(),
                    api_base,
                    room_id: room,
                    run_id: run_id.clone(),
                    media_generation: generation,
                    auth,
                };
                if let Err(e) = publisher.run(page.picks.clone()).await {
                    tracing::warn!(run = %run_id, error = %e, "page subtitles not published");
                }
                return;
            }
            if source.plan.subtitles.is_empty() {
                return;
            }
            while !this.regions(&key).iter().any(|r| r.produced_ms > 0) {
                tokio::time::sleep(Duration::from_millis(500)).await;
            }
            let dir = this.root.join(&key).join("subs");
            let _ = tokio::fs::remove_dir_all(&dir).await;
            let (input_url, cap) = bridge.register_input(InputTarget { source: source.sources[0].clone(), reader: format!("subs:{key}") });
            let _input = Revoke(bridge.clone(), cap);
            let extractor = subs::Extractor {
                ffmpeg_path: this.ffmpeg.clone(),
                client: this.client.clone(),
                api_base,
                room_id: room.clone(),
                run_id: run_id.clone(),
                media_generation: generation,
                auth,
                input_url,
                dir,
                state: subs::room_state(&this.subtitle_rooms, &room, generation, &source.plan),
            };
            if let Err(e) = extractor.run(&source.plan, 0, 0).await {
                tracing::warn!(run = %run_id, error = %e, "subtitle pass failed");
            }
        });
        *held = Some(Subtitles { room_id, generation, task });
        Ok(())
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
        // Every key this run prepared stays: a room plays or uploads only
        // from those.
        let busy: HashSet<String> = self.entries.lock().keys().cloned().collect();
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

#[cfg(test)]
mod tests {
    use super::*;

    fn region(n: u64, start_ms: u64, produced_ms: u64, growing: bool) -> RegionState {
        RegionState { n, start_ms, produced_ms, growing, low: false }
    }

    #[cfg(unix)]
    struct Empty;

    #[async_trait::async_trait]
    #[cfg(unix)]
    impl ByteSource for Empty {
        fn size(&self) -> u64 {
            0
        }
        async fn open(&self, _reader: &str, _position: u64) -> anyhow::Result<Box<dyn ss_remux::SourceReader>> {
            bail!("empty source")
        }
    }

    #[cfg(unix)]
    const PROBE: &str = r#"{"format":{"duration":"3600"},"streams":[{"codec_type":"video","codec_name":"h264"},{"codec_type":"audio","codec_name":"aac","channels":2}]}"#;

    /// A stand-in for ffprobe that counts its calls next to itself, takes a
    /// moment, and prints `out` (or fails without it).
    #[cfg(unix)]
    fn fake_ffprobe(dir: &Path, out: Option<&str>) -> String {
        use std::os::unix::fs::PermissionsExt;
        let path = dir.join("ffprobe.sh");
        let print = out.map(|o| format!("printf '%s' '{o}'")).unwrap_or_else(|| "exit 1".into());
        std::fs::write(&path, format!("#!/bin/sh\necho x >> '{}'\nsleep 0.2\n{print}\n", dir.join("calls").display())).unwrap();
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o755)).unwrap();
        path.to_string_lossy().into_owned()
    }

    #[cfg(unix)]
    fn calls(dir: &Path) -> usize {
        std::fs::read_to_string(dir.join("calls")).map(|s| s.lines().count()).unwrap_or(0)
    }

    /// A producer whose FFmpeg exits at once, with source `k` already known.
    #[cfg(unix)]
    fn producer_with_source(root: &Path, ffprobe: String) -> Arc<Producer> {
        let producer = Producer::new(root.join("cache"), "true".into(), ffprobe, u64::MAX);
        let dir = root.join("cache/k/hls");
        std::fs::create_dir_all(&dir).unwrap();
        let plan = plan::plan_streams(PROBE).unwrap();
        let meta = Meta { key: "k".into(), title: "Filme".into(), duration_ms: plan.duration_ms, audio_langs: vec![], video_codecs: None, low_resolution: None, regions: vec![] };
        producer.entries.lock().insert("k".into(), Production::new(dir, vec![Arc::new(Empty)], plan, None, meta));
        producer
    }

    #[cfg(unix)]
    fn region_numbers(producer: &Producer) -> Vec<u64> {
        producer.meta("k").unwrap().regions.iter().map(|r| r.n).collect()
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn regions_started_at_once_get_numbers_of_their_own() {
        let root = tempfile::tempdir().unwrap();
        let producer = producer_with_source(root.path(), fake_ffprobe(root.path(), None));

        let (a, b) = tokio::join!(producer.follow("k", 500_000), producer.follow("k", 900_000));
        a.unwrap();
        b.unwrap();

        let mut numbers = region_numbers(&producer);
        numbers.sort();
        assert_eq!(numbers, vec![0, 1]);
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn a_region_whose_keyframe_probe_failed_has_no_480p() {
        let root = tempfile::tempdir().unwrap();
        let producer = producer_with_source(root.path(), fake_ffprobe(root.path(), None));

        producer.want_low("k", true, 500_000).await.unwrap();

        let regions = producer.meta("k").unwrap().regions;
        assert_eq!(regions.len(), 1);
        assert!(!regions[0].low);
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn preparing_a_source_twice_at_once_reads_it_once() {
        let root = tempfile::tempdir().unwrap();
        let producer = Producer::new(root.path().join("cache"), "true".into(), fake_ffprobe(root.path(), Some(PROBE)), u64::MAX);

        let input = || Input::Container(Arc::new(Empty));
        let (a, b) = tokio::join!(producer.prepare("k", "Filme", input()), producer.prepare("k", "Filme", input()));
        a.unwrap();
        b.unwrap();

        assert_eq!(calls(root.path()), 1);
        assert_eq!(region_numbers(&producer), vec![0]);
    }

    #[test]
    fn nothing_covers_an_empty_cache() {
        assert!(!covered(&[], 0, false, 0));
    }

    #[test]
    fn a_sealed_region_covers_what_it_wrote() {
        let regions = [region(0, 0, 60_000, false)];
        assert!(covered(&regions, 0, false, 0));
        assert!(covered(&regions, 60_000, false, 0));
        assert!(!covered(&regions, 60_001, false, 0));
    }

    #[test]
    fn a_growing_region_covers_the_window_ahead() {
        let regions = [region(1, 100_000, 10_000, true)];
        assert!(covered(&regions, 99_000, false, 0));
        assert!(!covered(&regions, 98_999, false, 0));
        assert!(covered(&regions, 140_000, false, 0));
        assert!(!covered(&regions, 140_001, false, 0));
    }

    #[test]
    fn once_480p_is_wanted_only_a_region_with_it_covers() {
        let mut regions = vec![region(0, 0, 600_000, true)];
        assert!(covered(&regions, 300_000, false, 0));
        assert!(!covered(&regions, 300_000, true, 0));
        regions.push(RegionState { low: true, ..region(1, 299_000, 2_000, true) });
        assert!(covered(&regions, 300_000, true, 0));
    }

    #[test]
    fn a_region_that_reached_the_end_holds_past_it() {
        let regions = [region(1, 1_195_000, 4_955, false)];
        assert!(covered(&regions, 1_200_000, false, 1_199_955));
        assert!(!covered(&regions, 1_200_000, false, 1_300_000));
    }

    /// A server for one test: the page's subtitle document, and the room's
    /// subtitle route, which keeps every body it is sent.
    async fn subtitle_server() -> (String, Arc<Mutex<Vec<(String, serde_json::Value)>>>) {
        use tokio::io::{AsyncReadExt, AsyncWriteExt};
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let base = format!("http://{}", listener.local_addr().unwrap());
        let posts = Arc::new(Mutex::new(Vec::new()));
        let seen = posts.clone();
        tokio::spawn(async move {
            loop {
                let Ok((mut socket, _)) = listener.accept().await else { return };
                let seen = seen.clone();
                tokio::spawn(async move {
                    let mut raw = Vec::new();
                    let mut chunk = [0u8; 8192];
                    let (head, body) = loop {
                        let n = socket.read(&mut chunk).await.unwrap_or(0);
                        if n == 0 {
                            return;
                        }
                        raw.extend_from_slice(&chunk[..n]);
                        let Some(end) = raw.windows(4).position(|w| w == b"\r\n\r\n") else { continue };
                        let head = String::from_utf8_lossy(&raw[..end]).into_owned();
                        let length = head
                            .lines()
                            .find_map(|l| l.to_ascii_lowercase().strip_prefix("content-length:").map(|v| v.trim().parse::<usize>().unwrap()))
                            .unwrap_or(0);
                        while raw.len() < end + 4 + length {
                            let n = socket.read(&mut chunk).await.unwrap_or(0);
                            if n == 0 {
                                return;
                            }
                            raw.extend_from_slice(&chunk[..n]);
                        }
                        break (head, raw[end + 4..end + 4 + length].to_vec());
                    };
                    let path = head.split_whitespace().nth(1).unwrap_or("").to_string();
                    let reply = if head.starts_with("GET") {
                        "WEBVTT\n\n00:00:01.000 --> 00:00:02.000\nOlá, coração – 字幕\n".to_string()
                    } else {
                        seen.lock().push((path, serde_json::from_slice(&body).unwrap()));
                        "{}".to_string()
                    };
                    let status = if head.starts_with("GET") { "200 OK" } else { "201 Created" };
                    let response = format!("HTTP/1.1 {status}\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{reply}", reply.len());
                    let _ = socket.write_all(response.as_bytes()).await;
                });
            }
        });
        (base, posts)
    }

    #[cfg(unix)]
    fn page_producer(root: &Path, base: &str) -> Arc<Producer> {
        let producer = Producer::new(root.join("cache"), "true".into(), "true".into(), u64::MAX);
        let dir = root.join("cache/y/hls");
        std::fs::create_dir_all(&dir).unwrap();
        let plan = plan::plan_streams(PROBE).unwrap();
        let meta = Meta { key: "y".into(), title: "Clipe".into(), duration_ms: plan.duration_ms, audio_langs: vec![], video_codecs: None, low_resolution: None, regions: vec![] };
        let page = PageSubtitles {
            client: reqwest::Client::new(),
            picks: vec![youtube::SubtitlePick { language: "pt-BR".into(), title: "Português (Brasil)".into(), url: format!("{base}/sub.vtt"), auto: false }],
        };
        producer.entries.lock().insert("y".into(), Production::new(dir, vec![Arc::new(Empty)], plan, Some(page), meta));
        producer
    }

    fn member() -> subs::PublishAuth {
        subs::PublishAuth::Producer { member_id: "m1".into(), capability: "cap".into() }
    }

    async fn posts_settle(posts: &Arc<Mutex<Vec<(String, serde_json::Value)>>>, count: usize) {
        for _ in 0..100 {
            if posts.lock().len() >= count {
                break;
            }
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
        tokio::time::sleep(Duration::from_millis(100)).await;
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn a_videos_subtitles_go_to_the_room_where_a_browser_posts_them_once_per_source() {
        let root = tempfile::tempdir().unwrap();
        let (base, posts) = subtitle_server().await;
        let producer = page_producer(root.path(), &base);

        producer.subtitles("y", base.clone(), "R1".into(), 4, member()).await.unwrap();
        producer.subtitles("y", base.clone(), "R1".into(), 4, member()).await.unwrap();
        posts_settle(&posts, 1).await;

        let sent = posts.lock().clone();
        assert_eq!(sent.len(), 1, "the same source was published twice");
        let (path, body) = &sent[0];
        assert_eq!(path, "/api/rooms/R1/subtitles/local");
        assert!(body.get("claim").is_none());
        assert_eq!((body["memberId"].as_str(), body["capability"].as_str()), (Some("m1"), Some("cap")));
        assert_eq!(body["mediaGeneration"], 4);
        assert_eq!(body["complete"], true);
        assert_eq!(body["tracks"][0]["language"], "pt-BR");
        assert_eq!(body["tracks"][0]["title"], "Português (Brasil)");
        assert!(body["tracks"][0]["vtt"].as_str().unwrap().contains("Olá, coração – 字幕"));

        producer.subtitles("y", base.clone(), "R1".into(), 5, member()).await.unwrap();
        posts_settle(&posts, 2).await;
        assert_eq!(posts.lock().len(), 2, "a new source in the room was not published");
        assert_eq!(posts.lock()[1].1["mediaGeneration"], 5);
    }

    #[tokio::test]
    async fn subtitles_for_a_source_never_prepared_are_refused() {
        let root = tempfile::tempdir().unwrap();
        let producer = Producer::new(root.path().join("cache"), "true".into(), "true".into(), u64::MAX);
        assert!(producer.subtitles("nope", "http://127.0.0.1:9".into(), "R1".into(), 1, member()).await.is_err());
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn stopping_the_source_stops_its_subtitle_pass() {
        let root = tempfile::tempdir().unwrap();
        let (base, _posts) = subtitle_server().await;
        let producer = page_producer(root.path(), &base);
        producer.subtitles("y", base, "R1".into(), 4, member()).await.unwrap();
        producer.stop("y").await;
        let production = producer.entries.lock().get("y").cloned().unwrap();
        assert!(production.subtitles.lock().is_none());
    }
}

