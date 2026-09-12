//! The remote remux: FFmpeg over a loopback bridge, HLS objects PUT to the
//! bucket through the API, run state reported back. One crate so the fleet
//! worker and the host's companion app produce a room the same way.
pub mod bridge;
pub mod plan;
pub mod process;
pub mod protocol;
pub mod publish;
pub mod range;
pub mod sink;
pub mod source;
pub mod subs;
pub mod upload;
pub mod youtube;
pub mod live;

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::Arc;
use std::time::Duration;

use anyhow::{bail, Context};
use parking_lot::Mutex;
use serde_json::json;
use tokio::sync::Semaphore;

use bridge::{Bridge, InputTarget};
use protocol::{state, Spec};
pub use source::{ByteSource, SourceReader};

#[derive(Clone, Debug)]
pub struct RemuxConfig {
    pub data_dir: PathBuf,
    pub ffmpeg_path: String,
    pub ffprobe_path: String,
    pub slots: usize,
    pub spool_bytes: u64,
    pub object_bytes: u64,
    pub put_concurrency: usize,
    pub put_global: usize,
    pub youtube: Option<youtube::Config>,
    /// Lives on the relay at once; each is one FFmpeg copying, no encode.
    pub live_slots: usize,
}

/// What a run reads. A container is probed and its subtitles pulled by a
/// second FFmpeg pass; a YouTube video is already known stream by stream.
pub enum RunInput {
    Container(Arc<dyn ByteSource>),
    Youtube(youtube::Request),
}

/// The supervisor: accepts runs, drives FFmpeg over the loopback bridge,
/// uploads and publishes through the API, and reports every run's state.
pub struct Remux {
    cfg: RemuxConfig,
    client: reqwest::Client,
    pub ffmpeg_version: Option<String>,
    pub youtube: Option<Arc<youtube::Resolver>>,
    bridge: tokio::sync::OnceCell<Arc<Bridge>>,
    slots: Arc<Semaphore>,
    global_puts: Arc<Semaphore>,
    runs: Mutex<HashMap<String, Arc<RunEntry>>>,
    subtitle_rooms: subs::Rooms,
    /// Rooms whose YouTube subtitles are already published, by generation:
    /// the documents come whole, so one run per generation does it.
    vtt_done: Arc<Mutex<std::collections::HashSet<String>>>,
    /// Lives on the relay, one per room.
    lives: Mutex<HashMap<String, Arc<live::Session>>>,
}

struct RunEntry {
    room: String,
    status: Mutex<RunStatus>,
    sink: Mutex<Option<Arc<sink::Sink>>>,
    process: Mutex<Option<process::Supervised>>,
    subtitles: Mutex<Option<tokio::task::JoinHandle<()>>>,
}

#[derive(Clone)]
pub struct RunStatus {
    pub state: &'static str,
    pub produced_ms: u64,
    pub error: Option<String>,
}

impl Remux {
    pub async fn new(cfg: RemuxConfig) -> Arc<Self> {
        let ffmpeg_version = if cfg.slots > 0 { process::detect_version(&cfg.ffmpeg_path).await } else { None };
        if cfg.slots > 0 && ffmpeg_version.is_none() {
            tracing::warn!(path = %cfg.ffmpeg_path, "ffmpeg not found; remux capability void");
        }
        let youtube = match &cfg.youtube {
            Some(yt) if ffmpeg_version.is_some() => {
                let resolver = youtube::Resolver::new(yt.clone()).await;
                match &resolver.version {
                    Some(version) => tracing::info!(%version, proxy = yt.proxy.is_some(), "youtube capability on"),
                    None => tracing::warn!(path = %yt.ytdlp_path, "yt-dlp not found; youtube capability void"),
                }
                resolver.version.is_some().then(|| Arc::new(resolver))
            }
            _ => None,
        };
        Arc::new(Self {
            slots: Arc::new(Semaphore::new(cfg.slots.max(1))),
            global_puts: Arc::new(Semaphore::new(cfg.put_global.max(1))),
            client: reqwest::Client::builder().timeout(Duration::from_secs(120)).build().expect("reqwest client"),
            bridge: tokio::sync::OnceCell::new(),
            runs: Mutex::new(HashMap::new()),
            subtitle_rooms: subs::new_rooms(),
            vtt_done: Arc::new(Mutex::new(Default::default())),
            lives: Mutex::new(HashMap::new()),
            ffmpeg_version,
            youtube,
            cfg,
        })
    }

