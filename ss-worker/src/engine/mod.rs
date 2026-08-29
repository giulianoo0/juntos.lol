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
/// A tracker suggests its own re-announce interval and a hostile one would
/// suggest a second, turning this worker into a beacon against whatever
/// host the URL names. Announces re-run on this leash, never faster.
const TRACKER_INTERVAL: Duration = Duration::from_secs(30);

pub struct Engine {
    session: Arc<Session>,
    torrents: Mutex<HashMap<String, Entry>>,
    disk: DiskAccountant,
    pub cfg: WorkerConfig,
    draining: AtomicBool,
    permits_in_use: Arc<AtomicU64>,
    /// Whether the blocks behind a piece can actually be handed back here.
    /// Answered once at boot against the data directory itself, because the
    /// answer is the filesystem's, not the platform's: a container on overlayfs
    /// and a Mac both say no, for different reasons.
    releasing: bool,
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
    /// Blocks this torrent's files hold on the worker's disk right now, after
    /// everything behind the window has been punched back out. What the site
    /// shows when it says how much storage a room is using.
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
    /// playhead reads carry a generation — probes and scans are their own
    /// cursors and never superseded by a seek. The floor is the reader's
    /// own: another room seeking through the same torrent says nothing
    /// about where this one is.
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
///
/// The file keeps its length — librqbit created it whole and a FileStream
/// still seeks by absolute offset — so this is a hole, not a truncation. The
/// pieces named here are ones the tracker has already stopped reporting as
/// HAVE, so nothing will read them before they are fetched again.
///
/// Only pieces wholly inside `[file_offset, file_offset + file_len)` are
/// punched; the caller filters for that, and the arithmetic here refuses
/// anything else rather than trusting it.
///
/// Linux only. On anything else this is a no-op and the worker behaves as it
/// did before — the local e2e runs on a Mac, and running it should not need a
/// second storage story.
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
        // Back into file coordinates, and never outside this file.
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
            // A filesystem without hole punching (or a container without the
            // capability) answers here. Nothing is wrong except that the space
            // stays taken, so say it once per attempt at debug and move on.
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
// Only the Linux punch calls it; the tests keep it honest everywhere.
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

/// Whether this filesystem gives blocks back. Asked by doing it, in the one
/// directory it will be done in, because nothing else answers honestly: the
/// syscall exists on every Linux and still refuses on some filesystems.
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
        // Nothing under here survives a restart in any usable form: the
        // session keeps no persistence, so the last process's pieces are
        // bytes nobody can reach and nobody is accounting for. The volume
        // outlives the container, so sweeping at boot is what keeps a deploy
        // loop from filling the disk one restart at a time.
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
            // What admission counts on: each torrent's window footprint,
            // whether or not those blocks have landed yet. Placement needs the
            // promise, or a worker takes three rooms in the second before any
            // of them has downloaded anything.
            disk_used: self.disk.used().max(self.disk.real_used()),
            // What the volume is actually carrying. This is the one the site
            // shows: a reservation is a promise about the future, and someone
            // asking how much disk a room is using means the blocks.
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
                // Raced another lease on the same hash, or librqbit still
                // manages a torrent the map forgot; either way this lease
                // attaches to that handle, and the map learns it.
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
            // Deselecting a file does not delete what it already downloaded,
            // so the reservation covers every file ever selected here.
            let mut ever = previously;
            ever.extend(only.iter().copied());
            // A torrent already holding a fill keeps promising the whole of
            // its files: re-selecting it must not shrink the reservation
            // under bytes that are really on the disk.
            let reserve: u64 = ever
                .iter()
                .filter_map(|i| meta.file_infos.get(*i))
                .map(|f| if filling { f.len } else { window::footprint(f.len, window::AHEAD, window::BEHIND, window::PIN) })
                .sum();
            (only, total, reserve, ever)
        };
        let before = self.disk.reserved(&infohash);
        if !self.disk.reserve(&infohash, reserve_bytes) {
            // Fills go before rooms: what they hold is a convenience, and a
            // torrent someone is opening is not.
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
        // update_only_files selected the whole file; narrow it to the pins
        // straight away, so the swarm does not spend the gap before the
        // first read pulling down footage nobody has asked for.
        self.apply_window(&infohash);
        Ok(selected_bytes)
    }

    /// Releases a lease. The torrent stays hot for a grace period: a page
    /// reload or a failover comes back to warm pieces.
    pub async fn release(&self, infohash: &str, lease_id: &str) {
        let infohash = infohash.to_ascii_lowercase();
        let mut map = self.torrents.lock();
        if let Some(entry) = map.get_mut(&infohash) {
            entry.leases.remove(lease_id);
            entry.touch();
        }
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
    /// stream in a slot so librqbit's priority window keeps following them
    /// between requests; head probes use a throwaway stream.
    ///
    /// A torrent still paused or checking its files cannot open a stream
    /// yet; that window follows every select and is seconds long, so the
    /// open waits it out instead of bouncing the client through a 503.
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
            // A torrent the reaper paused stays paused until someone asks for
            // it again; a read with a valid ticket is exactly that.
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
                // The window follows the read, not only the hint: a read that
                // lands outside the last window — a retry, a hint swallowed by
                // the client's stride, a scan slice — would otherwise wait for
                // the sweep before its pieces are even wanted. And a startup
                // window that has done its time gives way to the full one
                // here, on the next read, rather than on the sweep.
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
        // A playhead read that could not take its slot — the response for the
        // region it left still holds the stream — still says where the
        // playhead is. Left unsaid, the window stays on the old region until
        // that response notices its generation and ends.
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
    ) -> anyhow::Result<()> {
        let handle = self.touch(infohash).context("unknown torrent")?;
        let size = self.file_size(infohash, index)?;
        let offset = read_offset.min(size.saturating_sub(1));
        let slot = self
            .slot(infohash, &handle, index, Prio::Playhead, offset)
            .await?;
        {
            let mut map = self.torrents.lock();
            if let Some(entry) = map.get_mut(infohash) {
                entry.floors.of(reader).fetch_max(gen, Ordering::Relaxed);
            }
        }
        // The hint itself is the sign of life, whether or not the stream can
        // be moved right now: a reader waiting on the swarm makes no reads to
        // touch the slot with, and letting it look idle is what retires the
        // window out from under the very seek it is describing.
        slot.keep_alive();
        // Said before the stream is tried: the window is built from what the
        // reader wants, and a busy stream must not leave it on the old region.
        slot.set_wanted(offset);
        slot.mark_hinted();
        self.reader_moved(infohash);
        // A busy slot is a response in flight for the old region; it notices
        // the floor on its next chunk and ends, freeing the slot to move.
        let seeked = match slot.stream.clone().try_lock_owned() {
            Ok(mut stream) => {
                stream.seek(SeekFrom::Start(offset)).await?;
                slot.touch(offset);
                slot.clear_wanted();
                true
            }
            Err(_) => false,
        };
        // The cursor moved, so the window moved with it. Selection only: what
        // the old region left behind is the sweep's to release, not this
        // request's — a hint runs on the seek's critical path, and a guess a
        // few percent off would punch holes in what the real read needs next.
        self.apply_window_with(infohash, false);
        tracing::info!(
            infohash,
            reader,
            index,
            read_offset = offset,
            gen,
            seeked,
            "hint",
        );
        Ok(())
    }

    /// Narrows the download to what the open readers actually need: a window
    /// around each cursor, plus the head and tail that carry the container's
    /// header and index. Without this librqbit fetches the whole selected
    /// file behind the readers — its stream window only reorders requests,
    /// it never drops anything — which for a 23 GB release is tens of
    /// gigabytes of swarm traffic and disk for footage nobody reaches.
    ///
    /// Best effort: a torrent still resolving, or paused, simply keeps what
    /// it had, and the next read reapplies the window.
    pub fn apply_window(&self, infohash: &str) {
        self.apply_window_with(infohash, true);
    }

    /// `release` says whether what falls outside the window is also given
    /// back to the disk; the sweep does that, the hot paths only select.
    pub fn apply_window_with(&self, infohash: &str, release: bool) {
        let Some(handle) = self.handle(infohash) else {
            return;
        };
        // The sweep is the only place the fill turns on: the hot paths only
        // ever narrow it, and the decision needs the HAVE bitfield.
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
            // Right after a seek every peer belongs to the pieces the first
            // byte is waiting on: the playhead's window narrows, and the scan
            // — which no viewer waits for — gets none at all for the moment.
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
        // No reader open yet: the pins alone still let the probe read the
        // header and the index without pulling the body down.
        let guard = handle.metadata.load();
        let Some(meta) = guard.as_ref() else { return };
        let Some(info) = meta.file_infos.get(index) else {
            return;
        };
        // Filling: everything. The stream priority keeps the readers'
        // windows first; the rest is what the swarm does with its idle time.
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
        // With no reader there is no window — only the two pins — and giving
        // up everything else would throw away the whole read-ahead the moment
        // a remux went quiet for twenty seconds, which is what filling a
        // player's buffer looks like, and what a backgrounded tab does the
        // whole time. Narrowing the selection while nobody reads is free;
        // releasing is not.
        // Holding keeps what a fill brought in: the reservation still says the
        // whole file, and the next fill — or the host's own background remux
        // — reads it instead of fetching it again.
        if cursors.is_empty() || !release || fill != Fill::Off {
            return;
        }
        self.release_behind_window(infohash, &handle, info, &pieces, piece_len);
    }

    /// The sweep's look at whether the swarm should be filling the file
    /// behind the readers, and the bookkeeping when the answer changes.
    fn sweep_fill(&self, infohash: &str, handle: &Handle) {
        let (index, now, playhead, quiet, ever) = {
            let map = self.torrents.lock();
            let Some(entry) = map.get(infohash) else { return };
            let Some(index) = entry.selected_file else { return };
            let playhead = entry.slots.get(&(index, Prio::Playhead)).cloned();
            // A retired slot is a reader that has not read in a while — the
            // quiet the fill is waiting for, dated from the last open or hint.
            let quiet = match &playhead {
                Some(slot) => slot.since_moved() >= fill::QUIET,
                None => entry.last_active.elapsed() >= fill::QUIET,
            };
            (index, entry.fill, playhead, quiet, entry.ever_selected.clone())
        };
        let guard = handle.metadata.load();
        let Some(meta) = guard.as_ref() else { return };
        let Some(info) = meta.file_infos.get(index) else { return };
        let lengths = meta.lengths();
        let piece_len = lengths.default_piece_length() as u64;
        let (full, footprint) = ever
            .iter()
            .filter_map(|i| meta.file_infos.get(*i))
            .fold((0u64, 0u64), |(full, fp), f| {
                (full + f.len, fp + window::footprint(f.len, window::AHEAD, window::BEHIND, window::PIN))
            });
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
    /// selection, so every peer goes back to the window. What it fetched is
    /// held, not released.
    fn reader_moved(&self, infohash: &str) {
        let mut map = self.torrents.lock();
        if let Some(entry) = map.get_mut(infohash) {
            if entry.fill == Fill::Filling {
                entry.fill = Fill::Holding;
                tracing::info!(infohash, from = "filling", to = "holding", "fill");
            }
        }
    }

    /// Gives back what fills are holding until `need` bytes fit. Largest
    /// first; each one is released on the spot, so the room is real by the
    /// time the reservation that asked for it is made.
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
                let ever = self.torrents.lock().get(&id).map(|e| e.ever_selected.clone()).unwrap_or_default();
                ever.iter()
                    .filter_map(|i| meta.file_infos.get(*i))
                    .fold((0u64, 0u64), |(full, fp), f| {
                        (full + f.len, fp + window::footprint(f.len, window::AHEAD, window::BEHIND, window::PIN))
                    })
            };
            self.set_fill(&id, Fill::Off, full, footprint);
            self.apply_window_with(&id, true);
        }
    }

    /// Gives back the storage of everything the window left behind. Narrowing
    /// the selection only stops librqbit *asking* for those pieces; without
    /// this the file still lands on disk in full, one window at a time, and a
    /// two-hour release costs its whole size on a worker that never needed
    /// more than a few hundred megabytes of it.
    ///
    /// Order matters: the tracker gives the pieces up first, and only what it
    /// actually gave up is punched. A hole under a piece that still reads as
    /// HAVE would be served to the host's remux as zeroes, with nothing
    /// anywhere to notice.
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
        // Forgetting is only worth it if the blocks actually go back. Where
        // holes cannot be punched — any non-Linux build, a filesystem that
        // refuses it — dropping HAVE would buy nothing and cost the swarm a
        // re-download of everything behind the cursor.
        if !self.can_release() {
            return;
        }
        let keeping: HashSet<u32> = keep.iter().copied().collect();
        // Only pieces wholly inside this file. One straddling either end also
        // carries a sibling file's bytes — a sidecar subtitle the host may be
        // reading right now — and this holds no claim on those.
        let first = info.offset_in_torrent.div_ceil(piece_len);
        let last = (info.offset_in_torrent + info.len) / piece_len;
        let candidates: Vec<u32> = (first..last)
            .filter_map(|p| u32::try_from(p).ok())
            .filter(|p| !keeping.contains(p))
            .collect();
        if candidates.is_empty() {
            return;
        }
        // Only the pieces the tracker actually gave up: it skips anything it
        // may not touch, and a hole punched under a piece that still reads as
        // HAVE would be served to the host's remux as zeroes.
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
            // Worth an info line: this is the whole reason a two-hour film
            // does not end up on the disk in full, and without it there is no
            // way to tell from the outside whether it is happening.
            tracing::info!(
                infohash,
                pieces = dropped.len(),
                freed_mib = freed / (1024 * 1024),
                "released pieces behind the window",
            );
        }
    }

    /// A parked stream keeps a 64MB priority window at its cursor for as
    /// long as it exists, and the swarm shares itself fairly between every
    /// window. A slot nobody has read through recently is a stale window
    /// stealing focus from the live one — after a seek, the abandoned
    /// region's — so it is dropped; the next read simply parks a new one.
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

    /// Deletes every torrent and the bytes behind it, leases and all. Called
    /// on the way out: nothing here survives into the next process in a form
    /// it could use, so anything left is a disk that only grows.
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

    /// A torrent librqbit gave up on (ENOSPC, a storage error) gets one
    /// restart in place; a second failure is final and the room's reads
    /// fail fast instead of waiting on pieces that will never come.
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

    /// Torrents with a file picked, whose piece window is worth refreshing.
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
