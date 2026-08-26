use std::sync::{Arc, Mutex};
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
}

impl StreamSlot {
    pub fn new(stream: BoxStream, position: u64) -> Self {
        Self {
            stream: Arc::new(tokio::sync::Mutex::new(stream)),
            meta: Mutex::new((position, Instant::now())),
        }
    }
    pub fn touch(&self, position: u64) {
        *self.meta.lock().unwrap() = (position, Instant::now());
    }
    /// Says the reader is still there without claiming it moved. A hint
    /// arrives precisely when the reader is not reading — it is telling us
    /// where it is about to go — and a busy stream cannot be seeked under
    /// the response holding it. Without this the slot looks abandoned, the
    /// sweeper retires it, and the window drops the pieces the hint just
    /// asked for.
    pub fn keep_alive(&self) {
        self.meta.lock().unwrap().1 = Instant::now();
    }
    #[allow(dead_code)]
    pub fn position(&self) -> u64 {
        self.meta.lock().unwrap().0
    }
    pub fn idle_for(&self) -> std::time::Duration {
        self.meta.lock().unwrap().1.elapsed()
    }
}
