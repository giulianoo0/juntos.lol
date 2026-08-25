mod admission;
mod disk;
mod entry;
mod reaper;
mod slots;

use std::collections::{HashMap, HashSet};
use std::io::SeekFrom;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use anyhow::{anyhow, bail, Context};
use librqbit::{
    AddTorrent, AddTorrentOptions, ConnectionOptions, ListenerMode, ListenerOptions, ManagedTorrent,
    ManagedTorrentState, PeerConnectionOptions, Session, SessionOptions,
};
use serde::Serialize;
use tokio::io::{AsyncReadExt, AsyncSeekExt};

use crate::config::WorkerConfig;
pub use admission::{is_sidecar, LeaseInfo, Rejection};
use disk::DiskAccountant;
use entry::{Entry, Phase};
pub use slots::Prio;

pub type Handle = Arc<ManagedTorrent>;

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

pub const MAX_SIDECAR: u64 = 8 * 1024 * 1024;
const INIT_TIMEOUT: Duration = Duration::from_secs(90);
const READ_CHUNK: usize = 256 * 1024;

pub struct Engine {
    session: Arc<Session>,
    torrents: Mutex<HashMap<String, Entry>>,
    disk: DiskAccountant,
    pub cfg: WorkerConfig,
    draining: AtomicBool,
    permits_in_use: Arc<AtomicU64>,
    // Throwaway streams each hold one of librqbit's blocking permits for
    // their whole life; unbounded they would exhaust the pool and wedge
    // every request, including the inits. Bounded here, refused beyond.
    transients: Arc<tokio::sync::Semaphore>,
}

#[derive(Serialize, Clone, Debug)]
pub struct TorrentDigest {
    pub infohash: String,
    pub name: String,
    pub phase: &'static str,
    #[serde(rename = "haveBytes")]
    pub have_bytes: u64,
    #[serde(rename = "selectedBytes")]
    pub selected_bytes: u64,
    pub peers: u64,
    #[serde(rename = "downSpeed")]
    pub down_speed: u64,
    #[serde(rename = "upSpeed")]
    pub up_speed: u64,
    #[serde(rename = "uploadedBytes")]
    pub uploaded_bytes: u64,
    pub leases: Vec<String>,
    #[serde(rename = "idleSecs")]
    pub idle_secs: u64,
}

#[derive(Serialize, Clone, Debug)]
pub struct EngineSnapshot {
    #[serde(rename = "diskUsed")]
    pub disk_used: u64,
    #[serde(rename = "diskQuota")]
    pub disk_quota: u64,
    pub torrents: Vec<TorrentDigest>,
    pub leases: usize,
    #[serde(rename = "permitsInUse")]
    pub permits_in_use: u64,
    pub draining: bool,
}

/// An open read on one file: a slot's parked stream when the priority class
/// has one, a throwaway stream otherwise.
pub struct Reader {
    slot: Option<Arc<slots::StreamSlot>>,
    stream: Option<tokio::sync::OwnedMutexGuard<slots::BoxStream>>,
    transient: Option<slots::BoxStream>,
    _transient_permit: Option<tokio::sync::OwnedSemaphorePermit>,
    pub position: u64,
    prio: Prio,
    gen_floor: Arc<AtomicU64>,
    permits: Arc<AtomicU64>,
}

impl Reader {
    pub async fn read(&mut self, buf: &mut [u8]) -> anyhow::Result<usize> {
        let n = match (&mut self.stream, &mut self.transient) {
            (Some(s), _) => s.read(buf).await?,
            (None, Some(t)) => t.read(buf).await?,
            _ => unreachable!(),
        };
        self.position += n as u64;
        if let Some(slot) = &self.slot {
            slot.touch(self.position);
        }
        Ok(n)
    }
    /// A hint moved the remux past this response; stop feeding it. Only
    /// playhead reads carry a generation — probes and scans are their own
    /// cursors and never superseded by a seek.
    pub fn superseded(&self, gen: u64) -> bool {
        self.prio == Prio::Playhead && gen < self.gen_floor.load(Ordering::Relaxed)
    }
}

