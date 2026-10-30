//! The upload a browser guest triggers: one run fenced on the room, objects
//! fed to ss-remux's uploader (presign in batches by claim, PUT under a
//! ceiling) in the plan's order, and a publish round every couple of seconds
//! with the regions the bucket holds.
use std::collections::BTreeMap;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::Arc;
use std::time::Duration;

use anyhow::{bail, Context};
use serde_json::{json, Value};
use ss_remux::sink::{ClosedObject, Sink};
use ss_remux::upload::Uploader;
use tokio::sync::{Notify, Semaphore};

use crate::hls::{self, MasterInfo};
use crate::local::Producer;
use crate::upload_plan::{region_prefix, Planner, RegionReport};

/// Who the upload publishes as. No Debug: the claim never reaches a log.
#[derive(Clone)]
pub struct Target {
    pub api_base: String,
    pub room_id: String,
    pub claim: String,
    pub media_generation: u64,
    pub run_id: String,
}

pub struct Round<'a> {
    pub seq: u64,
    pub confirm: &'a [String],
    pub playlists: BTreeMap<String, String>,
    pub regions: &'a [RegionReport],
    pub duration_ms: u64,
    pub master: &'a MasterInfo,
}

/// One publish body: the variant playlists, a master per region, and the
/// region map. `master.m3u8` is the earliest region's, which also sets the
/// room's offset; the round is complete once region 0 holds the whole film.
pub fn round_body(target: &Target, round: Round) -> Value {
    let mut playlists = round.playlists;
    // The 480p variant sits after every audio, as ss-remux numbers it.
    let low_index = 1 + round.master.audio_langs.len();
    for region in round.regions {
        let prefix = region_prefix(region.n);
        let low = playlists.contains_key(&hls::playlist_name(&prefix, low_index)).then_some(low_index);
        playlists.insert(format!("r{}_master.m3u8", region.n), hls::master(&prefix, round.master, low));
    }
    let first = round.regions.iter().min_by_key(|r| r.n);
    if let Some(first) = first {
        let plain = playlists[&format!("r{}_master.m3u8", first.n)].clone();
        playlists.insert("master.m3u8".into(), plain);
    }
    let complete = round.regions.iter().any(|r| r.n == 0 && !r.growing);
    json!({
        "claim": target.claim,
        "mediaGeneration": target.media_generation,
        "runId": target.run_id,
        "seq": round.seq,
        "confirm": round.confirm,
        "playlists": playlists,
        "complete": complete,
        "timeline": {
            "durationMs": round.duration_ms,
            "offsetMs": first.map_or(0, |r| r.start_ms),
            "regions": round.regions.iter().map(|r| json!({
                "n": r.n, "startMs": r.start_ms, "producedMs": r.produced_ms, "growing": r.growing,
            })).collect::<Vec<_>>(),
        },
    })
}

/// Objects handed to the uploader at once: small, so a seek reorders the
/// queue within a few PUTs.
const WINDOW: usize = 6;
const ROUND_EVERY: Duration = Duration::from_secs(2);
const REVOKED: &[&str] = &["claim_mismatch", "stale_generation", "stale_run", "room_not_found"];

/// One room's upload from the cache. Stops on `stop`, on a revoked claim,
/// or when the uploader gives up.
pub struct Upload {
    playhead: AtomicU64,
    stopped: AtomicBool,
    wake: Notify,
    error: parking_lot::Mutex<Option<String>>,
    sent: AtomicU64,
}

impl Upload {
    pub fn start(producer: Arc<Producer>, key: String, target: Target, playhead_ms: u64) -> Arc<Self> {
        let upload = Arc::new(Self {
            playhead: AtomicU64::new(playhead_ms),
            stopped: AtomicBool::new(false),
            wake: Notify::new(),
            error: parking_lot::Mutex::new(None),
            sent: AtomicU64::new(0),
        });
        let running = upload.clone();
        tokio::spawn(async move {
            if let Err(e) = running.run(&producer, &key, &target).await {
                tracing::warn!(room = %target.room_id, error = %e, "upload stopped");
                *running.error.lock() = Some(e.to_string().chars().take(300).collect());
            }
            running.stopped.store(true, Ordering::SeqCst);
        });
        upload
    }

    /// The room's position moved: what is around it goes to the front.
    pub fn seek(&self, position_ms: u64) {
        self.playhead.store(position_ms, Ordering::Relaxed);
        self.wake.notify_one();
    }

    pub fn stop(&self) {
        self.stopped.store(true, Ordering::SeqCst);
        self.wake.notify_one();
    }

