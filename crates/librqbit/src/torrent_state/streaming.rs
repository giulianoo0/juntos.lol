use std::{
    collections::VecDeque,
    io::SeekFrom,
    ops::Range,
    sync::{
        Arc,
        atomic::{AtomicUsize, Ordering},
    },
    task::{Poll, Waker},
    time::Instant,
};

use anyhow::Context;
use dashmap::DashMap;

use librqbit_core::lengths::{CurrentPiece, Lengths, ValidPieceIndex};
use tokio::{
    io::{AsyncRead, AsyncSeek},
    sync::{Notify, OwnedSemaphorePermit},
};
use tracing::{debug, trace};

use crate::{ManagedTorrent, file_info::FileInfo, storage::TorrentStorage};

use super::{ManagedTorrentHandle, TorrentMetadata};

type StreamId = usize;

// 32 mb lookahead by default.
const PER_STREAM_BUF_DEFAULT: u64 = 64 * 1024 * 1024;

// ss patch: right after a stream opens, seeks or blocks, piece selection is
// narrowed to max(2 MiB, 1.5 s of media) ahead of it until half of that has
// arrived, so the swarm converges on the playhead instead of spreading over
// the 64 MiB read-ahead. Same idea as torrentplayer's critical window.
const CRITICAL_MIN_BYTES: u64 = 2 * 1024 * 1024;

struct StreamState {
    file_id: usize,
    file_len: u64,
    file_abs_offset: u64,
    position: u64,
    waker: Option<Waker>,
    critical: bool,
    bytes_per_sec: u64,
}

impl StreamState {
    fn current_piece(&self, lengths: &Lengths) -> Option<CurrentPiece> {
        lengths.compute_current_piece(self.position, self.file_abs_offset)
    }

    fn queue<'a>(&self, lengths: &'a Lengths) -> impl Iterator<Item = ValidPieceIndex> + use<'a> {
        self.pieces_ahead(lengths, PER_STREAM_BUF_DEFAULT)
    }

    fn critical_len(&self) -> u64 {
        CRITICAL_MIN_BYTES.max(self.bytes_per_sec.saturating_mul(3) / 2)
    }

    fn critical_queue<'a>(
        &self,
        lengths: &'a Lengths,
    ) -> impl Iterator<Item = ValidPieceIndex> + use<'a> {
        self.pieces_ahead(lengths, self.critical_len())
    }

    // Half of the critical window is contiguous on disk from the position.
    fn critical_reached(&self, lengths: &Lengths, have: &impl Fn(ValidPieceIndex) -> bool) -> bool {
        let start = self.file_abs_offset + self.position;
        let end = (start + self.critical_len()).min(self.file_abs_offset + self.file_len);
        let mut reached = start;
        for piece in self.pieces_ahead(lengths, end - start) {
            if !have(piece) {
                break;
            }
            reached = lengths.piece_offset(piece) + lengths.piece_length(piece) as u64;
        }
        reached.min(end) - start >= (end - start) / 2
    }

    fn pieces_ahead<'a>(
        &self,
        lengths: &'a Lengths,
        len: u64,
    ) -> impl Iterator<Item = ValidPieceIndex> + use<'a> {
        let start = self.file_abs_offset + self.position;
        let end = (start + len).min(self.file_abs_offset + self.file_len);
        let dpl = lengths.default_piece_length();
        let start_id = (start / dpl as u64).try_into().unwrap();
        let end_id = end.div_ceil(dpl as u64).try_into().unwrap();
        (start_id..end_id).filter_map(|i| lengths.validate_piece_index(i))
    }
}

struct Interleave<I> {
    all: VecDeque<I>,
}

impl<I: Iterator<Item = ValidPieceIndex>> Iterator for Interleave<I> {
    type Item = ValidPieceIndex;

    fn next(&mut self) -> Option<Self::Item> {
        while let Some(mut it) = self.all.pop_front() {
            if let Some(piece) = it.next() {
                self.all.push_back(it);
                return Some(piece);
            }
        }
        None
    }
}

#[derive(Default)]
pub(crate) struct TorrentStreams {
    next_stream_id: AtomicUsize,
    streams: DashMap<StreamId, StreamState>,
    // ss patch: a stream opened, closed or seeked.
    changed: Notify,
}

