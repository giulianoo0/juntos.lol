use std::collections::HashMap;
use std::sync::atomic::AtomicU64;
use std::sync::Arc;

/// The generation each reader has moved past on one torrent.
///
/// A seek bumps the reader's generation and the responses behind it stop
/// being fed, which is what keeps a swarm from spending the seconds after a
/// jump on the region the remux just left. The floor that decides this is
/// per reader, never per torrent: a torrent outlives the room that warmed
/// it, and two rooms watching the same release are two readers with two
/// cursors. One floor for the pair would have every seek in one room refuse
/// the other's reads — and a room arriving at a torrent someone else already
/// seeked through would find every read of it refused before it began.
#[derive(Default)]
pub struct Floors(HashMap<String, Arc<AtomicU64>>);

impl Floors {
    /// This reader's floor, created at zero the first time it is asked for.
    pub fn of(&mut self, reader: &str) -> Arc<AtomicU64> {
        if let Some(floor) = self.0.get(reader) {
            return floor.clone();
        }
        let floor = Arc::new(AtomicU64::new(0));
        self.0.insert(reader.to_string(), floor.clone());
        floor
    }

    /// Forgets every reader. Called where the parked streams are dropped:
    /// nothing is reading, so no floor is holding anything back, and a room
    /// that comes back is a new reader anyway.
    pub fn clear(&mut self) {
        self.0.clear();
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::Ordering;

    #[test]
    fn a_reader_keeps_its_own_floor() {
        let mut floors = Floors::default();
        let first = floors.of("room-a");
        first.fetch_max(40, Ordering::Relaxed);
        assert_eq!(floors.of("room-a").load(Ordering::Relaxed), 40, "the same reader gets the same floor");
    }

    #[test]
    fn one_readers_seek_does_not_supersede_anothers_reads() {
        let mut floors = Floors::default();
        floors.of("room-a").fetch_max(40, Ordering::Relaxed);
        assert_eq!(
            floors.of("room-b").load(Ordering::Relaxed),
            0,
            "a room arriving at a torrent another room seeked through starts from zero",
        );
    }

    #[test]
    fn clearing_forgets_every_reader() {
        let mut floors = Floors::default();
        floors.of("room-a").fetch_max(40, Ordering::Relaxed);
        floors.clear();
        assert_eq!(floors.of("room-a").load(Ordering::Relaxed), 0);
    }
}