    pub fn enabled(&self) -> bool {
        self.cfg.slots > 0 && self.ffmpeg_version.is_some()
    }

    pub fn slots(&self) -> usize {
        self.cfg.slots
    }

    pub fn live_slots(&self) -> usize {
        if self.youtube.is_some() { self.cfg.live_slots } else { 0 }
    }

    /// Puts a room's live on the relay, replacing one already there for the
    /// room. Refused with a code when there is no yt-dlp or every slot is busy.
    pub fn start_live(&self, room: &str, request: live::Request) -> Result<(), &'static str> {
        let Some(resolver) = self.youtube.clone() else { return Err("youtube_disabled") };
        let mut lives = self.lives.lock();
        lives.retain(|_, session| !session.state().is_final());
        if let Some(previous) = lives.remove(room) {
            previous.stop();
        }
        if lives.len() >= self.cfg.live_slots {
            return Err("live_busy");
        }
        let session = live::Session::start(resolver, self.cfg.ffmpeg_path.clone(), request);
        lives.insert(room.to_string(), Arc::new(session));
        Ok(())
    }

    pub fn stop_live(&self, room: &str) -> bool {
        match self.lives.lock().remove(room) {
            Some(session) => {
                session.stop();
                true
            }
            None => false,
        }
    }

    pub fn live_state(&self, room: &str) -> Option<live::State> {
        self.lives.lock().get(room).map(|session| session.state())
    }

    /// Every live the caller may still care about; a finished one stays
    /// listed until the next start prunes it, so its end is reported once.
    pub fn lives(&self) -> Vec<serde_json::Value> {
        self.lives
            .lock()
            .iter()
            .map(|(room, session)| json!({ "roomId": room, "state": session.state() }))
            .collect()
    }

    pub fn active_lives(&self) -> usize {
        self.lives.lock().values().filter(|session| !session.state().is_final()).count()
    }

    pub fn status(&self, run_id: &str) -> Option<RunStatus> {
        self.runs.lock().get(run_id).map(|entry| entry.status.lock().clone())
    }

    /// Every run the caller may still care about, terminal ones included
    /// until the map is pruned.
    pub fn runs(&self) -> Vec<serde_json::Value> {
        self.runs
            .lock()
            .iter()
            .map(|(run_id, entry)| {
                let status = entry.status.lock().clone();
                json!({ "runId": run_id, "state": status.state, "producedMs": status.produced_ms, "error": status.error })
            })
            .collect()
    }

    pub fn active_runs(&self) -> usize {
        self.runs
            .lock()
            .values()
            .filter(|entry| {
                let held = entry.status.lock();
                !matches!(held.state, state::COMPLETED | state::CANCELLED | state::FAILED)
            })
            .count()
    }

    pub async fn start(self: &Arc<Self>, input: RunInput, spec: Spec) -> anyhow::Result<()> {
        if !self.enabled() {
            bail!("remux_disabled");
        }
        if spec.protocol_version != protocol::PROTOCOL_VERSION {
            bail!("protocol_mismatch");
        }
        if matches!(input, RunInput::Youtube(_)) && self.youtube.is_none() {
            bail!("youtube_disabled");
        }
        if self.runs.lock().contains_key(&spec.run_id) {
            return Ok(());
        }
        let stale: Vec<String> = self
            .runs
            .lock()
            .iter()
            .filter(|(run_id, entry)| {
                **run_id != spec.run_id
                    && entry.room == spec.room_id
                    && !matches!(entry.status.lock().state, state::COMPLETED | state::CANCELLED | state::FAILED)
            })
            .map(|(run_id, _)| run_id.clone())
            .collect();
        for run_id in stale {
            tracing::info!(run = %run_id, room = %spec.room_id, "remux run superseded by its room's new start");
            self.cancel(&run_id).await;
        }
        if self.active_runs() >= self.cfg.slots {
            bail!("remux_busy");
        }
        let entry = Arc::new(RunEntry {
            room: spec.room_id.clone(),
            status: Mutex::new(RunStatus { state: state::ACCEPTED, produced_ms: 0, error: None }),
            sink: Mutex::new(None),
            process: Mutex::new(None),
            subtitles: Mutex::new(None),
        });
        self.runs.lock().insert(spec.run_id.clone(), entry.clone());
        let this = self.clone();
        let run_id = spec.run_id.clone();
        tokio::spawn(async move {
            let outcome = this.execute(input, &spec, &entry).await;
            let mut status = entry.status.lock();
            match outcome {
                Ok(()) => {
                    if status.state != state::CANCELLED {
                        status.state = state::COMPLETED;
                    }
                }
                Err(e) => {
                    if status.state != state::CANCELLED {
                        status.state = state::FAILED;
                        status.error = Some(e.to_string().chars().take(400).collect());
                        tracing::warn!(run = %run_id, error = %e, "remux run failed");
                    }
                }
            }
            drop(status);
            let this = this.clone();
            tokio::spawn(async move {
                tokio::time::sleep(Duration::from_secs(120)).await;
                let room = {
                    let mut runs = this.runs.lock();
                    let room = runs.remove(&run_id).map(|entry| entry.room.clone());
                    room.filter(|room| !runs.values().any(|entry| entry.room == *room))
                };
                if let Some(room) = room {
                    subs::forget_room(&this.subtitle_rooms, &room);
                }
            });
        });
        Ok(())
    }

    pub async fn cancel(&self, run_id: &str) -> bool {
        let entry = self.runs.lock().get(run_id).cloned();
        let Some(entry) = entry else { return false };
        {
            let mut status = entry.status.lock();
            if matches!(status.state, state::COMPLETED | state::FAILED | state::CANCELLED) {
                return true;
            }
            status.state = state::CANCELLED;
        }
        if let Some(sink) = entry.sink.lock().clone() {
            sink.cancel();
        }
        let process = entry.process.lock().take();
        if let Some(mut process) = process {
            process.kill().await;
        }
        if let Some(handle) = entry.subtitles.lock().take() {
            handle.abort();
        }
        true
    }

    fn cancelled(entry: &RunEntry) -> bool {
        entry.status.lock().state == state::CANCELLED
    }

    async fn execute(self: &Arc<Self>, input: RunInput, spec: &Spec, entry: &Arc<RunEntry>) -> anyhow::Result<()> {
        let _slot = self.slots.clone().acquire_owned().await?;
        let bridge = self.bridge.get_or_try_init(|| Bridge::start()).await.context("bridge start")?.clone();

        // One byte source per FFmpeg input, the video first; and the plan,
        // probed off the container or read off the resolved video.
        let (sources, source, vtt_subtitles): (Vec<Arc<dyn ByteSource>>, plan::SourcePlan, Vec<youtube::SubtitlePick>) =
            match input {
                RunInput::Container(bytes) => {
                    let (probe_url, probe_cap) =
                        bridge.register_input(InputTarget { source: bytes.clone(), reader: format!("remux-probe:{}", spec.run_id) });
                    let probe_args: Vec<String> =
                        ["-v", "error", "-print_format", "json", "-show_format", "-show_streams", "-show_chapters", &probe_url]
                            .iter()
                            .map(|s| s.to_string())
                            .collect();
                    let probed = process::run_capture(&self.cfg.ffprobe_path, &probe_args, Duration::from_secs(120)).await;
                    bridge.revoke(&probe_cap, "");
                    (vec![bytes], plan::plan_streams(&probed?)?, Vec::new())
                }
                RunInput::Youtube(request) => {
                    let resolver = self.youtube.clone().context("youtube_disabled")?;
                    let materialized = resolver.materialize(&request).await?;
                    let sources: Vec<Arc<dyn ByteSource>> = materialized.streams.into_iter().map(|s| s as Arc<dyn ByteSource>).collect();
                    (sources, materialized.plan, materialized.subtitles)
                }
            };
        if Self::cancelled(entry) {
            return Ok(());
        }

        let (probe_url, probe_cap) =
            bridge.register_input(InputTarget { source: sources[0].clone(), reader: format!("remux-key:{}", spec.run_id) });
        let mut start_seconds = 0.0f64;
        let mut offset_ms = 0u64;
        if spec.start_ms > 0 {
            let target = spec.start_ms as f64 / 1000.0;
            let key_args: Vec<String> = [
                "-v", "error", "-select_streams", "v:0", "-skip_frame", "nokey",
                "-show_entries", "frame=pts_time", "-print_format", "json",
                "-read_intervals", &format!("{target:.3}%+#1"), &probe_url,
            ]
            .iter()
            .map(|s| s.to_string())
            .collect();
            if let Ok(output) = process::run_capture(&self.cfg.ffprobe_path, &key_args, Duration::from_secs(120)).await {
                if let Some(pts) = first_frame_pts(&output) {
                    start_seconds = pts.min(target);
                    offset_ms = (start_seconds * 1000.0) as u64;
                }
            }
            if offset_ms == 0 && spec.start_ms > 0 {
                start_seconds = target;
                offset_ms = spec.start_ms;
            }
        }
        bridge.revoke(&probe_cap, "");

        let mut input_urls = Vec::new();
        let mut input_caps = Vec::new();
        for (index, bytes) in sources.iter().enumerate() {
            let (url, cap) =
                bridge.register_input(InputTarget { source: bytes.clone(), reader: format!("remux:{}:{index}", spec.run_id) });
            input_urls.push(url);
            input_caps.push(cap);
        }
        let source_bytes: u64 = sources.iter().map(|s| s.size()).sum();
        let spool = spec.limits.clamp_spool(self.cfg.spool_bytes);
        let object_cap = spec.limits.clamp_object(self.cfg.object_bytes);
        let dir = self.cfg.data_dir.join("remux").join(&spec.run_id);
        let (run_sink, closed_rx) = sink::Sink::new(dir, spool, object_cap)?;
        *entry.sink.lock() = Some(run_sink.clone());
        let (output_base, output_cap) = bridge.register_output(run_sink.clone());

        let (subs_url, subs_cap) =
            bridge.register_input(InputTarget { source: sources[0].clone(), reader: format!("remux-subs:{}", spec.run_id) });
        if !source.subtitles.is_empty() {
            let extractor = subs::Extractor {
                ffmpeg_path: self.cfg.ffmpeg_path.clone(),
                client: self.client.clone(),
                api_base: spec.api_base.clone(),
                room_id: spec.room_id.clone(),
                run_id: spec.run_id.clone(),
                media_generation: spec.media_generation,
                claim: spec.claim.clone(),
                input_url: subs_url,
                dir: self.cfg.data_dir.join("remux").join(&spec.run_id).join("subs"),
                state: subs::room_state(&self.subtitle_rooms, &spec.room_id, spec.media_generation, &source),
            };
            let plan_for_subs = source.clone();
            let (run_id, start_ms, end_ms) = (spec.run_id.clone(), spec.start_ms, spec.end_ms);
            *entry.subtitles.lock() = Some(tokio::spawn(async move {
                if let Err(e) = extractor.run(&plan_for_subs, start_ms, end_ms).await {
                    tracing::warn!(run = %run_id, error = %e, "subtitle pass failed");
                }
            }));
        } else if !vtt_subtitles.is_empty()
            && !self.vtt_done.lock().contains(&format!("{}:{}", spec.room_id, spec.media_generation))
        {
            let done = self.vtt_done.clone();
            let key = format!("{}:{}", spec.room_id, spec.media_generation);
            let publisher = youtube::subs::Publisher {
                client: self.youtube.as_ref().map(|r| r.client.clone()).unwrap_or_else(|| self.client.clone()),
                api: self.client.clone(),
                api_base: spec.api_base.clone(),
                room_id: spec.room_id.clone(),
                run_id: spec.run_id.clone(),
                media_generation: spec.media_generation,
                claim: spec.claim.clone(),
            };
            let run_id = spec.run_id.clone();
            *entry.subtitles.lock() = Some(tokio::spawn(async move {
                match publisher.run(vtt_subtitles).await {
                    Ok(()) => {
                        done.lock().insert(key);
                    }
                    Err(e) => tracing::warn!(run = %run_id, error = %e, "youtube subtitles failed"),
                }
            }));
        }

        let (uploaded_tx, mut uploaded_rx) = tokio::sync::mpsc::unbounded_channel();
        let uploader = upload::Uploader {
            client: self.client.clone(),
            api_base: spec.api_base.clone(),
            room_id: spec.room_id.clone(),
            claim: spec.claim.clone(),
            job_puts: spec.limits.clamp_puts(self.cfg.put_concurrency),
            global_puts: self.global_puts.clone(),
            uploaded_tx,
        };
        let upload_sink = run_sink.clone();
        let mut upload_task = tokio::spawn(uploader.run(upload_sink, closed_rx));

        let mut publisher = publish::Publisher::new(
            self.client.clone(),
            spec.api_base.clone(),
            spec.room_id.clone(),
            spec.claim.clone(),
            spec.run_id.clone(),
            spec.media_generation,
            spec.region,
            offset_ms,
            source.duration_ms,
            source_bytes,
            source.audios.iter().map(|a| a.language.clone()).collect(),
            source.video_codecs.clone(),
            source.chapters.iter().map(|c| json!({ "startMs": c.start_ms, "endMs": c.end_ms, "title": c.title })).collect(),
        );

        let prefix = plan::region_prefix(spec.region);
        let end_seconds = (spec.end_ms > 0).then(|| spec.end_ms as f64 / 1000.0);
        let args = plan::ffmpeg_args(&input_urls, &output_base, &prefix, &source, start_seconds, end_seconds);

        let cleanup = |bridge: &Bridge| {
            for cap in &input_caps {
                bridge.revoke(cap, "");
            }
            bridge.revoke("", &output_cap);
            if let Some(handle) = entry.subtitles.lock().take() {
                handle.abort();
            }
            bridge.revoke(&subs_cap, "");
        };

        const STALL: Duration = Duration::from_secs(90);
        const UPLOAD_STALL: Duration = Duration::from_secs(600);
        let slab = object_cap.min(16 * 1024 * 1024);
        let mut attempts = 0u32;
        let exit = 'attempts: loop {
            attempts += 1;
            let supervised = process::spawn(&self.cfg.ffmpeg_path, &args)?;
            let stderr_tail = supervised.stderr_tail.clone();
            let progress = supervised.progress_ms.clone();
            *entry.process.lock() = Some(supervised);
            entry.status.lock().state = state::RUNNING;

            let mut ticker = tokio::time::interval(Duration::from_secs(2));
            let mut last_move = (0u64, std::time::Instant::now());
            let mut last_closed = run_sink.closed_count();
            let mut starved_since: Option<std::time::Instant> = None;
            loop {
                if Self::cancelled(entry) {
                    cleanup(&bridge);
                    run_sink.destroy().await;
                    return Ok(());
                }
                let process_done = {
                    let mut held = entry.process.lock();
                    match held.as_mut() {
                        None => break 'attempts None, // cancel took it
                        Some(p) => p.child_try_wait(),
                    }
                };
                if let Some(status) = process_done? {
                    break 'attempts Some((status, stderr_tail.clone()));
                }
                ticker.tick().await;
                publisher.absorb(&mut uploaded_rx);
                match publisher.round(&run_sink, true, false).await {
                    Ok(_) => {}
                    Err(e) if e.downcast_ref::<publish::Revoked>().is_some() => {
                        let mut process = entry.process.lock().take();
                        if let Some(process) = process.as_mut() {
                            process.kill().await;
                        }
                        cleanup(&bridge);
                        run_sink.destroy().await;
                        return Err(e);
                    }
                    Err(e) => tracing::warn!(error = %e, "publish round failed; retrying"),
                }
                entry.status.lock().produced_ms = publisher.produced_ms(&run_sink);

                let moved = progress.load(std::sync::atomic::Ordering::Relaxed);
                let closed = run_sink.closed_count();
                // A full spool means ffmpeg is waiting on the uploads, not the
                // other way round: that is the R2 link's stall, and it gets
                // far longer before the run is given up.
                let starved = run_sink.free_bytes() < slab;
                if moved != last_move.0 || closed != last_closed {
                    last_move = (moved, std::time::Instant::now());
                    last_closed = closed;
                    starved_since = None;
                } else if starved {
                    let since = *starved_since.get_or_insert_with(|| {
                        tracing::warn!(run = %spec.run_id, "remux output waiting on uploads");
                        std::time::Instant::now()
                    });
                    if since.elapsed() > UPLOAD_STALL {
                        let mut process = entry.process.lock().take();
                        if let Some(process) = process.as_mut() {
                            process.kill().await;
                        }
                        cleanup(&bridge);
                        run_sink.destroy().await;
                        bail!("uploads stalled for {}s with the spool full", since.elapsed().as_secs());
                    }
                } else if last_move.1.elapsed() > STALL {
                    let mut process = entry.process.lock().take();
                    if let Some(process) = process.as_mut() {
                        process.kill().await;
                    }
                    let tail: String = stderr_tail.lock().chars().take(600).collect();
                    if closed == 0 && attempts < 3 {
                        tracing::warn!(run = %spec.run_id, attempt = attempts, stderr = %tail, "ffmpeg made no progress; respawning");
                        continue 'attempts;
                    }
                    cleanup(&bridge);
                    run_sink.destroy().await;
                    bail!("ffmpeg stalled mid-run (attempt {attempts}): {tail}");
                }
            }
        };

        if let Some((status, stderr_tail)) = exit {
            if !status.success() && !Self::cancelled(entry) {
                let tail: String = stderr_tail.lock().clone();
                cleanup(&bridge);
                run_sink.destroy().await;
                bail!("ffmpeg exited {status}: {}", tail.chars().take(400).collect::<String>());
            }
        }
        entry.status.lock().state = state::DRAINING;
        run_sink.close_producer();
        match (&mut upload_task).await {
            Ok(Ok(())) => {}
            Ok(Err(e)) => {
                cleanup(&bridge);
                run_sink.destroy().await;
                return Err(e);
            }
            Err(e) => {
                cleanup(&bridge);
                run_sink.destroy().await;
                return Err(e.into());
            }
        }
        publisher.absorb(&mut uploaded_rx);
        for _ in 0..20 {
            if publisher.drained() {
                break;
            }
            publisher.round(&run_sink, false, false).await?;
            publisher.absorb(&mut uploaded_rx);
            if !publisher.drained() {
                tokio::time::sleep(Duration::from_millis(500)).await;
            }
        }
        let covers_all = spec.start_ms == 0 && spec.end_ms == 0;
        publisher.round(&run_sink, false, covers_all).await?;
        entry.status.lock().produced_ms = publisher.produced_ms(&run_sink);
        let subtitles = entry.subtitles.lock().take();
        if let Some(handle) = subtitles {
            if tokio::time::timeout(Duration::from_secs(900), handle).await.is_err() {
                tracing::warn!(run = %spec.run_id, "subtitle pass outlived the run; dropped");
            }
        }
        cleanup(&bridge);
        run_sink.destroy().await;
        Ok(())
    }
}

fn first_frame_pts(probe_json: &str) -> Option<f64> {
    let doc: serde_json::Value = serde_json::from_str(probe_json).ok()?;
    doc["frames"].as_array()?.first()?["pts_time"].as_str()?.parse().ok()
}

#[cfg(test)]
mod tests {
    #[test]
    fn first_frame_pts_reads_ffprobe_frames() {
        let json = r#"{"frames":[{"pts_time":"1077.577000"},{"pts_time":"1081.0"}]}"#;
        assert_eq!(super::first_frame_pts(json), Some(1077.577));
        assert_eq!(super::first_frame_pts("{}"), None);
    }
}
