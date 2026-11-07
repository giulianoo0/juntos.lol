pub mod stats;

use std::collections::HashMap;
use std::net::SocketAddr;
use std::sync::{Arc, atomic::Ordering};
use std::time::{Duration, Instant};

use librqbit_core::hash_id::Id20;
use librqbit_core::lengths::{ChunkInfo, ValidPieceIndex};
use peer_binary_protocol::{Message, Request};

use tokio::sync::{
    Notify,
    mpsc::{UnboundedReceiver, UnboundedSender, unbounded_channel},
};
use tracing::debug;

use crate::peer_connection::WriterRequest;
use crate::stream_connect::ConnectionKind;
use crate::type_aliases::BF;

use super::PeerStates;

pub(crate) type InflightRequest = ChunkInfo;
pub(crate) type PeerRx = UnboundedReceiver<WriterRequest>;
pub(crate) type PeerTx = UnboundedSender<WriterRequest>;

#[derive(Debug)]
pub(crate) struct Peer {
    pub addr: SocketAddr,
    state: PeerState,
    pub stats: stats::atomic::PeerStats,
    pub outgoing_address: Option<SocketAddr>,
}

impl Peer {
    pub fn new_live_for_incoming_connection(
        addr: SocketAddr,
        peer_id: Id20,
        tx: PeerTx,
        counters: &PeerStates,
        connection_kind: ConnectionKind,
    ) -> Self {
        let state = PeerState::Live(LivePeerState::new(peer_id, tx, true, connection_kind));
        for counter in [&counters.session_stats, &counters.stats] {
            counter.inc(&state);
        }
        Self {
            addr,
            state,
            stats: Default::default(),
            outgoing_address: None,
        }
    }

    pub fn new_with_outgoing_address(addr: SocketAddr) -> Self {
        Self {
            addr,
            outgoing_address: Some(addr),
            stats: Default::default(),
            state: Default::default(),
        }
    }

    pub(crate) fn reconnect_not_needed_peer(
        &mut self,
        counters: &PeerStates,
    ) -> Option<SocketAddr> {
        if let PeerState::NotNeeded = self.get_state() {
            match self.outgoing_address {
                None => None,
                Some(socket_addr) if self.addr == socket_addr => {
                    self.set_state(PeerState::Queued, counters);
                    Some(socket_addr)
                }
                Some(socket_addr) => {
                    debug!(
                        peer = %self.addr,
                        outgoing_addr = %socket_addr,
                        "peer will by retried on different address",
                    );
                    Some(socket_addr)
                }
            }
        } else {
            None
        }
    }
}

#[derive(Debug, Default)]
pub(crate) enum PeerState {
    #[default]
    // Will be tried to be connected as soon as possible.
    Queued,
    Connecting(PeerTx),
    Live(LivePeerState),
    // There was an error, and it's waiting for exponential backoff.
    Dead,
    // We don't need to do anything with the peer any longer.
    // The peer has the full torrent, and we have the full torrent, so no need
    // to keep talking to it.
    NotNeeded,
}

impl std::fmt::Display for PeerState {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}", self.name())
    }
}

impl PeerState {
    pub fn name(&self) -> &'static str {
        match self {
            PeerState::Queued => "queued",
            PeerState::Connecting(_) => "connecting",
            PeerState::Live(_) => "live",
            PeerState::Dead => "dead",
            PeerState::NotNeeded => "not needed",
        }
    }

    pub fn take_live_no_counters(self) -> Option<LivePeerState> {
        match self {
            PeerState::Live(l) => Some(l),
            _ => None,
        }
    }
}

#[derive(Debug, thiserror::Error)]
pub enum IncomingConnectionResult {
    #[error("peer already active")]
    AlreadyActive,
}

impl Peer {
    pub fn get_state(&self) -> &PeerState {
        &self.state
    }

    pub fn take_state(&mut self, counters: &PeerStates) -> PeerState {
        self.set_state(Default::default(), counters)
    }

