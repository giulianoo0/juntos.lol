//! Subtitles for a run: a second FFmpeg pass that seeks with the region and
//! copies every text track to an ASS file, which is tailed and merged into the
//! room's tracks across runs. The video rides along into a null muxer only so
//! the demuxer seeks by its cues.
use std::collections::{BTreeMap, HashMap};
use std::hash::{Hash, Hasher};
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::{Duration, Instant};

use anyhow::Context;
use parking_lot::Mutex;
use tokio::io::{AsyncReadExt, AsyncSeekExt};

use super::plan::SourcePlan;
use super::process;
use super::publish::Revoked;

const SEEK_LEAD_MS: u64 = 15_000;
const TAIL_MS: u64 = 15_000;
const POLL: Duration = Duration::from_millis(1500);
const PUBLISH_EVERY: Duration = Duration::from_secs(2);
const MAX_DOC_BYTES: usize = 4 << 20;
const MAX_FONT_BYTES: u64 = 8 << 20;
const MAX_FONTS: usize = 24;
const FONT_EXTENSIONS: &[&str] = &["ttf", "otf", "ttc", "woff", "woff2"];

pub struct RoomSubtitles {
    generation: u64,
    tracks: Vec<TrackState>,
    fonts_posted: bool,
    dirty: bool,
}

struct TrackState {
    language: String,
    title: String,
    header: String,
    format: String,
    events: BTreeMap<(u64, u64, u64), String>,
}

pub type Rooms = Mutex<HashMap<String, Arc<Mutex<RoomSubtitles>>>>;

pub fn new_rooms() -> Rooms {
    Mutex::new(HashMap::new())
}

/// The room's merged state, reset when the generation moves.
pub fn room_state(rooms: &Rooms, room_id: &str, generation: u64, plan: &SourcePlan) -> Arc<Mutex<RoomSubtitles>> {
    let fresh = || RoomSubtitles {
        generation,
        tracks: plan
            .subtitles
            .iter()
            .map(|t| TrackState {
                language: t.language.clone(),
                title: t.title.clone(),
                header: String::new(),
                format: String::new(),
                events: BTreeMap::new(),
            })
            .collect(),
        fonts_posted: false,
        dirty: false,
    };
    let mut held = rooms.lock();
    let entry = held.entry(room_id.to_string()).or_insert_with(|| Arc::new(Mutex::new(fresh())));
    {
        let mut state = entry.lock();
        if state.generation != generation || state.tracks.len() != plan.subtitles.len() {
            *state = fresh();
        }
    }
    entry.clone()
}

pub fn forget_room(rooms: &Rooms, room_id: &str) {
    rooms.lock().remove(room_id);
}

pub struct Extractor {
    pub ffmpeg_path: String,
    pub client: reqwest::Client,
    pub api_base: String,
    pub room_id: String,
    pub run_id: String,
    pub media_generation: u64,
    pub claim: String,
    pub input_url: String,
    pub dir: PathBuf,
    pub state: Arc<Mutex<RoomSubtitles>>,
}

struct Cursor {
    path: PathBuf,
    offset: u64,
    pending: Vec<u8>,
    header: String,
    in_events: bool,
}

pub fn extractor_args(input_url: &str, dir: &Path, plan: &SourcePlan, start_ms: u64, end_ms: u64) -> Vec<String> {
    let mut args: Vec<String> = vec![
        "-nostdin".into(),
        "-hide_banner".into(),
        "-loglevel".into(),
        "error".into(),
        "-progress".into(),
        "pipe:1".into(),
        "-readrate".into(),
        "8".into(),
    ];
    let seek_ms = start_ms.saturating_sub(SEEK_LEAD_MS);
    if start_ms > 0 && seek_ms > 0 {
        args.extend(["-ss".into(), format!("{:.3}", seek_ms as f64 / 1000.0)]);
    }
    args.extend(["-copyts".into(), "-protocol_whitelist".into(), "http,tcp".into(), "-i".into(), input_url.into()]);
    let to: Vec<String> = if end_ms > 0 {
        vec!["-to".into(), format!("{:.3}", (end_ms + TAIL_MS) as f64 / 1000.0)]
    } else {
        Vec::new()
    };
    args.extend(["-map".into(), "0:v:0".into(), "-c:v".into(), "copy".into()]);
    args.extend(to.iter().cloned());
    args.extend(["-f".into(), "null".into(), "/dev/null".into()]);
    for (out_index, track) in plan.subtitles.iter().enumerate() {
        let codec = if track.codec == "ass" || track.codec == "ssa" { "copy" } else { "ass" };
        args.extend(["-map".into(), format!("0:s:{}", track.input_index), "-c:s".into(), codec.into()]);
        args.extend(to.iter().cloned());
        args.extend([
            "-ignore_readorder".into(),
            "1".into(),
            "-flush_packets".into(),
            "1".into(),
            "-f".into(),
            "ass".into(),
            dir.join(format!("sub_{out_index}.ass")).to_string_lossy().into_owned(),
        ]);
    }
    args
}

