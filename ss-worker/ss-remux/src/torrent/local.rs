//! The window and the fill for a session on the host's own machine. No
//! leases and no disk budget: what comes down stays, so the fill only
//! decides where the peers go, never what is given back.
use std::collections::{HashMap, HashSet};
use std::io::SeekFrom;
use std::str::FromStr;
use std::sync::{Arc, Weak};
use std::time::{Duration, Instant};

use anyhow::{bail, Context};
use async_trait::async_trait;
use librqbit::api::TorrentIdOrHash;
use librqbit::dht::Id20;
use librqbit::{ManagedTorrent, ManagedTorrentState, Session};
use parking_lot::Mutex;
use tokio::io::{AsyncRead, AsyncReadExt, AsyncSeekExt};

use super::fill::{self, Fill};
use super::window::{self, Cursor};
use super::TorrentFiles;
use crate::source::SourceReader;

const SWEEP: Duration = Duration::from_secs(2);
const CURSOR_IDLE: Duration = Duration::from_secs(20);
const LIVE_WAIT: Duration = Duration::from_secs(25);
const OPEN_TIMEOUT: Duration = Duration::from_secs(10);

pub struct Local {
    session: Arc<Session>,
    files: Mutex<HashMap<(String, usize), Arc<Focus>>>,
    selected: Mutex<HashMap<String, usize>>,
}

impl Local {
    pub fn new(session: Arc<Session>) -> Arc<Self> {
        let local = Arc::new(Self {
            session,
            files: Mutex::new(HashMap::new()),
            selected: Mutex::new(HashMap::new()),
        });
        let weak = Arc::downgrade(&local);
        tokio::spawn(sweep(weak));
        local
    }

    pub fn session(&self) -> &Arc<Session> {
        &self.session
    }

    fn handle(&self, infohash: &str) -> anyhow::Result<Arc<ManagedTorrent>> {
        let id = Id20::from_str(&infohash.to_ascii_lowercase()).context("bad infohash")?;
        self.session.get(TorrentIdOrHash::Hash(id)).context("unknown torrent")
    }

    /// Downloads only this file of the torrent, and points the window at it.
    pub async fn select(&self, infohash: &str, index: usize) -> anyhow::Result<()> {
        let infohash = infohash.to_ascii_lowercase();
        let handle = self.handle(&infohash)?;
        if self.selected.lock().get(&infohash) != Some(&index)
            || handle.only_files().as_deref() != Some(&[index][..])
        {
            self.session
                .update_only_files(&handle, &HashSet::from([index]))
                .await
                .context("select file")?;
            self.selected.lock().insert(infohash.clone(), index);
            if let Some(focus) = self.files.lock().get(&(infohash.clone(), index)) {
                focus.state.lock().applied.clear();
            }
        }
        self.focus(&infohash, index, handle).apply();
        Ok(())
    }

    fn focus(&self, infohash: &str, index: usize, handle: Arc<ManagedTorrent>) -> Arc<Focus> {
        self.files
            .lock()
            .entry((infohash.to_string(), index))
            .or_insert_with(|| Arc::new(Focus::new(infohash.to_string(), handle, index)))
            .clone()
    }

    fn tick(&self) {
        let files: Vec<Arc<Focus>> = self.files.lock().values().cloned().collect();
        for focus in files {
            focus.sweep();
        }
    }
}

async fn sweep(local: Weak<Local>) {
    loop {
        tokio::time::sleep(SWEEP).await;
        let Some(local) = local.upgrade() else { break };
        local.tick();
    }
}

#[async_trait]
impl TorrentFiles for Local {
    fn file_size(&self, infohash: &str, index: usize) -> anyhow::Result<u64> {
        let handle = self.handle(infohash)?;
        let guard = handle.metadata.load();
        let meta = guard.as_ref().context("no metadata")?;
        meta.file_infos.get(index).map(|f| f.len).context("no such file")
    }

    async fn open_playhead(
        &self,
        infohash: &str,
        reader: &str,
        index: usize,
        position: u64,
    ) -> anyhow::Result<Box<dyn SourceReader>> {
        let infohash = infohash.to_ascii_lowercase();
        let handle = self.handle(&infohash)?;
        let deadline = tokio::time::Instant::now() + LIVE_WAIT;
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
            if tokio::time::Instant::now() >= deadline {
                bail!("torrent not live");
            }
            tokio::time::sleep(Duration::from_millis(300)).await;
        }
        let focus = self.focus(&infohash, index, handle.clone());
        let kind = reader_kind(reader);
        focus.moved_to(kind, position);
        let mut stream = tokio::time::timeout(OPEN_TIMEOUT, handle.stream(index))
            .await
            .context("stream open timed out")?
            .context("stream")?;
        stream.seek(SeekFrom::Start(position)).await?;
        Ok(Box::new(FocusReader { stream: Box::new(stream), focus, kind, position }))
    }
}

/// The bridge tags readers per run; the window keys them per role, so a new
/// run's reader takes over the old one's cursor.
fn reader_kind(reader: &str) -> &'static str {
    match reader.split(':').next().unwrap_or("") {
        "remux-probe" => "probe",
        "remux-key" => "key",
        "remux-subs" => "subs",
        _ => "playhead",
    }
}

struct FocusReader {
    stream: Box<dyn AsyncRead + Send + Unpin>,
    focus: Arc<Focus>,
    kind: &'static str,
    position: u64,
}

