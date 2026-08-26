use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::{Duration, Instant};

/// How long a walk of the data directory stands in for the next one. The
/// heartbeat asks every few seconds and the answer moves slowly.
const REAL_TTL: Duration = Duration::from_secs(5);

/// Disk is the worker's hard capacity: every served torrent tends to its
/// full selected size, so the selection is reserved when it is made, and
/// refused when it would not fit under the high-water mark.
pub struct DiskAccountant {
    quota: u64,
    high_water: u64,
    reserved: Mutex<HashMap<String, u64>>,
    dir: PathBuf,
    real: Mutex<(u64, Option<Instant>)>,
}

impl DiskAccountant {
    pub fn new(quota: u64, high_water: u64, dir: PathBuf) -> Self {
        Self {
            quota,
            high_water,
            reserved: Mutex::new(HashMap::new()),
            dir,
            real: Mutex::new((0, None)),
        }
    }

    /// What the filesystem is actually carrying under the data directory.
    /// A reservation is a promise about the whole selected size, and the
    /// files behind it are sparse until the pieces land, so the two answer
    /// different questions: the reservation decides admission, this one says
    /// how close the disk really is to full. Cached, because the heartbeat
    /// asks far more often than the number moves.
    pub fn real_used(&self) -> u64 {
        {
            let cached = self.real.lock().unwrap();
            if cached.1.is_some_and(|at| at.elapsed() < REAL_TTL) {
                return cached.0;
            }
        }
        let total = allocated_under(&self.dir);
        *self.real.lock().unwrap() = (total, Some(Instant::now()));
        total
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
        let others: u64 = map
            .iter()
            .filter(|(k, _)| k.as_str() != infohash)
            .map(|(_, v)| *v)
            .sum();
        if others + bytes > self.high_water {
            return false;
        }
        map.insert(infohash.to_string(), bytes);
        true
    }

    pub fn reserved(&self, infohash: &str) -> u64 {
        self.reserved
            .lock()
            .unwrap()
            .get(infohash)
            .copied()
            .unwrap_or(0)
    }

    pub fn reserve_unchecked(&self, infohash: &str, bytes: u64) {
        self.reserved
            .lock()
            .unwrap()
            .insert(infohash.to_string(), bytes);
    }

    pub fn release(&self, infohash: &str) {
        self.reserved.lock().unwrap().remove(infohash);
    }
}

/// Blocks allocated, not apparent size: librqbit creates every file of a
/// torrent at full length and the holes cost nothing until they are filled.
pub(super) fn allocated_under(dir: &Path) -> u64 {
    let Ok(entries) = std::fs::read_dir(dir) else {
        return 0;
    };
    let mut total = 0u64;
    for entry in entries.flatten() {
        let Ok(kind) = entry.file_type() else {
            continue;
        };
        if kind.is_dir() {
            total += allocated_under(&entry.path());
        } else if let Ok(meta) = entry.metadata() {
            #[cfg(unix)]
            {
                use std::os::unix::fs::MetadataExt;
                total += meta.blocks() * 512;
            }
            #[cfg(not(unix))]
            {
                total += meta.len();
            }
        }
    }
    total
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
        assert!(
            d.reserve("a", 10),
            "re-reserving a smaller selection shrinks it"
        );
        assert!(d.reserve("c", 40));
        d.release("b");
        assert_eq!(d.used(), 50);
        assert!(d.room_for(40));
        assert!(!d.room_for(41));
    }

    #[test]
    fn counts_the_blocks_a_sparse_file_actually_holds() {
        let dir = std::env::temp_dir().join(format!("ssw-disk-{}", std::process::id()));
        let nested = dir.join("nested");
        std::fs::create_dir_all(&nested).unwrap();
        std::fs::write(nested.join("piece"), vec![7u8; 8192]).unwrap();
        let d = DiskAccountant::new(100, 90, dir.clone());
        let used = d.real_used();
        assert!(
            used >= 8192,
            "expected at least the written bytes, got {used}"
        );
        // Nothing is reserved, so the two figures answer different questions.
        assert_eq!(d.used(), 0);
        std::fs::remove_dir_all(&dir).unwrap();
    }
}
