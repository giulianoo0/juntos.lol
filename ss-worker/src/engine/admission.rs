use anyhow::Context;
use serde::Serialize;

use super::{Engine, Handle, MAX_SIDECAR};

#[derive(Debug)]
pub enum Rejection {
    Draining,
    TooManyTorrents,
    TooManyLeases,
    DiskFull,
    NoMetadata,
    NotVideo,
    NoSuchFile,
    Unknown,
    Internal(anyhow::Error),
}

impl Rejection {
    pub fn code(&self) -> &'static str {
        match self {
            Rejection::Draining => "draining",
            Rejection::TooManyTorrents => "too_many_torrents",
            Rejection::TooManyLeases => "too_many_leases",
            Rejection::DiskFull => "disk_full",
            Rejection::NoMetadata => "no_metadata",
            Rejection::NotVideo => "not_video",
            Rejection::NoSuchFile => "no_such_file",
            Rejection::Unknown => "unknown_torrent",
            Rejection::Internal(_) => "internal",
        }
    }
}

impl std::fmt::Display for Rejection {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Rejection::Internal(e) => write!(f, "internal: {e:#}"),
            other => f.write_str(other.code()),
        }
    }
}

#[derive(Serialize, Clone, Debug)]
pub struct FileEntry {
    pub index: usize,
    pub name: String,
    pub path: String,
    pub size: u64,
}

#[derive(Serialize, Clone, Debug)]
pub struct LeaseInfo {
    pub infohash: String,
    pub name: String,
    pub files: Vec<FileEntry>,
}

pub fn admit_counts(engine: &Engine, _lease_id: &str) -> Result<(), Rejection> {
    if engine.torrent_count() >= engine.max_torrents() {
        return Err(Rejection::TooManyTorrents);
    }
    if engine.lease_count() >= engine.max_leases() {
        return Err(Rejection::TooManyLeases);
    }
    Ok(())
}

pub fn magnet(infohash: &str, trackers: &[String]) -> String {
    let mut m = format!("magnet:?xt=urn:btih:{infohash}");
    for t in trackers.iter().take(20) {
        m.push_str("&tr=");
        m.push_str(&urlencode(t));
    }
    m
}

fn urlencode(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for b in s.bytes() {
        match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => out.push(b as char),
            _ => out.push_str(&format!("%{b:02X}")),
        }
    }
    out
}

const VIDEO_EXT: &[&str] = &["mkv", "mp4", "m4v", "webm", "mov", "avi", "ts", "m2ts", "wmv", "flv"];
const SIDECAR_EXT: &[&str] = &["srt", "ass", "ssa", "vtt", "sub", "idx"];

fn ext(name: &str) -> String {
    name.rsplit('.').next().map(|e| e.to_ascii_lowercase()).unwrap_or_default()
}

pub fn is_video(name: &str) -> bool {
    VIDEO_EXT.contains(&ext(name).as_str())
}

pub fn is_sidecar(name: &str, size: u64) -> bool {
    size > 0 && size <= MAX_SIDECAR && SIDECAR_EXT.contains(&ext(name).as_str())
}

/// Passes when the torrent's bytes are overwhelmingly video, with sidecar
/// subtitles and small extras tolerated.
pub fn screen_video_only(info: &librqbit::ValidatedTorrentMetaV1Info<librqbit::ByteBufOwned>) -> Result<(), Rejection> {
    let mut video = 0u64;
    let mut total = 0u64;
    for file in info.iter_file_details() {
        if file.attrs().padding {
            continue;
        }
        let name = file.filename.to_string();
        total += file.len;
        if is_video(&name) {
            video += file.len;
        }
    }
    if video == 0 || video * 10 < total * 8 {
        return Err(Rejection::NotVideo);
    }
    Ok(())
}

pub fn lease_info(handle: &Handle) -> anyhow::Result<LeaseInfo> {
    let guard = handle.metadata.load();
    let meta = guard.as_ref().context("no metadata")?;
    let files = meta
        .file_infos
        .iter()
        .enumerate()
        .map(|(index, info)| {
            let path = info.relative_filename.to_string_lossy().to_string();
            let name = info
                .relative_filename
                .file_name()
                .map(|n| n.to_string_lossy().to_string())
                .unwrap_or_else(|| path.clone());
            FileEntry { index, name, path, size: info.len }
        })
        .collect();
    Ok(LeaseInfo {
        infohash: handle.info_hash().as_string(),
        name: handle.name().unwrap_or_else(|| "torrent".into()),
        files,
    })
}
