//! The upload a browser guest triggers: one run fenced on the room, objects
//! fed to ss-remux's uploader (presign in batches by claim, PUT under a
//! ceiling) in the plan's order, and a publish round every couple of seconds
//! with the regions the bucket holds.
use std::collections::{BTreeMap, HashMap, HashSet};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::Arc;
use std::time::Duration;

use anyhow::{bail, Context};
use serde_json::{json, Value};
use ss_remux::sink::ClosedObject;
use ss_remux::upload::{presign, put_with_retry, PresignedObject};
use tokio::sync::Notify;
use tokio::task::JoinSet;

use crate::hls::{self, MasterInfo};
use crate::local::{Producer, END_SLACK_MS};
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
/// A region a seek stopped is sealed too (FFmpeg ends its playlist on the way
/// out), so sealed alone does not make it whole: it has to reach the end.
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
    let complete = round
        .regions
        .iter()
        .any(|r| r.n == 0 && !r.growing && r.start_ms + r.produced_ms + END_SLACK_MS >= round.duration_ms);
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

/// PUTs at once. The uploader gets an object only when one of them frees,
/// picked then for the room's position: a seek reorders what goes next
/// without dropping what is already on the way.
const PUTS: usize = 4;
/// Objects signed in one request, the ones about to go and those after them.
const SIGN_AHEAD: usize = 16;
/// The server signs for 15 minutes; a URL is used well inside that.
const SIGNED_FOR: Duration = Duration::from_secs(10 * 60);
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
        tauri::async_runtime::spawn(async move {
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

        let meta = producer.meta(key).context("unknown source")?;
        let dir = producer.hls_dir(key);
        let mut planner = Planner::new();
        let mut signed: HashMap<String, (PresignedObject, tokio::time::Instant)> = HashMap::new();
        let mut puts: JoinSet<anyhow::Result<ClosedObject>> = JoinSet::new();
        let mut confirm: Vec<String> = Vec::new();
        let mut seq = 0u64;
        let mut bytes = 0u64;
        let mut last_round = tokio::time::Instant::now() - ROUND_EVERY;
        // Regions the server has heard of: a new one (a seek's) is published
        // as soon as its first object is up, not at the next round.
        let mut announced = HashSet::new();
        loop {
            if self.stopped() {
                return Ok(());
            }
            while let Some(done) = puts.try_join_next() {
                let object = done.context("upload task")??;
                planner.done(&object.name);
                bytes += object.size;
                self.sent.fetch_add(1, Ordering::Relaxed);
                confirm.push(object.name);
            }
            let local = producer.local_regions(key);
            let playhead = self.playhead.load(Ordering::Relaxed);
            if puts.len() < PUTS {
                signed.retain(|_, (_, at)| at.elapsed() < SIGNED_FOR);
                // Chosen now, for where the room is now; signed ahead, so a
                // free slot never waits on the server.
                let items: Vec<ClosedObject> = planner
                    .next(&local, playhead, PUTS - puts.len())
                    .into_iter()
                    .filter_map(|item| {
                        let path = dir.join(&item.local);
                        match std::fs::metadata(&path).map(|m| m.len()) {
                            Ok(size) if size > 0 => Some(ClosedObject { name: item.remote, path, size, digest: [0; 32] }),
                            _ => {
                                planner.failed(&item.remote);
                                None
                            }
                        }
                    })
                    .collect();
                if items.iter().any(|object| !signed.contains_key(&object.name)) {
                    let mut batch: Vec<ClosedObject> = items.iter().filter(|o| !signed.contains_key(&o.name)).cloned().collect();
                    for item in planner.upcoming(&local, playhead, SIGN_AHEAD) {
                        let path = dir.join(&item.local);
                        if signed.contains_key(&item.remote) || batch.iter().any(|o| o.name == item.remote) {
                            continue;
                        }
                        if let Ok(size) = std::fs::metadata(&path).map(|m| m.len()) {
                            if size > 0 {
                                batch.push(ClosedObject { name: item.remote, path, size, digest: [0; 32] });
                            }
                        }
                    }
                    match presign(&client, &target.api_base, &target.room_id, &target.claim, &batch).await {
                        Ok(objects) => {
                            let now = tokio::time::Instant::now();
                            signed.extend(objects.into_iter().map(|o| (o.name.clone(), (o, now))));
                        }
                        Err(e) if REVOKED.iter().any(|code| e.to_string().contains(code)) => return Err(e),
                        Err(e) => tracing::warn!(error = %e, "presign failed; retrying"),
                    }
                }
                for object in items {
                    let Some((sign, _)) = signed.remove(&object.name) else {
                        planner.failed(&object.name);
                        continue;
                    };
                    let client = client.clone();
                    puts.spawn(async move {
                        put_with_retry(&client, &sign.url, &sign.headers, &object).await?;
                        Ok(object)
                    });
                }
            }
            let regions = planner.regions(&local);
            let fresh = regions.iter().any(|r| r.produced_ms > 0 && !announced.contains(&r.n));
            if (last_round.elapsed() >= ROUND_EVERY || fresh) && (!confirm.is_empty() || seq == 0) {
                last_round = tokio::time::Instant::now();
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
                    Ok(()) => {
                        confirm.clear();
                        for region in regions.iter().filter(|r| r.produced_ms > 0 && announced.insert(r.n)) {
                            tracing::info!(n = region.n, start_ms = region.start_ms, "remote region published");
                        }
                    }
                    Err(e) if REVOKED.iter().any(|code| e.to_string().contains(code)) => return Err(e),
                    Err(e) => tracing::warn!(error = %e, "publish round failed; retrying"),
                }
            }
            tokio::select! {
                // A finished PUT frees a slot for the next object right away.
                Some(done) = puts.join_next(), if !puts.is_empty() => {
                    let object = done.context("upload task")??;
                    planner.done(&object.name);
                    bytes += object.size;
                    self.sent.fetch_add(1, Ordering::Relaxed);
                    confirm.push(object.name);
                }
                _ = self.wake.notified() => {}
                _ = tokio::time::sleep(Duration::from_millis(500)) => {}
            }
        }
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
    fn a_region_zero_a_seek_stopped_is_not_the_whole_film() {
        let regions = [
            RegionReport { n: 0, start_ms: 0, produced_ms: 240_000, growing: false },
            RegionReport { n: 1, start_ms: 400_000, produced_ms: 6_000, growing: true },
        ];
        let master = info();
        let body = round_body(&target(), Round { seq: 4, confirm: &[], playlists: BTreeMap::new(), regions: &regions, duration_ms: 600_000, master: &master });
        assert_eq!(body["complete"], false);
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