impl Drop for Reader {
    fn drop(&mut self) {
        if self.transient.is_some() {
            self.permits.fetch_sub(1, Ordering::Relaxed);
        }
    }
}

impl Engine {
    pub async fn new(cfg: WorkerConfig) -> anyhow::Result<Arc<Self>> {
        let dir = cfg.data_dir.join("torrents");
        std::fs::create_dir_all(&dir)?;
        let mut opts = SessionOptions {
            fastresume: true,
            trackers: TRACKERS.iter().filter_map(|t| url::Url::parse(t).ok()).collect(),
            runtime_worker_threads: Some(cfg.blocking_threads()),
            peer_limit: Some(cfg.per_torrent_peer_limit),
            ..Default::default()
        };
        opts.listen = Some(ListenerOptions {
            mode: ListenerMode::TcpAndUtp,
            listen_addr: (std::net::Ipv6Addr::UNSPECIFIED, cfg.bt_listen_port).into(),
            enable_upnp_port_forwarding: false,
            ..Default::default()
        });
        opts.connect = Some(ConnectionOptions {
            peer_opts: Some(PeerConnectionOptions {
                connect_timeout: Some(Duration::from_secs(4)),
                read_write_timeout: Some(Duration::from_secs(8)),
                ..Default::default()
            }),
            ..Default::default()
        });
        if cfg.download_bps > 0 {
            opts.ratelimits.download_bps = std::num::NonZeroU32::new(cfg.download_bps);
        }
        let session = Session::new_with_opts(dir.clone(), opts).await?;
        let engine = Arc::new(Self {
            session,
            torrents: Mutex::new(HashMap::new()),
            disk: DiskAccountant::new(cfg.disk_quota_bytes, cfg.high_water_bytes(), dir),
            transients: Arc::new(tokio::sync::Semaphore::new(cfg.max_leases * 2)),
            cfg,
            draining: AtomicBool::new(false),
            permits_in_use: Arc::new(AtomicU64::new(0)),
        });
        engine.adopt_persisted();
        reaper::spawn(Arc::downgrade(&engine));
        Ok(engine)
    }

    // Torrents librqbit restored from its own persistence are bytes on disk
    // the accountant has to know about; they start idle and reap normally.
    fn adopt_persisted(&self) {
        let handles: Vec<Handle> = self.session.with_torrents(|it| it.map(|(_, h)| h.clone()).collect());
        let mut map = self.torrents.lock().unwrap();
        for handle in handles {
            let id = handle.info_hash().as_string();
            let selected = handle.stats().total_bytes;
            self.disk.reserve_unchecked(&id, selected);
            map.insert(id, Entry::new(handle, Phase::Idle, selected));
        }
    }

    pub fn drain(&self) {
        self.draining.store(true, Ordering::Relaxed);
    }
    pub fn draining(&self) -> bool {
        self.draining.load(Ordering::Relaxed)
    }

    pub fn snapshot(&self) -> EngineSnapshot {
        let map = self.torrents.lock().unwrap();
        let torrents = map.iter().map(|(id, e)| e.digest(id)).collect::<Vec<_>>();
        let leases = map.values().map(|e| e.leases.len()).sum();
        EngineSnapshot {
            disk_used: self.disk.used(),
            disk_quota: self.cfg.disk_quota_bytes,
            torrents,
            leases,
            permits_in_use: self.permits_in_use.load(Ordering::Relaxed),
            draining: self.draining(),
        }
    }

