//! The host's own swarm: librqbit (the fork) with ss-remux's `torrent::local`
//! window, no leases and no disk budget. What comes down stays in the app's
//! data directory, so the next room with the same magnet starts warm.
use std::path::PathBuf;
use std::sync::Arc;
use std::time::Duration;

use anyhow::Context;
use librqbit::dht::DhtPersistenceConfig;
use librqbit::{AddTorrent, AddTorrentOptions, DhtSessionConfig, Session, SessionOptions};
use serde::Serialize;
use ss_remux::torrent::local::Local;
use ss_remux::torrent::{TorrentFiles, TorrentSource};
use ss_remux::ByteSource;

const ADD_TIMEOUT: Duration = Duration::from_secs(90);

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TorrentFile {
    pub index: usize,
    pub path: String,
    pub size: u64,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Opened {
    pub id: String,
    pub name: String,
    pub files: Vec<TorrentFile>,
}

#[derive(Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct Stats {
    pub peers: u64,
    pub down_bps: u64,
    pub downloaded: u64,
    pub progress: f64,
}

fn options(dht: DhtSessionConfig) -> SessionOptions {
    SessionOptions {
        fastresume: true,
        trackers: ss_remux::torrent::tracker_urls(),
        dht: Some(dht),
        ..Default::default()
    }
}

pub struct Torrents {
    local: Arc<Local>,
}

impl Torrents {
    pub async fn new(dir: PathBuf) -> anyhow::Result<Self> {
        std::fs::create_dir_all(&dir)?;
        // The DHT's table lives with the app's own torrents: librqbit's
        // default is one file for every program on the machine built on it,
        // whose remembered port another of them may hold.
        let persisted = DhtSessionConfig {
            persistence: Some(DhtPersistenceConfig { config_filename: Some(dir.join("dht.json")), ..Default::default() }),
            ..Default::default()
        };
        let session = match Session::new_with_opts(dir.clone(), options(persisted)).await {
            Ok(session) => session,
            Err(e) => {
                // A port taken since it was remembered: a fresh one for this run.
                tracing::warn!(error = %format!("{e:#}"), "torrent session with the remembered DHT failed; starting without it");
                let fresh = DhtSessionConfig { persistence: None, ..Default::default() };
                Session::new_with_opts(dir, options(fresh)).await.context("torrent session")?
            }
        };
        Ok(Self { local: Local::new(session) })
    }

    /// Adds the magnet (paused: nothing downloads until a file is picked)
    /// and lists its files.
    pub async fn open(&self, magnet: &str) -> anyhow::Result<Opened> {
        let response = tokio::time::timeout(
            ADD_TIMEOUT,
            self.local.session().add_torrent(
                AddTorrent::from_url(magnet),
                Some(AddTorrentOptions { paused: true, overwrite: true, ..Default::default() }),
            ),
        )
        .await
        .context("torrent metadata timed out")??;
        let handle = response.into_handle().context("no torrent handle")?;
        // A torrent still checking its pieces refuses a file selection.
        tokio::time::timeout(ADD_TIMEOUT, handle.wait_until_initialized())
            .await
            .context("torrent initialization timed out")??;
        let id = handle.info_hash().as_string();
        let files = {
            let guard = handle.metadata.load();
            let meta = guard.as_ref().context("no metadata")?;
            meta.file_infos
                .iter()
                .enumerate()
                .map(|(index, info)| TorrentFile {
                    index,
                    path: info.relative_filename.to_string_lossy().into_owned(),
                    size: info.len,
                })
                .collect()
        };
        Ok(Opened { id, name: handle.name().unwrap_or_default(), files })
    }

    pub async fn select(&self, id: &str, index: usize) -> anyhow::Result<()> {
        self.local.select(id, index).await
    }

    pub fn source(&self, id: &str, index: usize) -> anyhow::Result<Arc<dyn ByteSource>> {
        let files: Arc<dyn TorrentFiles> = self.local.clone();
        Ok(Arc::new(TorrentSource::new(files, id, index)?))
    }

    pub fn stats(&self, id: &str) -> Stats {
        let Ok(hash) = id.parse::<librqbit::dht::Id20>() else { return Stats::default() };
        let Some(handle) = self.local.session().get(librqbit::api::TorrentIdOrHash::Hash(hash)) else { return Stats::default() };
        let stats = handle.stats();
        let (peers, down_bps) = stats
            .live
            .as_ref()
            .map(|live| (live.snapshot.peer_stats.live as u64, live.download_speed.as_bytes()))
            .unwrap_or((0, 0));
        let downloaded = stats.have_bytes.max(stats.progress_bytes);
        let progress = if stats.total_bytes > 0 { stats.progress_bytes as f64 / stats.total_bytes as f64 } else { 0.0 };
        Stats { peers, down_bps, downloaded, progress }
    }
}