impl TorrentStreams {
    fn next_id(&self) -> usize {
        self.next_stream_id.fetch_add(1, Ordering::Relaxed)
    }

    // Returns true if the stream was not critical yet.
    fn mark_critical(&self, stream_id: StreamId) -> bool {
        self.streams
            .get_mut(&stream_id)
            .is_some_and(|mut s| !std::mem::replace(&mut s.critical, true))
    }

    fn register_waker(&self, stream_id: StreamId, waker: Waker) -> bool {
        if let Some(mut s) = self.streams.get_mut(&stream_id) {
            s.value_mut().waker = Some(waker);
        }
        self.mark_critical(stream_id)
    }

    /// Ends the critical phase of streams that got half their window.
    /// Returns true if any stream was critical: peers that went idle on a
    /// critical window must look again, as it either slid or ended.
    pub(crate) fn settle_critical(
        &self,
        lengths: &Lengths,
        have: impl Fn(ValidPieceIndex) -> bool,
    ) -> bool {
        let mut any = false;
        for mut s in self.streams.iter_mut() {
            if s.critical {
                any = true;
                s.critical = !s.critical_reached(lengths, &have);
            }
        }
        any
    }

    /// Pieces to try first for a peer, and whether the selection must stop at
    /// them. While a stream is critical, that is only the critical windows,
    /// unless the peer has none of the missing pieces in them.
    pub(crate) fn next_pieces(
        &self,
        lengths: &Lengths,
        have: impl Fn(ValidPieceIndex) -> bool,
        peer_has: impl Fn(ValidPieceIndex) -> bool,
    ) -> (Vec<ValidPieceIndex>, bool) {
        self.settle_critical(lengths, &have);
        let mut critical: Vec<_> = self
            .streams
            .iter()
            .filter(|s| s.critical)
            .map(|s| s.critical_queue(lengths))
            .collect();
        if !critical.is_empty() {
            use rand::seq::SliceRandom;
            critical.shuffle(&mut rand::rng());
            let mut pieces = Vec::new();
            for p in (Interleave { all: critical.into() }) {
                if !pieces.contains(&p) {
                    pieces.push(p);
                }
            }
            if pieces.iter().any(|p| !have(*p) && peer_has(*p)) {
                return (pieces, true);
            }
        }
        (self.iter_next_pieces(lengths).collect(), false)
    }

    // Interleave 1st, 2nd etc pieces from each active stream in turn until they get 1/10th of the file .
    pub(crate) fn iter_next_pieces<'a>(
        &'a self,
        lengths: &'a Lengths,
    ) -> impl Iterator<Item = ValidPieceIndex> + 'a {
        let mut all: Vec<_> = self.streams.iter().map(|s| s.queue(lengths)).collect();

        // Shuffle to decrease determinism and make queueing fairer.
        use rand::seq::SliceRandom;
        all.shuffle(&mut rand::rng());

        Interleave { all: all.into() }
    }

    pub(crate) fn wake_streams_on_piece_completed(
        &self,
        piece_id: ValidPieceIndex,
        lengths: &Lengths,
    ) {
        for mut w in self.streams.iter_mut() {
            if w.value().current_piece(lengths).map(|p| p.id) == Some(piece_id)
                && let Some(waker) = w.value_mut().waker.take()
            {
                debug!(
                    stream_id = *w.key(),
                    piece_id = piece_id.get(),
                    "waking stream"
                );
                waker.wake();
            }
        }
    }

    fn drop_stream(&self, stream_id: StreamId) -> Option<StreamState> {
        debug!(stream_id, "dropping stream");
        let s = self.streams.remove(&stream_id).map(|s| s.1);
        self.changed.notify_one();
        s
    }

    pub(crate) async fn wait_changed(&self) {
        self.changed.notified().await
    }

    /// ss patch: absolute byte range each stream reads ahead of its position.
    pub(crate) fn reader_windows(&self) -> Vec<Range<u64>> {
        self.streams
            .iter()
            .map(|s| {
                let start = s.file_abs_offset + s.position;
                start..(start + PER_STREAM_BUF_DEFAULT).min(s.file_abs_offset + s.file_len)
            })
            .collect()
    }

    pub(crate) fn streamed_file_ids(&self) -> impl Iterator<Item = usize> + '_ {
        self.streams.iter().map(|s| s.value().file_id)
    }
}

