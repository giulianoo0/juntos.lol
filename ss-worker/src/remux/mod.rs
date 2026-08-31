pub mod bridge;
pub mod plan;
pub mod process;
pub mod protocol;
pub mod publish;
pub mod sink;
pub mod upload;

use std::collections::HashMap;
use std::sync::Arc;
use std::time::Duration;

use anyhow::{bail, Context};
use parking_lot::Mutex;
use serde_json::json;
use tokio::sync::Semaphore;

use crate::config::WorkerConfig;
use crate::engine::Engine;
use bridge::{Bridge, InputTarget};
use protocol::{state, Spec};

/// The remote-remux supervisor: accepts signed runs, drives FFmpeg over the
/// loopback bridge, uploads and publishes through the API, and reports every
/// run's state in the heartbeat.
pub struct Remux {
    cfg: WorkerConfig,
    engine: Arc<Engine>,
    client: reqwest::Client,
    pub ffmpeg_version: Option<String>,
    bridge: tokio::sync::OnceCell<Arc<Bridge>>,
    slots: Arc<Semaphore>,
    global_puts: Arc<Semaphore>,
    runs: Mutex<HashMap<String, Arc<RunEntry>>>,
}

struct RunEntry {
    room: String,
    status: Mutex<RunStatus>,
    sink: Mutex<Option<Arc<sink::Sink>>>,
    process: Mutex<Option<process::Supervised>>,
}

#[derive(Clone)]
struct RunStatus {
    state: &'static str,
    produced_ms: u64,
    error: Option<String>,
}

impl Remux {
    pub async fn new(cfg: WorkerConfig, engine: Arc<Engine>) -> Arc<Self> {
        let ffmpeg_version = if cfg.remux_slots > 0 {
            process::detect_version(&cfg.ffmpeg_path).await
        } else {
            None
        };
        if cfg.remux_slots > 0 && ffmpeg_version.is_none() {
            tracing::warn!(path = %cfg.ffmpeg_path, "ffmpeg not found; remux capability void");
        }
        let slots = cfg.remux_slots.max(1);
        let puts = cfg.remux_put_global.max(1);
        Arc::new(Self {
            slots: Arc::new(Semaphore::new(slots)),
            global_puts: Arc::new(Semaphore::new(puts)),
            client: reqwest::Client::builder()
                .timeout(Duration::from_secs(120))
                .build()
                .expect("reqwest client"),
            bridge: tokio::sync::OnceCell::new(),
            runs: Mutex::new(HashMap::new()),
            ffmpeg_version,
            cfg,
            engine,
        })
    }

    pub fn enabled(&self) -> bool {
        self.cfg.remux_slots > 0 && self.ffmpeg_version.is_some()
    }

    /// The heartbeat block: capability plus every run the server may still
    /// care about. Terminal runs stay listed until the map is pruned, so a
    /// reconnecting server sees how they ended.
    pub fn heartbeat(&self) -> Option<serde_json::Value> {
        if !self.enabled() {
            return None;
        }
        let runs: Vec<serde_json::Value> = self
            .runs
            .lock()
            .iter()
            .map(|(run_id, entry)| {
                let status = entry.status.lock().clone();
                json!({
                    "runId": run_id,
                    "state": status.state,
                    "producedMs": status.produced_ms,
                    "error": status.error,
                })
            })
            .collect();
        Some(json!({
            "protocolVersion": protocol::PROTOCOL_VERSION,
            "slots": self.cfg.remux_slots,
            "activeRuns": self.active_runs(),
            "ffmpeg": self.ffmpeg_version,
            "audioCodecs": ["aac", "ac3", "dts"],
            "runs": runs,
        }))
    }

    fn active_runs(&self) -> usize {
        self.runs
            .lock()
            .values()
            .filter(|entry| {
                let held = entry.status.lock();
                !matches!(held.state, state::COMPLETED | state::CANCELLED | state::FAILED)
            })
            .count()
    }

