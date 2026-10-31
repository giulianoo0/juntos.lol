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
use tokio::task::{AbortHandle, JoinError, JoinSet};
use tokio::time::Instant;

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
/// picked then for the room's position. A seek drops the PUTs it left
/// behind, so what the room now needs has the whole uplink.
const PUTS: usize = 4;
/// Objects signed in one request, the ones about to go and those after them.
const SIGN_AHEAD: usize = 16;
/// The server signs for 15 minutes; a URL is used well inside that.
const SIGNED_FOR: Duration = Duration::from_secs(10 * 60);
const ROUND_EVERY: Duration = Duration::from_secs(2);
/// What the room's gate waits to have buffered past the position
/// (GateReadyBufferMs) and no more: a wider margin can cross into the next
/// segment, and that one is seconds of uplink.
const READY_AHEAD_MS: u64 = 3_100;
/// How far past what a region holds the playhead may sit and still be
/// that region's to fill: the next couple of segments.
const REACH_MS: u64 = 10_000;
/// Objects a held region lets pile up before the rounds go on without it.
const HELD_CONFIRMS: usize = 32;
/// What playback and the room's drift corrections move the playhead by,
/// past the time between two looks, short of a seek.
const JUMP_SLACK_MS: u64 = 5_000;
/// The longest the room goes between follows while it plays (a couple of
/// heartbeats).
const FOLLOW_GAP: Duration = Duration::from_secs(10);
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
        let given = self.playhead.load(Ordering::Relaxed);
        let fence = client
            .post(format!("{}/api/rooms/{}/client-media/run", target.api_base, target.room_id))
            .json(&json!({ "claim": target.claim, "runId": target.run_id }))
            .send()
            .await
            .context("run fence")?;
        if !fence.status().is_success() {
            bail!("run fence refused: {}", fence.status());
        }
        // The page knows the position of the room's last change, not where
        // it played on to since; a seek in the meantime is newer still.
        if let Some(position) = fenced_position(&fence.text().await.unwrap_or_default()) {
            let _ = self.playhead.compare_exchange(given, position, Ordering::Relaxed, Ordering::Relaxed);
        }

        let meta = producer.meta(key).context("unknown source")?;
        let dir = producer.hls_dir(key);
        let mut planner = Planner::new();
        let mut signed: HashMap<String, (PresignedObject, Instant)> = HashMap::new();
        let mut puts: JoinSet<anyhow::Result<ClosedObject>> = JoinSet::new();
        // What each PUT on the way carries, to drop it and keep its URL.
        let mut flying: HashMap<String, (AbortHandle, PresignedObject, Instant)> = HashMap::new();
        let mut finished: Option<Result<anyhow::Result<ClosedObject>, JoinError>> = None;
        let mut followed = (self.playhead.load(Ordering::Relaxed), Instant::now());
        let mut confirm: Vec<String> = Vec::new();
        let mut seq = 0u64;
        let mut bytes = 0u64;
        let mut last_round = Instant::now() - ROUND_EVERY;
        // Regions the server has heard of: a new one (a seek's) is published
        // as soon as it can be played, not at the next round.
        let mut announced = HashSet::new();
        loop {
            if self.stopped() {
                return Ok(());
            }
            while let Some(done) = finished.take().or_else(|| puts.try_join_next()) {
                let Some(object) = landed(done)? else { continue };
                flying.remove(&object.name);
                planner.done(&object.name);
                bytes += object.size;
                self.sent.fetch_add(1, Ordering::Relaxed);
                confirm.push(object.name);
            }
            let local = producer.local_regions(key);
            let playhead = self.playhead.load(Ordering::Relaxed);
            if playhead != followed.0 {
                let seek = jumped(followed.0, playhead, followed.1.elapsed());
                followed = (playhead, Instant::now());
                if seek {
                    for name in planner.displaced(&local, playhead, PUTS) {
                        if let Some((put, sign, at)) = flying.remove(&name) {
                            put.abort();
                            signed.insert(name, (sign, at));
                        }
                    }
                }
            }
            // A dropped PUT leaves the set only once reaped; its slot is free now.
            if flying.len() < PUTS {
                signed.retain(|_, (_, at)| at.elapsed() < SIGNED_FOR);
                // Chosen now, for where the room is now; signed ahead, so a
                // free slot never waits on the server.
                let items: Vec<ClosedObject> = planner
                    .next(&local, playhead, PUTS - flying.len())
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
                            let now = Instant::now();
                            signed.extend(objects.into_iter().map(|o| (o.name.clone(), (o, now))));
                        }
                        Err(e) if REVOKED.iter().any(|code| e.to_string().contains(code)) => return Err(e),
                        Err(e) => tracing::warn!(error = %e, "presign failed; retrying"),
                    }
                }
                for object in items {
                    let Some((sign, at)) = signed.remove(&object.name) else {
                        planner.failed(&object.name);
                        continue;
                    };
                    let client = client.clone();
                    let name = object.name.clone();
                    let url = sign.url.clone();
                    let headers = sign.headers.clone();
                    let put = puts.spawn(async move {
                        put_with_retry(&client, &url, &headers, &object).await?;
                        Ok(object)
                    });
                    flying.insert(name, (put, sign, at));
                }
            }
            let mut regions = planner.regions(&local);
            let hold = held(&regions, &announced, playhead);
            regions.retain(|r| Some(r.n) != hold);
            let fresh = regions.iter().any(|r| r.produced_ms > 0 && !announced.contains(&r.n));
            // While the playhead's region fills, a round would only hold up the one announcing it.
            let due = last_round.elapsed() >= ROUND_EVERY && (hold.is_none() || confirm.len() >= HELD_CONFIRMS);
            if (due || fresh) && (!confirm.is_empty() || seq == 0) {
                last_round = Instant::now();
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
                Some(done) = puts.join_next(), if !puts.is_empty() => finished = Some(done),
                _ = self.wake.notified() => {}
                _ = tokio::time::sleep(Duration::from_millis(500)) => {}
            }
        }
    }
}