#[async_trait]
impl SourceReader for FocusReader {
    async fn read(&mut self, buf: &mut [u8]) -> anyhow::Result<usize> {
        let n = self.stream.read(buf).await?;
        self.position += n as u64;
        self.focus.touch(self.kind, self.position);
        Ok(n)
    }
}

struct Tracked {
    at: u64,
    touched: Instant,
}

struct FocusState {
    cursors: HashMap<&'static str, Tracked>,
    moved_at: Instant,
    read_at: Instant,
    fill: Fill,
    applied: Vec<u32>,
}

struct Focus {
    infohash: String,
    handle: Arc<ManagedTorrent>,
    index: usize,
    state: Mutex<FocusState>,
}

impl Focus {
    fn new(infohash: String, handle: Arc<ManagedTorrent>, index: usize) -> Self {
        let now = Instant::now();
        Self {
            infohash,
            handle,
            index,
            state: Mutex::new(FocusState {
                cursors: HashMap::new(),
                moved_at: now,
                read_at: now,
                fill: Fill::Off,
                applied: Vec::new(),
            }),
        }
    }

    fn touch(&self, kind: &'static str, at: u64) {
        let now = Instant::now();
        let mut state = self.state.lock();
        state.read_at = now;
        state.cursors.insert(kind, Tracked { at, touched: now });
    }

    /// A reader opened here. A jump away from where its role was reading
    /// narrows the window to a short startup span, and a fill in progress
    /// stops widening the selection.
    fn moved_to(&self, kind: &'static str, at: u64) {
        let jumped = {
            let mut state = self.state.lock();
            let now = Instant::now();
            let jumped = matches!(kind, "playhead" | "key")
                && ["playhead", "key"]
                    .iter()
                    .filter_map(|k| state.cursors.get(k))
                    .all(|c| at.abs_diff(c.at) > window::BEHIND);
            if jumped {
                state.moved_at = now;
                if state.fill == Fill::Filling {
                    state.fill = Fill::Holding;
                    tracing::info!(infohash = %self.infohash, from = "filling", to = "holding", "fill");
                }
            }
            state.cursors.insert(kind, Tracked { at, touched: now });
            jumped
        };
        if jumped {
            tracing::info!(infohash = %self.infohash, index = self.index, at, "playhead moved");
        }
        self.apply();
    }

    fn sweep(&self) {
        let quiet = {
            let mut state = self.state.lock();
            state.cursors.retain(|_, c| c.touched.elapsed() < CURSOR_IDLE);
            state.moved_at.elapsed() >= fill::QUIET && state.read_at.elapsed() >= fill::QUIET
        };
        if let Some(window_have) = self.playhead_window_have() {
            let (from, next) = {
                let mut state = self.state.lock();
                let next = fill::decide(state.fill, fill::Reader { quiet, window_have }, true);
                (std::mem::replace(&mut state.fill, next), next)
            };
            if from != next {
                tracing::info!(infohash = %self.infohash, from = from.name(), to = next.name(), "fill");
            }
        }
        self.apply();
    }

    fn playhead_window_have(&self) -> Option<bool> {
        let at = self.state.lock().cursors.get("playhead").map(|c| c.at);
        let guard = self.handle.metadata.load();
        let meta = guard.as_ref()?;
        let info = meta.file_infos.get(self.index)?;
        let Some(at) = at else { return Some(true) };
        let lengths = meta.lengths();
        let cursor = Cursor { at, ahead: window::AHEAD, behind: window::BEHIND };
        let ranges = window::needed_ranges_for(info.len, &[cursor], 0);
        let pieces = window::pieces_for_ranges(
            info.offset_in_torrent,
            lengths.default_piece_length() as u64,
            lengths.total_pieces(),
            &ranges,
        );
        self.handle
            .with_chunk_tracker(|ct| {
                let have = ct.get_have_pieces();
                pieces.iter().all(|p| have.as_slice()[*p as usize])
            })
            .ok()
    }

    /// Selects the pieces the readers need: a span around each cursor, the
    /// pinned head and tail, and the whole file while filling.
    fn apply(&self) {
        if self.handle.live().is_none() {
            return;
        }
        let guard = self.handle.metadata.load();
        let Some(meta) = guard.as_ref() else { return };
        let Some(info) = meta.file_infos.get(self.index) else { return };
        let state = self.state.lock();
        let starting = state.moved_at.elapsed() < window::STARTUP;
        let mut cursors: Vec<Cursor> = state
            .cursors
            .iter()
            .filter_map(|(kind, c)| {
                let ahead = match *kind {
                    "subs" if starting => return None,
                    "subs" => window::SCAN_AHEAD,
                    "probe" => return None,
                    _ if starting => window::STARTUP_AHEAD,
                    _ => window::AHEAD,
                };
                Some(Cursor { at: c.at, ahead, behind: window::BEHIND })
            })
            .collect();
        if state.fill == Fill::Filling {
            cursors.push(Cursor { at: 0, ahead: info.len, behind: 0 });
        }
        let lengths = meta.lengths();
        let ranges = window::needed_ranges_for(info.len, &cursors, window::PIN);
        let pieces = window::pieces_for_ranges(
            info.offset_in_torrent,
            lengths.default_piece_length() as u64,
            lengths.total_pieces(),
            &ranges,
        );
        if pieces.is_empty() || pieces == state.applied {
            return;
        }
        drop(state);
        match self.handle.update_selected_pieces(&pieces) {
            Ok(()) => self.state.lock().applied = pieces,
            Err(e) => tracing::debug!(infohash = %self.infohash, error = %e, "could not narrow the piece window"),
        }
    }
}
