//! A YouTube live pushed into the MoQ relay: yt-dlp names the HLS renditions,
//! FFmpeg copies the chosen video and audio into one MPEG-TS, and moq-mux
//! turns that stream into the hang broadcast the site's viewer already reads
//! for screen shares. The worker and jlocal run this unchanged.
use std::sync::Arc;
use std::time::Duration;

use anyhow::Context;
use parking_lot::Mutex;
use serde::{Deserialize, Serialize};
use tokio::io::{AsyncBufReadExt, AsyncReadExt};

use crate::youtube::{self, Error, Format, Info, Picked, Resolver};

const MAX_HEIGHT: u32 = 1080;
const READ_BUF: usize = 64 * 1024;
const STDERR_KEEP: usize = 4096;

/// The renditions a live is taken from: one H.264 video playlist and, when
/// the live offers one apart, the best audio playlist.
#[derive(Clone, Debug)]
pub struct Selection {
    pub video: Format,
    pub audio: Option<Format>,
}

fn is_hls(format: &Format) -> bool {
    format
        .protocol
        .as_deref()
        .map(|p| p.starts_with("m3u8"))
        .unwrap_or(false)
        && format.url.is_some()
        && format.has_drm != Some(true)
}

fn bitrate(format: &Format) -> u64 {
    format
        .abr
        .or(format.tbr)
        .map(|b| (b * 1000.0) as u64)
        .unwrap_or(0)
}

/// Picks the tallest H.264 rendition up to 1080p and the richest audio one.
/// Only a live that is on the air qualifies: an announced one has nothing to
/// read yet, and a finished one is a recording the VOD path serves.
pub fn select(info: &Info) -> Result<Selection, Error> {
    match info.live_status.as_deref() {
        Some("is_upcoming") => {
            return Err(Error::Unavailable("the live has not started yet".into()))
        }
        _ if info.is_live == Some(true) || info.live_status.as_deref() == Some("is_live") => {}
        _ => return Err(Error::Unsupported("not a live stream".into())),
    }
    let video = info
        .formats
        .iter()
        .filter(|f| {
            is_hls(f)
                && f.vcodec
                    .as_deref()
                    .map(|v| v.starts_with("avc1"))
                    .unwrap_or(false)
        })
        .filter(|f| f.height.unwrap_or(0) <= MAX_HEIGHT)
        .max_by(|a, b| {
            a.height
                .cmp(&b.height)
                .then_with(|| bitrate(a).cmp(&bitrate(b)))
        })
        .cloned()
        .ok_or_else(|| Error::Unsupported("the live has no H.264 rendition".into()))?;
    let audio = info
        .formats
        .iter()
        .filter(|f| is_hls(f) && youtube::is_none(&f.vcodec))
        .max_by(|a, b| {
            bitrate(a)
                .cmp(&bitrate(b))
                .then_with(|| numeric(&a.format_id).cmp(&numeric(&b.format_id)))
        })
        .cloned();
    Ok(Selection { video, audio })
}

fn numeric(id: &str) -> u64 {
    id.parse().unwrap_or(0)
}

/// What a producer needs to put one live on the relay.
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Request {
    pub url: String,
    /// The relay URL with the publish token appended, as the site builds it.
    pub relay: String,
    /// The broadcast name under that URL, ending in `.hang`.
    pub broadcast: String,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(tag = "state", rename_all = "lowercase")]
pub enum State {
    Starting,
    Live,
    Ended,
    Failed { code: String, detail: String },
}

impl State {
    pub fn is_final(&self) -> bool {
        matches!(self, State::Ended | State::Failed { .. })
    }
    fn failed(error: &Error) -> Self {
        State::Failed {
            code: error.code().into(),
            detail: error.detail(),
        }
    }
}

/// A live in flight. Dropping it or calling [`Session::stop`] kills FFmpeg and
/// leaves the relay; the state stays readable after either.
pub struct Session {
    state: Arc<Mutex<State>>,
    child: Arc<Mutex<Option<tokio::process::Child>>>,
    task: tokio::task::JoinHandle<()>,
}