/// The region the rounds keep from the room for now: the newest one at the
/// playhead, not announced yet, until it holds what the gate waits for. Seen
/// with one segment, the rest would reach the guest only at its next
/// playlist reload.
pub fn held(regions: &[RegionReport], announced: &HashSet<u64>, playhead_ms: u64) -> Option<u64> {
    let region = regions
        .iter()
        .filter(|r| r.start_ms <= playhead_ms && playhead_ms <= r.start_ms + r.produced_ms + REACH_MS)
        .max_by_key(|r| r.start_ms)?;
    let ready = !region.growing || region.start_ms + region.produced_ms >= playhead_ms + READY_AHEAD_MS;
    (!ready && !announced.contains(&region.n)).then_some(region.n)
}

/// Whether the room's position jumped (a seek) between two looks `since`
/// apart, rather than moving with playback: the room follows every few
/// seconds while it plays, and a PUT dropped for that is uplink thrown away.
/// A longer gap means a pause, which moves nothing.
fn jumped(from_ms: u64, to_ms: u64, since: Duration) -> bool {
    let played = since.min(FOLLOW_GAP).as_millis() as u64;
    to_ms + JUMP_SLACK_MS < from_ms || to_ms > from_ms + played + JUMP_SLACK_MS
}

/// Where the run fence says the room is; an older server answers nothing.
fn fenced_position(body: &str) -> Option<u64> {
    serde_json::from_str::<Value>(body).ok()?.get("positionMs")?.as_u64()
}

/// The object a finished PUT sent; none for one a seek dropped.
fn landed(done: Result<anyhow::Result<ClosedObject>, JoinError>) -> anyhow::Result<Option<ClosedObject>> {
    match done {
        Err(e) if e.is_cancelled() => Ok(None),
        done => Ok(Some(done.context("upload task")??)),
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

    fn report(n: u64, start_ms: u64, produced_ms: u64, growing: bool) -> RegionReport {
        RegionReport { n, start_ms, produced_ms, growing }
    }

    #[test]
    fn a_seek_region_is_held_until_it_covers_what_the_gate_waits_for() {
        let announced = HashSet::from([0]);
        let one = [report(0, 0, 320_000, true), report(1, 598_083, 4_000, true)];
        assert_eq!(held(&one, &announced, 600_000), Some(1));
        let two = [report(0, 0, 320_000, true), report(1, 598_083, 8_000, true)];
        assert_eq!(held(&two, &announced, 600_000), None);
    }

    #[test]
    fn a_seek_region_goes_out_with_the_gate_covered_without_waiting_on_the_next_segment() {
        // Sintel at 820 s: the keyframe sits at 812.8 s and its 10.4 s
        // segment already holds the gate's 3 s; the next one is 2.4 MB.
        let regions = [report(0, 0, 320_000, true), report(2, 812_792, 10_416, true)];
        assert_eq!(held(&regions, &HashSet::from([0]), 820_000), None);
    }

    #[test]
    fn an_announced_region_or_one_at_its_end_is_never_held() {
        let regions = [report(0, 0, 320_000, true), report(1, 598_083, 4_000, true)];
        assert_eq!(held(&regions, &HashSet::from([0, 1]), 600_000), None);
        let ended = [report(0, 0, 320_000, true), report(1, 884_000, 4_000, false)];
        assert_eq!(held(&ended, &HashSet::from([0]), 886_000), None);
    }

    #[test]
    fn playback_moving_the_playhead_is_not_a_seek() {
        let look = Duration::from_secs(3);
        for (from, to, since, seek) in [
            (60_000, 63_000, look, false),
            (60_000, 59_400, look, false),
            (100_000, 150_000, Duration::from_secs(60), true),
            (45_000, 56_000, look, true),
            (60_000, 600_000, look, true),
            (600_000, 150_000, look, true),
        ] {
            assert_eq!(jumped(from, to, since), seek, "{from} -> {to} in {since:?}");
        }
    }

    #[test]
    fn a_region_far_from_the_playhead_is_not_held() {
        let regions = [report(0, 0, 4_000, true)];
        assert_eq!(held(&regions, &HashSet::new(), 600_000), None);
        assert_eq!(held(&regions, &HashSet::new(), 2_000), Some(0));
    }

    #[test]
    fn the_run_fence_tells_where_the_room_is_when_the_server_knows() {
        assert_eq!(fenced_position(r#"{"positionMs":12000}"#), Some(12_000));
        assert_eq!(fenced_position(""), None);
        assert_eq!(fenced_position(r#"{"positionMs":-5}"#), None);
    }

    #[tokio::test]
    async fn a_put_a_seek_dropped_is_no_error_and_sends_nothing() {
        let mut puts: JoinSet<anyhow::Result<ClosedObject>> = JoinSet::new();
        let put = puts.spawn(async {
            std::future::pending::<()>().await;
            unreachable!()
        });
        put.abort();
        assert!(landed(puts.join_next().await.unwrap()).unwrap().is_none());
        puts.spawn(async { anyhow::bail!("PUT failed") });
        assert!(landed(puts.join_next().await.unwrap()).is_err());
    }

    #[test]
    fn nothing_started_publishes_no_master() {
        let master = info();
        let body = round_body(&target(), Round { seq: 1, confirm: &[], playlists: BTreeMap::new(), regions: &[], duration_ms: 0, master: &master });
        assert_eq!(body["playlists"], json!({}));
        assert_eq!(body["timeline"]["regions"], json!([]));
    }
}
