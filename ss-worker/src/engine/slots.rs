use std::sync::Arc;
use parking_lot::Mutex;
use std::time::Instant;

pub trait RangeStream: tokio::io::AsyncRead + tokio::io::AsyncSeek + Send + Unpin {}
impl<T: tokio::io::AsyncRead + tokio::io::AsyncSeek + Send + Unpin> RangeStream for T {}
pub type BoxStream = Box<dyn RangeStream>;

/// What a read is for. The playhead and the scan each keep a parked stream
/// so librqbit's priority window follows their cursor between requests;
/// head probes are tiny and urgent and never wait behind either.
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

// Small files (sidecar subtitles) are read once; parking a stream for them
// would only burn a blocking permit.
pub const MIN_POOLED_FILE: u64 = 32 * 1024 * 1024;

pub struct StreamSlot {
    pub stream: Arc<tokio::sync::Mutex<BoxStream>>,
    meta: Mutex<(u64, Instant)>,
    /// Where the reader said it is going, when the stream could not be moved
    /// there yet: a hint lands while a response for the old region still
    /// holds the stream, and a window built from the stream's own position
    /// would keep the swarm on the stretch the reader just left.
    wanted: Mutex<Option<u64>>,
    /// When the playhead last announced a seek. A window applied within the
    /// startup span after it is narrow on purpose (see window::STARTUP).
    hinted_at: Mutex<Option<Instant>>,
    /// The cursor the last window was built around, and whether that window
    /// was the narrow startup one.
    windowed: Mutex<(u64, bool)>,
    /// When the reader last went somewhere new — a hint, or a read that
    /// landed outside the window. The fill waits for this to go quiet.
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
    /// The reader is going here; the window follows even if the stream
    /// itself cannot be seeked yet.
    pub fn set_wanted(&self, position: u64) {
        *self.wanted.lock() = Some(position);
    }
    /// The stream actually moved: whatever was wanted has been honoured.
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
    /// Says the reader is still there without claiming it moved. A hint
    /// arrives precisely when the reader is not reading — it is telling us
    /// where it is about to go — and a busy stream cannot be seeked under
    /// the response holding it. Without this the slot looks abandoned, the
    /// sweeper retires it, and the window drops the pieces the hint just
    /// asked for.
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