pub struct FileStream {
    torrent: ManagedTorrentHandle,
    metadata: Arc<TorrentMetadata>,
    streams: Arc<TorrentStreams>,
    stream_id: usize,
    file_id: usize,
    position: u64,

    // file params
    file_len: u64,
    file_torrent_abs_offset: u64,

    _blocking_permit: OwnedSemaphorePermit,
}

macro_rules! map_io_err {
    ($e:expr) => {
        $e.map_err(|e| std::io::Error::new(std::io::ErrorKind::Other, e))
    };
}

macro_rules! poll_try_io {
    ($e:expr) => {{
        let e = map_io_err!($e);
        match e {
            Ok(r) => r,
            Err(e) => {
                debug!("stream error {e:#}");
                return Poll::Ready(Err(e));
            }
        }
    }};
}

impl AsyncRead for FileStream {
    fn poll_read(
        mut self: std::pin::Pin<&mut Self>,
        cx: &mut std::task::Context<'_>,
        tbuf: &mut tokio::io::ReadBuf<'_>,
    ) -> Poll<std::io::Result<()>> {
        // if the file is over, return 0
        if self.position == self.file_len {
            debug!(
                stream_id = self.stream_id,
                file_id = self.file_id,
                "stream completed, EOF"
            );
            return Poll::Ready(Ok(()));
        }

        let current = poll_try_io!(
            self.metadata
                .lengths()
                .compute_current_piece(self.position, self.file_torrent_abs_offset)
                .context("invalid position")
        );

        // if the piece is not there, register to wake when it is
        // check if we have the piece for real
        let mut entered_critical = false;
        let have = poll_try_io!(self.torrent.with_chunk_tracker(|ct| {
            let have = ct.get_have_pieces().as_slice()[current.id.get() as usize];
            if !have {
                entered_critical = self
                    .streams
                    .register_waker(self.stream_id, cx.waker().clone());
            }
            have
        }));
        if entered_critical {
            self.torrent.notify_new_pieces();
        }
        if !have {
            debug!(stream_id = self.stream_id, file_id = self.file_id, piece_id = %current.id, "poll pending, not have");
            return Poll::Pending;
        }

        // actually stream the piece
        let buf = tbuf.initialize_unfilled();
        let file_remaining = self.file_len - self.position;
        let bytes_to_read: usize = poll_try_io!(
            (buf.len() as u64)
                .min(current.piece_remaining as u64)
                .min(file_remaining)
                .try_into()
        );

        let buf = &mut buf[..bytes_to_read];

        let start = Instant::now();
        poll_try_io!(poll_try_io!(self.torrent.shared.spawner.block_in_place(
            || {
                self.torrent.with_storage_and_file(
                    self.file_id,
                    |files, _fi| {
                        files.pread_exact(self.file_id, self.position, buf)?;
                        Ok::<_, anyhow::Error>(())
                    },
                    &self.metadata,
                )
            }
        )));

        trace!(
            buflen = buf.len(),
            stream_id = self.stream_id,
            file_id = self.file_id,
            read_time = ?start.elapsed(),
            "will write bytes"
        );

        self.as_mut().advance(bytes_to_read as u64);
        tbuf.advance(bytes_to_read);

        Poll::Ready(Ok(()))
    }
}

impl AsyncSeek for FileStream {
    fn start_seek(
        mut self: std::pin::Pin<&mut Self>,
        position: std::io::SeekFrom,
    ) -> std::io::Result<()> {
        let end_i64 = map_io_err!(TryInto::<i64>::try_into(self.file_len))?;
        let new_pos: i64 = match position {
            SeekFrom::Start(s) => map_io_err!(s.try_into())?,
            SeekFrom::End(e) => map_io_err!(TryInto::<i64>::try_into(self.file_len))? + e,
            SeekFrom::Current(o) => map_io_err!(TryInto::<i64>::try_into(self.position))? + o,
        };

        if new_pos < 0 || new_pos > end_i64 {
            return Err(std::io::Error::new(
                std::io::ErrorKind::InvalidInput,
                anyhow::anyhow!("invalid seek"),
            ));
        }

        let old_pos = self.position;
        self.as_mut().set_position(map_io_err!(new_pos.try_into())?);
        if self.position != old_pos {
            self.streams.changed.notify_one();
        }
        debug!(stream_id = self.stream_id, position = self.position, "seek");
        Ok(())
    }