    pub fn destroy(self, counters: &PeerStates) {
        for counter in [&counters.session_stats, &counters.stats] {
            counter.dec(&self.state);
        }
        if let (Some(addr), PeerState::Live(..)) = (self.outgoing_address, &self.state) {
            counters.live_outgoing_peers.write().remove(&addr);
        }
    }

    pub fn set_state(&mut self, new: PeerState, counters: &PeerStates) -> PeerState {
        for counter in [&counters.session_stats, &counters.stats] {
            counter.incdec(&self.state, &new);
        }
        if let Some(addr) = self.outgoing_address {
            if matches!(&self.state, PeerState::Live(..)) {
                counters.live_outgoing_peers.write().remove(&addr);
            }
            if matches!(&new, PeerState::Live(..))
                && self
                    .stats
                    .counters
                    .outgoing_connections
                    .load(Ordering::Relaxed)
                    > 0
            {
                counters.live_outgoing_peers.write().insert(addr);
            }
        }

        std::mem::replace(&mut self.state, new)
    }

    pub fn get_live(&self) -> Option<&LivePeerState> {
        match &self.state {
            PeerState::Live(l) => Some(l),
            _ => None,
        }
    }

    pub fn get_live_mut(&mut self) -> Option<&mut LivePeerState> {
        match &mut self.state {
            PeerState::Live(l) => Some(l),
            _ => None,
        }
    }

    pub fn idle_to_connecting(&mut self, counters: &PeerStates) -> Option<(PeerRx, PeerTx)> {
        match &self.state {
            PeerState::Queued | PeerState::NotNeeded => {
                let (tx, rx) = unbounded_channel();
                let tx_2 = tx.clone();
                self.set_state(PeerState::Connecting(tx), counters);
                Some((rx, tx_2))
            }
            _ => None,
        }
    }

    pub fn incoming_connection(
        &mut self,
        peer_id: Id20,
        tx: PeerTx,
        counters: &PeerStates,
        connection_kind: ConnectionKind,
    ) -> Result<(), IncomingConnectionResult> {
        if matches!(&self.state, PeerState::Connecting(..) | PeerState::Live(..)) {
            return Err(IncomingConnectionResult::AlreadyActive);
        }
        match self.take_state(counters) {
            PeerState::Queued | PeerState::Dead | PeerState::NotNeeded => {
                self.set_state(
                    PeerState::Live(LivePeerState::new(peer_id, tx, true, connection_kind)),
                    counters,
                );
            }
            PeerState::Connecting(..) | PeerState::Live(..) => unreachable!(),
        }
        Ok(())
    }

    pub fn connecting_to_live(
        &mut self,
        peer_id: Id20,
        counters: &PeerStates,
        conn_kind: ConnectionKind,
    ) -> Option<&mut LivePeerState> {
        if let PeerState::Connecting(_) = &self.state {
            let tx = match self.take_state(counters) {
                PeerState::Connecting(tx) => tx,
                _ => unreachable!(),
            };
            self.set_state(
                PeerState::Live(LivePeerState::new(peer_id, tx, false, conn_kind)),
                counters,
            );
            self.get_live_mut()
        } else {
            None
        }
    }

    pub fn set_not_needed(&mut self, counters: &PeerStates) -> PeerState {
        self.set_state(PeerState::NotNeeded, counters)
    }
}

#[derive(Debug)]
pub(crate) struct LivePeerState {
    #[allow(dead_code)]
    peer_id: Id20,

    pub client_name: Option<String>,

    pub peer_interested: bool,

    // This is used to track the pieces the peer has.
    pub bitfield: BF,

    // When the peer sends us data this is used to track if we asked for it.
    // ss patch: with the time each request went out, so unanswered ones expire.
    inflight_requests: HashMap<InflightRequest, Instant>,

    // Bounded tolerance for chunks that arrive after we cancel requests.
    // This is intentionally approximate: we track a count instead of storing every
    // canceled chunk, so a peer is not disconnected for racing our cancel messages.
    late_cancelled_request_tolerance: u32,