    /// Takes a lease on a torrent for a job: admits it, resolves its
    /// metadata, and lists its files. Nothing is downloaded until select.
    pub async fn lease(&self, infohash: &str, lease_id: &str, trackers: &[String]) -> Result<LeaseInfo, Rejection> {
        let infohash = infohash.to_ascii_lowercase();
        if self.draining() {
            return Err(Rejection::Draining);
        }
        if let Some(handle) = self.attach_existing(&infohash, lease_id) {
            let _ = self.session.unpause(&handle).await;
            return admission::lease_info(&handle).map_err(Rejection::Internal);
        }
        admission::admit_counts(self, lease_id)?;
        let magnet = admission::magnet(&infohash, trackers);
        let listed = tokio::time::timeout(
            INIT_TIMEOUT,
            self.session.add_torrent(
                AddTorrent::from_url(&magnet),
                Some(AddTorrentOptions { list_only: true, ..Default::default() }),
            ),
        )
        .await
        .map_err(|_| Rejection::NoMetadata)?
        .map_err(|e| Rejection::Internal(anyhow!(e)))?;
        let listed = match listed {
            librqbit::AddTorrentResponse::ListOnly(l) => l,
            other => {
                // Raced another lease on the same hash, or librqbit still
                // manages a torrent the map forgot; either way this lease
                // attaches to that handle, and the map learns it.
                if let Some(handle) = other.into_handle() {
                    if self.attach_existing(&infohash, lease_id).is_none() {
                        let mut map = self.torrents.lock().unwrap();
                        let entry = map
                            .entry(infohash.clone())
                            .or_insert_with(|| Entry::new(handle.clone(), Phase::Ready, 0));
                        entry.take_lease(lease_id);
                    }
                    return admission::lease_info(&handle).map_err(Rejection::Internal);
                }
                return Err(Rejection::Internal(anyhow!("unexpected add response")));
            }
        };
        admission::screen_video_only(&listed.info)?;
        let mut options = AddTorrentOptions {
            overwrite: true,
            paused: true,
            initial_peers: Some(listed.seen_peers.clone()),
            ..Default::default()
        };
        options.ratelimits.upload_bps = std::num::NonZeroU32::new(self.cfg.upload_bps);
        let response = self
            .session
            .add_torrent(AddTorrent::from_bytes(listed.torrent_bytes.clone()), Some(options))
            .await
            .map_err(|e| Rejection::Internal(anyhow!(e)))?;
        let handle = response.into_handle().ok_or_else(|| Rejection::Internal(anyhow!("no handle")))?;
        if tokio::time::timeout(INIT_TIMEOUT, handle.wait_until_initialized()).await.is_err() {
            let _ = self.session.delete(handle.id().into(), true).await;
            return Err(Rejection::NoMetadata);
        }
        let info = admission::lease_info(&handle).map_err(Rejection::Internal)?;
        let mut map = self.torrents.lock().unwrap();
        let entry = map
            .entry(infohash.clone())
            .or_insert_with(|| Entry::new(handle.clone(), Phase::Ready, 0));
        entry.take_lease(lease_id);
        Ok(info)
    }

    fn attach_existing(&self, infohash: &str, lease_id: &str) -> Option<Handle> {
        let mut map = self.torrents.lock().unwrap();
        let entry = map.get_mut(infohash)?;
        entry.take_lease(lease_id);
        Some(entry.handle.clone())
    }

    /// Selects the file a lease will read, plus the sidecar subtitles beside
    /// it, reserving the disk they will take before a byte downloads.
    pub async fn select(&self, infohash: &str, file_index: usize) -> Result<u64, Rejection> {
        let infohash = infohash.to_ascii_lowercase();
        let handle = self.handle(&infohash).ok_or(Rejection::Unknown)?;
        let previously = self
            .torrents
            .lock()
            .unwrap()
            .get(&infohash)
            .map(|e| e.ever_selected.clone())
            .unwrap_or_default();
        let (only, selected_bytes, reserve_bytes, ever) = {
            let guard = handle.metadata.load();
            let meta = guard.as_ref().ok_or_else(|| Rejection::Internal(anyhow!("no metadata")))?;
            let mut only = HashSet::new();
            let mut total = 0u64;
            for (index, info) in meta.file_infos.iter().enumerate() {
                let name = info.relative_filename.to_string_lossy();
                if index == file_index || admission::is_sidecar(&name, info.len) {
                    only.insert(index);
                    total += info.len;
                }
            }
            if !only.contains(&file_index) {
                return Err(Rejection::NoSuchFile);
            }
            // Deselecting a file does not delete what it already downloaded,
            // so the reservation covers every file ever selected here.
            let mut ever = previously;
            ever.extend(only.iter().copied());
            let reserve: u64 = ever.iter().filter_map(|i| meta.file_infos.get(*i)).map(|f| f.len).sum();
            (only, total, reserve, ever)
        };
        let before = self.disk.reserved(&infohash);
        if !self.disk.reserve(&infohash, reserve_bytes) {
            self.evict_idle_until_room(reserve_bytes).await;
            if !self.disk.reserve(&infohash, reserve_bytes) {
                return Err(Rejection::DiskFull);
            }
        }
        if let Err(e) = self.session.update_only_files(&handle, &only).await {
            self.disk.reserve_unchecked(&infohash, before);
            return Err(Rejection::Internal(anyhow!(e)));
        }
        let _ = self.session.unpause(&handle).await;
        if let Some(entry) = self.torrents.lock().unwrap().get_mut(&infohash) {
            entry.selected_bytes = selected_bytes;
            entry.selected_file = Some(file_index);
            entry.ever_selected = ever;
            entry.phase = Phase::Serving;
            entry.touch();
        }
        Ok(selected_bytes)
    }

