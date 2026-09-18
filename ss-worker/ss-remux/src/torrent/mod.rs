//! A torrent as remux input, for the fleet's engine and the host's own
//! session alike: the piece window around the readers, the fill behind a
//! quiet one, and the byte source the bridge reads.
pub mod fill;
pub mod local;
pub mod window;

use std::sync::Arc;

use anyhow::Context;
use async_trait::async_trait;

pub use librqbit;

use crate::source::{ByteSource, SourceReader};

pub const TRACKERS: &[&str] = &[
    "udp://tracker.opentrackr.org:1337/announce",
    "udp://open.tracker.cl:1337/announce",
    "udp://open.demonii.com:1337/announce",
    "udp://tracker.torrent.eu.org:451/announce",
    "udp://exodus.desync.com:6969/announce",
    "udp://open.stealth.si:80/announce",
    "udp://tracker.tiny-vps.com:6969/announce",
    "udp://explodie.org:6969/announce",
    "udp://tracker.dler.org:6969/announce",
    "udp://tracker.openbittorrent.com:6969/announce",
    "udp://tracker.moeking.me:6969/announce",
    "https://tracker.tamersunion.org:443/announce",
    "udp://tracker1.bt.moack.co.kr:80/announce",
    "udp://tracker.bittor.pw:1337/announce",
];

pub fn tracker_urls() -> std::collections::HashSet<url::Url> {
    TRACKERS.iter().filter_map(|t| url::Url::parse(t).ok()).collect()
}

/// Whoever holds the torrents: opens a file at the playhead's priority.
#[async_trait]
pub trait TorrentFiles: Send + Sync {
    fn file_size(&self, infohash: &str, index: usize) -> anyhow::Result<u64>;
    fn read_chunk_size(&self) -> usize {
        256 * 1024
    }
    async fn open_playhead(
        &self,
        infohash: &str,
        reader: &str,
        index: usize,
        position: u64,
    ) -> anyhow::Result<Box<dyn SourceReader>>;
}

/// One file of a torrent as the remux reads it, reopened by the bridge at
/// every stride.
pub struct TorrentSource {
    files: Arc<dyn TorrentFiles>,
    infohash: String,
    file_index: usize,
    size: u64,
}

impl TorrentSource {
    pub fn new(files: Arc<dyn TorrentFiles>, infohash: &str, file_index: usize) -> anyhow::Result<Self> {
        let size = files.file_size(infohash, file_index).context("unknown file")?;
        Ok(Self { files, infohash: infohash.into(), file_index, size })
    }
}

#[async_trait]
impl ByteSource for TorrentSource {
    fn size(&self) -> u64 {
        self.size
    }

    fn chunk_size(&self) -> usize {
        self.files.read_chunk_size()
    }

    async fn open(&self, reader: &str, position: u64) -> anyhow::Result<Box<dyn SourceReader>> {
        self.files.open_playhead(&self.infohash, reader, self.file_index, position).await
    }
}