    // ss patch: when the peer last sent us a chunk, and the send time of the
    // newest request it has answered. Peers answer in order, so a request
    // older than that one was dropped.
    last_chunk_at: Instant,
    newest_answered_sent: Option<Instant>,

    request_slots_changed: Arc<Notify>,

    // The main channel to send requests to peer.
    pub tx: PeerTx,

    pub connection_kind: ConnectionKind,
}

impl LivePeerState {
    pub fn new(
        peer_id: Id20,
        tx: PeerTx,
        initial_interested: bool,
        connection_kind: ConnectionKind,
    ) -> Self {
        LivePeerState {
            peer_id,
            client_name: None,
            peer_interested: initial_interested,
            bitfield: BF::default(),
            inflight_requests: Default::default(),
            late_cancelled_request_tolerance: 0,
            last_chunk_at: Instant::now(),
            newest_answered_sent: None,
            request_slots_changed: Default::default(),
            tx,
            connection_kind,
        }
    }

    pub fn has_full_torrent(&self, total_pieces: usize) -> bool {
        self.bitfield.get(0..total_pieces).is_some_and(|s| s.all())
    }

    pub fn request_slots_changed(&self) -> Arc<Notify> {
        self.request_slots_changed.clone()
    }

    pub fn requested_inflight_count(&self) -> usize {
        self.inflight_requests.len()
    }

    pub fn add_inflight_request(&mut self, chunk: ChunkInfo) -> bool {
        if self.inflight_requests.contains_key(&chunk) {
            return false;
        }
        self.inflight_requests.insert(chunk, Instant::now());
        true
    }

    pub fn remove_inflight_request(&mut self, chunk: &ChunkInfo) -> RemoveInflightRequestResult {
        self.last_chunk_at = Instant::now();
        if let Some(sent) = self.inflight_requests.remove(chunk) {
            self.newest_answered_sent = self.newest_answered_sent.max(Some(sent));
            self.request_slots_changed.notify_waiters();
            return RemoveInflightRequestResult::Expected;
        }

        if self.late_cancelled_request_tolerance > 0 {
            // This may be any unexpected chunk, not necessarily the exact canceled
            // one, but the tolerance is bounded by cancels we sent.
            self.late_cancelled_request_tolerance -= 1;
            RemoveInflightRequestResult::LateCanceled
        } else {
            RemoveInflightRequestResult::Unexpected
        }
    }

    pub fn cancel_inflight_requests_for_piece(&mut self, piece: ValidPieceIndex) {
        let tx = &self.tx;
        let late_cancelled_request_tolerance = &mut self.late_cancelled_request_tolerance;
        let before = self.inflight_requests.len();
        self.inflight_requests.retain(|req, _| {
            if req.piece_index == piece {
                let _ = tx.send(WriterRequest::Message(Message::Cancel(Request {
                    index: piece.get(),
                    begin: req.offset,
                    length: req.size,
                })));
                *late_cancelled_request_tolerance += 1;
                false
            } else {
                true
            }
        });

        if self.inflight_requests.len() != before {
            self.request_slots_changed.notify_waiters();
        }
    }

    pub fn inflight_requests(&self) -> impl Iterator<Item = &InflightRequest> {
        self.inflight_requests.keys()
    }

    pub fn inflight_requests_debug(&self) -> &HashMap<InflightRequest, Instant> {
        &self.inflight_requests
    }

    /// ss patch: a request older than `timeout` that the peer skipped (it
    /// answered a later one) or that sits behind a peer silent for `timeout`
    /// will never be answered — choked peers drop what they had queued. Every
    /// request for its piece is cancelled, and those pieces are returned so
    /// the caller can hand them back. A slow peer still working through a
    /// deep queue in order is left alone.
    pub fn expire_stale_requests(&mut self, timeout: Duration) -> Vec<ValidPieceIndex> {
        let now = Instant::now();
        let silent = now.saturating_duration_since(self.last_chunk_at) >= timeout;
        let newest_answered = self.newest_answered_sent;
        let mut pieces: Vec<ValidPieceIndex> = self
            .inflight_requests
            .iter()
            .filter(|(_, sent)| {
                now.saturating_duration_since(**sent) >= timeout
                    && (silent || newest_answered.is_some_and(|n| n > **sent))
            })
            .map(|(req, _)| req.piece_index)
            .collect();
        pieces.sort_unstable_by_key(|p| p.get());
        pieces.dedup();
        for piece in &pieces {
            self.cancel_inflight_requests_for_piece(*piece);
        }
        pieces
    }
}

