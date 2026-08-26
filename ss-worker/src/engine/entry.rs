use std::collections::{HashMap, HashSet};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;
use std::time::Instant;

use super::slots::{Prio, StreamSlot};
use super::{Handle, TorrentDigest};

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Phase {
    Ready,
    Serving,
    Idle,
    Reaping,
}

impl Phase {
    pub fn name(self) -> &'static str {
        match self {
            Phase::Ready => "ready",
            Phase::Serving => "serving",
            Phase::Idle => "idle",
            Phase::Reaping => "reaping",
        }
    }
}

pub struct Entry {
    pub handle: Handle,
    pub leases: HashMap<String, Instant>,
    pub last_active: Instant,
    pub phase: Phase,
    pub selected_file: Option<usize>,
    pub selected_bytes: u64,
    /// Every file index ever selected: what may be on disk.
    pub ever_selected: HashSet<usize>,
    pub slots: HashMap<(usize, Prio), Arc<StreamSlot>>,
    pub gen_floor: Arc<AtomicU64>,
    /// Whether the one in-place restart after a failure was spent.
    pub retried: bool,
}

impl Entry {
    pub fn new(handle: Handle, phase: Phase, selected_bytes: u64) -> Self {
        Self {
            handle,
            leases: HashMap::new(),
            last_active: Instant::now(),
            phase,
            selected_file: None,
            selected_bytes,
            ever_selected: HashSet::new(),
            slots: HashMap::new(),
            gen_floor: Arc::new(AtomicU64::new(0)),
            retried: false,
        }
    }

    pub fn touch(&mut self) {
        self.last_active = Instant::now();
    }

    // A lease revives whatever the reaper had in mind: the phase goes back
    // to serving and the idle clock restarts. Lease and pending reap are
    // never both true — reap() refuses an entry with leases.
    pub fn take_lease(&mut self, lease_id: &str) {
        self.leases.insert(lease_id.to_string(), Instant::now());
        if matches!(self.phase, Phase::Idle | Phase::Reaping) {
            self.phase = if self.selected_file.is_some() { Phase::Serving } else { Phase::Ready };
        }
        self.touch();
    }

    pub fn digest(&self, infohash: &str) -> TorrentDigest {
        let stats = self.handle.stats();
        let failed = self.handle.with_state(|s| matches!(s, librqbit::ManagedTorrentState::Error(_)));
        let (peers, down, up) = stats
            .live
            .as_ref()
            .map(|l| {
                (
                    l.snapshot.peer_stats.live as u64,
                    l.download_speed.as_bytes(),
                    l.upload_speed.as_bytes(),
                )
            })
            .unwrap_or((0, 0, 0));
        TorrentDigest {
            infohash: infohash.to_string(),
            name: self.handle.name().unwrap_or_default(),
            phase: if failed { "failed" } else { self.phase.name() },
            // Not progress_bytes: that is progress against the current piece
            // window, which shrinks every time the window moves. This is what
            // the torrent actually holds, so the room's readout only grows.
            have_bytes: stats.have_bytes.max(stats.progress_bytes),
            selected_bytes: self.selected_bytes,
            peers,
            down_speed: down,
            up_speed: up,
            uploaded_bytes: stats.uploaded_bytes,
            leases: self.leases.keys().cloned().collect(),
            idle_secs: self.last_active.elapsed().as_secs(),
        }
    }

    #[allow(dead_code)]
    pub fn gen_floor(&self) -> u64 {
        self.gen_floor.load(Ordering::Relaxed)
    }
}
