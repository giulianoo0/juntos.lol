//! The local cache: one directory per source (a torrent file, a video),
//! kept under a byte ceiling. What was used longest ago leaves first; what
//! a room is playing or uploading never leaves.
use std::collections::HashSet;
use std::path::{Component, Path, PathBuf};
use std::time::SystemTime;

pub const DEFAULT_CAP_BYTES: u64 = 20 * 1024 * 1024 * 1024;

#[derive(Clone, Debug)]
pub struct Entry {
    pub key: String,
    pub bytes: u64,
    pub used: SystemTime,
}

/// The keys to delete so the rest fits under `cap`, oldest first.
pub fn evictions(entries: &[Entry], cap: u64, busy: &HashSet<String>) -> Vec<String> {
    let mut total: u64 = entries.iter().map(|e| e.bytes).sum();
    let mut oldest: Vec<&Entry> = entries.iter().filter(|e| !busy.contains(&e.key)).collect();
    oldest.sort_by_key(|e| e.used);
    let mut out = Vec::new();
    for entry in oldest {
        if total <= cap {
            break;
        }
        total -= entry.bytes;
        out.push(entry.key.clone());
    }
    out
}

/// A cache key is the directory name: letters, digits, '-' and '_' only.
pub fn valid_key(key: &str) -> bool {
    !key.is_empty() && key.len() <= 96 && key.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')
}

const SERVED_EXTENSIONS: &[&str] = &["m3u8", "m4s", "mp4"];

/// A file under the cache, from a request path like `key/hls/name`; None for
/// anything that would leave the entry's `hls` directory.
pub fn resolve(root: &Path, request_path: &str) -> Option<PathBuf> {
    let parts: Vec<&str> = request_path.trim_start_matches('/').split('/').collect();
    let [key, "hls", name] = parts[..] else { return None };
    if !valid_key(key) {
        return None;
    }
    let file = Path::new(name);
    let plain = matches!(file.components().collect::<Vec<_>>()[..], [Component::Normal(_)]);
    let served = file.extension().and_then(|e| e.to_str()).is_some_and(|e| SERVED_EXTENSIONS.contains(&e));
    (plain && served && !name.starts_with('.')).then(|| root.join(key).join("hls").join(name))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::Duration;

    fn entry(key: &str, gb: u64, age_s: u64) -> Entry {
        Entry { key: key.into(), bytes: gb << 30, used: SystemTime::UNIX_EPOCH + Duration::from_secs(1_000_000 - age_s) }
    }

    #[test]
    fn nothing_leaves_under_the_cap() {
        let entries = [entry("a", 5, 10), entry("b", 5, 5)];
        assert!(evictions(&entries, 20 << 30, &HashSet::new()).is_empty());
    }

    #[test]
    fn the_least_recently_used_leave_first() {
        let entries = [entry("new", 8, 1), entry("old", 8, 100), entry("mid", 8, 50)];
        assert_eq!(evictions(&entries, 20 << 30, &HashSet::new()), vec!["old".to_string()]);
        assert_eq!(evictions(&entries, 10 << 30, &HashSet::new()), vec!["old".to_string(), "mid".to_string()]);
    }

    #[test]
    fn busy_entries_never_leave() {
        let entries = [entry("playing", 15, 100), entry("idle", 10, 1)];
        let busy: HashSet<String> = ["playing".to_string()].into();
        assert_eq!(evictions(&entries, 20 << 30, &busy), vec!["idle".to_string()]);
    }

    #[test]
    fn keys_are_plain_names() {
        assert!(valid_key("t-0123abcd-3"));
        assert!(valid_key("y-dQw4w9WgXcQ"));
        assert!(!valid_key(""));
        assert!(!valid_key(".."));
        assert!(!valid_key("a/b"));
        assert!(!valid_key("a.b"));
    }

    #[test]
    fn resolve_stays_inside_the_entry() {
        let root = Path::new("/cache");
        assert_eq!(resolve(root, "t-1/hls/r2_cs_0_4.m4s"), Some(PathBuf::from("/cache/t-1/hls/r2_cs_0_4.m4s")));
        assert_eq!(resolve(root, "/t-1/hls/master.m3u8"), Some(PathBuf::from("/cache/t-1/hls/master.m3u8")));
        assert_eq!(resolve(root, "t-1/hls/../meta.json"), None);
        assert_eq!(resolve(root, "t-1/meta.json"), None);
        assert_eq!(resolve(root, "../etc/hls/passwd"), None);
        assert_eq!(resolve(root, "t-1/hls/a/b.m4s"), None);
        assert_eq!(resolve(root, "t-1/hls/x.exe"), None);
    }
}
