//! Coordinates piece download state by wrapping ChunkTracker with inflight piece tracking.
//!
//! This module provides the [`PieceTracker`] type which encapsulates the relationship between
//! queued pieces (in ChunkTracker) and in-flight pieces (being downloaded by a peer).
//!
//! The key invariant maintained is: a piece is in exactly one state at any time:
//! - HAVE (completed)
//! - QUEUED (available to download)
//! - IN_FLIGHT (currently being downloaded)
//! - NOT_NEEDED (not selected for download)

use std::{
    collections::{HashMap, HashSet},
    time::{Duration, Instant},
};

use buffers::ByteBuf;
use librqbit_core::lengths::{ChunkInfo, ValidPieceIndex};
use peer_binary_protocol::Piece;

use crate::{
    chunk_tracker::{ChunkMarkingResult, ChunkTracker},
    file_info::FileInfo,
    type_aliases::{FileInfos, FilePriorities, PeerHandle},
};

/// Tracks a piece currently being downloaded.
#[derive(Debug, Clone)]
pub struct InflightPiece {
    // ss patch: a piece can be co-downloaded by several peers, each taking
    // the chunks the others have not fetched yet. The first entry is the
    // original owner for steal accounting.
    pub peers: Vec<PeerHandle>,
    pub started: Instant,
    // ss patch: when a chunk of it last arrived, or it last changed hands.
    pub last_progress: Instant,
}

/// ss patch: a peer with work out that has delivered nothing for this long is
/// stalled, and its pieces in a stream's window go to the next peer that asks.
pub const STALL_TIMEOUT: Duration = Duration::from_secs(1);

/// Result of attempting to acquire a piece.
#[derive(Debug)]
pub enum AcquireResult {
    /// A new piece was reserved from the queue.
    Reserved(ValidPieceIndex),
    /// A piece was stolen from a slower peer.
    Stolen {
        piece: ValidPieceIndex,
        from_peer: PeerHandle,
    },
    /// The peer joined an in-flight priority piece to co-download its
    /// remaining chunks (ss patch).
    Joined(ValidPieceIndex),
    /// No pieces are available for this peer.
    NoneAvailable,
}

/// Parameters for acquiring a piece.
pub struct AcquireRequest<'a, I, P, S>
where
    I: Iterator<Item = ValidPieceIndex>,
    P: Fn(ValidPieceIndex) -> bool,
    S: Fn(ValidPieceIndex) -> bool,
{
    /// The peer requesting a piece.
    pub peer: PeerHandle,
    /// The peer's average piece download time (for steal calculations).
    pub peer_avg_time: Option<Duration>,
    /// Priority pieces to check first (e.g., for streaming).
    pub priority_pieces: I,
    /// File download priority ordering.
    pub file_priorities: &'a FilePriorities,
    /// File metadata for iterating pieces.
    pub file_infos: &'a FileInfos,
    /// Returns true if the peer has the given piece.
    pub peer_has_piece: P,
    /// Returns true if the piece can be stolen (e.g., not locked for writing).
    pub can_steal: S,
}

/// Coordinates piece download state.
///
/// Wraps a [`ChunkTracker`] with tracking of which pieces are currently being downloaded
/// (in-flight) and by which peer. This ensures that:
///
/// - A piece is only assigned to one peer at a time (unless stolen)
/// - Pieces are properly requeued when a peer dies
/// - State transitions maintain invariants
pub struct PieceTracker {
    chunks: ChunkTracker,
    inflight: HashMap<ValidPieceIndex, InflightPiece>,
    // ss patch: per peer, when it last delivered a chunk we kept, or when it
    // got work while holding none.
    last_data: HashMap<PeerHandle, Instant>,
}

impl PieceTracker {
    // === CONSTRUCTION ===

    /// Create a new PieceTracker wrapping the given ChunkTracker.
    pub fn new(chunks: ChunkTracker) -> Self {
        Self {
            chunks,
            inflight: HashMap::new(),
            last_data: HashMap::new(),
        }
    }

    /// Read-only access to the underlying ChunkTracker.
    pub fn chunks(&self) -> &ChunkTracker {
        &self.chunks
    }

    /// Consume the PieceTracker, requeuing any in-flight pieces.
    ///
    /// This is used when pausing a torrent - any pieces that were being downloaded
    /// need to be put back in the queue so they can be re-downloaded on resume.
    pub fn into_chunks(mut self) -> ChunkTracker {
        // Requeue all in-flight pieces so they'll be re-downloaded on resume
        for piece in self.inflight.into_keys() {
            self.chunks.mark_piece_broken_if_not_have(piece);
        }
        self.chunks
    }

    // === PIECE ACQUISITION ===