impl Session {
    pub fn start(resolver: Arc<Resolver>, ffmpeg_path: String, request: Request) -> Self {
        let state = Arc::new(Mutex::new(State::Starting));
        let child = Arc::new(Mutex::new(None));
        let task = tokio::spawn({
            let state = state.clone();
            let child = child.clone();
            async move {
                let outcome = run(resolver, ffmpeg_path, request, state.clone(), child).await;
                let mut held = state.lock();
                if !held.is_final() {
                    *held = match outcome {
                        Ok(()) => State::Ended,
                        Err(Failure::Youtube(error)) => State::failed(&error),
                        Err(Failure::Other(error)) => State::Failed {
                            code: "youtube_tool".into(),
                            detail: format!("{error:#}"),
                        },
                    };
                }
            }
        });
        Self { state, child, task }
    }

    pub fn state(&self) -> State {
        self.state.lock().clone()
    }

    pub fn stop(&self) {
        self.task.abort();
        if let Some(mut child) = self.child.lock().take() {
            let _ = child.start_kill();
        }
        let mut held = self.state.lock();
        if !held.is_final() {
            *held = State::Ended;
        }
    }
}

impl Drop for Session {
    fn drop(&mut self) {
        self.stop();
    }
}

enum Failure {
    Youtube(Error),
    Other(anyhow::Error),
}

impl From<Error> for Failure {
    fn from(error: Error) -> Self {
        Failure::Youtube(error)
    }
}

impl From<anyhow::Error> for Failure {
    fn from(error: anyhow::Error) -> Self {
        Failure::Other(error)
    }
}

/// The FFmpeg command: each playlist is an input with its own reconnects
/// (and the proxy yt-dlp resolved through, since the URLs are bound to it),
/// mapped verbatim into one transport stream on stdout.
pub fn ffmpeg_args(selection: &Selection, proxy: Option<&str>) -> Vec<String> {
    let mut args: Vec<String> = ["-nostdin", "-hide_banner", "-loglevel", "error"]
        .iter()
        .map(|s| s.to_string())
        .collect();
    let mut input = |url: &str| {
        if let Some(proxy) = proxy {
            args.extend(["-http_proxy".into(), proxy.into()]);
        }
        args.extend(
            [
                "-reconnect",
                "1",
                "-reconnect_streamed",
                "1",
                "-reconnect_delay_max",
                "5",
                "-i",
                url,
            ]
            .iter()
            .map(|s| s.to_string()),
        );
    };
    input(selection.video.url.as_deref().unwrap_or_default());
    if let Some(audio) = &selection.audio {
        input(audio.url.as_deref().unwrap_or_default());
    }
    args.extend(["-map", "0:v:0"].iter().map(|s| s.to_string()));
    if selection.audio.is_some() {
        args.extend(["-map", "1:a:0"].iter().map(|s| s.to_string()));
    } else {
        args.extend(["-map", "0:a:0?"].iter().map(|s| s.to_string()));
    }
    args.extend(
        [
            "-c",
            "copy",
            "-f",
            "mpegts",
            "-muxdelay",
            "0",
            "-muxpreload",
            "0",
            "-flush_packets",
            "1",
            "pipe:1",
        ]
        .iter()
        .map(|s| s.to_string()),
    );
    args
}