    fn poll_complete(
        self: std::pin::Pin<&mut Self>,
        _cx: &mut std::task::Context<'_>,
    ) -> Poll<std::io::Result<u64>> {
        Poll::Ready(Ok(self.position))
    }
}

impl Drop for FileStream {
    fn drop(&mut self) {
        self.streams.drop_stream(self.stream_id);
    }
}

impl ManagedTorrent {
    fn with_storage_and_file<F, R>(
        &self,
        file_id: usize,
        f: F,
        metadata: &TorrentMetadata,
    ) -> anyhow::Result<R>
    where
        F: FnOnce(&dyn TorrentStorage, &FileInfo) -> R,
    {
        self.with_state(|s| {
            let files = match s {
                crate::ManagedTorrentState::Paused(p) => &*p.files,
                crate::ManagedTorrentState::Live(l) => &*l.files,
                s => anyhow::bail!("with_storage_and_file: invalid state: {}", s.name()),
            };
            let fi = metadata.file_infos.get(file_id).context("invalid file")?;
            Ok(f(files, fi))
        })
    }

    fn streams(&self) -> anyhow::Result<Arc<TorrentStreams>> {
        self.with_state(|s| match s {
            crate::ManagedTorrentState::Paused(p) => Ok(p.streams.clone()),
            crate::ManagedTorrentState::Live(l) => Ok(l.streams.clone()),
            s => anyhow::bail!("streams: invalid state {}", s.name()),
        })
    }

    fn maybe_reconnect_needed_peers_for_file(&self, file_id: usize) -> bool {
        // If we have the full file, don't bother.
        if self.is_file_finished(file_id) {
            return false;
        }
        self.with_state(|state| {
            if let crate::ManagedTorrentState::Live(l) = &state {
                l.reconnect_all_not_needed_peers();
            }
        });
        true
    }

    // Peers idle on the old selection pick up a new critical window now
    // instead of on their 5 s timer.
    fn notify_new_pieces(&self) {
        if let Some(live) = self.live() {
            live.notify_new_pieces();
        }
    }

    fn is_file_finished(&self, file_id: usize) -> bool {
        let metadata = self.metadata.load();
        let metadata = match metadata.as_ref() {
            Some(r) => r,
            None => return false,
        };
        // TODO: would be nice to remove locking
        self.with_chunk_tracker(|ct| ct.is_file_finished(&metadata.file_infos[file_id]))
            .unwrap_or(false)
    }

    pub async fn stream(self: Arc<Self>, file_id: usize) -> anyhow::Result<FileStream> {
        let metadata = self
            .metadata
            .load_full()
            .context("torrent metadata is not resolved")?;
        let (fd_len, fd_offset) = self.with_storage_and_file(
            file_id,
            |_fd, fi| (fi.len, fi.offset_in_torrent),
            &metadata,
        )?;
        let streams = self.streams()?;
        let blocking_permit = self.shared().spawner.semaphore().acquire_owned().await?;
        let s = FileStream {
            stream_id: streams.next_id(),
            streams: streams.clone(),
            file_id,
            position: 0,

            file_len: fd_len,
            file_torrent_abs_offset: fd_offset,
            _blocking_permit: blocking_permit,
            torrent: self,
            metadata,
        };
        s.torrent.maybe_reconnect_needed_peers_for_file(file_id);
        streams.streams.insert(
            s.stream_id,
            StreamState {
                file_id,
                position: 0,
                waker: None,
                critical: true,
                bytes_per_sec: 0,
                file_len: fd_len,
                file_abs_offset: fd_offset,
            },
        );
        streams.changed.notify_one();

        s.torrent.notify_new_pieces();
        debug!(stream_id = s.stream_id, file_id, "started stream");

        Ok(s)
    }
}

impl FileStream {
    pub fn position(&self) -> u64 {
        self.position
    }

    fn advance(&mut self, diff: u64) {
        self.set_position(self.position + diff)
    }

    fn set_position(&mut self, new_pos: u64) {
        self.position = new_pos;
        self.streams
            .streams
            .get_mut(&self.stream_id)
            .unwrap()
            .value_mut()
            .position = new_pos;
    }

    pub fn len(&self) -> u64 {
        self.file_len
    }

