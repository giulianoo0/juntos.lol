//! A YouTube video as a run input: yt-dlp resolves the page into elementary
//! streams, the crate picks one video and one audio per language, and each
//! stream is read over HTTP by ranges. URLs never leave this process: they
//! are bound to the IP that resolved them.
pub mod http;
pub mod subs;

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::Arc;
use std::time::{Duration, Instant};

use anyhow::Context;
use parking_lot::Mutex;
use serde::{Deserialize, Serialize};

use crate::plan::{AudioAction, AudioTrack, Chapter, SourcePlan};

const MAX_HEIGHT: u32 = 1080;
const MAX_AUDIOS: usize = 8;
const MAX_SUBTITLES: usize = 24;
const CACHE_TTL: Duration = Duration::from_secs(20 * 60);
const UPDATE_EVERY: Duration = Duration::from_secs(24 * 3600);
const RESOLVE_TIMEOUT: Duration = Duration::from_secs(90);
/// Languages the audience asks for first, after the original.
const PREFERRED_LANGUAGES: &[&str] = &["pt", "en", "es", "ja"];

#[derive(Clone, Debug)]
pub struct Config {
    pub ytdlp_path: String,
    pub proxy: Option<String>,
    pub cookies_file: Option<PathBuf>,
    /// A PEM bundle FFmpeg verifies HTTPS against when its build carries no
    /// system roots (the static macOS and Windows binaries the companion app
    /// downloads); None trusts the system store.
    pub ca_file: Option<PathBuf>,
}

/// Why a video cannot be prepared, as the code the site shows.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Error {
    /// The resolver's address is refused as a bot; another exit is needed.
    Blocked,
    /// Private, removed, or otherwise gone.
    Unavailable(String),
    /// Live, upcoming, no usable stream.
    Unsupported(String),
    /// yt-dlp itself misbehaved.
    Tool(String),
}

impl Error {
    pub fn code(&self) -> &'static str {
        match self {
            Error::Blocked => "youtube_blocked",
            Error::Unavailable(_) => "youtube_unavailable",
            Error::Unsupported(_) => "youtube_unsupported",
            Error::Tool(_) => "youtube_tool",
        }
    }
    pub fn detail(&self) -> String {
        match self {
            Error::Blocked => "the resolver's address is refused by youtube".into(),
            Error::Unavailable(s) | Error::Unsupported(s) | Error::Tool(s) => s.clone(),
        }
    }
}

impl std::fmt::Display for Error {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}: {}", self.code(), self.detail())
    }
}
impl std::error::Error for Error {}

/// What a run asks for: the page. The selection is deterministic, so the
/// summary the host saw is what the run produces.
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Request {
    pub url: String,
}

/// yt-dlp's info.json, the parts that matter.
#[derive(Clone, Debug, Deserialize)]
pub struct Info {
    pub id: String,
    #[serde(default)]
    pub title: String,
    #[serde(default)]
    pub duration: Option<f64>,
    #[serde(default)]
    pub language: Option<String>,
    #[serde(default)]
    pub is_live: Option<bool>,
    #[serde(default)]
    pub live_status: Option<String>,
    #[serde(default)]
    pub thumbnail: Option<String>,
    #[serde(default)]
    pub chapters: Option<Vec<InfoChapter>>,
    #[serde(default)]
    pub formats: Vec<Format>,
    #[serde(default)]
    pub subtitles: HashMap<String, Vec<SubEntry>>,
    #[serde(default)]
    pub automatic_captions: HashMap<String, Vec<SubEntry>>,
}

#[derive(Clone, Debug, Deserialize)]
pub struct InfoChapter {
    #[serde(default)]
    pub start_time: Option<f64>,
    #[serde(default)]
    pub end_time: Option<f64>,
    #[serde(default)]
    pub title: Option<String>,
}