async fn run(
    resolver: Arc<Resolver>,
    ffmpeg_path: String,
    request: Request,
    state: Arc<Mutex<State>>,
    child_slot: Arc<Mutex<Option<tokio::process::Child>>>,
) -> Result<(), Failure> {
    let resolved = resolver.resolve(&request.url).await?;
    let Picked::Live(selection) = &resolved.picked else {
        return Err(Error::Unsupported("not a live stream".into()).into());
    };

    let relay = url::Url::parse(&request.relay).context("relay url")?;
    let origin = moq_net::Origin::random().produce();
    let client = moq_native::ClientConfig::default()
        .init()
        .context("moq client")?;
    let reconnect = client.with_publisher(&origin).reconnect(relay);
    let mut broadcast = origin
        .create_broadcast(
            &request.broadcast,
            moq_net::broadcast::Route::new().with_announce(true),
        )
        .context("create broadcast")?;
    let catalog = moq_mux::catalog::Producer::new(&mut broadcast).context("catalog")?;
    let mut importer =
        moq_mux::import::ContainerStream::new(broadcast.clone(), catalog.reserve(), "ts")
            .context("ts importer")?;

    let mut cmd = tokio::process::Command::new(&ffmpeg_path);
    cmd.args(ffmpeg_args(selection, resolver.proxy()));
    // The HLS demuxer reopens playlists and segments with its own options,
    // so the trust roots go in through OpenSSL's environment, not an argument.
    if let Some(ca) = resolver.ca_file() {
        cmd.env("SSL_CERT_FILE", ca);
    }
    cmd.stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .kill_on_drop(true);
    let mut child = cmd
        .spawn()
        .map_err(|e| Error::Tool(format!("ffmpeg did not start: {e}")))?;
    let mut stdout = child.stdout.take().context("ffmpeg stdout")?;
    let stderr = child.stderr.take().context("ffmpeg stderr")?;
    *child_slot.lock() = Some(child);

    let stderr_tail = Arc::new(Mutex::new(String::new()));
    tokio::spawn({
        let tail = stderr_tail.clone();
        async move {
            let mut lines = tokio::io::BufReader::new(stderr).lines();
            while let Ok(Some(line)) = lines.next_line().await {
                tracing::warn!(target: "ffmpeg", "{line}");
                let mut held = tail.lock();
                held.push_str(&line);
                held.push('\n');
                if held.len() > STDERR_KEEP {
                    let cut = held.len() - STDERR_KEEP;
                    held.drain(..cut);
                }
            }
        }
    });

    let mut closed = std::pin::pin!(reconnect.closed());
    let mut buf = vec![0u8; READ_BUF];
    let mut decoded: u64 = 0;
    loop {
        tokio::select! {
            read = stdout.read(&mut buf) => {
                let n = read.context("ffmpeg read")?;
                if n == 0 {
                    break;
                }
                importer.decode(&buf[..n]).context("ts import")?;
                decoded += n as u64;
                if decoded > 0 && reconnect.connected() {
                    let mut held = state.lock();
                    if *held == State::Starting {
                        tracing::info!(broadcast = %request.broadcast, "live on the relay");
                        *held = State::Live;
                    }
                }
            }
            result = &mut closed => {
                result.context("relay session")?;
                return Err(anyhow::anyhow!("relay session closed").into());
            }
        }
    }
    let _ = importer.finish();
    let child = child_slot.lock().take();
    let status = match child {
        Some(mut child) => tokio::time::timeout(Duration::from_secs(10), child.wait())
            .await
            .ok()
            .and_then(|r| r.ok()),
        None => None,
    };
    if status.map(|s| s.success()).unwrap_or(true) {
        return Ok(());
    }
    let stderr = stderr_tail.lock().clone();
    Err(youtube::classify_failure(&stderr).into())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn fixture() -> Info {
        serde_json::from_str(include_str!("../../tests/fixtures/live.json")).unwrap()
    }

    #[test]
    fn picks_1080p_h264_and_the_richest_audio() {
        let picked = select(&fixture()).unwrap();
        assert_eq!(picked.video.format_id, "270");
        assert_eq!(picked.video.height, Some(1080));
        assert_eq!(
            picked.audio.as_ref().map(|a| a.format_id.as_str()),
            Some("234")
        );
    }

    #[test]
    fn refuses_what_is_not_on_the_air() {
        let mut info = fixture();
        info.is_live = Some(false);
        info.live_status = Some("was_live".into());
        assert_eq!(select(&info).unwrap_err().code(), "youtube_unsupported");
        info.live_status = Some("is_upcoming".into());
        assert_eq!(select(&info).unwrap_err().code(), "youtube_unavailable");
    }

    #[test]
    fn ffmpeg_copies_both_playlists_into_one_ts() {
        let picked = select(&fixture()).unwrap();
        let args = ffmpeg_args(&picked, Some("http://proxy:8888"));
        let joined = args.join(" ");
        assert_eq!(args.iter().filter(|a| *a == "-i").count(), 2);
        assert_eq!(args.iter().filter(|a| *a == "-http_proxy").count(), 2);
        assert!(joined.contains("-map 0:v:0 -map 1:a:0 -c copy -f mpegts"));
        assert!(joined.ends_with("pipe:1"));
    }
}