    pub async fn start(self: &Arc<Self>, infohash: &str, file_index: usize, spec: Spec) -> anyhow::Result<()> {
        if !self.enabled() {
            bail!("remux_disabled");
        }
        if spec.protocol_version != protocol::PROTOCOL_VERSION {
            bail!("protocol_mismatch");
        }
        {
            let runs = self.runs.lock();
            if runs.contains_key(&spec.run_id) {
                // Same run dispatched twice (a retry): one execution stands.
                return Ok(());
            }
        }
        // A follow supersedes the same room's active run: the fence already
        // moved on the server, so the old run only wastes the slot. Rooms
        // never queue behind their own past.
        let stale: Vec<String> = self
            .runs
            .lock()
            .iter()
            .filter(|(run_id, entry)| {
                **run_id != spec.run_id
                    && entry.room == spec.room_id
                    && !matches!(
                        entry.status.lock().state,
                        state::COMPLETED | state::CANCELLED | state::FAILED
                    )
            })
            .map(|(run_id, _)| run_id.clone())
            .collect();
        for run_id in stale {
            tracing::info!(run = %run_id, room = %spec.room_id, "remux run superseded by its room's new start");
            self.cancel(&run_id).await;
        }
        if self.active_runs() >= self.cfg.remux_slots {
            bail!("remux_busy");
        }
        let size = self.engine.file_size(infohash, file_index).context("unknown file")?;
        let entry = Arc::new(RunEntry {
            room: spec.room_id.clone(),
            status: Mutex::new(RunStatus { state: state::ACCEPTED, produced_ms: 0, error: None }),
            sink: Mutex::new(None),
            process: Mutex::new(None),
        });
        self.runs.lock().insert(spec.run_id.clone(), entry.clone());
        let this = self.clone();
        let infohash = infohash.to_string();
        let run_id = spec.run_id.clone();
        tokio::spawn(async move {
            let outcome = this.execute(&infohash, file_index, size, &spec, &entry).await;
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
            // Terminal runs linger for a few heartbeats, then go away.
            let this = this.clone();
            tokio::spawn(async move {
                tokio::time::sleep(Duration::from_secs(120)).await;
                this.runs.lock().remove(&run_id);
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
        true
    }

    fn cancelled(entry: &RunEntry) -> bool {
        entry.status.lock().state == state::CANCELLED
    }

    async fn execute(
        self: &Arc<Self>,
        infohash: &str,
        file_index: usize,
        size: u64,
        spec: &Spec,
        entry: &Arc<RunEntry>,
    ) -> anyhow::Result<()> {
        let _slot = self.slots.clone().acquire_owned().await?;
        let bridge = self
            .bridge
            .get_or_try_init(|| Bridge::start())
            .await
            .context("bridge start")?
            .clone();

        // Probe reader and playhead reader carry distinct names so the
        // engine's windows never mistake one for the other.
        let (probe_url, probe_cap) = bridge.register_input(InputTarget {
            engine: self.engine.clone(),
            infohash: infohash.into(),
            file_index,
            reader: format!("remux-probe:{}", spec.run_id),
            size,
        });
        let probe_args: Vec<String> = [
            "-v", "error", "-print_format", "json", "-show_format", "-show_streams", &probe_url,
        ]
        .iter()
        .map(|s| s.to_string())
        .collect();
        let probed = process::run_capture(&self.cfg.ffprobe_path, &probe_args, Duration::from_secs(120)).await;
        let source = match probed {
            Ok(output) => plan::plan_streams(&output)?,
            Err(e) => {
                bridge.revoke(&probe_cap, "");
                return Err(e);
            }
        };
        if Self::cancelled(entry) {
            bridge.revoke(&probe_cap, "");
            return Ok(());
        }

        // With copied video a seek starts at the keyframe at or before the
        // target; the region start the room learns is that keyframe's real
        // time, never the requested time by convenience.
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

        let (input_url, input_cap) = bridge.register_input(InputTarget {
            engine: self.engine.clone(),
            infohash: infohash.into(),
            file_index,
            reader: format!("remux:{}", spec.run_id),
            size,
        });
        let spool = spec.limits.clamp_spool(self.cfg.remux_spool_bytes);
        let object_cap = spec.limits.clamp_object(self.cfg.remux_object_bytes);
        let dir = self.cfg.data_dir.join("remux").join(&spec.run_id);
        let (run_sink, closed_rx) = sink::Sink::new(dir, spool, object_cap)?;
        *entry.sink.lock() = Some(run_sink.clone());
        let (output_base, output_cap) = bridge.register_output(run_sink.clone());

        let (uploaded_tx, mut uploaded_rx) = tokio::sync::mpsc::unbounded_channel();
        let uploader = upload::Uploader {
            client: self.client.clone(),
            api_base: spec.api_base.clone(),
            room_id: spec.room_id.clone(),
            claim: spec.claim.clone(),
            job_puts: spec.limits.clamp_puts(self.cfg.remux_put_concurrency),
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
            size,
            source.audios.iter().map(|a| a.language.clone()).collect(),
        );

        let prefix = plan::region_prefix(spec.region);
        let end_seconds = (spec.end_ms > 0).then(|| spec.end_ms as f64 / 1000.0);
        let args = plan::ffmpeg_args(&input_url, &output_base, &prefix, &source, start_seconds, end_seconds);

        let cleanup = |bridge: &Bridge| {
            bridge.revoke(&input_cap, &output_cap);
        };

        // A run that stops moving is killed, not waited on: a reader wedged
        // over a cold swarm has parked FFmpeg forever before. While nothing
        // has been produced yet the run simply respawns over the same
        // capabilities; past first output it fails loudly instead, because a
        // rerun would collide with objects already closed under their names.
        const STALL: Duration = Duration::from_secs(90);
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
                if moved != last_move.0 || closed != last_closed {
                    last_move = (moved, std::time::Instant::now());
                    last_closed = closed;
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
        // Complete only when this run alone covered the room's timeline;
        // a seek region ends with a final sealed publish and the backend
        // decides what the claim does next.
        let covers_all = spec.start_ms == 0 && spec.end_ms == 0;
        publisher.round(&run_sink, false, covers_all).await?;
        entry.status.lock().produced_ms = publisher.produced_ms(&run_sink);
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