    /// Releases a lease. The torrent stays hot for a grace period: a page
    /// reload or a failover comes back to warm pieces.
    pub async fn release(&self, infohash: &str, lease_id: &str) {
        let infohash = infohash.to_ascii_lowercase();
        let mut map = self.torrents.lock().unwrap();
        if let Some(entry) = map.get_mut(&infohash) {
            entry.leases.remove(lease_id);
            entry.touch();
        }
    }

    pub fn file_size(&self, infohash: &str, index: usize) -> anyhow::Result<u64> {
        let handle = self.handle(infohash).context("unknown torrent")?;
        let guard = handle.metadata.load();
        let meta = guard.as_ref().context("no metadata")?;
        meta.file_infos.get(index).map(|f| f.len).context("no such file")
    }

    pub fn file_name(&self, infohash: &str, index: usize) -> anyhow::Result<String> {
        let handle = self.handle(infohash).context("unknown torrent")?;
        let guard = handle.metadata.load();
        let meta = guard.as_ref().context("no metadata")?;
        meta.file_infos
            .get(index)
            .map(|f| f.relative_filename.to_string_lossy().to_string())
            .context("no such file")
    }

    /// Opens a read at `start`. The playhead and scan classes park their
    /// stream in a slot so librqbit's priority window keeps following them
    /// between requests; head probes use a throwaway stream.
    ///
    /// A torrent still paused or checking its files cannot open a stream
    /// yet; that window follows every select and is seconds long, so the
    /// open waits it out instead of bouncing the client through a 503.
    pub async fn open(&self, infohash: &str, index: usize, start: u64, prio: Prio) -> anyhow::Result<Reader> {
        let handle = self.touch(infohash).context("unknown torrent")?;
        let live_deadline = tokio::time::Instant::now() + Duration::from_secs(25);
        loop {
            if handle.with_state(|s| matches!(s, ManagedTorrentState::Error(_))) {
                bail!("torrent failed");
            }
            if handle.live().is_some() {
                break;
            }
            if tokio::time::Instant::now() >= live_deadline {
                bail!("torrent not live");
            }
            tokio::time::sleep(Duration::from_millis(300)).await;
        }
        let size = self.file_size(infohash, index)?;
        if start >= size {
            bail!("start past end");
        }
        let gen_floor = self
            .torrents
            .lock()
            .unwrap()
            .get(infohash)
            .map(|e| e.gen_floor.clone())
            .context("unknown torrent")?;
        if prio != Prio::Head && size >= slots::MIN_POOLED_FILE {
            let slot = self.slot(infohash, &handle, index, prio, start).await?;
            if let Ok(mut stream) = slot.stream.clone().try_lock_owned() {
                stream.seek(SeekFrom::Start(start)).await?;
                slot.touch(start);
                return Ok(Reader {
                    slot: Some(slot),
                    stream: Some(stream),
                    transient: None,
                    _transient_permit: None,
                    position: start,
                    prio,
                    gen_floor,
                    permits: self.permits_in_use.clone(),
                });
            }
        }
        let permit = self.transients.clone().try_acquire_owned().map_err(|_| anyhow!("too many readers"))?;
        let mut stream = tokio::time::timeout(Duration::from_secs(10), handle.clone().stream(index))
            .await
            .context("stream open timed out")?
            .context("stream")?;
        stream.seek(SeekFrom::Start(start)).await?;
        self.permits_in_use.fetch_add(1, Ordering::Relaxed);
        Ok(Reader {
            slot: None,
            stream: None,
            transient: Some(Box::new(stream)),
            _transient_permit: Some(permit),
            position: start,
            prio,
            gen_floor,
            permits: self.permits_in_use.clone(),
        })
    }

