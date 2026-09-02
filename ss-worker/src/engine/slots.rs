use std::sync::Arc;
use parking_lot::Mutex;
use std::time::Instant;

pub trait RangeStream: tokio::io::AsyncRead + tokio::io::AsyncSeek + Send + Unpin {}
impl<T: tokio::io::AsyncRead + tokio::io::AsyncSeek + Send + Unpin> RangeStream for T {}
pub type BoxStream = Box<dyn RangeStream>;

/// What a read is for. The playhead and the scan each keep a parked stream
/// so librqbit's priority window follows their cursor between requests.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum Prio {
    Head,
    Playhead,
    Scan,
}

impl Prio {
    pub fn parse(s: Option<&str>) -> Self {
        match s {
            Some("head") => Prio::Head,
            Some("scan") => Prio::Scan,
            _ => Prio::Playhead,
        }
    }
}

pub const MIN_POOLED_FILE: u64 = 32 * 1024 * 1024;

pub struct StreamSlot {
    pub stream: Arc<tokio::sync::Mutex<BoxStream>>,
    meta: Mutex<(u64, Instant)>,
    wanted: Mutex<Option<u64>>,
    hinted_at: Mutex<Option<Instant>>,
    windowed: Mutex<(u64, bool)>,
    moved_at: Mutex<Instant>,
}

impl StreamSlot {
    pub fn new(stream: BoxStream, position: u64) -> Self {
        Self {
            stream: Arc::new(tokio::sync::Mutex::new(stream)),
            meta: Mutex::new((position, Instant::now())),
            wanted: Mutex::new(None),
            hinted_at: Mutex::new(None),
            windowed: Mutex::new((position, false)),
            moved_at: Mutex::new(Instant::now()),
        }
    }
    pub fn mark_moved(&self) {
        *self.moved_at.lock() = Instant::now();
    }
    pub fn since_moved(&self) -> std::time::Duration {
        self.moved_at.lock().elapsed()
    }
    pub fn set_wanted(&self, position: u64) {
        *self.wanted.lock() = Some(position);
    }
    pub fn clear_wanted(&self) {
        *self.wanted.lock() = None;
    }
    /// Where the window should sit: the announced position if one is
    /// pending, the stream's own otherwise.
    pub fn cursor(&self) -> u64 {
        self.wanted.lock().unwrap_or_else(|| self.position())
    }
    pub fn mark_hinted(&self) {
        *self.hinted_at.lock() = Some(Instant::now());
        self.mark_moved();
    }
    pub fn since_hint(&self) -> Option<std::time::Duration> {
        self.hinted_at.lock().map(|at| at.elapsed())
    }
    pub fn note_windowed(&self, cursor: u64, startup: bool) {
        *self.windowed.lock() = (cursor, startup);
    }
    pub fn windowed(&self) -> (u64, bool) {
        *self.windowed.lock()
    }
    pub fn touch(&self, position: u64) {
        *self.meta.lock() = (position, Instant::now());
    }
    pub fn keep_alive(&self) {
        self.meta.lock().1 = Instant::now();
    }
    pub fn position(&self) -> u64 {
        self.meta.lock().0
    }
    pub fn idle_for(&self) -> std::time::Duration {
        self.meta.lock().1.elapsed()
    }
}
