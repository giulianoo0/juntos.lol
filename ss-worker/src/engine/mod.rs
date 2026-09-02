mod admission;
mod disk;
mod entry;
mod fill;
mod floors;
mod reaper;
mod slots;
mod window;

use std::collections::{HashMap, HashSet};
use std::io::SeekFrom;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::Arc;
use parking_lot::Mutex;
use std::time::{Duration, Instant};

use anyhow::{anyhow, bail, Context};
use librqbit::{
    AddTorrent, AddTorrentOptions, ConnectionOptions, ListenerMode, ListenerOptions,
    ManagedTorrent, ManagedTorrentState, PeerConnectionOptions, Session, SessionOptions,
};
use serde::Serialize;
use tokio::io::{AsyncReadExt, AsyncSeekExt};

use crate::config::WorkerConfig;
pub use admission::{is_sidecar, LeaseInfo, Rejection};
use disk::DiskAccountant;
use entry::{Entry, Phase};
use fill::Fill;
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
const TRACKER_INTERVAL: Duration = Duration::from_secs(30);

pub struct Engine {
    session: Arc<Session>,
    torrents: Mutex<HashMap<String, Entry>>,
    disk: DiskAccountant,
    pub cfg: WorkerConfig,
    draining: AtomicBool,
    permits_in_use: Arc<AtomicU64>,
    releasing: bool,
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
    #[serde(rename = "diskBytes")]
    pub disk_bytes: u64,
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
    #[serde(rename = "diskReal")]
    pub disk_real: u64,
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
    /// A hint moved this reader past this response; stop feeding it. Only
    /// playhead reads carry a generation, and the floor is the reader's own.
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

/// Gives the filesystem back the blocks behind pieces the torrent gave up.
/// A hole, not a truncation: the file keeps its length. Linux only; a no-op
/// everywhere else.
#[cfg(target_os = "linux")]
fn punch_holes(
    path: &std::path::Path,
    file_offset: u64,
    file_len: u64,
    pieces: &[u32],
    piece_len: u64,
) -> u64 {
    use std::os::unix::io::AsRawFd;

    let file = match std::fs::OpenOptions::new().write(true).open(path) {
        Ok(f) => f,
        Err(e) => {
            tracing::debug!(path = %path.display(), error = %e, "could not open to release blocks");
            return 0;
        }
    };
    let mut freed = 0u64;
    for (start, end) in merge_piece_ranges(pieces, piece_len) {
        let start = start.max(file_offset) - file_offset;
        let end = (end.min(file_offset + file_len)).saturating_sub(file_offset);
        if end <= start {
            continue;
        }
        let mode = libc::FALLOC_FL_PUNCH_HOLE | libc::FALLOC_FL_KEEP_SIZE;
        // SAFETY: a live descriptor, and an offset and length that fit i64 for
        // any file size a torrent can carry.
        let rc = unsafe {
            libc::fallocate(
                file.as_raw_fd(),
                mode,
                start as libc::off_t,
                (end - start) as libc::off_t,
            )
        };
        if rc != 0 {
            tracing::debug!(path = %path.display(), error = %std::io::Error::last_os_error(), "could not punch a hole");
            return freed;
        }
        freed += end - start;
    }
    freed
}

#[cfg(not(target_os = "linux"))]
fn punch_holes(
    _path: &std::path::Path,
    _file_offset: u64,
    _file_len: u64,
    _pieces: &[u32],
    _piece_len: u64,
) -> u64 {
    0
}

/// Torrent-absolute byte ranges for a set of pieces, sorted and merged, so a
/// window that gave up a thousand pieces costs a handful of syscalls.
#[cfg_attr(not(target_os = "linux"), allow(dead_code))]
fn merge_piece_ranges(pieces: &[u32], piece_len: u64) -> Vec<(u64, u64)> {
    if pieces.is_empty() || piece_len == 0 {
        return Vec::new();
    }
    let mut sorted: Vec<u32> = pieces.to_vec();
    sorted.sort_unstable();
    let mut merged: Vec<(u64, u64)> = Vec::new();
    for piece in sorted {
        let start = piece as u64 * piece_len;
        let end = start + piece_len;
        match merged.last_mut() {
            Some(last) if start <= last.1 => last.1 = last.1.max(end),
            _ => merged.push((start, end)),
        }
    }
    merged
}

#[cfg(test)]
mod release_tests {
    use super::merge_piece_ranges;