    async fn slot(
        &self,
        infohash: &str,
        handle: &Handle,
        index: usize,
        prio: Prio,
        start: u64,
    ) -> anyhow::Result<Arc<slots::StreamSlot>> {
        let key = (index, prio);
        {
            let map = self.torrents.lock().unwrap();
            let entry = map.get(infohash).context("unknown torrent")?;
            if let Some(slot) = entry.slots.get(&key) {
                return Ok(slot.clone());
            }
        }
        let stream = tokio::time::timeout(Duration::from_secs(10), handle.clone().stream(index))
            .await
            .context("stream open timed out")?
            .context("stream")?;
        let slot = Arc::new(slots::StreamSlot::new(Box::new(stream), start));
        let mut map = self.torrents.lock().unwrap();
        let entry = map.get_mut(infohash).context("unknown torrent")?;
        Ok(entry.slots.entry(key).or_insert(slot).clone())
    }

    /// The remux reader moved: point the playhead slot there so the swarm
    /// fetches ahead of it, and stop feeding responses from before `gen`.
    pub async fn hint(&self, infohash: &str, index: usize, read_offset: u64, gen: u64) -> anyhow::Result<()> {
        let handle = self.touch(infohash).context("unknown torrent")?;
        let size = self.file_size(infohash, index)?;
        let offset = read_offset.min(size.saturating_sub(1));
        let slot = self.slot(infohash, &handle, index, Prio::Playhead, offset).await?;
        {
            let map = self.torrents.lock().unwrap();
            if let Some(entry) = map.get(infohash) {
                entry.gen_floor.fetch_max(gen, Ordering::Relaxed);
            }
        }
        // A busy slot is a response in flight for the old region; it notices
        // the floor on its next chunk and ends, freeing the slot to move.
        if let Ok(mut stream) = slot.stream.clone().try_lock_owned() {
            stream.seek(SeekFrom::Start(offset)).await?;
            slot.touch(offset);
        }
        Ok(())
    }

    /// The raw piece bitfield, for the buffered-ranges bar.
    pub fn haves(&self, infohash: &str) -> anyhow::Result<(Vec<u8>, u32, u64)> {
        let handle = self.handle(infohash).context("unknown torrent")?;
        let piece_len = handle.with_metadata(|m| m.lengths().default_piece_length() as u64)?;
        let (bits, total) = handle
            .with_chunk_tracker(|chunks| {
                let bf = chunks.get_have_pieces();
                (bf.as_bytes().to_vec(), chunks.get_lengths().total_pieces())
            })
            .context("torrent not live")?;
        Ok((bits, total, piece_len))
    }

    async fn evict_idle_until_room(&self, need: u64) {
        let candidates: Vec<(String, Handle)> = {
            let map = self.torrents.lock().unwrap();
            let mut idle: Vec<_> = map
                .iter()
                .filter(|(_, e)| e.leases.is_empty())
                .map(|(id, e)| (e.last_active, id.clone(), e.handle.clone()))
                .collect();
            idle.sort_by_key(|(at, _, _)| *at);
            idle.into_iter().map(|(_, id, h)| (id, h)).collect()
        };
        for (id, handle) in candidates {
            if self.disk.room_for(need) {
                break;
            }
            self.reap(&id, &handle).await;
        }
    }

    pub(crate) async fn reap(&self, infohash: &str, handle: &Handle) {
        let removed = {
            let mut map = self.torrents.lock().unwrap();
            match map.get(infohash) {
                Some(e) if e.leases.is_empty() => map.remove(infohash).is_some(),
                _ => false,
            }
        };
        if !removed {
            return;
        }
        tracing::info!(infohash, "reaping torrent");
        let _ = self.session.delete(handle.id().into(), true).await;
        self.disk.release(infohash);
    }