impl Extractor {
    pub async fn run(self, plan: &SourcePlan, start_ms: u64, end_ms: u64) -> anyhow::Result<()> {
        if plan.subtitles.is_empty() {
            return Ok(());
        }
        tokio::fs::create_dir_all(&self.dir).await.context("subtitle dir")?;
        let fonts_wanted = plan.attachments > 0 && !self.state.lock().fonts_posted;
        if fonts_wanted {
            self.state.lock().fonts_posted = true;
            if let Err(e) = self.post_fonts().await {
                tracing::warn!(run = %self.run_id, error = %e, "subtitle fonts not posted");
            }
        }
        let args = extractor_args(&self.input_url, &self.dir, plan, start_ms, end_ms);
        let mut supervised = process::spawn(&self.ffmpeg_path, &args)?;
        let mut cursors: Vec<Cursor> = (0..plan.subtitles.len())
            .map(|i| Cursor {
                path: self.dir.join(format!("sub_{i}.ass")),
                offset: 0,
                pending: Vec::new(),
                header: String::new(),
                in_events: false,
            })
            .collect();
        let mut last_publish = Instant::now() - PUBLISH_EVERY;
        let status = loop {
            tokio::time::sleep(POLL).await;
            let done = supervised.child_try_wait()?;
            self.ingest(&mut cursors).await;
            if done.is_none() && self.state.lock().dirty && last_publish.elapsed() >= PUBLISH_EVERY {
                self.publish(false).await?;
                last_publish = Instant::now();
            }
            if let Some(status) = done {
                break status;
            }
        };
        if !status.success() {
            let tail: String = supervised.stderr_tail.lock().chars().take(300).collect();
            tracing::warn!(run = %self.run_id, %status, stderr = %tail, "subtitle pass ended badly");
        }
        let covers_all = start_ms == 0 && end_ms == 0 && status.success();
        if self.state.lock().dirty || covers_all {
            self.publish(covers_all).await?;
        }
        Ok(())
    }

    async fn ingest(&self, cursors: &mut [Cursor]) {
        for (index, cursor) in cursors.iter_mut().enumerate() {
            let Ok(mut file) = tokio::fs::File::open(&cursor.path).await else { continue };
            if file.seek(std::io::SeekFrom::Start(cursor.offset)).await.is_err() {
                continue;
            }
            let mut fresh = Vec::new();
            if file.read_to_end(&mut fresh).await.is_err() || fresh.is_empty() {
                continue;
            }
            cursor.offset += fresh.len() as u64;
            cursor.pending.extend_from_slice(&fresh);
            let Some(cut) = cursor.pending.iter().rposition(|b| *b == b'\n') else { continue };
            let complete: Vec<u8> = cursor.pending.drain(..=cut).collect();
            let text = String::from_utf8_lossy(&complete);
            let mut state = self.state.lock();
            let Some(track) = state.tracks.get_mut(index) else { continue };
            let mut dirty = false;
            for line in text.lines() {
                let line = line.trim_end_matches('\r');
                if !cursor.in_events {
                    if line.trim().eq_ignore_ascii_case("[Events]") {
                        cursor.in_events = true;
                        if track.header.is_empty() {
                            track.header = sanitize_header(&cursor.header);
                        }
                    } else {
                        cursor.header.push_str(line);
                        cursor.header.push('\n');
                    }
                    continue;
                }
                if line.starts_with("Format:") {
                    if track.format.is_empty() {
                        track.format = line.to_string();
                    }
                    continue;
                }
                if let Some((start, end)) = dialogue_span(line) {
                    let mut hasher = std::collections::hash_map::DefaultHasher::new();
                    line.hash(&mut hasher);
                    if track.events.insert((start, end, hasher.finish()), line.to_string()).is_none() {
                        dirty = true;
                    }
                }
            }
            if dirty {
                state.dirty = true;
            }
        }
    }

    async fn publish(&self, complete: bool) -> anyhow::Result<()> {
        let tracks: Vec<serde_json::Value> = {
            let mut state = self.state.lock();
            state.dirty = false;
            state
                .tracks
                .iter()
                .map(|track| {
                    serde_json::json!({
                        "language": track.language,
                        "title": track.title,
                        "vtt": webvtt_document(track),
                        "ass": ass_document(track),
                    })
                })
                .collect()
        };
        let body = serde_json::json!({
            "claim": self.claim,
            "mediaGeneration": self.media_generation,
            "complete": complete,
            "tracks": tracks,
        });
        let url = format!("{}/api/rooms/{}/subtitles/fleet", self.api_base, self.room_id);
        let response = self.client.post(&url).json(&body).send().await.context("subtitles send")?;
        let status = response.status();
        if !status.is_success() {
            let text = response.text().await.unwrap_or_default();
            if ["claim_mismatch", "stale_generation", "room_not_found"].iter().any(|code| text.contains(code)) {
                return Err(Revoked(text.chars().take(200).collect()).into());
            }
            self.state.lock().dirty = true;
            tracing::warn!(run = %self.run_id, %status, body = %text.chars().take(200).collect::<String>(), "subtitle publish failed");
        }
        Ok(())
    }