#[derive(Clone, Debug, Deserialize)]
pub struct Format {
    pub format_id: String,
    #[serde(default)]
    pub ext: Option<String>,
    #[serde(default)]
    pub vcodec: Option<String>,
    #[serde(default)]
    pub acodec: Option<String>,
    #[serde(default)]
    pub height: Option<u32>,
    #[serde(default)]
    pub width: Option<u32>,
    #[serde(default)]
    pub audio_channels: Option<u32>,
    #[serde(default)]
    pub language: Option<String>,
    #[serde(default)]
    pub format_note: Option<String>,
    #[serde(default)]
    pub filesize: Option<u64>,
    #[serde(default)]
    pub filesize_approx: Option<u64>,
    #[serde(default)]
    pub tbr: Option<f64>,
    #[serde(default)]
    pub abr: Option<f64>,
    #[serde(default)]
    pub protocol: Option<String>,
    #[serde(default)]
    pub language_preference: Option<i32>,
    #[serde(default)]
    pub has_drm: Option<bool>,
    #[serde(default)]
    pub url: Option<String>,
}

impl Format {
    fn is_https(&self) -> bool {
        self.protocol.as_deref() == Some("https") && self.url.is_some() && self.has_drm != Some(true)
    }
    fn video_only(&self) -> bool {
        self.is_https() && !is_none(&self.vcodec) && is_none(&self.acodec)
    }
    fn audio_only(&self) -> bool {
        self.is_https() && is_none(&self.vcodec) && !is_none(&self.acodec)
    }
    fn size(&self) -> Option<u64> {
        self.filesize.or(self.filesize_approx)
    }
    fn original(&self) -> bool {
        self.language_preference.unwrap_or(-1) > 0
            || self.format_note.as_deref().map(|n| n.to_ascii_lowercase().contains("original")).unwrap_or(false)
    }
    fn language(&self) -> String {
        self.language.clone().filter(|l| !l.is_empty()).unwrap_or_else(|| "und".into())
    }
}

pub(crate) fn is_none(codec: &Option<String>) -> bool {
    matches!(codec.as_deref(), None | Some("none") | Some(""))
}

#[derive(Clone, Debug, Deserialize)]
pub struct SubEntry {
    #[serde(default)]
    pub ext: Option<String>,
    #[serde(default)]
    pub name: Option<String>,
    #[serde(default)]
    pub url: Option<String>,
}

/// One subtitle document to fetch and publish whole.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct SubtitlePick {
    pub language: String,
    pub title: String,
    pub url: String,
    pub auto: bool,
}

/// The streams a run reads, chosen once from the info.
#[derive(Clone, Debug)]
pub struct Selection {
    pub video: Format,
    pub audios: Vec<Format>,
    pub subtitles: Vec<SubtitlePick>,
    pub chapters: Vec<Chapter>,
    pub duration_ms: u64,
}