    pub fn stopped(&self) -> bool {
        self.stopped.load(Ordering::SeqCst)
    }

    pub fn error(&self) -> Option<String> {
        self.error.lock().clone()
    }

    pub fn sent(&self) -> u64 {
        self.sent.load(Ordering::Relaxed)
    }

    async fn run(&self, producer: &Producer, key: &str, target: &Target) -> anyhow::Result<()> {
        let client = reqwest::Client::builder().timeout(Duration::from_secs(120)).build()?;
        let fence = client
            .post(format!("{}/api/rooms/{}/client-media/run", target.api_base, target.room_id))
            .json(&json!({ "claim": target.claim, "runId": target.run_id }))
            .send()
            .await
            .context("run fence")?;
        if !fence.status().is_success() {
            bail!("run fence refused: {}", fence.status());
        }

        let spool = producer.root().join(".spool").join(&target.run_id);
        // The sink only carries the cancel: the objects come from the cache,
        // fed in the plan's order instead of FFmpeg's.
        let (sink, _unused) = Sink::new(spool.clone(), 64 << 20, 16 << 20)?;
        let (feed_tx, feed_rx) = tokio::sync::mpsc::unbounded_channel::<ClosedObject>();
        let (uploaded_tx, mut uploaded_rx) = tokio::sync::mpsc::unbounded_channel();
        let uploader = Uploader {
            client: client.clone(),
            api_base: target.api_base.clone(),
            room_id: target.room_id.clone(),
            claim: target.claim.clone(),
            job_puts: 4,
            global_puts: Arc::new(Semaphore::new(4)),
            uploaded_tx,
        };
        let mut uploading = tokio::spawn(uploader.run(sink.clone(), feed_rx));

        let meta = producer.meta(key).context("unknown source")?;
        let mut planner = Planner::new();
        let mut inflight = 0usize;
        let mut confirm: Vec<String> = Vec::new();
        let mut seq = 0u64;
        let mut bytes = 0u64;
        let mut last_round = tokio::time::Instant::now() - ROUND_EVERY;
        let result = loop {
            if self.stopped() {
                break Ok(());
            }
            while let Ok(object) = uploaded_rx.try_recv() {
                planner.done(&object.name);
                inflight = inflight.saturating_sub(1);
                bytes += object.size;
                self.sent.fetch_add(1, Ordering::Relaxed);
                confirm.push(object.name);
            }
            let local = producer.local_regions(key);
            if inflight < WINDOW {
                let dir = producer.hls_dir(key);
                for item in planner.next(&local, self.playhead.load(Ordering::Relaxed), WINDOW - inflight) {
                    let path = dir.join(&item.local);
                    let size = std::fs::metadata(&path).map(|m| m.len()).unwrap_or(0);
                    if size == 0 {
                        planner.failed(&item.remote);
                        continue;
                    }
                    inflight += 1;
                    let _ = feed_tx.send(ClosedObject { name: item.remote, path, size, digest: [0; 32] });
                }
            }
            if last_round.elapsed() >= ROUND_EVERY && (!confirm.is_empty() || seq == 0) {
                last_round = tokio::time::Instant::now();
                let regions = planner.regions(&local);
                let produced: u64 = regions.iter().map(|r| r.produced_ms).sum();
                let master = MasterInfo {
                    audio_langs: meta.audio_langs.clone(),
                    video_codecs: meta.video_codecs.clone(),
                    bandwidth: if produced > 0 { bytes * 8 * 1000 / produced } else { 0 },
                    low_resolution: meta.low_resolution,
                };
                seq += 1;
                let body = round_body(
                    target,
                    Round { seq, confirm: &confirm, playlists: planner.playlists(&local), regions: &regions, duration_ms: meta.duration_ms, master: &master },
                );
                match publish(&client, target, &body).await {
                    Ok(()) => confirm.clear(),
                    Err(e) if REVOKED.iter().any(|code| e.to_string().contains(code)) => break Err(e),
                    Err(e) => tracing::warn!(error = %e, "publish round failed; retrying"),
                }
            }
            tokio::select! {
                result = &mut uploading => {
                    break match result {
                        Ok(Ok(())) => Ok(()),
                        Ok(Err(e)) => Err(e),
                        Err(e) => Err(e.into()),
                    };
                }
                _ = self.wake.notified() => {}
                _ = tokio::time::sleep(Duration::from_millis(500)) => {}
            }
        };
        sink.cancel();
        uploading.abort();
        let _ = std::fs::remove_dir_all(spool);
        result
    }
}