    async fn post_fonts(&self) -> anyhow::Result<()> {
        let fonts_dir = self.dir.join("fonts");
        tokio::fs::create_dir_all(&fonts_dir).await?;
        let output = tokio::time::timeout(
            Duration::from_secs(120),
            tokio::process::Command::new(&self.ffmpeg_path)
                .args([
                    "-nostdin", "-v", "error", "-dump_attachment:t", "", "-protocol_whitelist", "http,tcp",
                    "-i", &self.input_url, "-t", "0", "-f", "null", "/dev/null",
                ])
                .current_dir(&fonts_dir)
                .env_clear()
                .env("PATH", std::env::var("PATH").unwrap_or_default())
                .stdin(std::process::Stdio::null())
                .kill_on_drop(true)
                .output(),
        )
        .await
        .context("attachment dump timed out")??;
        if !output.status.success() {
            tracing::debug!(stderr = %String::from_utf8_lossy(&output.stderr).chars().take(200).collect::<String>(), "attachment dump exited non-zero");
        }
        let mut entries = tokio::fs::read_dir(&fonts_dir).await?;
        let mut posted = 0usize;
        while let Some(entry) = entries.next_entry().await? {
            if posted >= MAX_FONTS {
                break;
            }
            let name = entry.file_name().to_string_lossy().into_owned();
            let ext = name.rsplit('.').next().unwrap_or("").to_ascii_lowercase();
            if !FONT_EXTENSIONS.contains(&ext.as_str()) {
                continue;
            }
            let meta = entry.metadata().await?;
            if !meta.is_file() || meta.len() == 0 || meta.len() > MAX_FONT_BYTES {
                continue;
            }
            let bytes = tokio::fs::read(entry.path()).await?;
            let url = format!("{}/api/rooms/{}/subtitles/fonts", self.api_base, self.room_id);
            let response = self
                .client
                .post(&url)
                .query(&[("name", name.as_str()), ("mediaGeneration", &self.media_generation.to_string())])
                .body(bytes)
                .send()
                .await?;
            if response.status().is_success() {
                posted += 1;
            } else {
                tracing::warn!(font = %name, status = %response.status(), "font not accepted");
            }
        }
        tracing::info!(run = %self.run_id, fonts = posted, "subtitle fonts posted");
        Ok(())
    }
}

fn sanitize_header(raw: &str) -> String {
    let trimmed = raw.trim_start_matches('\u{feff}').trim_start();
    if trimmed.len() >= 13 && trimmed[..13].eq_ignore_ascii_case("[Script Info]") {
        trimmed.to_string()
    } else {
        format!("[Script Info]\nScriptType: v4.00+\n{trimmed}")
    }
}

/// `Dialogue: layer,start,end,...` → (start_ms, end_ms).
pub fn dialogue_span(line: &str) -> Option<(u64, u64)> {
    let rest = line.strip_prefix("Dialogue:")?;
    let mut fields = rest.splitn(4, ',');
    fields.next()?;
    let start = ass_time_ms(fields.next()?.trim())?;
    let end = ass_time_ms(fields.next()?.trim())?;
    Some((start, end))
}

fn ass_time_ms(value: &str) -> Option<u64> {
    let mut parts = value.split(':');
    let h: u64 = parts.next()?.trim().parse().ok()?;
    let m: u64 = parts.next()?.trim().parse().ok()?;
    let s: f64 = parts.next()?.trim().parse().ok()?;
    if parts.next().is_some() {
        return None;
    }
    Some((h * 3600 + m * 60) * 1000 + (s * 1000.0).round() as u64)
}

fn ass_document(track: &TrackState) -> String {
    let mut out = if track.header.is_empty() {
        String::from("[Script Info]\nScriptType: v4.00+\n\n[V4+ Styles]\nFormat: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding\nStyle: Default,Arial,20,&H00FFFFFF,&H000000FF,&H00000000,&H00000000,0,0,0,0,100,100,0,0,1,2,0,2,10,10,10,1\n")
    } else {
        track.header.clone()
    };
    if !out.ends_with('\n') {
        out.push('\n');
    }
    out.push_str("\n[Events]\n");
    if track.format.is_empty() {
        out.push_str("Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text\n");
    } else {
        out.push_str(&track.format);
        out.push('\n');
    }
    for line in track.events.values() {
        if out.len() + line.len() + 1 > MAX_DOC_BYTES {
            break;
        }
        out.push_str(line);
        out.push('\n');
    }
    out
}