    /// Attempt to acquire a piece for the requesting peer.
    ///
    /// The acquisition strategy is:
    /// 1. Try to steal a piece from a peer that's 10x slower
    /// 2. Try to reserve a piece from the queue (priority pieces first)
    /// 3. Try to steal a piece from a peer that's 3x slower
    ///
    /// If `Stolen` is returned, the caller MUST call `peers.on_steal()` to notify
    /// the old peer and update counters.
    pub fn acquire_piece<I, P, S>(&mut self, mut req: AcquireRequest<I, P, S>) -> AcquireResult
    where
        I: Iterator<Item = ValidPieceIndex>,
        P: Fn(ValidPieceIndex) -> bool,
        S: Fn(ValidPieceIndex) -> bool,
    {
        // ss patch: the priority pieces are collected so that, when every one
        // of them is already in flight, an idle peer can steal the most stuck
        // one below instead of wandering off to the far side of the file.
        let priority: Vec<ValidPieceIndex> = req.priority_pieces.by_ref().collect();

        if let Some(result) = self.try_steal_stalled(&req, &priority) {
            return result;
        }

        // 1. Try steal with 10x threshold (very slow peer)
        // ss patch: while a reader is waiting on priority pieces, a steal
        // only takes one of those. With the whole file selected behind the
        // window, the in-flight map is full of far-away pieces that have
        // been sitting the longest, and an idle peer would otherwise be
        // sent to rescue one of them instead of what the reader is on.
        if let Some(result) = self.try_steal(&req, 10.0, &priority) {
            return result;
        }

        // 2. Try reserve from priority_pieces then queued pieces
        // First check priority pieces that aren't already downloaded or in-flight
        //
        // ss patch: the pieces at the head of the priority list are the ones
        // a reader is blocked on right now, and with large pieces the peer
        // that owns one sets the pace on its own. So, before taking a free
        // piece further down, an idle peer joins a head piece that still has
        // room: the head fetches with several peers, the rest with one each.
        // Without this the join only happened once every priority piece was
        // in flight — which, with dozens of peers and sixteen pieces in the
        // window, was never.
        const MAX_CODOWNLOADERS: usize = 4;
        const HEAD_PIECES: usize = 2;
        let mut head = 0usize;
        for &piece in &priority {
            if self.chunks.is_piece_have(piece) || !(req.peer_has_piece)(piece) {
                continue;
            }
            match self.inflight.get_mut(&piece) {
                None => return self.reserve_piece(piece, req.peer),
                Some(info) if head < HEAD_PIECES => {
                    head += 1;
                    if info.peers.contains(&req.peer) || info.peers.len() >= MAX_CODOWNLOADERS {
                        continue;
                    }
                    info.peers.push(req.peer);
                    self.note_assigned(req.peer, piece);
                    return AcquireResult::Joined(piece);
                }
                Some(_) => continue,
            }
        }

        // 2.5 Priority co-download: every priority piece is in flight. An
        // idle peer joins the first one with room and fetches the chunks the
        // others have not taken, back to front. This is the intra-piece
        // parallelism streaming clients get from virtual pieces.
        for &piece in &priority {
            if self.chunks.is_piece_have(piece) || !(req.peer_has_piece)(piece) {
                continue;
            }
            if let Some(info) = self.inflight.get_mut(&piece) {
                if info.peers.contains(&req.peer) || info.peers.len() >= MAX_CODOWNLOADERS {
                    continue;
                }
                info.peers.push(req.peer);
                self.note_assigned(req.peer, piece);
                return AcquireResult::Joined(piece);
            }
        }

        // Then check naturally ordered queued pieces
        // Note: iter_queued_pieces only returns pieces in queue_pieces (not in-flight)
        let queued: Vec<_> = self
            .chunks
            .iter_queued_pieces(req.file_priorities, req.file_infos)
            .collect();

        for piece in queued {
            if (req.peer_has_piece)(piece) {
                return self.reserve_piece(piece, req.peer);
            }
        }

        // 3. Try steal with 3x threshold (moderately slow peer)
        if let Some(result) = self.try_steal(&req, 3.0, &priority) {
            return result;
        }

        AcquireResult::NoneAvailable
    }

    /// Reserve a piece: remove from queue, add to inflight.
    fn reserve_piece(&mut self, piece: ValidPieceIndex, peer: PeerHandle) -> AcquireResult {
        self.chunks.reserve_needed_piece(piece);
        let now = Instant::now();
        self.inflight.insert(
            piece,
            InflightPiece {
                peers: vec![peer],
                started: now,
                last_progress: now,
            },
        );
        self.note_assigned(peer, piece);
        AcquireResult::Reserved(piece)
    }

    // A peer that held no work starts its stall clock when it gets some.
    fn note_assigned(&mut self, peer: PeerHandle, piece: ValidPieceIndex) {
        let holds_other = self
            .inflight
            .iter()
            .any(|(p, info)| *p != piece && info.peers.contains(&peer));
        if !holds_other {
            self.last_data.insert(peer, Instant::now());
        }
    }

    fn is_stalled(&self, peer: PeerHandle, now: Instant) -> bool {
        self.last_data
            .get(&peer)
            .is_some_and(|t| now.saturating_duration_since(*t) >= STALL_TIMEOUT)
            && self.inflight.values().any(|info| info.peers.contains(&peer))
    }

    /// ss patch: a piece in a stream's window whose peers have all gone
    /// quiet is handed to the asking peer right away, whether or not it has
    /// a piece time of its own to compare against. The old owners' requests
    /// for it are cancelled by `on_steal`, and their requester loop stops at
    /// the next chunk once it sees the piece is no longer theirs.
    fn try_steal_stalled<I, P, S>(
        &mut self,
        req: &AcquireRequest<I, P, S>,
        priority: &[ValidPieceIndex],
    ) -> Option<AcquireResult>
    where
        I: Iterator<Item = ValidPieceIndex>,
        P: Fn(ValidPieceIndex) -> bool,
        S: Fn(ValidPieceIndex) -> bool,
    {
        let now = Instant::now();
        if priority.is_empty() || self.is_stalled(req.peer, now) {
            return None;
        }
        let piece = priority.iter().copied().find(|p| {
            (req.peer_has_piece)(*p)
                && self.inflight.get(p).is_some_and(|info| {
                    !info.peers.contains(&req.peer)
                        && now.saturating_duration_since(info.last_progress) >= STALL_TIMEOUT
                        && info.peers.iter().all(|q| self.is_stalled(*q, now))
                })
                && (req.can_steal)(*p)
        })?;

        self.note_assigned(req.peer, piece);
        let info = self.inflight.get_mut(&piece)?;
        let from_peer = *info.peers.first()?;
        info.peers = vec![req.peer];
        info.started = now;
        info.last_progress = now;
        Some(AcquireResult::Stolen { piece, from_peer })
    }

