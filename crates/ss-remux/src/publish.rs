use std::collections::{HashMap, HashSet};
use std::sync::Arc;

use anyhow::{bail, Context};
use serde::Deserialize;
use tokio::sync::mpsc;

use super::sink::{ClosedObject, Sink};

/// What one variant playlist declares, in order.
pub(crate) fn playlist_segments(body: &str) -> Vec<(String, f64)> {
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

/// The 480p variant's peak: video maxrate plus one AAC track. The full
/// variant never declares less than 2 Mb/s, so it stays the heavier one.
const LOW_BANDWIDTH: u64 = 1_700_000;

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
    pub audio_langs: Vec<String>,
    /// CODECS for the video variant, when the player cannot infer it (AV1, VP9).
    video_codecs: Option<String>,
    chapters: Vec<serde_json::Value>,
    /// The 480p variant's playlist index, when the run encodes one.
    low_variant: Option<usize>,
    low_resolution: Option<(u32, u32)>,

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
/// newer run took the fence. Not a transport error: nothing to retry.
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
        audio_langs: Vec<String>,
        video_codecs: Option<String>,
        chapters: Vec<serde_json::Value>,
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
            audio_langs,
            video_codecs,
            chapters,
            low_variant: None,
            low_resolution: None,
            seq: 0,
            uploaded_bytes: 0,
            pending: Vec::new(),
            confirmed: HashSet::new(),
        }
    }

    /// The 480p variant at `index`, of `resolution` when the source's size
    /// is known (see `plan::low_resolution`).
    pub fn with_low_variant(mut self, index: usize, resolution: Option<(u32, u32)>) -> Self {
        self.low_variant = Some(index);
        self.low_resolution = resolution;
        self
    }

    pub fn absorb(&mut self, uploaded: &mut mpsc::UnboundedReceiver<ClosedObject>) {
        while let Ok(object) = uploaded.try_recv() {
            self.take(object);
        }
    }

    pub fn take(&mut self, object: ClosedObject) {
        self.uploaded_bytes += object.size;
        self.pending.push(object);
    }

    /// Objects the bucket confirmed, and the bytes uploaded.
    pub fn totals(&self) -> (usize, u64) {
        (self.confirmed.len(), self.uploaded_bytes)
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
        playlists.remove(&format!("{}master.m3u8", self.prefix));
        let produced = self.produced_ms(sink);
        if playlists.contains_key(&format!("{}client_stream_0.m3u8", self.prefix)) {
            let low_ready = self
                .low_variant
                .is_some_and(|n| playlists.contains_key(&format!("{}client_stream_{n}.m3u8", self.prefix)));
            let master = self.synthesize_master(produced, low_ready);
            playlists.insert("master.m3u8".into(), master.clone());
            playlists.insert(format!("r{}_master.m3u8", self.region), master);
        }
        self.seq += 1;
        let body = serde_json::json!({
            "claim": self.claim,
            "mediaGeneration": self.media_generation,
            "runId": self.run_id,
            "seq": self.seq,
            "confirm": confirm.iter().map(|o| o.name.clone()).collect::<Vec<_>>(),
            "playlists": playlists,
            "complete": complete,
            "chapters": self.chapters,
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

impl Publisher {
    /// `low_ready`: the 480p playlist exists, so the variant can be listed
    /// without the player fetching a name the bucket does not have yet.
    fn synthesize_master(&self, produced_ms: u64, low_ready: bool) -> String {
        let seconds = (produced_ms as f64 / 1000.0).max(4.0);
        let bandwidth = (((self.uploaded_bytes as f64 * 8.0) / seconds) as u64).max(2_000_000);
        let mut out = String::from("#EXTM3U\n#EXT-X-VERSION:7\n");
        for (index, lang) in self.audio_langs.iter().enumerate() {
            out.push_str(&format!(
                "#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID=\"aud\",NAME=\"audio_{n}\",LANGUAGE=\"{lang}\",{d}URI=\"{p}client_stream_{n}.m3u8\"\n",
                n = index + 1,
                lang = lang,
                d = if index == 0 { "DEFAULT=YES,AUTOSELECT=YES," } else { "" },
                p = self.prefix,
            ));
        }
        let audio_attr = if self.audio_langs.is_empty() { String::new() } else { ",AUDIO=\"aud\"".into() };
        let codecs_attr = match &self.video_codecs {
            Some(video) if self.audio_langs.is_empty() => format!(",CODECS=\"{video}\""),
            Some(video) => format!(",CODECS=\"{video},mp4a.40.2\""),
            None => String::new(),
        };
        out.push_str(&format!(
            "#EXT-X-STREAM-INF:BANDWIDTH={bandwidth}{codecs_attr}{audio_attr}\n{}client_stream_0.m3u8\n",
            self.prefix,
        ));
        if let (Some(index), true) = (self.low_variant, low_ready) {
            let audio_codec = if self.audio_langs.is_empty() { "" } else { ",mp4a.40.2" };
            let resolution = self.low_resolution.map(|(w, h)| format!(",RESOLUTION={w}x{h}")).unwrap_or_default();
            out.push_str(&format!(
                "#EXT-X-STREAM-INF:BANDWIDTH={LOW_BANDWIDTH}{resolution},CODECS=\"avc1.4d401f{audio_codec}\"{audio_attr}\n{}client_stream_{index}.m3u8\n",
                self.prefix,
            ));
        }
        out
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

#[cfg(test)]
mod master_tests {
    use super::*;

    fn publisher(langs: Vec<String>, prefix_region: u64) -> Publisher {
        publisher_with_codecs(langs, prefix_region, None)
    }

    fn publisher_with_codecs(langs: Vec<String>, prefix_region: u64, video_codecs: Option<&str>) -> Publisher {
        let mut p = Publisher::new(
            reqwest::Client::new(), "http://a".into(), "r".into(), "c".into(),
            "run".into(), 0, prefix_region, 0, 60_000, 0, langs, video_codecs.map(str::to_string), Vec::new(),
        );
        p.uploaded_bytes = 8_000_000;
        p
    }

    #[test]
    fn master_names_video_and_audio_within_the_grammar() {
        let m = publisher(vec!["jpn".into(), "eng".into()], 2).synthesize_master(20_000, false);
        assert!(m.contains("#EXT-X-STREAM-INF:BANDWIDTH="));
        assert!(m.contains("AUDIO=\"aud\""));
        assert!(m.contains("URI=\"r2_client_stream_1.m3u8\""));
        assert!(m.contains("URI=\"r2_client_stream_2.m3u8\""));
        assert!(m.ends_with("r2_client_stream_0.m3u8\n"));
        assert!(m.contains("DEFAULT=YES"));
    }

    #[test]
    fn master_declares_codecs_the_player_cannot_infer() {
        let m = publisher(vec!["eng".into()], 0).synthesize_master(8_000, false);
        assert!(!m.contains("CODECS"), "avc stays undeclared, as it always was");
        let m = publisher_with_codecs(vec!["eng".into()], 0, Some("av01.0.08M.10")).synthesize_master(8_000, false);
        assert!(m.contains("CODECS=\"av01.0.08M.10,mp4a.40.2\""));
        let m = publisher_with_codecs(vec![], 0, Some("vp09.00.10.08")).synthesize_master(8_000, false);
        assert!(m.contains("CODECS=\"vp09.00.10.08\""));
        assert!(!m.contains("mp4a"));
    }

    #[test]
    fn master_lists_the_480p_variant_once_its_playlist_exists() {
        let p = publisher(vec!["jpn".into(), "eng".into()], 2).with_low_variant(3, Some((1152, 480)));
        let m = p.synthesize_master(20_000, false);
        assert!(!m.contains("client_stream_3"), "no variant the player cannot fetch yet");
        let m = p.synthesize_master(20_000, true);
        assert_eq!(m.matches("#EXT-X-STREAM-INF").count(), 2);
        assert!(m.contains("RESOLUTION=1152x480,CODECS=\"avc1.4d401f,mp4a.40.2\",AUDIO=\"aud\"\nr2_client_stream_3.m3u8\n"));
        let bandwidths: Vec<u64> = m
            .lines()
            .filter_map(|l| l.strip_prefix("#EXT-X-STREAM-INF:BANDWIDTH="))
            .map(|l| l.split(',').next().unwrap().parse().unwrap())
            .collect();
        assert!(bandwidths[1] < bandwidths[0], "the full variant stays the heavier one");
    }

    #[test]
    fn a_480p_variant_of_unknown_size_declares_no_resolution() {
        let m = publisher(vec!["eng".into()], 2).with_low_variant(2, None).synthesize_master(20_000, true);
        assert!(m.contains("client_stream_2.m3u8"));
        assert!(!m.contains("RESOLUTION"));
    }

    #[test]
    fn master_without_audio_has_no_media_lines() {
        let m = publisher(vec![], 0).synthesize_master(8_000, false);
        assert!(!m.contains("EXT-X-MEDIA"));
        assert!(m.ends_with("client_stream_0.m3u8\n"));
        assert!(!m.contains(",AUDIO"));
    }
}
