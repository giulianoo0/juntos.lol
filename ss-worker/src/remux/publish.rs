use std::collections::{HashMap, HashSet};
use std::sync::Arc;

use anyhow::{bail, Context};
use serde::Deserialize;
use tokio::sync::mpsc;

use super::sink::{ClosedObject, Sink};

/// What one variant playlist declares, in order.
fn playlist_segments(body: &str) -> Vec<(String, f64)> {
    let mut out = Vec::new();
    let mut pending: Option<f64> = None;
    for line in body.lines() {
        let line = line.trim();
        if let Some(rest) = line.strip_prefix("#EXTINF:") {
            pending = rest.split(',').next().and_then(|d| d.parse().ok());
            continue;
        }
        if line.is_empty() || line.starts_with('#') {
            continue;
        }
        let name = line.rsplit('/').next().unwrap_or(line).to_string();
        out.push((name, pending.take().unwrap_or(0.0)));
    }
    out
}

/// The region spans what the bucket confirmed, never what the muxer wrote:
/// the contiguous confirmed prefix, at its shortest across the variants.
pub fn confirmed_span_ms(manifests: &HashMap<String, String>, confirmed: &HashSet<String>) -> u64 {
    let mut span: Option<f64> = None;
    for (name, body) in manifests {
        if name.ends_with("master.m3u8") {
            continue;
        }
        let mut seconds = 0.0;
        for (segment, duration) in playlist_segments(body) {
            if !confirmed.contains(&segment) {
                break;
            }
            seconds += duration;
        }
        span = Some(match span {
            None => seconds,
            Some(held) => held.min(seconds),
        });
    }
    (span.unwrap_or(0.0) * 1000.0) as u64
}

pub struct Publisher {
    pub client: reqwest::Client,
    pub api_base: String,
    pub room_id: String,
    pub claim: String,
    pub run_id: String,
    pub media_generation: u64,
    pub region: u64,
    pub offset_ms: u64,
    pub duration_ms: u64,
    pub source_bytes: u64,
    pub prefix: String,

    seq: u64,
    uploaded_bytes: u64,
    pending: Vec<ClosedObject>,
    confirmed: HashSet<String>,
}

#[derive(Deserialize)]
struct PublishResponse {
    #[serde(default)]
    confirmed: Vec<String>,
    #[serde(default)]
    ready: bool,
}

/// The room moved on: the claim died, the generation was swapped, or a
/// newer run took the fence. Not a transport error — nothing to retry.
#[derive(Debug)]
pub struct Revoked(pub String);

impl std::fmt::Display for Revoked {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "run revoked: {}", self.0)
    }
}
impl std::error::Error for Revoked {}

impl Publisher {
    pub fn new(
        client: reqwest::Client,
        api_base: String,
        room_id: String,
        claim: String,
        run_id: String,
        media_generation: u64,
        region: u64,
        offset_ms: u64,
        duration_ms: u64,
        source_bytes: u64,
    ) -> Self {
        Self {
            client,
            api_base,
            room_id,
            claim,
            run_id,
            media_generation,
            region,
            offset_ms,
            duration_ms,
            source_bytes,
            prefix: super::plan::region_prefix(region),
            seq: 0,
            uploaded_bytes: 0,
            pending: Vec::new(),
            confirmed: HashSet::new(),
        }
    }

    pub fn absorb(&mut self, uploaded: &mut mpsc::UnboundedReceiver<ClosedObject>) {
        while let Ok(object) = uploaded.try_recv() {
            self.uploaded_bytes += object.size;
            self.pending.push(object);
        }
    }

    pub fn drained(&self) -> bool {
        self.pending.is_empty()
    }

    pub fn produced_ms(&self, sink: &Sink) -> u64 {
        confirmed_span_ms(&sink.manifests(), &self.confirmed)
    }