    #[test]
    fn merges_runs_and_leaves_gaps_alone() {
        assert_eq!(merge_piece_ranges(&[3, 1, 2], 100), vec![(100, 400)]);
        assert_eq!(merge_piece_ranges(&[0, 5], 100), vec![(0, 100), (500, 600)]);
        assert_eq!(merge_piece_ranges(&[7], 1 << 20), vec![(7 << 20, 8 << 20)]);
        assert!(merge_piece_ranges(&[], 100).is_empty());
        assert!(merge_piece_ranges(&[1], 0).is_empty());
    }
}

/// Whether this filesystem gives blocks back, asked by actually doing it.
fn punch_works(dir: &std::path::Path) -> bool {
    #[cfg(target_os = "linux")]
    {
        use std::io::Write;
        use std::os::unix::io::AsRawFd;
        let path = dir.join(".punch-probe");
        let ok = (|| -> std::io::Result<bool> {
            let mut file = std::fs::File::create(&path)?;
            file.write_all(&[0u8; 65536])?;
            let mode = libc::FALLOC_FL_PUNCH_HOLE | libc::FALLOC_FL_KEEP_SIZE;
            // SAFETY: a live descriptor and a range inside the file just written.
            Ok(unsafe { libc::fallocate(file.as_raw_fd(), mode, 0, 65536) } == 0)
        })()
        .unwrap_or(false);
        let _ = std::fs::remove_file(&path);
        if !ok {
            tracing::warn!(dir = %dir.display(), "this filesystem will not hand blocks back; torrents keep every piece they fetch");
        }
        ok
    }
    #[cfg(not(target_os = "linux"))]
    {
        let _ = dir;
        false
    }
}

impl Engine {
    pub async fn new(cfg: WorkerConfig) -> anyhow::Result<Arc<Self>> {
        let dir = cfg.data_dir.join("torrents");
        if dir.exists() {
            match std::fs::remove_dir_all(&dir) {
                Ok(()) => {
                    tracing::info!(dir = %dir.display(), "cleared torrent data left by the previous run")
                }
                Err(e) => {
                    tracing::warn!(dir = %dir.display(), error = %e, "could not clear leftover torrent data")
                }
            }
        }
        std::fs::create_dir_all(&dir)?;
        let mut opts = SessionOptions {
            fastresume: true,
            trackers: TRACKERS
                .iter()
                .filter_map(|t| url::Url::parse(t).ok())
                .collect(),
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
            disk: DiskAccountant::new(cfg.disk_quota_bytes, cfg.high_water_bytes(), dir.clone()),
            transients: Arc::new(tokio::sync::Semaphore::new(cfg.max_leases * 2)),
            cfg,
            draining: AtomicBool::new(false),
            permits_in_use: Arc::new(AtomicU64::new(0)),
            releasing: punch_works(&dir),
        });
        reaper::spawn(Arc::downgrade(&engine));
        Ok(engine)
    }

    pub fn drain(&self) {
        self.draining.store(true, Ordering::Relaxed);
    }
    pub fn draining(&self) -> bool {
        self.draining.load(Ordering::Relaxed)
    }

    fn can_release(&self) -> bool {
        self.releasing
    }

    pub fn snapshot(&self) -> EngineSnapshot {
        let map = self.torrents.lock();
        let torrents = map.iter().map(|(id, e)| e.digest(id)).collect::<Vec<_>>();
        let leases = map.values().map(|e| e.leases.len()).sum();
        EngineSnapshot {
            disk_used: self.disk.used().max(self.disk.real_used()),
            disk_real: self.disk.real_used(),
            disk_quota: self.cfg.disk_quota_bytes,
            torrents,
            leases,
            permits_in_use: self.permits_in_use.load(Ordering::Relaxed),
            draining: self.draining(),
        }
    }