    /// Try to steal a piece from a slower peer.
    fn try_steal<I, P, S>(
        &mut self,
        req: &AcquireRequest<I, P, S>,
        threshold: f64,
        priority: &[ValidPieceIndex],
    ) -> Option<AcquireResult>
    where
        I: Iterator<Item = ValidPieceIndex>,
        P: Fn(ValidPieceIndex) -> bool,
        S: Fn(ValidPieceIndex) -> bool,
    {
        let my_avg = req.peer_avg_time?;
        let min_elapsed = Duration::from_secs_f64(my_avg.as_secs_f64() * threshold);

        // Find the slowest piece from another peer that exceeds threshold
        // and that the stealing peer actually has (can download)
        let (piece, old_peer, _) = self
            .inflight
            .iter()
            .filter(|(_, info)| !info.peers.contains(&req.peer))
            .filter(|(p, _)| priority.is_empty() || priority.contains(p))
            .filter(|(p, _)| (req.peer_has_piece)(**p))
            .filter_map(|(p, info)| {
                info.peers.first().map(|peer| (*p, *peer, info.started.elapsed()))
            })
            .filter(|(_, _, elapsed)| *elapsed >= min_elapsed)
            .max_by_key(|(_, _, elapsed)| *elapsed)?;

        // Check can_steal (e.g., per_piece_lock)
        if !(req.can_steal)(piece) {
            return None;
        }

        // Update ownership (piece stays in inflight, just changes owner)
        self.note_assigned(req.peer, piece);
        let info = self.inflight.get_mut(&piece)?;
        info.peers = vec![req.peer];
        info.started = Instant::now();
        info.last_progress = info.started;

        Some(AcquireResult::Stolen {
            piece,
            from_peer: old_peer,
        })
    }

    // === PIECE COMPLETION ===

    /// Remove piece from inflight tracking (e.g., after all chunks received).
    ///
    /// Returns download duration if piece was in-flight.
    /// Note: Does NOT mark the piece as downloaded - caller should do hash check
    /// and then call `mark_piece_hash_ok` or `mark_piece_hash_failed`.
    pub fn take_inflight(&mut self, piece: ValidPieceIndex) -> Option<Duration> {
        let inflight = self.inflight.remove(&piece)?;
        Some(inflight.started.elapsed())
    }

    /// Mark piece as downloaded after successful hash verification.
    pub fn mark_piece_hash_ok(&mut self, piece: ValidPieceIndex) {
        self.chunks.mark_piece_downloaded(piece);
    }

    /// Mark piece as failed after hash verification failure - requeues the piece.
    pub fn mark_piece_hash_failed(&mut self, piece: ValidPieceIndex) {
        self.chunks.mark_piece_broken_if_not_have(piece);
    }

    /// Release all pieces owned by a peer (on peer death).
    ///
    /// Moves all pieces owned by the peer from IN_FLIGHT back to QUEUED.
    /// Returns the number of pieces released.
    pub fn release_pieces_owned_by(&mut self, peer: PeerHandle) -> usize {
        // ss patch: a co-downloaded piece stays in flight while any peer is
        // still on it; only the last one leaving requeues it.
        let pieces_to_release: Vec<_> = self
            .inflight
            .iter_mut()
            .filter(|(_, info)| info.peers.contains(&peer))
            .map(|(p, info)| {
                info.peers.retain(|other| *other != peer);
                (*p, info.peers.is_empty())
            })
            .collect();

        self.last_data.remove(&peer);
        let mut count = 0;
        for (piece, abandoned) in pieces_to_release {
            if !abandoned {
                continue;
            }
            count += 1;
            self.inflight.remove(&piece);
            self.chunks.mark_piece_broken_if_not_have(piece);
        }
        count
    }

    /// ss patch: `peer` gives up one piece (its requests for it went
    /// unanswered). Co-downloaders keep it; if nobody is left it goes back to
    /// the queue with the chunks already written. Returns true if requeued.
    pub fn release_piece_from(&mut self, piece: ValidPieceIndex, peer: PeerHandle) -> bool {
        let Some(info) = self.inflight.get_mut(&piece) else {
            return false;
        };
        info.peers.retain(|other| *other != peer);
        if !info.peers.is_empty() {
            return false;
        }
        self.inflight.remove(&piece);
        self.chunks.requeue_piece_keep_chunks(piece);
        true
    }

    /// ss patch: checked right before each request goes out. None once the
    /// piece is no longer this peer's to fetch (stolen, released, done),
    /// Some(false) when another peer already brought the chunk.
    pub fn should_request_chunk(&self, peer: PeerHandle, chunk: &ChunkInfo) -> Option<bool> {
        let info = self.inflight.get(&chunk.piece_index)?;
        if !info.peers.contains(&peer) {
            return None;
        }
        Some(!self.chunks.is_chunk_downloaded(chunk))
    }

    // === QUERIES ===

    /// Get the inflight info for a piece, if it's currently being downloaded.
    pub fn get_inflight(&self, piece: ValidPieceIndex) -> Option<&InflightPiece> {
        self.inflight.get(&piece)
    }

    /// Check if a piece is currently in-flight.
    #[allow(dead_code)]
    pub fn is_inflight(&self, piece: ValidPieceIndex) -> bool {
        self.inflight.contains_key(&piece)
    }

    /// Get the number of pieces currently in-flight.
    #[allow(dead_code)]
    pub fn inflight_count(&self) -> usize {
        self.inflight.len()
    }

    // === PASS-THROUGH METHODS ===