    /// One committed round. Confirmed objects leave the spool; unconfirmed
    /// names ride the next round.
    pub async fn round(&mut self, sink: &Arc<Sink>, growing: bool, complete: bool) -> anyhow::Result<bool> {
        let confirm: Vec<ClosedObject> = self.pending.drain(..self.pending.len().min(128)).collect();
        let mut playlists = sink.manifests();
        // The bare master names whichever region is live; the prefixed one
        // is this region's for good.
        if let Some(master) = playlists.get(&format!("{}master.m3u8", self.prefix)).cloned() {
            playlists.insert("master.m3u8".into(), master.clone());
            playlists.insert(format!("r{}_master.m3u8", self.region), master);
        }
        let produced = self.produced_ms(sink);
        self.seq += 1;
        let body = serde_json::json!({
            "claim": self.claim,
            "mediaGeneration": self.media_generation,
            "runId": self.run_id,
            "seq": self.seq,
            "confirm": confirm.iter().map(|o| o.name.clone()).collect::<Vec<_>>(),
            "playlists": playlists,
            "complete": complete,
            "progress": { "receivedBytes": self.uploaded_bytes, "sourceBytes": self.source_bytes },
            "timeline": {
                "durationMs": self.duration_ms,
                "offsetMs": self.offset_ms,
                "regions": [{ "n": self.region, "startMs": self.offset_ms, "producedMs": produced, "growing": growing }],
            },
        });
        let url = format!("{}/api/rooms/{}/client-media/publish", self.api_base, self.room_id);
        let response = self
            .client
            .post(&url)
            .json(&body)
            .send()
            .await
            .context("publish send")?;
        let status = response.status();
        if !status.is_success() {
            let text = response.text().await.unwrap_or_default();
            let revoked = ["claim_mismatch", "stale_generation", "stale_run", "room_not_found"]
                .iter()
                .any(|code| text.contains(code));
            // Whatever this round carried goes back for the next attempt.
            self.pending.splice(0..0, confirm);
            if revoked {
                return Err(Revoked(text.chars().take(200).collect()).into());
            }
            bail!("publish failed: {status} {}", text.chars().take(200).collect::<String>());
        }
        let parsed: PublishResponse = response.json().await.context("publish body")?;
        let vouched: HashSet<String> = parsed.confirmed.iter().cloned().collect();
        for object in confirm {
            if vouched.contains(&object.name) {
                self.confirmed.insert(object.name.clone());
                sink.discard(&object).await;
            } else {
                self.pending.push(object);
            }
        }
        Ok(parsed.ready)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn span_is_the_confirmed_prefix_at_its_shortest() {
        let mut manifests = HashMap::new();
        manifests.insert(
            "client_stream_0.m3u8".to_string(),
            "#EXTM3U\n#EXT-X-MAP:URI=\"cinit_0.mp4\"\n#EXTINF:4.0,\ncs_0_0.m4s\n#EXTINF:4.0,\ncs_0_1.m4s\n".to_string(),
        );
        manifests.insert(
            "client_stream_1.m3u8".to_string(),
            "#EXTINF:4.0,\ncs_1_0.m4s\n#EXTINF:4.0,\ncs_1_1.m4s\n".to_string(),
        );
        manifests.insert("master.m3u8".to_string(), "#EXT-X-STREAM-INF\n".to_string());
        let confirmed: HashSet<String> =
            ["cs_0_0.m4s", "cs_0_1.m4s", "cs_1_0.m4s"].iter().map(|s| s.to_string()).collect();
        // Video confirmed 8s, audio confirmed 4s: the region spans 4s.
        assert_eq!(confirmed_span_ms(&manifests, &confirmed), 4_000);
    }

    #[test]
    fn a_hole_ends_the_span() {
        let mut manifests = HashMap::new();
        manifests.insert(
            "client_stream_0.m3u8".to_string(),
            "#EXTINF:4.0,\ncs_0_0.m4s\n#EXTINF:4.0,\ncs_0_1.m4s\n#EXTINF:4.0,\ncs_0_2.m4s\n".to_string(),
        );
        let confirmed: HashSet<String> = ["cs_0_0.m4s", "cs_0_2.m4s"].iter().map(|s| s.to_string()).collect();
        assert_eq!(confirmed_span_ms(&manifests, &confirmed), 4_000);
    }

    #[test]
    fn playlist_urls_reduce_to_names() {
        let body = "#EXTINF:2.0,\nhttp://x/y/cs_0_0.m4s\n";
        assert_eq!(playlist_segments(body), vec![("cs_0_0.m4s".to_string(), 2.0)]);
    }
}