    /// Takes a lease on a torrent for a job: admits it, resolves its
    /// metadata, and lists its files. Nothing is downloaded until select.
    pub async fn lease(
        &self,
        infohash: &str,
        lease_id: &str,
        trackers: &[String],
    ) -> Result<LeaseInfo, Rejection> {
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
                Some(AddTorrentOptions {
                    list_only: true,
                    force_tracker_interval: Some(TRACKER_INTERVAL),
                    ..Default::default()
                }),
            ),
        )
        .await
        .map_err(|_| Rejection::NoMetadata)?
        .map_err(|e| Rejection::Internal(anyhow!(e)))?;
        let listed = match listed {
            librqbit::AddTorrentResponse::ListOnly(l) => l,
            other => {
                if let Some(handle) = other.into_handle() {
                    if self.attach_existing(&infohash, lease_id).is_none() {
                        let mut map = self.torrents.lock();
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
            force_tracker_interval: Some(TRACKER_INTERVAL),
            ..Default::default()
        };
        options.ratelimits.upload_bps = std::num::NonZeroU32::new(self.cfg.upload_bps);
        let response = self
            .session
            .add_torrent(
                AddTorrent::from_bytes(listed.torrent_bytes.clone()),
                Some(options),
            )
            .await
            .map_err(|e| Rejection::Internal(anyhow!(e)))?;
        let handle = response
            .into_handle()
            .ok_or_else(|| Rejection::Internal(anyhow!("no handle")))?;
        if tokio::time::timeout(INIT_TIMEOUT, handle.wait_until_initialized())
            .await
            .is_err()
        {
            let _ = self.session.delete(handle.id().into(), true).await;
            return Err(Rejection::NoMetadata);
        }
        let info = admission::lease_info(&handle).map_err(Rejection::Internal)?;
        let mut map = self.torrents.lock();
        let entry = map
            .entry(infohash.clone())
            .or_insert_with(|| Entry::new(handle.clone(), Phase::Ready, 0));
        entry.take_lease(lease_id);
        Ok(info)
    }

    fn attach_existing(&self, infohash: &str, lease_id: &str) -> Option<Handle> {
        let mut map = self.torrents.lock();
        let entry = map.get_mut(infohash)?;
        entry.take_lease(lease_id);
        Some(entry.handle.clone())
    }

    /// Selects the file a lease will read, plus the sidecar subtitles beside
    /// it, reserving the disk they will take before a byte downloads.
    pub async fn select(&self, infohash: &str, file_index: usize) -> Result<u64, Rejection> {
        let infohash = infohash.to_ascii_lowercase();
        let handle = self.handle(&infohash).ok_or(Rejection::Unknown)?;
        let (previously, filling) = self
            .torrents
            .lock()
            .get(&infohash)
            .map(|e| (e.ever_selected.clone(), e.fill.reserves_file()))
            .unwrap_or_default();
        let (only, selected_bytes, reserve_bytes, ever) = {
            let guard = handle.metadata.load();
            let meta = guard
                .as_ref()
                .ok_or_else(|| Rejection::Internal(anyhow!("no metadata")))?;
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
            let mut ever = previously;
            ever.extend(only.iter().copied());
            let reserve: u64 = only
                .iter()
                .filter_map(|i| meta.file_infos.get(*i))
                .map(|f| if filling { f.len } else { window::footprint(f.len, window::AHEAD, window::BEHIND, window::PIN) })
                .sum();
            (only, total, reserve, ever)
        };
        let before = self.disk.reserved(&infohash);
        if !self.disk.reserve(&infohash, reserve_bytes) {
            self.shed_fill(reserve_bytes);
        }
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
        if let Some(entry) = self.torrents.lock().get_mut(&infohash) {
            entry.selected_bytes = selected_bytes;
            entry.selected_file = Some(file_index);
            entry.ever_selected = ever;
            entry.phase = Phase::Serving;
            entry.touch();
        }
        self.apply_window(&infohash);
        Ok(selected_bytes)
    }

    /// Releases a lease. The torrent stays hot for a grace period; the LAST
    /// lease going stops the fill and gives back everything outside the pins.
    pub async fn release(&self, infohash: &str, lease_id: &str) {
        let infohash = infohash.to_ascii_lowercase();
        let drop_fill = {
            let mut map = self.torrents.lock();
            let Some(entry) = map.get_mut(&infohash) else { return };
            entry.leases.remove(lease_id);
            entry.touch();
            if entry.leases.is_empty() && entry.fill != Fill::Off {
                entry.fill = Fill::Off;
                true
            } else {
                entry.leases.is_empty()
            }
        };
        if drop_fill {
            self.drop_to_pins(&infohash);
        }
    }

    fn drop_to_pins(&self, infohash: &str) {
        let Some(handle) = self.handle(infohash) else { return };
        let index = {
            let map = self.torrents.lock();
            match map.get(infohash).and_then(|e| e.selected_file) {
                Some(index) => index,
                None => return,
            }
        };
        let guard = handle.metadata.load();
        let Some(meta) = guard.as_ref() else { return };
        let Some(info) = meta.file_infos.get(index) else { return };
        let lengths = meta.lengths();
        let piece_len = lengths.default_piece_length() as u64;
        let ranges = window::needed_ranges_for(info.len, &[], window::PIN);
        let pieces = window::pieces_for_ranges(info.offset_in_torrent, piece_len, lengths.total_pieces(), &ranges);
        if pieces.is_empty() {
            return;
        }
        if handle.update_selected_pieces(&pieces).is_err() {
            return;
        }
        self.release_behind_window(infohash, &handle, info, &pieces, piece_len);
        self.disk.reserve_unchecked(
            infohash,
            window::footprint(info.len, window::AHEAD, window::BEHIND, window::PIN),
        );
        tracing::info!(infohash, "last lease gone; dropped to pins");
    }

    pub fn file_size(&self, infohash: &str, index: usize) -> anyhow::Result<u64> {
        let handle = self.handle(infohash).context("unknown torrent")?;
        let guard = handle.metadata.load();
        let meta = guard.as_ref().context("no metadata")?;
        meta.file_infos
            .get(index)
            .map(|f| f.len)
            .context("no such file")
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
    /// stream in a slot; head probes use a throwaway stream. A torrent still
    /// paused or checking its files is waited out rather than refused.
    pub async fn open(
        &self,
        infohash: &str,
        reader: &str,
        index: usize,
        start: u64,
        prio: Prio,
    ) -> anyhow::Result<Reader> {
        let handle = self.touch(infohash).context("unknown torrent")?;
        let live_deadline = tokio::time::Instant::now() + Duration::from_secs(25);
        let mut unpaused = false;
        loop {
            if handle.with_state(|s| matches!(s, ManagedTorrentState::Error(_))) {
                bail!("torrent failed");
            }
            if handle.live().is_some() {
                break;
            }
            if !unpaused && handle.is_paused() {
                unpaused = true;
                let _ = self.session.unpause(&handle).await;
                continue;
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
            .get_mut(infohash)
            .map(|e| e.floors.of(reader))
            .context("unknown torrent")?;
        if prio != Prio::Head && size >= slots::MIN_POOLED_FILE {
            let slot = self.slot(infohash, &handle, index, prio, start).await?;
            if let Ok(mut stream) = slot.stream.clone().try_lock_owned() {
                stream.seek(SeekFrom::Start(start)).await?;
                slot.touch(start);
                slot.clear_wanted();
                let (windowed_at, startup) = slot.windowed();
                let moved = start.abs_diff(windowed_at) > window::BEHIND;
                let startup_over = startup && slot.since_hint().is_none_or(|since| since >= window::STARTUP);
                if moved {
                    slot.mark_moved();
                    self.reader_moved(infohash);
                }
                if moved || startup_over {
                    self.apply_window_with(infohash, false);
                }
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
        if prio == Prio::Playhead && size >= slots::MIN_POOLED_FILE {
            if let Some(slot) = self.existing_slot(infohash, index, prio) {
                if slot.cursor().abs_diff(start) > window::BEHIND {
                    slot.set_wanted(start);
                    slot.keep_alive();
                    slot.mark_moved();
                    self.reader_moved(infohash);
                    self.apply_window_with(infohash, false);
                }
            }
        }
        let permit = self
            .transients
            .clone()
            .try_acquire_owned()
            .map_err(|_| anyhow!("too many readers"))?;
        let mut stream =
            tokio::time::timeout(Duration::from_secs(10), handle.clone().stream(index))
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

    fn existing_slot(&self, infohash: &str, index: usize, prio: Prio) -> Option<Arc<slots::StreamSlot>> {
        let map = self.torrents.lock();
        map.get(infohash).and_then(|e| e.slots.get(&(index, prio)).cloned())
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
            let map = self.torrents.lock();
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
        let mut map = self.torrents.lock();
        let entry = map.get_mut(infohash).context("unknown torrent")?;
        Ok(entry.slots.entry(key).or_insert(slot).clone())
    }

    /// The remux reader moved: point the playhead slot there so the swarm
    /// fetches ahead of it, and stop feeding responses from before `gen`.
    pub async fn hint(
        &self,
        infohash: &str,
        reader: &str,
        index: usize,
        read_offset: u64,
        gen: u64,
        seek: bool,
    ) -> anyhow::Result<()> {
        let handle = self.touch(infohash).context("unknown torrent")?;
        let size = self.file_size(infohash, index)?;
        let offset = read_offset.min(size.saturating_sub(1));
        let slot = self
            .slot(infohash, &handle, index, Prio::Playhead, offset)
            .await?;
        let before = slot.cursor();
        let jump = seek || offset < before.saturating_sub(window::BEHIND) || offset > before.saturating_add(window::AHEAD);
        {
            let mut map = self.torrents.lock();
            if let Some(entry) = map.get_mut(infohash) {
                entry.floors.of(reader).fetch_max(gen, Ordering::Relaxed);
            }
        }
        slot.keep_alive();
        slot.set_wanted(offset);
        if jump {
            slot.mark_hinted();
            self.reader_moved(infohash);
        }
        let seeked = match slot.stream.clone().try_lock_owned() {
            Ok(mut stream) => {
                stream.seek(SeekFrom::Start(offset)).await?;
                slot.touch(offset);
                slot.clear_wanted();
                true
            }
            Err(_) => false,
        };
        self.apply_window_with(infohash, false);
        tracing::info!(
            infohash,
            reader,
            index,
            read_offset = offset,
            gen,
            seek = jump,
            seeked,
            "hint",
        );
        Ok(())
    }

    /// Narrows the download to what the open readers actually need: a window
    /// around each cursor, plus the pinned head and tail. Best effort — a
    /// torrent still resolving, or paused, simply keeps what it had.
    pub fn apply_window(&self, infohash: &str) {
        self.apply_window_with(infohash, true);
    }

    /// `release` says whether what falls outside the window is also given
    /// back to the disk; the sweep does that, the hot paths only select.
    pub fn apply_window_with(&self, infohash: &str, release: bool) {
        let Some(handle) = self.handle(infohash) else {
            return;
        };
        if release {
            self.sweep_fill(infohash, &handle);
        }
        let (index, mut cursors, fill) = {
            let map = self.torrents.lock();
            let Some(entry) = map.get(infohash) else {
                return;
            };
            let Some(index) = entry.selected_file else {
                return;
            };
            let slots: Vec<(Prio, &Arc<slots::StreamSlot>)> = entry
                .slots
                .iter()
                .filter(|((slot_index, _), _)| *slot_index == index)
                .map(|((_, prio), slot)| (*prio, slot))
                .collect();
            let starting = slots.iter().any(|(prio, slot)| {
                *prio == Prio::Playhead && slot.since_hint().is_some_and(|since| since < window::STARTUP)
            });
            let cursors: Vec<window::Cursor> = slots
                .iter()
                .filter_map(|(prio, slot)| {
                    let at = slot.cursor();
                    let ahead = match prio {
                        Prio::Playhead if starting => window::STARTUP_AHEAD,
                        Prio::Playhead => window::AHEAD,
                        Prio::Scan if starting => return None,
                        Prio::Scan => window::SCAN_AHEAD,
                        Prio::Head => return None,
                    };
                    slot.note_windowed(at, starting && *prio == Prio::Playhead);
                    Some(window::Cursor { at, ahead, behind: window::BEHIND })
                })
                .collect();
            (index, cursors, entry.fill)
        };
        let guard = handle.metadata.load();
        let Some(meta) = guard.as_ref() else { return };
        let Some(info) = meta.file_infos.get(index) else {
            return;
        };
        if fill == Fill::Filling {
            cursors.push(window::Cursor { at: 0, ahead: info.len, behind: 0 });
        }
        let lengths = meta.lengths();
        let piece_len = lengths.default_piece_length() as u64;
        let ranges = window::needed_ranges_for(info.len, &cursors, window::PIN);
        let pieces = window::pieces_for_ranges(
            info.offset_in_torrent,
            piece_len,
            lengths.total_pieces(),
            &ranges,
        );
        if pieces.is_empty() {
            return;
        }
        if let Err(e) = handle.update_selected_pieces(&pieces) {
            tracing::debug!(infohash, error = %e, "could not narrow the piece window");
            return;
        }
        if cursors.is_empty() || !release || fill != Fill::Off {
            return;
        }
        self.release_behind_window(infohash, &handle, info, &pieces, piece_len);
    }

    /// The sweep's look at whether the swarm should be filling the file
    /// behind the readers, and the bookkeeping when the answer changes.
    fn sweep_fill(&self, infohash: &str, handle: &Handle) {
        let (index, now, playhead, quiet) = {
            let map = self.torrents.lock();
            let Some(entry) = map.get(infohash) else { return };
            let Some(index) = entry.selected_file else { return };
            let playhead = entry.slots.get(&(index, Prio::Playhead)).cloned();
            let quiet = match &playhead {
                Some(slot) => slot.since_moved() >= fill::QUIET && slot.idle_for() >= fill::QUIET,
                None => entry.last_active.elapsed() >= fill::QUIET,
            };
            (index, entry.fill, playhead, quiet)
        };
        let guard = handle.metadata.load();
        let Some(meta) = guard.as_ref() else { return };
        let Some(info) = meta.file_infos.get(index) else { return };
        let lengths = meta.lengths();
        let piece_len = lengths.default_piece_length() as u64;
        let full = info.len;
        let footprint = window::footprint(info.len, window::AHEAD, window::BEHIND, window::PIN);
        let window_have = match &playhead {
            None => true,
            Some(slot) => {
                let cursor = window::Cursor { at: slot.cursor(), ahead: window::AHEAD, behind: window::BEHIND };
                let ranges = window::needed_ranges_for(info.len, &[cursor], 0);
                let pieces = window::pieces_for_ranges(info.offset_in_torrent, piece_len, lengths.total_pieces(), &ranges);
                handle
                    .with_chunk_tracker(|ct| {
                        let have = ct.get_have_pieces();
                        pieces.iter().all(|p| have.as_slice()[*p as usize])
                    })
                    .unwrap_or(false)
            }
        };
        let fits = self.disk.fits_replacing(infohash, full);
        let next = fill::decide(now, fill::Reader { quiet, window_have }, fits);
        if next == now {
            return;
        }
        self.set_fill(infohash, next, full, footprint);
    }

    fn set_fill(&self, infohash: &str, next: Fill, full: u64, footprint: u64) {
        let from = {
            let mut map = self.torrents.lock();
            let Some(entry) = map.get_mut(infohash) else { return };
            std::mem::replace(&mut entry.fill, next)
        };
        if from == next {
            return;
        }
        self.disk
            .reserve_unchecked(infohash, if next.reserves_file() { full } else { footprint });
        tracing::info!(infohash, from = from.name(), to = next.name(), reserved_mib = if next.reserves_file() { full } else { footprint } / (1024 * 1024), "fill");
    }

    /// The reader went somewhere new: a fill in progress stops widening the
    /// selection, and what it fetched is held, not released.
    fn reader_moved(&self, infohash: &str) {
        let mut map = self.torrents.lock();
        if let Some(entry) = map.get_mut(infohash) {
            if entry.fill == Fill::Filling {
                entry.fill = Fill::Holding;
                tracing::info!(infohash, from = "filling", to = "holding", "fill");
            }
        }
    }

    /// Gives back what fills are holding until `need` bytes fit, largest
    /// first, releasing each on the spot.
    fn shed_fill(&self, need: u64) {
        loop {
            if self.disk.room_for(need) {
                return;
            }
            let victim = {
                let map = self.torrents.lock();
                map.iter()
                    .filter(|(_, e)| e.fill != Fill::Off)
                    .map(|(id, _)| (self.disk.reserved(id), id.clone()))
                    .max()
            };
            let Some((_, id)) = victim else { return };
            let Some(handle) = self.handle(&id) else { return };
            let (full, footprint) = {
                let guard = handle.metadata.load();
                let Some(meta) = guard.as_ref() else { return };
                let index = self.torrents.lock().get(&id).and_then(|e| e.selected_file);
                match index.and_then(|i| meta.file_infos.get(i)) {
                    Some(f) => (f.len, window::footprint(f.len, window::AHEAD, window::BEHIND, window::PIN)),
                    None => (0, 0),
                }
            };
            self.set_fill(&id, Fill::Off, full, footprint);
            self.apply_window_with(&id, true);
        }
    }

    /// Gives back the storage of everything the window left behind. Order
    /// matters: the tracker gives the pieces up first, and only what it
    /// actually gave up is punched.
    fn release_behind_window(
        &self,
        infohash: &str,
        handle: &Handle,
        info: &librqbit::file_info::FileInfo,
        keep: &[u32],
        piece_len: u64,
    ) {
        if piece_len == 0 {
            return;
        }
        if !self.can_release() {
            return;
        }
        let keeping: HashSet<u32> = keep.iter().copied().collect();
        let first = info.offset_in_torrent.div_ceil(piece_len);
        let last = (info.offset_in_torrent + info.len) / piece_len;
        let candidates: Vec<u32> = (first..last)
            .filter_map(|p| u32::try_from(p).ok())
            .filter(|p| !keeping.contains(p))
            .collect();
        if candidates.is_empty() {
            return;
        }
        let dropped = match handle.forget_pieces(&candidates) {
            Ok(d) if d.is_empty() => return,
            Ok(d) => d,
            Err(e) => {
                tracing::debug!(infohash, error = %e, "could not give up pieces behind the window");
                return;
            }
        };
        let path = handle.output_folder().join(&info.relative_filename);
        let freed = punch_holes(&path, info.offset_in_torrent, info.len, &dropped, piece_len);
        if freed > 0 {
            tracing::info!(
                infohash,
                pieces = dropped.len(),
                freed_mib = freed / (1024 * 1024),
                "released pieces behind the window",
            );
        }
    }

    /// A slot nobody has read through recently is a stale priority window
    /// stealing peers from the live one, so it is dropped; the next read
    /// parks a new one.
    pub fn drop_stale_slots(&self, idle: Duration) {
        let mut map = self.torrents.lock();
        for entry in map.values_mut() {
            entry
                .slots
                .retain(|_, slot| slot.stream.try_lock().is_err() || slot.idle_for() < idle);
        }
    }

    async fn evict_idle_until_room(&self, need: u64) {
        let candidates: Vec<(String, Handle)> = {
            let map = self.torrents.lock();
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
            let mut map = self.torrents.lock();
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

    /// Deletes every torrent and the bytes behind it, leases and all.
    pub async fn reap_all(&self) {
        let all: Vec<(String, Handle)> = {
            let mut map = self.torrents.lock();
            map.drain()
                .map(|(id, entry)| (id, entry.handle.clone()))
                .collect()
        };
        if all.is_empty() {
            return;
        }
        tracing::info!(count = all.len(), "reaping every torrent on the way out");
        for (id, handle) in all {
            let _ = self.session.delete(handle.id().into(), true).await;
            self.disk.release(&id);
        }
    }

    /// Pauses an idle torrent, unless a lease arrived meanwhile — the pause
    /// runs outside the lock, so the decision is re-taken after it.
    pub(crate) async fn pause_if_idle(&self, infohash: &str, handle: &Handle) {
        let _ = self.session.pause(handle).await;
        let still_idle = {
            let mut map = self.torrents.lock();
            match map.get_mut(infohash) {
                Some(entry) if entry.leases.is_empty() => {
                    entry.phase = Phase::Idle;
                    entry.slots.clear();
                    entry.floors.clear();
                    true
                }
                _ => false,
            }
        };
        if !still_idle {
            let _ = self.session.unpause(handle).await;
        }
    }

    /// A torrent librqbit gave up on gets one restart in place; a second
    /// failure is final and the room's reads fail fast.
    pub(crate) async fn retry_failed(&self) {
        let failed: Vec<(String, Handle, bool)> = {
            let map = self.torrents.lock();
            map.iter()
                .filter(|(_, e)| {
                    e.handle
                        .with_state(|s| matches!(s, ManagedTorrentState::Error(_)))
                })
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
            if let Some(entry) = self.torrents.lock().get_mut(&id) {
                entry.retried = true;
            }
            let _ = self.session.unpause(&handle).await;
        }
    }

    pub(crate) fn idle_candidates(&self) -> Vec<(String, Handle, Phase, Duration)> {
        let map = self.torrents.lock();
        map.iter()
            .filter(|(_, e)| e.leases.is_empty())
            .map(|(id, e)| {
                (
                    id.clone(),
                    e.handle.clone(),
                    e.phase,
                    e.last_active.elapsed(),
                )
            })
            .collect()
    }

    pub(crate) fn serving_infohashes(&self) -> Vec<String> {
        let map = self.torrents.lock();
        map.iter()
            .filter(|(_, e)| e.selected_file.is_some())
            .map(|(id, _)| id.clone())
            .collect()
    }

    pub(crate) fn set_phase(&self, infohash: &str, phase: Phase) {
        if let Some(entry) = self.torrents.lock().get_mut(infohash) {
            entry.phase = phase;
            entry.slots.clear();
            entry.floors.clear();
        }
    }

    pub(crate) fn lease_count(&self) -> usize {
        self.torrents
            .lock()
            .values()
            .map(|e| e.leases.len())
            .sum()
    }
    pub(crate) fn torrent_count(&self) -> usize {
        self.torrents.lock().len()
    }
    pub(crate) fn max_torrents(&self) -> usize {
        self.cfg.max_torrents
    }
    pub(crate) fn max_leases(&self) -> usize {
        self.cfg.max_leases
    }

    pub fn expire_stale_leases(&self, ttl: Duration) {
        let mut map = self.torrents.lock();
        for entry in map.values_mut() {
            let before = entry.leases.len();
            entry.leases.retain(|_, at| at.elapsed() < ttl);
            if entry.leases.len() != before {
                entry.touch();
            }
        }
    }

    pub fn renew_lease(&self, infohash: &str, lease_id: &str) -> bool {
        let mut map = self.torrents.lock();
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
        let mut map = self.torrents.lock();
        let entry = map.get_mut(infohash)?;
        entry.touch();
        Some(entry.handle.clone())
    }

    fn handle(&self, infohash: &str) -> Option<Handle> {
        self.torrents
            .lock()
            .get(infohash)
            .map(|e| e.handle.clone())
    }

    pub fn read_chunk_size(&self) -> usize {
        READ_CHUNK
    }
}