fn webvtt_document(track: &TrackState) -> String {
    let mut out = String::from("WEBVTT\n\n");
    for ((start, end, _), line) in &track.events {
        let text = plain_text(dialogue_text(line));
        if text.is_empty() || *end <= *start {
            continue;
        }
        let cue = format!("{} --> {}\n{}\n\n", vtt_time(*start), vtt_time(*end), text);
        if out.len() + cue.len() > MAX_DOC_BYTES {
            break;
        }
        out.push_str(&cue);
    }
    out
}

fn dialogue_text(line: &str) -> &str {
    let rest = line.strip_prefix("Dialogue:").unwrap_or(line);
    rest.splitn(10, ',').nth(9).unwrap_or("")
}

fn plain_text(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    let mut depth = 0usize;
    for ch in text.chars() {
        match ch {
            '{' => depth += 1,
            '}' if depth > 0 => depth -= 1,
            _ if depth == 0 => out.push(ch),
            _ => {}
        }
    }
    out.replace("\\N", "\n").replace("\\n", "\n").replace("\\h", " ").trim().to_string()
}

fn vtt_time(ms: u64) -> String {
    format!("{:02}:{:02}:{:02}.{:03}", ms / 3_600_000, (ms % 3_600_000) / 60_000, (ms % 60_000) / 1000, ms % 1000)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::remux::plan::SubtitleTrack;

    fn plan() -> SourcePlan {
        SourcePlan {
            video_codec: "h264".into(),
            audios: vec![],
            duration_ms: 1_000_000,
            chapters: vec![],
            subtitles: vec![
                SubtitleTrack { input_index: 2, codec: "ass".into(), language: "por".into(), title: "Português".into() },
                SubtitleTrack { input_index: 3, codec: "subrip".into(), language: "eng".into(), title: String::new() },
            ],
            bitmap_subtitles: 0,
            attachments: 0,
        }
    }

    #[test]
    fn args_seek_with_a_lead_and_keep_the_video_for_the_cues() {
        let args = extractor_args("http://in", Path::new("/tmp/x"), &plan(), 1_021_000, 0);
        let joined = args.join(" ");
        assert!(joined.contains("-ss 1006.000 -copyts"));
        assert!(joined.contains("-map 0:v:0 -c:v copy -f null /dev/null"));
        assert!(joined.contains("-map 0:s:2 -c:s copy"));
        assert!(joined.contains("-map 0:s:3 -c:s ass"));
        assert!(joined.ends_with("/tmp/x/sub_1.ass"));
        assert!(!joined.contains("-to"));
        let bounded = extractor_args("http://in", Path::new("/tmp/x"), &plan(), 0, 60_000).join(" ");
        assert!(!bounded.contains("-ss"));
        assert_eq!(bounded.matches("-to 75.000").count(), 3);
    }

    #[test]
    fn dialogue_times_parse_to_ms() {
        assert_eq!(dialogue_span("Dialogue: 0,0:17:00.02,1:00:01.5,Default,,0,0,0,,Oi"), Some((1_020_020, 3_601_500)));
        assert_eq!(dialogue_span("Comment: 0,0:00:01.00,0:00:02.00,a,,0,0,0,,x"), None);
    }

    #[test]
    fn documents_merge_events_in_time_order() {
        let mut track = TrackState {
            language: "por".into(),
            title: String::new(),
            header: sanitize_header("\u{feff}[Script Info]\nPlayResX: 640\n\n[V4+ Styles]\nFormat: Name\nStyle: Default\n"),
            format: "Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text".into(),
            events: BTreeMap::new(),
        };
        for line in [
            "Dialogue: 0,0:00:05.00,0:00:06.00,Default,,0,0,0,,{\\i1}Depois{\\i0}\\Nlinha",
            "Dialogue: 0,0:00:01.00,0:00:02.00,Default,,0,0,0,,Antes",
        ] {
            let (s, e) = dialogue_span(line).unwrap();
            track.events.insert((s, e, 0), line.into());
        }
        let ass = ass_document(&track);
        assert!(ass.starts_with("[Script Info]\nPlayResX: 640"));
        assert!(ass.find("Antes").unwrap() < ass.find("Depois").unwrap());
        let vtt = webvtt_document(&track);
        assert!(vtt.starts_with("WEBVTT\n\n00:00:01.000 --> 00:00:02.000\nAntes\n\n00:00:05.000 --> 00:00:06.000\nDepois\nlinha\n"));
    }

    #[test]
    fn a_missing_header_gets_a_minimal_one() {
        assert!(sanitize_header("PlayResX: 1\n").starts_with("[Script Info]\nScriptType"));
    }
}
