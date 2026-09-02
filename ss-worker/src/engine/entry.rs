use std::collections::{HashMap, HashSet};
use std::sync::Arc;
use parking_lot::Mutex;
use std::time::{Duration, Instant};

use super::fill::Fill;
use super::floors::Floors;
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
    pub ever_selected: HashSet<usize>,
    pub slots: HashMap<(usize, Prio), Arc<StreamSlot>>,
    pub floors: Floors,
    pub retried: bool,
    pub fill: Fill,
    disk: Mutex<(u64, Option<Instant>)>,
}

const DISK_TTL: Duration = Duration::from_secs(5);

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
            floors: Floors::default(),
            retried: false,
            fill: Fill::Off,
            disk: Mutex::new((0, None)),
        }
    }

    fn disk_bytes(&self) -> u64 {
        {
            let cached = self.disk.lock();
            if cached.1.is_some_and(|at| at.elapsed() < DISK_TTL) {
                return cached.0;
            }
        }
        let total = super::disk::allocated_under(&self.handle.output_folder());
        *self.disk.lock() = (total, Some(Instant::now()));
        total
    }

    pub fn touch(&mut self) {
        self.last_active = Instant::now();
    }

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
            have_bytes: stats.have_bytes.max(stats.progress_bytes),
            selected_bytes: self.selected_bytes,
            disk_bytes: self.disk_bytes(),
            peers,
            down_speed: down,
            up_speed: up,
            uploaded_bytes: stats.uploaded_bytes,
            leases: self.leases.keys().cloned().collect(),
            idle_secs: self.last_active.elapsed().as_secs(),
        }
    }
}