async fn publish(client: &reqwest::Client, target: &Target, body: &Value) -> anyhow::Result<()> {
    let response = client
        .post(format!("{}/api/rooms/{}/client-media/publish", target.api_base, target.room_id))
        .json(body)
        .send()
        .await
        .context("publish send")?;
    let status = response.status();
    if status.is_success() {
        return Ok(());
    }
    let text = response.text().await.unwrap_or_default();
    bail!("publish {status}: {}", text.chars().take(200).collect::<String>())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn target() -> Target {
        Target { api_base: "http://a".into(), room_id: "r".into(), claim: "c".into(), media_generation: 3, run_id: "run_1".into() }
    }

    fn info() -> MasterInfo {
        MasterInfo { audio_langs: vec!["eng".into()], video_codecs: None, bandwidth: 0, low_resolution: None }
    }

    #[test]
    fn a_region_mid_film_gets_its_master_and_sets_the_offset() {
        let regions = [RegionReport { n: 1, start_ms: 40_000, produced_ms: 12_000, growing: true }];
        let mut playlists = BTreeMap::new();
        playlists.insert("r1_client_stream_0.m3u8".to_string(), "#EXTM3U\n".to_string());
        let master = info();
        let body = round_body(&target(), Round { seq: 2, confirm: &["r1_cs_0_0.m4s".into()], playlists, regions: &regions, duration_ms: 600_000, master: &master });
        assert_eq!(body["claim"], "c");
        assert_eq!(body["mediaGeneration"], 3);
        assert_eq!(body["runId"], "run_1");
        assert_eq!(body["seq"], 2);
        assert_eq!(body["confirm"][0], "r1_cs_0_0.m4s");
        assert!(body["playlists"]["r1_master.m3u8"].as_str().unwrap().contains("r1_client_stream_0.m3u8"));
        assert_eq!(body["playlists"]["master.m3u8"], body["playlists"]["r1_master.m3u8"]);
        assert_eq!(body["timeline"]["offsetMs"], 40_000);
        assert_eq!(body["timeline"]["durationMs"], 600_000);
        assert_eq!(body["timeline"]["regions"][0], json!({ "n": 1, "startMs": 40_000, "producedMs": 12_000, "growing": true }));
        assert_eq!(body["complete"], false);
    }

    #[test]
    fn region_zero_names_the_plain_master_and_completes_when_sealed() {
        let regions = [
            RegionReport { n: 0, start_ms: 0, produced_ms: 600_000, growing: false },
            RegionReport { n: 1, start_ms: 40_000, produced_ms: 12_000, growing: true },
        ];
        let master = info();
        let body = round_body(&target(), Round { seq: 9, confirm: &[], playlists: BTreeMap::new(), regions: &regions, duration_ms: 600_000, master: &master });
        assert_eq!(body["playlists"]["master.m3u8"], body["playlists"]["r0_master.m3u8"]);
        assert!(body["playlists"]["master.m3u8"].as_str().unwrap().ends_with("\nclient_stream_0.m3u8\n"));
        assert_eq!(body["timeline"]["offsetMs"], 0);
        assert_eq!(body["complete"], true);
    }

    #[test]
    fn the_480p_variant_is_listed_only_where_its_playlist_goes_up() {
        let regions = [
            RegionReport { n: 0, start_ms: 0, produced_ms: 60_000, growing: false },
            RegionReport { n: 1, start_ms: 40_000, produced_ms: 12_000, growing: true },
        ];
        let mut playlists = BTreeMap::new();
        playlists.insert("r1_client_stream_2.m3u8".to_string(), "#EXTM3U\n".to_string());
        let master = MasterInfo { low_resolution: Some((854, 480)), ..info() };
        let body = round_body(&target(), Round { seq: 3, confirm: &[], playlists, regions: &regions, duration_ms: 600_000, master: &master });
        assert!(body["playlists"]["r1_master.m3u8"].as_str().unwrap().ends_with("RESOLUTION=854x480,CODECS=\"avc1.4d401f,mp4a.40.2\",AUDIO=\"aud\"\nr1_client_stream_2.m3u8\n"));
        assert!(!body["playlists"]["r0_master.m3u8"].as_str().unwrap().contains("854x480"));
    }

    #[test]
    fn nothing_started_publishes_no_master() {
        let master = info();
        let body = round_body(&target(), Round { seq: 1, confirm: &[], playlists: BTreeMap::new(), regions: &[], duration_ms: 0, master: &master });
        assert_eq!(body["playlists"], json!({}));
        assert_eq!(body["timeline"]["regions"], json!([]));
    }
}