    /// Pauses an idle torrent, unless a lease arrived meanwhile — the pause
    /// runs outside the lock, so the decision is re-taken after it.
    pub(crate) async fn pause_if_idle(&self, infohash: &str, handle: &Handle) {
        let _ = self.session.pause(handle).await;
        let still_idle = {
            let mut map = self.torrents.lock().unwrap();
            match map.get_mut(infohash) {
                Some(entry) if entry.leases.is_empty() => {
                    entry.phase = Phase::Idle;
                    entry.slots.clear();
                    true
                }
                _ => false,
            }
        };
        if !still_idle {
            let _ = self.session.unpause(handle).await;
        }
    }

    /// A torrent librqbit gave up on (ENOSPC, a storage error) gets one
    /// restart in place; a second failure is final and the room's reads
    /// fail fast instead of waiting on pieces that will never come.
    pub(crate) async fn retry_failed(&self) {
        let failed: Vec<(String, Handle, bool)> = {
            let map = self.torrents.lock().unwrap();
            map.iter()
                .filter(|(_, e)| e.handle.with_state(|s| matches!(s, ManagedTorrentState::Error(_))))
                .map(|(id, e)| (id.clone(), e.handle.clone(), e.retried))
                .collect()
        };
        for (id, handle, retried) in failed {
            if retried {
                continue;
            }
            let error = handle.with_state(|s| match s {
                ManagedTorrentState::Error(e) => format!("{e:#}"),
                _ => String::new(),
            });
            tracing::warn!(infohash = %id, error, "torrent failed; restarting once");
            if let Some(entry) = self.torrents.lock().unwrap().get_mut(&id) {
                entry.retried = true;
            }
            let _ = self.session.unpause(&handle).await;
        }
    }

    pub(crate) fn idle_candidates(&self) -> Vec<(String, Handle, Phase, Duration)> {
        let map = self.torrents.lock().unwrap();
        map.iter()
            .filter(|(_, e)| e.leases.is_empty())
            .map(|(id, e)| (id.clone(), e.handle.clone(), e.phase, e.last_active.elapsed()))
            .collect()
    }

    pub(crate) fn set_phase(&self, infohash: &str, phase: Phase) {
        if let Some(entry) = self.torrents.lock().unwrap().get_mut(infohash) {
            entry.phase = phase;
            entry.slots.clear();
        }
    }

    pub(crate) fn lease_count(&self) -> usize {
        self.torrents.lock().unwrap().values().map(|e| e.leases.len()).sum()
    }
    pub(crate) fn torrent_count(&self) -> usize {
        self.torrents.lock().unwrap().len()
    }
    pub(crate) fn max_torrents(&self) -> usize {
        self.cfg.max_torrents
    }
    pub(crate) fn max_leases(&self) -> usize {
        self.cfg.max_leases
    }

    pub fn expire_stale_leases(&self, ttl: Duration) {
        let mut map = self.torrents.lock().unwrap();
        for entry in map.values_mut() {
            let before = entry.leases.len();
            entry.leases.retain(|_, at| at.elapsed() < ttl);
            if entry.leases.len() != before {
                entry.touch();
            }
        }
    }

    pub fn renew_lease(&self, infohash: &str, lease_id: &str) -> bool {
        let mut map = self.torrents.lock().unwrap();
        match map.get_mut(&infohash.to_ascii_lowercase()) {
            Some(entry) if entry.leases.contains_key(lease_id) => {
                entry.leases.insert(lease_id.to_string(), Instant::now());
                entry.touch();
                true
            }
            _ => false,
        }
    }

    fn touch(&self, infohash: &str) -> Option<Handle> {
        let mut map = self.torrents.lock().unwrap();
        let entry = map.get_mut(infohash)?;
        entry.touch();
        Some(entry.handle.clone())
    }

    fn handle(&self, infohash: &str) -> Option<Handle> {
        self.torrents.lock().unwrap().get(infohash).map(|e| e.handle.clone())
    }

    pub fn read_chunk_size(&self) -> usize {
        READ_CHUNK
    }
}