/// The public face of a resolution: what the site shows while it waits.
/// No URL in here.
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Summary {
    pub video_id: String,
    pub title: String,
    pub duration_ms: u64,
    #[serde(default)]
    pub live: bool,
    pub thumbnail: Option<String>,
    pub video: SummaryVideo,
    pub audios: Vec<SummaryAudio>,
    pub subtitles: Vec<SummarySubtitle>,
    pub chapters: usize,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct SummaryVideo {
    pub itag: String,
    pub codec: String,
    pub width: u32,
    pub height: u32,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct SummaryAudio {
    pub itag: String,
    pub codec: String,
    pub language: String,
    pub original: bool,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct SummarySubtitle {
    pub language: String,
    pub title: String,
    pub auto: bool,
}

/// What a page resolved to: a video the remux reads, or a live the relay path takes.
pub enum Picked {
    Vod(Selection),
    Live(crate::live::Selection),
}

pub struct Resolved {
    pub info: Info,
    pub picked: Picked,
}

impl Resolved {
    pub fn vod(&self) -> Result<&Selection, Error> {
        match &self.picked {
            Picked::Vod(selection) => Ok(selection),
            Picked::Live(_) => Err(Error::Unsupported("a live is not prepared as a video".into())),
        }
    }
}

/// A run's inputs: the plan FFmpeg follows and the streams behind it.
pub struct Materialized {
    pub plan: SourcePlan,
    pub streams: Vec<Arc<http::HttpSource>>,
    pub subtitles: Vec<SubtitlePick>,
}

fn video_family(vcodec: &str) -> Option<(&'static str, u8)> {
    if vcodec.starts_with("avc1") || vcodec.starts_with("h264") {
        Some(("h264", 0))
    } else if vcodec.starts_with("vp09") || vcodec.starts_with("vp9") {
        Some(("vp9", 1))
    } else if vcodec.starts_with("av01") {
        Some(("av1", 2))
    } else {
        None
    }
}

fn audio_codec(acodec: &str) -> Option<&'static str> {
    if acodec.starts_with("mp4a") {
        Some("aac")
    } else if acodec.starts_with("opus") {
        Some("opus")
    } else {
        None
    }
}

fn base_language(tag: &str) -> &str {
    tag.split(['-', '_']).next().unwrap_or(tag)
}

fn language_rank(language: &str) -> usize {
    let base = base_language(language);
    PREFERRED_LANGUAGES.iter().position(|p| *p == base).unwrap_or(PREFERRED_LANGUAGES.len())
}

/// Picks the streams: the tallest video up to 1080p with H.264 preferred at
/// that height, one audio per language with AAC copied when offered, manual
/// subtitles plus the original language's automatic one.
pub fn select(info: &Info) -> Result<Selection, Error> {
    if info.is_live == Some(true) || matches!(info.live_status.as_deref(), Some("is_live") | Some("is_upcoming")) {
        return Err(Error::Unsupported("live streams are not supported".into()));
    }
    let duration_ms = info.duration.filter(|d| *d > 0.0).map(|d| (d * 1000.0) as u64);
    let Some(duration_ms) = duration_ms else {
        return Err(Error::Unsupported("the video reports no duration".into()));
    };

    let videos: Vec<&Format> = info
        .formats
        .iter()
        .filter(|f| f.video_only() && f.height.unwrap_or(0) <= MAX_HEIGHT && f.size().is_some())
        .filter(|f| video_family(f.vcodec.as_deref().unwrap_or("")).is_some())
        .collect();
    let tallest = videos.iter().map(|f| f.height.unwrap_or(0)).max().unwrap_or(0);
    let video = videos
        .iter()
        .filter(|f| f.height.unwrap_or(0) == tallest)
        .min_by(|a, b| {
            let fa = video_family(a.vcodec.as_deref().unwrap_or("")).map(|f| f.1).unwrap_or(9);
            let fb = video_family(b.vcodec.as_deref().unwrap_or("")).map(|f| f.1).unwrap_or(9);
            fa.cmp(&fb).then(b.tbr.unwrap_or(0.0).total_cmp(&a.tbr.unwrap_or(0.0)))
        })
        .copied()
        .cloned();
    let Some(video) = video else {
        return Err(Error::Unsupported("no video stream the player can copy".into()));
    };

    let mut by_language: HashMap<String, Vec<&Format>> = HashMap::new();
    for f in info.formats.iter().filter(|f| f.audio_only() && f.size().is_some()) {
        if audio_codec(f.acodec.as_deref().unwrap_or("")).is_none() {
            continue;
        }
        by_language.entry(f.language()).or_default().push(f);
    }
    let mut audios: Vec<Format> = by_language
        .values()
        .filter_map(|candidates| {
            let best = |codec: &str| {
                candidates
                    .iter()
                    .filter(|f| audio_codec(f.acodec.as_deref().unwrap_or("")) == Some(codec))
                    .max_by(|a, b| a.abr.unwrap_or(0.0).total_cmp(&b.abr.unwrap_or(0.0)))
                    .copied()
            };
            best("aac").or_else(|| best("opus")).cloned()
        })
        .collect();
    audios.sort_by(|a, b| {
        b.original()
            .cmp(&a.original())
            .then(language_rank(&a.language()).cmp(&language_rank(&b.language())))
            .then(a.language().cmp(&b.language()))
    });
    audios.truncate(MAX_AUDIOS);
    if audios.is_empty() {
        return Err(Error::Unsupported("no audio stream the player can use".into()));
    }

    let mut subtitles = Vec::new();
    let mut languages: Vec<&String> = info.subtitles.keys().collect();
    languages.sort();
    for language in languages {
        let Some(entry) = info.subtitles[language].iter().find(|e| e.ext.as_deref() == Some("vtt") && e.url.is_some()) else {
            continue;
        };
        subtitles.push(SubtitlePick {
            language: language.clone(),
            title: entry.name.clone().unwrap_or_else(|| language.clone()),
            url: entry.url.clone().unwrap_or_default(),
            auto: false,
        });
        if subtitles.len() >= MAX_SUBTITLES {
            break;
        }
    }
    let original = info.language.as_deref().map(base_language).unwrap_or("");
    if !original.is_empty() {
        let keys = [format!("{original}-orig"), original.to_string()];
        if let Some((key, entry)) = keys.iter().find_map(|key| {
            info.automatic_captions
                .get(key)
                .and_then(|entries| entries.iter().find(|e| e.ext.as_deref() == Some("vtt") && e.url.is_some()))
                .map(|entry| (key.clone(), entry))
        }) {
            let _ = key;
            subtitles.push(SubtitlePick {
                language: original.to_string(),
                title: format!("{} (auto)", entry.name.clone().unwrap_or_else(|| original.to_string())),
                url: entry.url.clone().unwrap_or_default(),
                auto: true,
            });
        }
    }

    let chapters = info
        .chapters
        .as_deref()
        .unwrap_or(&[])
        .iter()
        .enumerate()
        .filter_map(|(index, c)| {
            let start_ms = (c.start_time?.max(0.0) * 1000.0) as u64;
            let end_ms = (c.end_time?.max(0.0) * 1000.0) as u64;
            (end_ms > start_ms).then(|| Chapter {
                start_ms,
                end_ms,
                title: c
                    .title
                    .as_deref()
                    .map(|t| t.trim().chars().take(200).collect::<String>())
                    .filter(|t| !t.is_empty())
                    .unwrap_or_else(|| format!("{}", index + 1)),
            })
        })
        .collect();

    Ok(Selection { video, audios, subtitles, chapters, duration_ms })
}

/// The plan FFmpeg follows for the selection: video copied, each audio its
/// own input, no subtitle stream (those arrive as documents).
pub fn plan_for(selection: &Selection) -> SourcePlan {
    let vcodec = selection.video.vcodec.clone().unwrap_or_default();
    let (video_codec, _) = video_family(&vcodec).unwrap_or(("h264", 0));
    let video_codecs = match video_codec {
        "vp9" => Some(if vcodec.starts_with("vp09.") { vcodec.clone() } else { "vp09.00.40.08".into() }),
        "av1" => Some(vcodec.clone()),
        _ => None,
    };
    let audios = selection
        .audios
        .iter()
        .enumerate()
        .map(|(index, f)| {
            let codec = audio_codec(f.acodec.as_deref().unwrap_or("")).unwrap_or("opus");
            let channels = f.audio_channels.unwrap_or(2).clamp(1, 8);
            AudioTrack {
                input_file: index + 1,
                input_index: 0,
                codec: codec.into(),
                channels,
                language: f.language(),
                action: if codec == "aac" {
                    AudioAction::Copy
                } else {
                    AudioAction::ConvertAac { bitrate: if channels <= 2 { 160_000 } else { 384_000 } }
                },
            }
        })
        .collect();
    SourcePlan {
        video_codec: video_codec.into(),
        video_codecs,
        audios,
        duration_ms: selection.duration_ms,
        subtitles: Vec::new(),
        bitmap_subtitles: 0,
        attachments: 0,
        chapters: selection.chapters.clone(),
    }
}

pub fn summary(info: &Info, selection: &Selection) -> Summary {
    Summary {
        video_id: info.id.clone(),
        title: info.title.clone(),
        duration_ms: selection.duration_ms,
        live: false,
        thumbnail: info.thumbnail.clone(),
        video: SummaryVideo {
            itag: selection.video.format_id.clone(),
            codec: video_family(selection.video.vcodec.as_deref().unwrap_or("")).map(|f| f.0).unwrap_or("h264").into(),
            width: selection.video.width.unwrap_or(0),
            height: selection.video.height.unwrap_or(0),
        },
        audios: selection
            .audios
            .iter()
            .map(|f| SummaryAudio {
                itag: f.format_id.clone(),
                codec: audio_codec(f.acodec.as_deref().unwrap_or("")).unwrap_or("opus").into(),
                language: f.language(),
                original: f.original(),
            })
            .collect(),
        subtitles: selection
            .subtitles
            .iter()
            .map(|s| SummarySubtitle { language: s.language.clone(), title: s.title.clone(), auto: s.auto })
            .collect(),
        chapters: selection.chapters.len(),
    }
}

/// A live in the picker: no duration, one video and one audio, nothing to seek.
pub fn live_summary(info: &Info, selection: &crate::live::Selection) -> Summary {
    Summary {
        video_id: info.id.clone(),
        title: info.title.clone(),
        duration_ms: 0,
        live: true,
        thumbnail: info.thumbnail.clone(),
        video: SummaryVideo {
            itag: selection.video.format_id.clone(),
            codec: "h264".into(),
            width: selection.video.width.unwrap_or(0),
            height: selection.video.height.unwrap_or(0),
        },
        audios: selection
            .audio
            .iter()
            .map(|f| SummaryAudio { itag: f.format_id.clone(), codec: "aac".into(), language: f.language(), original: true })
            .collect(),
        subtitles: Vec::new(),
        chapters: 0,
    }
}

/// Reads yt-dlp's failure into the code the site can act on.
pub fn classify_failure(stderr: &str) -> Error {
    // URLs in the log say nothing about the failure and carry words like
    // "playlist" that would.
    let lower = strip_urls(&stderr.to_ascii_lowercase());
    if lower.contains("not a bot") || lower.contains("sign in to confirm") {
        Error::Blocked
    } else if lower.contains("private video")
        || lower.contains("video unavailable")
        || lower.contains("video is unavailable")
        || lower.contains("is unavailable")
        || lower.contains("has been removed")
        || lower.contains("is not available")
        || lower.contains("does not exist")
        || lower.contains("members-only")
        || lower.contains("sign in to confirm your age")
        || lower.contains("age-restricted")
    {
        Error::Unavailable(stderr.lines().rev().find(|l| l.contains("ERROR")).unwrap_or(stderr).chars().take(200).collect())
    } else if lower.contains("is live")
        || lower.contains("live event")
        || lower.contains("premieres in")
        || lower.contains("unsupported url")
        || lower.contains("is not a valid url")
        || lower.contains("playlist")
    {
        Error::Unsupported(stderr.lines().rev().find(|l| l.contains("ERROR")).unwrap_or(stderr).chars().take(200).collect())
    } else {
        Error::Tool(stderr.lines().rev().find(|l| l.contains("ERROR")).unwrap_or(stderr).chars().take(200).collect())
    }
}

fn strip_urls(text: &str) -> String {
    text.split_whitespace()
        .filter(|word| {
            let bare = word.trim_start_matches(['\'', '"', '(', '[', '<']);
            !bare.starts_with("http://") && !bare.starts_with("https://")
        })
        .collect::<Vec<_>>()
        .join(" ")
}

/// Whether the failure smells like an extractor the site moved past, which
/// a newer yt-dlp fixes.
fn stale_extractor(stderr: &str) -> bool {
    let lower = stderr.to_ascii_lowercase();
    lower.contains("unable to extract")
        || lower.contains("nsig")
        || lower.contains("requested format is not available")
        || lower.contains("http error 403")
        || lower.contains("please report this issue")
}

/// Runs yt-dlp, caches resolutions, and hands streams fresh URLs when the
/// old ones expire.
pub struct Resolver {
    cfg: Config,
    pub version: Option<String>,
    /// Leaves through the same exit as yt-dlp: the URLs only work there.
    pub client: reqwest::Client,
    cache: Mutex<HashMap<String, (Instant, Arc<Resolved>)>>,
    last_update: Mutex<Option<Instant>>,
    update_lock: tokio::sync::Mutex<()>,
}

impl Resolver {
    pub async fn new(cfg: Config) -> Self {
        let mut builder = reqwest::Client::builder()
            .connect_timeout(Duration::from_secs(15))
            .timeout(Duration::from_secs(120))
            .user_agent("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36");
        if let Some(proxy) = &cfg.proxy {
            match reqwest::Proxy::all(proxy) {
                Ok(p) => builder = builder.proxy(p),
                Err(e) => tracing::error!(error = %e, "youtube proxy url rejected; going direct"),
            }
        }
        let client = builder.build().expect("reqwest client");
        let version = detect_version(&cfg.ytdlp_path).await;
        Self {
            cfg,
            version,
            client,
            cache: Mutex::new(HashMap::new()),
            last_update: Mutex::new(None),
            update_lock: tokio::sync::Mutex::new(()),
        }
    }

    pub fn proxied(&self) -> bool {
        self.cfg.proxy.is_some()
    }

    pub fn proxy(&self) -> Option<&str> {
        self.cfg.proxy.as_deref()
    }

    pub fn ca_file(&self) -> Option<&std::path::Path> {
        self.cfg.ca_file.as_deref()
    }

    fn command(&self) -> tokio::process::Command {
        let mut cmd = tokio::process::Command::new(&self.cfg.ytdlp_path);
        cmd.env_clear()
            .env("PATH", std::env::var("PATH").unwrap_or_default())
            .env("HOME", std::env::var("HOME").unwrap_or_else(|_| "/tmp".into()))
            .stdin(std::process::Stdio::null())
            .kill_on_drop(true);
        if let Some(proxy) = &self.cfg.proxy {
            cmd.arg("--proxy").arg(proxy);
        }
        if let Some(cookies) = &self.cfg.cookies_file {
            cmd.arg("--cookies").arg(cookies);
        }
        cmd
    }

    async fn run_ytdlp(&self, url: &str) -> Result<Info, Error> {
        let mut cmd = self.command();
        cmd.args(["-J", "--no-playlist", "--no-warnings", "--socket-timeout", "20", "--"]).arg(url);
        let output = tokio::time::timeout(RESOLVE_TIMEOUT, cmd.output())
            .await
            .map_err(|_| Error::Tool("yt-dlp timed out".into()))?
            .map_err(|e| Error::Tool(format!("yt-dlp did not start: {e}")))?;
        if !output.status.success() {
            let stderr = String::from_utf8_lossy(&output.stderr).into_owned();
            return Err(classify_failure(&stderr));
        }
        serde_json::from_slice::<Info>(&output.stdout).map_err(|e| Error::Tool(format!("info.json: {e}")))
    }

    /// `yt-dlp -U`, at most once a day, when a failure looks like an
    /// extractor the site has outgrown.
    async fn maybe_update(&self) -> bool {
        let _held = self.update_lock.lock().await;
        if self.last_update.lock().map(|at| at.elapsed() < UPDATE_EVERY).unwrap_or(false) {
            return false;
        }
        *self.last_update.lock() = Some(Instant::now());
        let mut cmd = tokio::process::Command::new(&self.cfg.ytdlp_path);
        cmd.arg("-U").stdin(std::process::Stdio::null()).kill_on_drop(true);
        match tokio::time::timeout(Duration::from_secs(120), cmd.output()).await {
            Ok(Ok(output)) => {
                tracing::info!(ok = output.status.success(), "yt-dlp self-update ran");
                output.status.success()
            }
            _ => false,
        }
    }

    async fn resolve_fresh(&self, url: &str) -> Result<Arc<Resolved>, Error> {
        let info = match self.run_ytdlp(url).await {
            Ok(info) => info,
            Err(Error::Tool(detail)) if stale_extractor(&detail) && self.maybe_update().await => self.run_ytdlp(url).await?,
            Err(e) => return Err(e),
        };
        let live = info.is_live == Some(true) || matches!(info.live_status.as_deref(), Some("is_live") | Some("is_upcoming"));
        let picked = if live { Picked::Live(crate::live::select(&info)?) } else { Picked::Vod(select(&info)?) };
        let resolved = Arc::new(Resolved { info, picked });
        self.cache.lock().insert(url.to_string(), (Instant::now(), resolved.clone()));
        Ok(resolved)
    }

    pub async fn resolve(&self, url: &str) -> Result<Arc<Resolved>, Error> {
        if let Some((at, held)) = self.cache.lock().get(url).cloned() {
            if at.elapsed() < CACHE_TTL {
                return Ok(held);
            }
        }
        self.resolve_fresh(url).await
    }

    pub async fn summary(&self, url: &str) -> Result<Summary, Error> {
        let resolved = self.resolve(url).await?;
        Ok(match &resolved.picked {
            Picked::Vod(selection) => summary(&resolved.info, selection),
            Picked::Live(selection) => live_summary(&resolved.info, selection),
        })
    }

    pub async fn materialize(self: &Arc<Self>, request: &Request) -> anyhow::Result<Materialized> {
        let resolved = self.resolve(&request.url).await?;
        let selection = resolved.vod()?;
        let mut streams = Vec::with_capacity(1 + selection.audios.len());
        for format in std::iter::once(&selection.video).chain(selection.audios.iter()) {
            let url = format.url.clone().context("format without url")?;
            let size = format.size().context("format without size")?;
            let refresh = Arc::new(RefreshVia { resolver: self.clone(), page: request.url.clone(), itag: format.format_id.clone() });
            streams.push(Arc::new(http::HttpSource::new(self.client.clone(), format.format_id.clone(), url, size, refresh)));
        }
        Ok(Materialized { plan: plan_for(selection), streams, subtitles: selection.subtitles.clone() })
    }
}

/// Hands a stream a fresh URL for its itag by resolving the page again.
struct RefreshVia {
    resolver: Arc<Resolver>,
    page: String,
    itag: String,
}

#[async_trait::async_trait]
impl http::Refresh for RefreshVia {
    async fn fresh_url(&self) -> anyhow::Result<String> {
        let resolved = self.resolver.resolve_fresh(&self.page).await?;
        resolved
            .info
            .formats
            .iter()
            .find(|f| f.format_id == self.itag)
            .and_then(|f| f.url.clone())
            .with_context(|| format!("itag {} gone after re-resolve", self.itag))
    }
}

pub async fn detect_version(path: &str) -> Option<String> {
    let output = tokio::time::timeout(
        Duration::from_secs(20),
        tokio::process::Command::new(path).arg("--version").stdin(std::process::Stdio::null()).kill_on_drop(true).output(),
    )
    .await
    .ok()?
    .ok()?;
    output.status.success().then(|| String::from_utf8_lossy(&output.stdout).trim().to_string()).filter(|v| !v.is_empty())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn fixture() -> Info {
        serde_json::from_str(include_str!("../../tests/fixtures/dub.json")).unwrap()
    }

    #[test]
    fn picks_h264_at_the_tallest_height_up_to_1080p() {
        let selection = select(&fixture()).unwrap();
        assert_eq!(selection.video.format_id, "137");
        assert_eq!(selection.video.height, Some(1080));
        assert_eq!(selection.duration_ms, 1_541_000);
    }

    #[test]
    fn falls_back_to_vp9_when_h264_stops_short() {
        let mut info = fixture();
        info.formats.retain(|f| f.format_id != "137");
        let selection = select(&info).unwrap();
        assert_eq!(selection.video.format_id, "248");
        let plan = plan_for(&selection);
        assert_eq!(plan.video_codec, "vp9");
        assert_eq!(plan.video_codecs.as_deref(), Some("vp09.00.40.08"));
    }

    #[test]
    fn one_aac_audio_per_language_original_first() {
        let selection = select(&fixture()).unwrap();
        let langs: Vec<String> = selection.audios.iter().map(|a| a.language()).collect();
        assert_eq!(langs, vec!["en-US", "pt", "de"]);
        assert!(selection.audios.iter().all(|a| a.format_id.starts_with("140-")), "{:?}", selection.audios.iter().map(|a| &a.format_id).collect::<Vec<_>>());
        let plan = plan_for(&selection);
        assert!(plan.audios.iter().all(|a| a.action == AudioAction::Copy));
        assert_eq!(plan.audios[1].input_file, 2);
        assert_eq!(plan.audios[1].input_index, 0);
    }

    #[test]
    fn opus_when_no_aac_and_it_converts() {
        let mut info = fixture();
        info.formats.retain(|f| !f.acodec.as_deref().unwrap_or("").starts_with("mp4a"));
        let selection = select(&info).unwrap();
        assert!(selection.audios.iter().all(|a| a.format_id.starts_with("251-")));
        let plan = plan_for(&selection);
        assert_eq!(plan.audios[0].action, AudioAction::ConvertAac { bitrate: 160_000 });
    }

    #[test]
    fn manual_subtitles_plus_the_original_auto_one() {
        let selection = select(&fixture()).unwrap();
        let langs: Vec<(String, bool)> = selection.subtitles.iter().map(|s| (s.language.clone(), s.auto)).collect();
        assert_eq!(langs, vec![("de".into(), false), ("en".into(), false), ("pt".into(), false), ("en".into(), true)]);
        assert!(selection.subtitles[3].title.ends_with("(auto)"));
        assert!(selection.subtitles.iter().all(|s| s.url.contains("fmt=vtt")));
    }

    #[test]
    fn chapters_and_summary_carry_no_urls() {
        let info = fixture();
        let selection = select(&info).unwrap();
        assert_eq!(selection.chapters[0].title, "Red Light");
        assert_eq!(selection.chapters[0].end_ms, 240_000);
        let summary = summary(&info, &selection);
        let json = serde_json::to_string(&summary).unwrap();
        assert!(!json.contains("googlevideo"));
        assert_eq!(summary.video.itag, "137");
        assert_eq!(summary.audios[0].language, "en-US");
        assert!(summary.audios[0].original);
        assert_eq!(summary.chapters, selection.chapters.len());
    }

    #[test]
    fn lives_and_empty_videos_are_refused() {
        let mut info = fixture();
        info.is_live = Some(true);
        assert!(matches!(select(&info), Err(Error::Unsupported(_))));
        let mut info = fixture();
        info.formats.retain(|f| f.acodec.as_deref() != Some("none"));
        assert!(matches!(select(&info), Err(Error::Unsupported(_))));
    }

    #[test]
    fn failures_map_to_codes() {
        assert_eq!(classify_failure("ERROR: [youtube] x: Sign in to confirm you’re not a bot."), Error::Blocked);
        assert_eq!(classify_failure("ERROR: [youtube] x: Private video. Sign in").code(), "youtube_unavailable");
        assert_eq!(classify_failure("ERROR: [youtube] AAAAAAAAAAA: This video is unavailable").code(), "youtube_unavailable");
        assert_eq!(classify_failure("ERROR: Unsupported URL: https://x").code(), "youtube_unsupported");
        assert_eq!(classify_failure("ERROR: something odd").code(), "youtube_tool");
        assert!(stale_extractor("ERROR: Unable to extract nsig"));
    }
}

#[cfg(test)]
mod failure_tests {
    use super::*;

    #[test]
    fn a_url_in_the_log_does_not_make_the_failure_a_playlist() {
        let stderr = "[tls @ 0x1] error:0A000086:SSL routines::certificate verify failed\nError opening input file https://manifest.googlevideo.com/api/manifest/hls_playlist/id/x/playlist/index.m3u8\n";
        assert_eq!(classify_failure(stderr).code(), "youtube_tool");
    }

    #[test]
    fn a_quoted_segment_url_is_stripped_too() {
        let stderr = "[in#0] Error when loading first segment 'https://rr5.googlevideo.com/videoplayback/playlist_type/DVR/sq/1'\nError opening input: Input/output error\n";
        assert_eq!(classify_failure(stderr).code(), "youtube_tool");
    }
}
