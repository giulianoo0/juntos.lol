use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::Mutex;

/// Disk is the worker's hard capacity: every served torrent tends to its
/// full selected size, so the selection is reserved when it is made, and
/// refused when it would not fit under the high-water mark.
pub struct DiskAccountant {
    quota: u64,
    high_water: u64,
    reserved: Mutex<HashMap<String, u64>>,
    #[allow(dead_code)]
    dir: PathBuf,
}

impl DiskAccountant {
    pub fn new(quota: u64, high_water: u64, dir: PathBuf) -> Self {
        Self { quota, high_water, reserved: Mutex::new(HashMap::new()), dir }
    }

    pub fn used(&self) -> u64 {
        self.reserved.lock().unwrap().values().sum()
    }

    #[allow(dead_code)]
    pub fn quota(&self) -> u64 {
        self.quota
    }

    pub fn room_for(&self, bytes: u64) -> bool {
        self.used() + bytes <= self.high_water
    }

    /// Reserves `bytes` for a torrent, replacing any earlier reservation.
    pub fn reserve(&self, infohash: &str, bytes: u64) -> bool {
        let mut map = self.reserved.lock().unwrap();
        let others: u64 = map.iter().filter(|(k, _)| k.as_str() != infohash).map(|(_, v)| *v).sum();
        if others + bytes > self.high_water {
            return false;
        }
        map.insert(infohash.to_string(), bytes);
        true
    }

    pub fn reserved(&self, infohash: &str) -> u64 {
        self.reserved.lock().unwrap().get(infohash).copied().unwrap_or(0)
    }

    pub fn reserve_unchecked(&self, infohash: &str, bytes: u64) {
        self.reserved.lock().unwrap().insert(infohash.to_string(), bytes);
    }

    pub fn release(&self, infohash: &str) {
        self.reserved.lock().unwrap().remove(infohash);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reserves_under_high_water_and_replaces() {
        let d = DiskAccountant::new(100, 90, PathBuf::from("/tmp"));
        assert!(d.reserve("a", 50));
        assert!(d.reserve("b", 40));
        assert!(!d.reserve("c", 1));
        assert!(d.reserve("a", 10), "re-reserving a smaller selection shrinks it");
        assert!(d.reserve("c", 40));
        d.release("b");
        assert_eq!(d.used(), 50);
        assert!(d.room_for(40));
        assert!(!d.room_for(41));
    }
}