pub(crate) enum RemoveInflightRequestResult {
    Expected,
    LateCanceled,
    Unexpected,
}

#[cfg(test)]
mod tests {
    use super::*;
    use librqbit_core::lengths::Lengths;

    const TIMEOUT: Duration = Duration::from_secs(8);

    fn live_peer() -> (LivePeerState, PeerRx, Lengths) {
        let (tx, rx) = unbounded_channel();
        let live = LivePeerState::new(Id20::default(), tx, false, ConnectionKind::Tcp);
        (live, rx, Lengths::new(16384 * 8, 16384 * 4).unwrap())
    }

    fn chunks(lengths: &Lengths, piece: u32) -> Vec<ChunkInfo> {
        lengths
            .iter_chunk_infos(lengths.validate_piece_index(piece).unwrap())
            .collect()
    }

    #[test]
    fn a_request_behind_a_silent_peer_expires_with_the_rest_of_its_piece() {
        let (mut live, mut rx, lengths) = live_peer();
        let p0 = lengths.validate_piece_index(0).unwrap();
        let old = &chunks(&lengths, 0)[..2];
        let fresh = chunks(&lengths, 1)[0];
        for c in old.iter().chain([&fresh]) {
            assert!(live.add_inflight_request(*c));
        }
        *live.inflight_requests.get_mut(&old[0]).unwrap() -= TIMEOUT;
        live.last_chunk_at -= TIMEOUT;

        assert_eq!(live.expire_stale_requests(TIMEOUT), vec![p0]);
        assert_eq!(live.inflight_requests().copied().collect::<Vec<_>>(), vec![fresh]);
        let mut cancels = 0;
        while let Ok(WriterRequest::Message(Message::Cancel(r))) = rx.try_recv() {
            assert_eq!(r.index, 0);
            cancels += 1;
        }
        assert_eq!(cancels, 2);
        assert!(matches!(
            live.remove_inflight_request(&old[1]),
            RemoveInflightRequestResult::LateCanceled
        ));
    }

    #[test]
    fn a_slow_peer_answering_in_order_keeps_its_old_requests() {
        let (mut live, _rx, lengths) = live_peer();
        let c = chunks(&lengths, 0);
        for x in &c {
            live.add_inflight_request(*x);
        }
        for x in &c[1..] {
            *live.inflight_requests.get_mut(x).unwrap() -= TIMEOUT;
        }
        *live.inflight_requests.get_mut(&c[0]).unwrap() -= TIMEOUT * 2;
        live.remove_inflight_request(&c[0]);

        assert!(live.expire_stale_requests(TIMEOUT).is_empty());
        assert_eq!(live.requested_inflight_count(), 3);
    }

    #[test]
    fn a_request_the_peer_skipped_expires_while_it_answers_later_ones() {
        let (mut live, _rx, lengths) = live_peer();
        let p0 = lengths.validate_piece_index(0).unwrap();
        let (dropped, later) = (chunks(&lengths, 0)[0], chunks(&lengths, 1)[0]);
        live.add_inflight_request(dropped);
        live.add_inflight_request(later);
        *live.inflight_requests.get_mut(&dropped).unwrap() -= TIMEOUT * 2;
        *live.inflight_requests.get_mut(&later).unwrap() -= TIMEOUT;
        live.remove_inflight_request(&later);

        assert_eq!(live.expire_stale_requests(TIMEOUT), vec![p0]);
    }
}