    /// Mark a chunk as downloaded. Returns the result indicating if the piece is complete.
    pub fn mark_chunk_downloaded(
        &mut self,
        peer: PeerHandle,
        piece: &Piece<ByteBuf<'_>>,
    ) -> Option<ChunkMarkingResult> {
        let result = self.chunks.mark_chunk_downloaded(piece)?;
        let now = Instant::now();
        self.last_data.insert(peer, now);
        if let Some(info) = self
            .chunks
            .get_lengths()
            .validate_piece_index(piece.index)
            .and_then(|p| self.inflight.get_mut(&p))
        {
            info.last_progress = now;
        }
        Some(result)
    }

    /// Update which files are selected for download.
    pub fn update_only_files(
        &mut self,
        file_infos: &FileInfos,
        new_only_files: &HashSet<usize>,
    ) -> anyhow::Result<crate::chunk_tracker::HaveNeededSelected> {
        let inflight: HashSet<usize> = self.inflight.keys().map(|p| p.get_usize()).collect();
        self.chunks.update_only_files_except(file_infos, new_only_files, |i| inflight.contains(&i))
    }

    /// ss patch: select pieces directly, for a streaming reader that only
    /// needs a window around its cursor rather than the whole file.
    pub fn update_selected_pieces(
        &mut self,
        selected: crate::type_aliases::BF,
    ) -> anyhow::Result<crate::chunk_tracker::HaveNeededSelected> {
        let inflight: HashSet<usize> = self.inflight.keys().map(|p| p.get_usize()).collect();
        self.chunks.update_selected_pieces_except(selected, |i| inflight.contains(&i))
    }

    /// ss patch: give up pieces the window has left behind, so their storage
    /// can be released. Only pieces that are HAVE and not selected are
    /// touched, which by the invariant above is never one in flight.
    pub fn forget_pieces(
        &mut self,
        forget: &crate::type_aliases::BS,
        file_infos: &FileInfos,
    ) -> Vec<u32> {
        self.chunks.forget_pieces(forget, file_infos)
    }

    /// Update per-file have bytes when a piece completes. Returns remaining bytes for the file.
    pub fn update_file_have_on_piece_completed(
        &mut self,
        piece_id: ValidPieceIndex,
        file_id: usize,
        file_info: &FileInfo,
    ) -> u64 {
        self.chunks
            .update_file_have_on_piece_completed(piece_id, file_id, file_info)
    }