    /// Media bitrate in bytes per second, when known. It sizes the window
    /// fetched first after opening, seeking or blocking (1.5 s of media,
    /// at least 2 MiB). 0 keeps the 2 MiB default.
    pub fn set_bytes_per_sec(&mut self, bytes_per_sec: u64) {
        if let Some(mut s) = self.streams.streams.get_mut(&self.stream_id) {
            s.bytes_per_sec = bytes_per_sec;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const MIB: u64 = 1024 * 1024;

    fn streams(piece_len: u64, positions: &[(u64, bool)]) -> (TorrentStreams, Lengths) {
        let lengths = Lengths::new(256 * MIB, piece_len as u32).unwrap();
        let streams = TorrentStreams::default();
        for &(position, critical) in positions {
            streams.streams.insert(
                streams.next_id(),
                StreamState {
                    file_id: 0,
                    file_len: 256 * MIB,
                    file_abs_offset: 0,
                    position,
                    waker: None,
                    critical,
                    bytes_per_sec: 0,
                },
            );
        }
        (streams, lengths)
    }

    fn is_critical(s: &TorrentStreams) -> bool {
        s.streams.get(&0).unwrap().critical
    }

    fn ids(pieces: &[ValidPieceIndex]) -> Vec<u32> {
        let mut v: Vec<_> = pieces.iter().map(|p| p.get()).collect();
        v.sort();
        v
    }

    #[test]
    fn critical_stream_narrows_selection_to_its_window() {
        let (s, l) = streams(MIB, &[(10 * MIB, true), (100 * MIB, false)]);
        let (pieces, critical) = s.next_pieces(&l, |_| false, |_| true);
        assert!(critical);
        assert_eq!(ids(&pieces), vec![10, 11]);
    }

    #[test]
    fn window_grows_with_bitrate_and_covers_at_least_a_piece() {
        let (s, l) = streams(MIB, &[(0, true)]);
        s.streams.get_mut(&0).unwrap().bytes_per_sec = 4 * MIB;
        assert_eq!(ids(&s.next_pieces(&l, |_| false, |_| true).0), (0..6).collect::<Vec<_>>());

        let (s, l) = streams(8 * MIB, &[(MIB, true)]);
        assert_eq!(ids(&s.next_pieces(&l, |_| false, |_| true).0), vec![0]);
    }

    #[test]
    fn critical_ends_once_half_the_window_arrived() {
        let (s, l) = streams(MIB, &[(10 * MIB + MIB / 2, true)]);
        assert!(s.settle_critical(&l, |p| p.get() == 10));
        assert!(is_critical(&s));
        assert!(s.settle_critical(&l, |p| p.get() == 10 || p.get() == 11));
        assert!(!is_critical(&s));
        assert!(!s.settle_critical(&l, |_| false));

        let (pieces, critical) = s.next_pieces(&l, |_| false, |_| true);
        assert!(!critical);
        assert_eq!(pieces.len(), 65);
        assert_eq!(pieces.first().map(|p| p.get()), Some(10));
    }

    #[test]
    fn large_piece_window_ends_only_with_the_piece() {
        let (s, l) = streams(8 * MIB, &[(MIB, true)]);
        s.settle_critical(&l, |_| false);
        assert!(is_critical(&s));
        s.settle_critical(&l, |p| p.get() == 0);
        assert!(!is_critical(&s));
    }

    #[test]
    fn peer_without_critical_pieces_keeps_normal_selection() {
        let (s, l) = streams(MIB, &[(10 * MIB, true)]);
        let (pieces, critical) = s.next_pieces(&l, |_| false, |p| p.get() > 11);
        assert!(!critical);
        assert_eq!(pieces.len(), 64);
        assert!(is_critical(&s));
    }

    #[test]
    fn seek_and_block_reenter_critical() {
        let (s, l) = streams(MIB, &[(0, true)]);
        s.settle_critical(&l, |p| p.get() == 0);
        assert!(s.mark_critical(0));
        assert!(!s.mark_critical(0));
        s.streams.get_mut(&0).unwrap().position = 50 * MIB;
        assert_eq!(ids(&s.next_pieces(&l, |p| p.get() == 0, |_| true).0), vec![50, 51]);

        s.settle_critical(&l, |_| true);
        assert!(s.register_waker(0, std::task::Waker::noop().clone()));
        assert!(s.next_pieces(&l, |_| false, |_| true).1);
    }
}