    /// Flush the have pieces bitfield to disk.
    pub fn flush_have_pieces(&mut self, flush_async: bool) -> anyhow::Result<()> {
        self.chunks.get_have_pieces_mut().flush(flush_async)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{bitv::BitV as BitVTrait, type_aliases::BF};
    use librqbit_core::lengths::Lengths;
    use std::net::{IpAddr, Ipv4Addr, SocketAddr};

    fn peer(id: u8) -> PeerHandle {
        SocketAddr::new(IpAddr::V4(Ipv4Addr::new(127, 0, 0, id)), 6881)
    }

    /// Create a simple ChunkTracker for testing.
    /// Creates a torrent with the specified number of pieces, all selected.
    fn make_test_chunk_tracker(num_pieces: u32) -> ChunkTracker {
        // Create a simple single-file torrent
        let piece_length = 16384u32; // 16KB pieces
        let total_length = piece_length as u64 * num_pieces as u64;

        let lengths = Lengths::new(total_length, piece_length).unwrap();

        let bf_len = lengths.piece_bitfield_bytes();

        // No pieces downloaded yet (empty have)
        let have = BF::from_boxed_slice(vec![0u8; bf_len].into_boxed_slice());

        // All pieces selected
        let mut selected = BF::from_boxed_slice(vec![0u8; bf_len].into_boxed_slice());
        for i in 0..num_pieces as usize {
            selected.set(i, true);
        }

        // Single file spanning all pieces
        let file_infos = vec![crate::file_info::FileInfo {
            relative_filename: "test.dat".into(),
            offset_in_torrent: 0,
            len: total_length,
            piece_range: 0..num_pieces,
            attrs: Default::default(),
        }];

        ChunkTracker::new(have.into_dyn(), selected, lengths, &file_infos).unwrap()
    }

    fn make_test_file_infos(num_pieces: u32) -> FileInfos {
        let piece_length = 16384u64;
        vec![crate::file_info::FileInfo {
            relative_filename: "test.dat".into(),
            offset_in_torrent: 0,
            len: piece_length * num_pieces as u64,
            piece_range: 0..num_pieces,
            attrs: Default::default(),
        }]
    }

    fn make_default_file_priorities(file_infos: &FileInfos) -> FilePriorities {
        (0..file_infos.len()).collect()
    }

    #[test]
    fn test_new_piece_tracker() {
        let chunks = make_test_chunk_tracker(10);
        let tracker = PieceTracker::new(chunks);
        assert_eq!(tracker.inflight_count(), 0);
    }

    #[test]
    fn test_reserve_piece_from_queue() {
        let chunks = make_test_chunk_tracker(5);
        let mut tracker = PieceTracker::new(chunks);

        let file_infos = make_test_file_infos(5);
        let file_priorities = make_default_file_priorities(&file_infos);

        let result = tracker.acquire_piece(AcquireRequest {
            peer: peer(1),
            peer_avg_time: None,
            priority_pieces: std::iter::empty(),
            file_priorities: &file_priorities,
            file_infos: &file_infos,
            peer_has_piece: |_| true, // Peer has all pieces
            can_steal: |_| true,
        });

        // Should reserve piece 0 (first in queue)
        match result {
            AcquireResult::Reserved(piece) => {
                assert_eq!(piece.get(), 0);
                assert!(tracker.is_inflight(piece));
                assert_eq!(tracker.inflight_count(), 1);
            }
            _ => panic!("Expected Reserved, got {:?}", result),
        }
    }

    #[test]
    fn test_reserve_filters_by_peer_has_piece() {
        let chunks = make_test_chunk_tracker(5);
        let mut tracker = PieceTracker::new(chunks);

        let file_infos = make_test_file_infos(5);
        let file_priorities = make_default_file_priorities(&file_infos);

        // Peer only has piece 2 and later
        // Note: iter_queued_pieces iterates in order: first, last, middle
        // So for 0..5: 0, 4, 1, 2, 3
        // With filter >= 2, we get 4 first (skips 0, takes 4)
        let result = tracker.acquire_piece(AcquireRequest {
            peer: peer(1),
            peer_avg_time: None,
            priority_pieces: std::iter::empty(),
            file_priorities: &file_priorities,
            file_infos: &file_infos,
            peer_has_piece: |p| p.get() >= 2,
            can_steal: |_| true,
        });

        match result {
            AcquireResult::Reserved(piece) => {
                // Got piece 4 (first one peer has in iteration order)
                assert!(piece.get() >= 2, "Should have gotten a piece >= 2");
            }
            _ => panic!("Expected Reserved, got {:?}", result),
        }
    }

    #[test]
    fn test_complete_piece() {
        let chunks = make_test_chunk_tracker(5);
        let mut tracker = PieceTracker::new(chunks);

        let file_infos = make_test_file_infos(5);
        let file_priorities = make_default_file_priorities(&file_infos);

        // Reserve a piece first
        let result = tracker.acquire_piece(AcquireRequest {
            peer: peer(1),
            peer_avg_time: None,
            priority_pieces: std::iter::empty(),
            file_priorities: &file_priorities,
            file_infos: &file_infos,
            peer_has_piece: |_| true,
            can_steal: |_| true,
        });

        let piece = match result {
            AcquireResult::Reserved(p) => p,
            _ => panic!("Expected Reserved"),
        };

        // Complete the piece (take_inflight + hash check + mark_piece_hash_ok)
        let duration = tracker.take_inflight(piece);
        assert!(duration.is_some());
        assert!(!tracker.is_inflight(piece));
        // Simulate successful hash check
        tracker.mark_piece_hash_ok(piece);
        assert!(tracker.chunks().is_piece_have(piece));
    }

    #[test]
    fn test_fail_piece_requeues() {
        let chunks = make_test_chunk_tracker(5);
        let mut tracker = PieceTracker::new(chunks);

        let file_infos = make_test_file_infos(5);
        let file_priorities = make_default_file_priorities(&file_infos);

        // Reserve piece 0
        let result = tracker.acquire_piece(AcquireRequest {
            peer: peer(1),
            peer_avg_time: None,
            priority_pieces: std::iter::empty(),
            file_priorities: &file_priorities,
            file_infos: &file_infos,
            peer_has_piece: |_| true,
            can_steal: |_| true,
        });

        let piece = match result {
            AcquireResult::Reserved(p) => p,
            _ => panic!("Expected Reserved"),
        };

        assert!(tracker.is_inflight(piece));

        // Fail the piece (take_inflight + hash check fails + mark_piece_hash_failed)
        let duration = tracker.take_inflight(piece);
        assert!(duration.is_some());
        // Simulate failed hash check
        tracker.mark_piece_hash_failed(piece);

        // Should no longer be in-flight
        assert!(!tracker.is_inflight(piece));
        // Should not be in have
        assert!(!tracker.chunks().is_piece_have(piece));
        // Should be back in queue - verify by trying to reserve it again
        let result2 = tracker.acquire_piece(AcquireRequest {
            peer: peer(2),
            peer_avg_time: None,
            priority_pieces: std::iter::empty(),
            file_priorities: &file_priorities,
            file_infos: &file_infos,
            peer_has_piece: |p| p == piece, // Only has the failed piece
            can_steal: |_| true,
        });

        match result2 {
            AcquireResult::Reserved(p) => assert_eq!(p, piece),
            _ => panic!("Expected piece to be re-reservable after fail"),
        }
    }

    #[test]
    fn test_release_pieces_owned_by_peer() {
        let chunks = make_test_chunk_tracker(5);
        let mut tracker = PieceTracker::new(chunks);

        let file_infos = make_test_file_infos(5);
        let file_priorities = make_default_file_priorities(&file_infos);

        let peer_a = peer(1);
        let peer_b = peer(2);

        // Peer A reserves first two pieces (order: 0, 4, 1, 2, 3)
        // So peer A gets pieces 0 and 4
        let piece_a1 = match tracker.acquire_piece(AcquireRequest {
            peer: peer_a,
            peer_avg_time: None,
            priority_pieces: std::iter::empty(),
            file_priorities: &file_priorities,
            file_infos: &file_infos,
            peer_has_piece: |_| true,
            can_steal: |_| true,
        }) {
            AcquireResult::Reserved(p) => p,
            _ => panic!("Expected Reserved"),
        };
        let piece_a2 = match tracker.acquire_piece(AcquireRequest {
            peer: peer_a,
            peer_avg_time: None,
            priority_pieces: std::iter::empty(),
            file_priorities: &file_priorities,
            file_infos: &file_infos,
            peer_has_piece: |_| true,
            can_steal: |_| true,
        }) {
            AcquireResult::Reserved(p) => p,
            _ => panic!("Expected Reserved"),
        };

        // Peer B reserves next piece
        let piece_b = match tracker.acquire_piece(AcquireRequest {
            peer: peer_b,
            peer_avg_time: None,
            priority_pieces: std::iter::empty(),
            file_priorities: &file_priorities,
            file_infos: &file_infos,
            peer_has_piece: |_| true,
            can_steal: |_| true,
        }) {
            AcquireResult::Reserved(p) => p,
            _ => panic!("Expected Reserved"),
        };

        assert_eq!(tracker.inflight_count(), 3);
        assert!(tracker.is_inflight(piece_a1));
        assert!(tracker.is_inflight(piece_a2));
        assert!(tracker.is_inflight(piece_b));

        // Peer A dies
        let released = tracker.release_pieces_owned_by(peer_a);
        assert_eq!(released, 2);
        assert_eq!(tracker.inflight_count(), 1); // Only peer B's piece remains

        // Verify peer B's piece is still in-flight
        assert!(tracker.is_inflight(piece_b));
        // Verify peer A's pieces are no longer in-flight
        assert!(!tracker.is_inflight(piece_a1));
        assert!(!tracker.is_inflight(piece_a2));
    }

    #[test]
    fn test_into_chunks_requeues_inflight() {
        let chunks = make_test_chunk_tracker(5);
        let mut tracker = PieceTracker::new(chunks);

        let file_infos = make_test_file_infos(5);
        let file_priorities = make_default_file_priorities(&file_infos);

        // Reserve pieces 0 and 1
        tracker.acquire_piece(AcquireRequest {
            peer: peer(1),
            peer_avg_time: None,
            priority_pieces: std::iter::empty(),
            file_priorities: &file_priorities,
            file_infos: &file_infos,
            peer_has_piece: |_| true,
            can_steal: |_| true,
        });
        tracker.acquire_piece(AcquireRequest {
            peer: peer(1),
            peer_avg_time: None,
            priority_pieces: std::iter::empty(),
            file_priorities: &file_priorities,
            file_infos: &file_infos,
            peer_has_piece: |_| true,
            can_steal: |_| true,
        });

        assert_eq!(tracker.inflight_count(), 2);

        // Convert back to chunks (simulates pause)
        let chunks = tracker.into_chunks();

        // Create a new tracker and verify pieces are back in queue
        let mut new_tracker = PieceTracker::new(chunks);
        let result = new_tracker.acquire_piece(AcquireRequest {
            peer: peer(2),
            peer_avg_time: None,
            priority_pieces: std::iter::empty(),
            file_priorities: &file_priorities,
            file_infos: &file_infos,
            peer_has_piece: |_| true,
            can_steal: |_| true,
        });

        // Should get piece 0 again (was requeued)
        match result {
            AcquireResult::Reserved(p) => assert_eq!(p.get(), 0),
            _ => panic!("Expected to reserve piece 0 after into_chunks"),
        }
    }

    #[test]
    fn test_priority_pieces_checked_first() {
        let chunks = make_test_chunk_tracker(5);
        let mut tracker = PieceTracker::new(chunks);

        let file_infos = make_test_file_infos(5);
        let file_priorities = make_default_file_priorities(&file_infos);

        // Priority pieces: piece 3, then piece 2
        let piece3 = tracker
            .chunks()
            .get_lengths()
            .validate_piece_index(3)
            .unwrap();
        let piece2 = tracker
            .chunks()
            .get_lengths()
            .validate_piece_index(2)
            .unwrap();
        let priority = vec![piece3, piece2];

        let result = tracker.acquire_piece(AcquireRequest {
            peer: peer(1),
            peer_avg_time: None,
            priority_pieces: priority.into_iter(),
            file_priorities: &file_priorities,
            file_infos: &file_infos,
            peer_has_piece: |_| true,
            can_steal: |_| true,
        });

        // Should get piece 3 (first priority piece)
        match result {
            AcquireResult::Reserved(p) => assert_eq!(p.get(), 3),
            _ => panic!("Expected Reserved(3), got {:?}", result),
        }
    }

    #[test]
    fn test_none_available_when_no_pieces() {
        let chunks = make_test_chunk_tracker(5);
        let mut tracker = PieceTracker::new(chunks);

        let file_infos = make_test_file_infos(5);
        let file_priorities = make_default_file_priorities(&file_infos);

        // Peer has no pieces
        let result = tracker.acquire_piece(AcquireRequest {
            peer: peer(1),
            peer_avg_time: None,
            priority_pieces: std::iter::empty(),
            file_priorities: &file_priorities,
            file_infos: &file_infos,
            peer_has_piece: |_| false, // Peer has nothing
            can_steal: |_| true,
        });

        match result {
            AcquireResult::NoneAvailable => {}
            _ => panic!("Expected NoneAvailable, got {:?}", result),
        }
    }

    #[test]
    fn test_take_inflight_nonexistent_piece_returns_none() {
        let chunks = make_test_chunk_tracker(5);
        let mut tracker = PieceTracker::new(chunks);
        let piece = tracker
            .chunks()
            .get_lengths()
            .validate_piece_index(0)
            .unwrap();

        // Try to take a piece that's not in-flight
        let result = tracker.take_inflight(piece);
        assert!(result.is_none());
    }

    #[test]
    fn test_steal_only_pieces_peer_has() {
        // This test verifies the fix for a bug where try_steal didn't check
        // if the stealing peer actually has the piece in their bitfield.
        // Without this check, a peer could "steal" a piece they can't download,
        // leaving it stuck in inflight forever.

        let chunks = make_test_chunk_tracker(5);
        let mut tracker = PieceTracker::new(chunks);

        let file_infos = make_test_file_infos(5);
        let file_priorities = make_default_file_priorities(&file_infos);

        let peer_a = peer(1);
        let peer_b = peer(2);

        // Peer A reserves pieces 0 and 4 (first two in iteration order)
        let piece_0 = match tracker.acquire_piece(AcquireRequest {
            peer: peer_a,
            peer_avg_time: None,
            priority_pieces: std::iter::empty(),
            file_priorities: &file_priorities,
            file_infos: &file_infos,
            peer_has_piece: |_| true,
            can_steal: |_| true,
        }) {
            AcquireResult::Reserved(p) => {
                assert_eq!(p.get(), 0);
                p
            }
            _ => panic!("Expected Reserved"),
        };

        let piece_4 = match tracker.acquire_piece(AcquireRequest {
            peer: peer_a,
            peer_avg_time: None,
            priority_pieces: std::iter::empty(),
            file_priorities: &file_priorities,
            file_infos: &file_infos,
            peer_has_piece: |_| true,
            can_steal: |_| true,
        }) {
            AcquireResult::Reserved(p) => {
                assert_eq!(p.get(), 4);
                p
            }
            _ => panic!("Expected Reserved"),
        };

        // Sleep briefly so pieces become stealable
        std::thread::sleep(Duration::from_millis(5));

        // Peer B tries to acquire with:
        // - Very short avg_time (1ms) so 3x threshold = 3ms < 5ms elapsed
        // - peer_has_piece returns true ONLY for piece 4, NOT piece 0
        let result = tracker.acquire_piece(AcquireRequest {
            peer: peer_b,
            peer_avg_time: Some(Duration::from_millis(1)),
            priority_pieces: std::iter::empty(),
            file_priorities: &file_priorities,
            file_infos: &file_infos,
            peer_has_piece: |p| p.get() == 4, // Peer B only has piece 4
            can_steal: |_| true,
        });

        // Should steal piece 4 (which peer B has), NOT piece 0 (which peer B doesn't have)
        match result {
            AcquireResult::Stolen { piece, from_peer } => {
                assert_eq!(piece, piece_4, "Should steal piece 4 (the one peer B has)");
                assert_eq!(from_peer, peer_a);
                // Verify piece 0 is still owned by peer A (wasn't stolen)
                assert_eq!(tracker.get_inflight(piece_0).unwrap().peers[0], peer_a);
            }
            _ => panic!("Expected Stolen, got {:?}", result),
        }
    }

    #[test]
    fn a_piece_in_flight_is_not_queued_again_when_the_window_returns_to_it() {
        let mut tracker = PieceTracker::new(make_test_chunk_tracker(3));
        let file_infos = make_test_file_infos(3);
        let file_priorities = make_default_file_priorities(&file_infos);
        let mut acquire = |tracker: &mut PieceTracker| {
            tracker.acquire_piece(AcquireRequest {
                peer: peer(1),
                peer_avg_time: None,
                priority_pieces: std::iter::empty(),
                file_priorities: &file_priorities,
                file_infos: &file_infos,
                peer_has_piece: |p| p.get() == 1,
                can_steal: |_| true,
            })
        };
        let selection = |on: &[usize]| {
            let mut bf = BF::from_boxed_slice(vec![0u8; 1].into_boxed_slice());
            for &i in on {
                bf.set(i, true);
            }
            bf
        };

        assert!(matches!(acquire(&mut tracker), AcquireResult::Reserved(p) if p.get() == 1));
        tracker.update_selected_pieces(selection(&[0, 2])).unwrap();
        tracker.update_selected_pieces(selection(&[0, 1, 2])).unwrap();

        let again = acquire(&mut tracker);
        assert!(matches!(again, AcquireResult::NoneAvailable), "piece 1 handed out twice: {again:?}");
    }

    // Pieces of four chunks, so partial progress inside a piece shows.
    const CHUNK: u32 = 16384;
    const PIECE: u32 = CHUNK * 4;

    fn multi_chunk_tracker(num_pieces: u32) -> (PieceTracker, FileInfos) {
        let total_length = PIECE as u64 * num_pieces as u64;
        let lengths = Lengths::new(total_length, PIECE).unwrap();
        let bf_len = lengths.piece_bitfield_bytes();
        let have = BF::from_boxed_slice(vec![0u8; bf_len].into_boxed_slice());
        let mut selected = BF::from_boxed_slice(vec![0u8; bf_len].into_boxed_slice());
        for i in 0..num_pieces as usize {
            selected.set(i, true);
        }
        let file_infos = vec![crate::file_info::FileInfo {
            relative_filename: "test.dat".into(),
            offset_in_torrent: 0,
            len: total_length,
            piece_range: 0..num_pieces,
            attrs: Default::default(),
        }];
        let chunks = ChunkTracker::new(have.into_dyn(), selected, lengths, &file_infos).unwrap();
        (PieceTracker::new(chunks), file_infos)
    }

    fn acquire_as(
        tracker: &mut PieceTracker,
        file_infos: &FileInfos,
        who: PeerHandle,
        priority: &[u32],
    ) -> AcquireResult {
        let lengths = *tracker.chunks().get_lengths();
        let file_priorities = make_default_file_priorities(file_infos);
        let priority: Vec<_> = priority
            .iter()
            .map(|i| lengths.validate_piece_index(*i).unwrap())
            .collect();
        tracker.acquire_piece(AcquireRequest {
            peer: who,
            peer_avg_time: None,
            priority_pieces: priority.into_iter(),
            file_priorities: &file_priorities,
            file_infos,
            peer_has_piece: |_| true,
            can_steal: |_| true,
        })
    }

    fn deliver(tracker: &mut PieceTracker, who: PeerHandle, piece: u32, chunk: u32) {
        let data = vec![0u8; CHUNK as usize];
        let msg = Piece::from_data(piece, chunk * CHUNK, &data);
        tracker.mark_chunk_downloaded(who, &msg).unwrap();
    }

    fn chunk(tracker: &PieceTracker, piece: u32, chunk: u32) -> ChunkInfo {
        let lengths = tracker.chunks().get_lengths();
        let piece = lengths.validate_piece_index(piece).unwrap();
        lengths.iter_chunk_infos(piece).nth(chunk as usize).unwrap()
    }

    // Moves every stall clock back, as if `by` had passed with no data.
    fn age(tracker: &mut PieceTracker, by: Duration) {
        for t in tracker.last_data.values_mut() {
            *t -= by;
        }
        for info in tracker.inflight.values_mut() {
            info.last_progress -= by;
            info.started -= by;
        }
    }

    #[test]
    fn a_stalled_window_piece_goes_to_a_peer_with_no_piece_time() {
        let (mut tracker, files) = multi_chunk_tracker(4);
        let (slow, fresh) = (peer(1), peer(2));
        assert!(matches!(acquire_as(&mut tracker, &files, slow, &[0, 1]), AcquireResult::Reserved(p) if p.get() == 0));
        age(&mut tracker, STALL_TIMEOUT);

        match acquire_as(&mut tracker, &files, fresh, &[0, 1]) {
            AcquireResult::Stolen { piece, from_peer } => {
                assert_eq!(piece.get(), 0);
                assert_eq!(from_peer, slow);
            }
            other => panic!("expected the stalled piece, got {other:?}"),
        }
        assert_eq!(tracker.should_request_chunk(slow, &chunk(&tracker, 0, 1)), None);
        assert_eq!(tracker.should_request_chunk(fresh, &chunk(&tracker, 0, 1)), Some(true));
    }

    #[test]
    fn a_quiet_piece_is_not_stolen_while_its_peer_delivers_other_pieces() {
        let (mut tracker, files) = multi_chunk_tracker(4);
        let (busy, other) = (peer(1), peer(2));
        acquire_as(&mut tracker, &files, busy, &[0]);
        acquire_as(&mut tracker, &files, busy, &[1]);
        deliver(&mut tracker, busy, 1, 0);
        age(&mut tracker, STALL_TIMEOUT / 2);
        let p0 = tracker.chunks().get_lengths().validate_piece_index(0).unwrap();
        tracker.inflight.get_mut(&p0).unwrap().last_progress -= STALL_TIMEOUT;

        let result = acquire_as(&mut tracker, &files, other, &[0, 1]);
        assert!(!matches!(result, AcquireResult::Stolen { .. }), "{result:?}");
    }

    #[test]
    fn a_stalled_piece_outside_every_window_waits_for_the_usual_steal() {
        let (mut tracker, files) = multi_chunk_tracker(4);
        acquire_as(&mut tracker, &files, peer(1), &[]);
        age(&mut tracker, STALL_TIMEOUT * 5);

        let result = acquire_as(&mut tracker, &files, peer(2), &[]);
        assert!(matches!(result, AcquireResult::Reserved(p) if p.get() != 0), "{result:?}");
        let result = acquire_as(&mut tracker, &files, peer(3), &[2]);
        assert!(matches!(result, AcquireResult::Reserved(p) if p.get() == 2), "{result:?}");
    }

    #[test]
    fn a_stalled_peer_does_not_take_another_stalled_piece() {
        let (mut tracker, files) = multi_chunk_tracker(4);
        let (a, b) = (peer(1), peer(2));
        acquire_as(&mut tracker, &files, a, &[0]);
        acquire_as(&mut tracker, &files, b, &[3]);
        age(&mut tracker, STALL_TIMEOUT);

        let result = acquire_as(&mut tracker, &files, b, &[0]);
        assert!(!matches!(result, AcquireResult::Stolen { .. }), "{result:?}");
    }

    #[test]
    fn a_chunk_arriving_keeps_the_piece_with_its_peer() {
        let (mut tracker, files) = multi_chunk_tracker(4);
        acquire_as(&mut tracker, &files, peer(1), &[0]);
        age(&mut tracker, STALL_TIMEOUT);
        deliver(&mut tracker, peer(1), 0, 0);

        let result = acquire_as(&mut tracker, &files, peer(2), &[0]);
        assert!(!matches!(result, AcquireResult::Stolen { .. }), "{result:?}");
    }

    #[test]
    fn a_chunk_a_co_downloader_brought_is_not_requested_again() {
        let (mut tracker, files) = multi_chunk_tracker(4);
        acquire_as(&mut tracker, &files, peer(1), &[0]);
        assert!(matches!(acquire_as(&mut tracker, &files, peer(2), &[0]), AcquireResult::Joined(_)));
        deliver(&mut tracker, peer(2), 0, 3);

        assert_eq!(tracker.should_request_chunk(peer(1), &chunk(&tracker, 0, 3)), Some(false));
        assert_eq!(tracker.should_request_chunk(peer(1), &chunk(&tracker, 0, 2)), Some(true));
        assert_eq!(tracker.should_request_chunk(peer(3), &chunk(&tracker, 0, 2)), None);
    }

    #[test]
    fn a_released_piece_is_queued_again_with_the_chunks_it_had() {
        let (mut tracker, files) = multi_chunk_tracker(4);
        acquire_as(&mut tracker, &files, peer(1), &[]);
        deliver(&mut tracker, peer(1), 0, 0);
        deliver(&mut tracker, peer(1), 0, 1);
        let p0 = tracker.chunks().get_lengths().validate_piece_index(0).unwrap();

        assert!(tracker.release_piece_from(p0, peer(1)));
        assert!(!tracker.is_inflight(p0));
        assert!(matches!(acquire_as(&mut tracker, &files, peer(2), &[]), AcquireResult::Reserved(p) if p == p0));
        assert_eq!(tracker.chunks().missing_chunks(p0), vec![false, false, true, true]);
    }

    #[test]
    fn a_released_co_downloaded_piece_stays_with_the_others() {
        let (mut tracker, files) = multi_chunk_tracker(4);
        acquire_as(&mut tracker, &files, peer(1), &[0]);
        acquire_as(&mut tracker, &files, peer(2), &[0]);
        let p0 = tracker.chunks().get_lengths().validate_piece_index(0).unwrap();

        assert!(!tracker.release_piece_from(p0, peer(1)));
        assert_eq!(tracker.get_inflight(p0).unwrap().peers, vec![peer(2)]);
    }
}
