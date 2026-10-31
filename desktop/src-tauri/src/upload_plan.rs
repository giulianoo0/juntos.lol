//! What goes to the bucket next once a browser guest needs the room. The
//! cache already holds the segments; the plan turns the playhead into the
//! order they go up in: init, what its region still misses behind it and a
//! few segments around it, then the window ahead, then what was played
//! before the region, then the rest. A seek moves the front of the queue.
//! Every remote region is a slice of one local region starting at some
//! segment, renamed into the server's grammar.
use std::collections::{BTreeMap, HashMap, HashSet};

use crate::hls::{self, Variant};

/// Segments around the playhead that go first.
pub const URGENT: usize = 3;
/// Segments of the window ahead (about a minute at 4 s).
pub const AHEAD: usize = 15;
/// How far past a remote region's uploaded end a position may land and
/// still extend it instead of opening a new region.
pub const REUSE_GAP: usize = 8;

/// One region FFmpeg wrote into the cache; variant 0 is the video.
#[derive(Clone, Debug)]
pub struct LocalRegion {
    pub n: u64,
    pub start_ms: u64,
    pub variants: Vec<Variant>,
}

impl LocalRegion {
    pub fn prefix(&self) -> String {
        region_prefix(self.n)
    }

    fn end_ms(&self) -> u64 {
        self.start_ms + self.variants.first().map(Variant::duration_ms).unwrap_or(0)
    }
}

pub fn region_prefix(n: u64) -> String {
    if n == 0 { String::new() } else { format!("r{n}_") }
}

/// One object to send: its name in the bucket and its file in the cache.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Item {
    pub remote: String,
    pub local: String,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct RegionReport {
    pub n: u64,
    pub start_ms: u64,
    pub produced_ms: u64,
    pub growing: bool,
}

#[derive(Clone, Debug)]
struct Remote {
    n: u64,
    local: u64,
    /// Where the slice starts, in ms into the local region.
    from_ms: u64,
}

#[derive(Default)]
pub struct Planner {
    remotes: Vec<Remote>,
    uploaded: HashSet<String>,
    inflight: HashSet<String>,
}

impl Planner {
    pub fn new() -> Self {
        Self::default()
    }

    /// Up to `max` objects to send now, in priority order; they count as in
    /// flight until `done` or `failed`.
    pub fn next(&mut self, local: &[LocalRegion], playhead_ms: u64, max: usize) -> Vec<Item> {
        let out = self.upcoming(local, playhead_ms, max);
        for item in &out {
            self.inflight.insert(item.remote.clone());
        }
        out
    }

    /// What `next` would hand out, without taking it: what to sign ahead.
    pub fn upcoming(&mut self, local: &[LocalRegion], playhead_ms: u64, max: usize) -> Vec<Item> {
        self.plan(local, playhead_ms, max, false)
    }

    /// In-flight objects a seek left behind: none of the first `slots` the
    /// plan wants now. They go back in the queue; the caller drops their PUTs.
    pub fn displaced(&mut self, local: &[LocalRegion], playhead_ms: u64, slots: usize) -> Vec<String> {
        let front: HashSet<String> = self.plan(local, playhead_ms, slots, true).into_iter().map(|item| item.remote).collect();
        let behind: Vec<String> = self.inflight.iter().filter(|name| !front.contains(*name)).cloned().collect();
        for name in &behind {
            self.inflight.remove(name);
        }
        behind
    }

    fn plan(&mut self, local: &[LocalRegion], playhead_ms: u64, max: usize, with_inflight: bool) -> Vec<Item> {
        let mut order: Vec<(usize, usize)> = Vec::new();
        let mut rest: Vec<(usize, usize)> = Vec::new();
        let anchor = self.anchor(local, playhead_ms);
        let first = local.iter().find(|l| l.n == 0);
        let mut past_limit = first.map(|l| l.variants.first().map_or(0, |v| v.segments.len())).unwrap_or(0);
        if let Some((remote, kp)) = anchor {
            let at = &self.remotes[remote];
            if at.local == 0 {
                past_limit = if at.from_ms == 0 { 0 } else { first.map_or(0, |l| index_or_len(&l.variants[0], at.from_ms)) };
            }
            // The region plays only up to its first missing object: what the playhead passed goes first.
            order.extend((0..kp + AHEAD).map(|k| (remote, k)));
            rest.extend((kp + AHEAD..region_len(local, &self.remotes[remote])).map(|k| (remote, k)));
        }
        let mut past = Vec::new();
        if past_limit > 0 && first.is_some() {
            let back = self.remote_for(0, 0);
            past.extend((0..past_limit).map(|k| (back, k)));
        }

        let mut out = Vec::new();
        let mut seen = HashSet::new();
        for slots in [&order, &past, &rest] {
            let mut last = None;
            for &(remote, k) in slots {
                if last != Some(remote) {
                    last = Some(remote);
                    for item in self.inits(local, remote) {
                        self.offer(item, &mut out, &mut seen, max, with_inflight);
                    }
                }
                for item in self.segments(local, remote, k) {
                    self.offer(item, &mut out, &mut seen, max, with_inflight);
                }
            }
        }
        out
    }

    pub fn done(&mut self, remote: &str) {
        self.inflight.remove(remote);
        self.uploaded.insert(remote.to_string());
    }

    pub fn failed(&mut self, remote: &str) {
        self.inflight.remove(remote);
    }

    /// Every remote region's variant playlists, as the server renders them
    /// (it cuts each one at the first object it does not hold).
    pub fn playlists(&self, local: &[LocalRegion]) -> BTreeMap<String, String> {
        let mut out = BTreeMap::new();
        for remote in self.remotes.iter().filter(|r| self.started(local, r)) {
            out.extend(self.region_playlists(local, remote));
        }
        out
    }

    /// A region the bucket can play anything of: every init is up.
    fn started(&self, local: &[LocalRegion], remote: &Remote) -> bool {
        let Some(region) = local.iter().find(|l| l.n == remote.local) else { return false };
        let prefix = region_prefix(remote.n);
        (0..region.variants.len()).all(|v| self.uploaded.contains(&hls::init_name(&prefix, v)))
    }

    /// The region map: each region spans the contiguous prefix the bucket holds.
    pub fn regions(&self, local: &[LocalRegion]) -> Vec<RegionReport> {
        let mut out = Vec::new();
        for remote in self.remotes.iter().filter(|r| self.started(local, r)) {
            let Some(region) = local.iter().find(|l| l.n == remote.local) else { continue };
            let prefix = region_prefix(remote.n);
            let playlists: HashMap<String, String> = self.region_playlists(local, remote).into_iter().collect();
            let produced_ms = ss_remux::publish::confirmed_span_ms(&playlists, &self.uploaded);
            let complete = region.variants.iter().enumerate().all(|(v, variant)| {
                variant.ended
                    && (index_or_len(variant, remote.from_ms)..variant.segments.len())
                        .enumerate()
                        .all(|(k, _)| self.uploaded.contains(&hls::segment_name(&prefix, v, k)))
            });
            let start_ms = region.start_ms + region.variants.first().map_or(0, |v| v.start_ms(index_or_len(v, remote.from_ms)));
            out.push(RegionReport { n: remote.n, start_ms, produced_ms, growing: !complete });
        }
        out.sort_by_key(|r| r.n);
        out
    }

    /// The remote region holding the playhead and the playhead's index in
    /// it, opening one when no region reaches it closely enough.
    fn anchor(&mut self, local: &[LocalRegion], playhead_ms: u64) -> Option<(usize, usize)> {
        let region = local
            .iter()
            .filter(|l| l.start_ms <= playhead_ms && playhead_ms < l.end_ms())
            .max_by_key(|l| l.start_ms)?;
        let video = region.variants.first()?;
        let index = video.index_at(playhead_ms - region.start_ms)?;
        let reusable = self.remotes.iter().position(|remote| {
            if remote.local != region.n {
                return false;
            }
            let from = index_or_len(video, remote.from_ms);
            from <= index && from + self.contiguous(remote, video, 0) + REUSE_GAP >= index
        });
        let remote = match reusable {
            Some(found) => found,
            None => self.remote_for(region.n, video.start_ms(index)),
        };
        Some((remote, index - index_or_len(video, self.remotes[remote].from_ms)))
    }

    fn remote_for(&mut self, local: u64, from_ms: u64) -> usize {
        if let Some(found) = self.remotes.iter().position(|r| r.local == local && r.from_ms == from_ms) {
            return found;
        }
        let n = if local == 0 && from_ms == 0 { 0 } else { self.remotes.iter().map(|r| r.n).max().unwrap_or(0) + 1 };
        self.remotes.push(Remote { n, local, from_ms });
        self.remotes.len() - 1
    }

    /// How many segments of variant `v` the bucket holds in a row from the slice's start.
    fn contiguous(&self, remote: &Remote, variant: &Variant, v: usize) -> usize {
        let prefix = region_prefix(remote.n);
        let available = variant.segments.len().saturating_sub(index_or_len(variant, remote.from_ms));
        (0..available).take_while(|&k| self.uploaded.contains(&hls::segment_name(&prefix, v, k))).count()
    }

    fn inits(&self, local: &[LocalRegion], remote: usize) -> Vec<Item> {
        let remote = &self.remotes[remote];
        let Some(region) = local.iter().find(|l| l.n == remote.local) else { return Vec::new() };
        let prefix = region_prefix(remote.n);
        region
            .variants
            .iter()
            .enumerate()
            .filter_map(|(v, variant)| variant.init.clone().map(|init| Item { remote: hls::init_name(&prefix, v), local: init }))
            .collect()
    }

    fn segments(&self, local: &[LocalRegion], remote: usize, k: usize) -> Vec<Item> {
        let remote = &self.remotes[remote];
        let Some(region) = local.iter().find(|l| l.n == remote.local) else { return Vec::new() };
        let prefix = region_prefix(remote.n);
        region
            .variants
            .iter()
            .enumerate()
            .filter_map(|(v, variant)| {
                let (name, _) = variant.segments.get(index_or_len(variant, remote.from_ms) + k)?;
                Some(Item { remote: hls::segment_name(&prefix, v, k), local: name.clone() })
            })
            .collect()
    }

    fn offer(&self, item: Item, out: &mut Vec<Item>, seen: &mut HashSet<String>, max: usize, with_inflight: bool) {
        if out.len() >= max || self.uploaded.contains(&item.remote) || (!with_inflight && self.inflight.contains(&item.remote)) {
            return;
        }
        if seen.insert(item.remote.clone()) {
            out.push(item);
        }
    }

    fn region_playlists(&self, local: &[LocalRegion], remote: &Remote) -> Vec<(String, String)> {
        let Some(region) = local.iter().find(|l| l.n == remote.local) else { return Vec::new() };
        let prefix = region_prefix(remote.n);
        region
            .variants
            .iter()
            .enumerate()
            .map(|(v, variant)| {
                (hls::playlist_name(&prefix, v), hls::slice(variant, index_or_len(variant, remote.from_ms), &prefix, v))
            })
            .collect()
    }
}

fn index_or_len(variant: &Variant, offset_ms: u64) -> usize {
    variant.index_at(offset_ms).unwrap_or(variant.segments.len())
}

fn region_len(local: &[LocalRegion], remote: &Remote) -> usize {
    local
        .iter()
        .find(|l| l.n == remote.local)
        .and_then(|l| l.variants.first())
        .map(|v| v.segments.len())
        .unwrap_or(0)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A local region of `count` 4 s segments with a video and one audio variant.
    fn region(n: u64, start_ms: u64, count: usize, ended: bool) -> LocalRegion {
        let prefix = region_prefix(n);
        let variants = (0..2)
            .map(|v| Variant {
                init: Some(hls::init_name(&prefix, v)),
                segments: (0..count).map(|i| (hls::segment_name(&prefix, v, i), 4.0)).collect(),
                ended,
                target_duration: 4,
            })
            .collect();
        LocalRegion { n, start_ms, variants }
    }

    fn names(items: &[Item]) -> Vec<&str> {
        items.iter().map(|i| i.remote.as_str()).collect()
    }

    fn finish(planner: &mut Planner, items: &[Item]) {
        for item in items {
            planner.done(&item.remote);
        }
    }

    #[test]
    fn a_guest_mid_film_gets_init_and_the_segments_around_the_playhead_first() {
        let local = [region(0, 0, 20, true)];
        let mut planner = Planner::new();
        let items = planner.next(&local, 41_000, 8);
        assert_eq!(
            names(&items),
            ["r1_cinit_0.mp4", "r1_cinit_1.mp4", "r1_cs_0_0.m4s", "r1_cs_1_0.m4s", "r1_cs_0_1.m4s", "r1_cs_1_1.m4s", "r1_cs_0_2.m4s", "r1_cs_1_2.m4s"]
        );
        assert_eq!(items[2].local, "cs_0_10.m4s");
    }

    #[test]
    fn then_the_window_ahead_then_what_was_played() {
        let local = [region(0, 0, 40, true)];
        let mut planner = Planner::new();
        let first = planner.next(&local, 41_000, 8);
        finish(&mut planner, &first);
        let ahead = planner.next(&local, 41_000, 2 * (AHEAD - URGENT));
        assert_eq!(ahead.first().unwrap().remote, "r1_cs_0_3.m4s");
        assert_eq!(ahead.last().unwrap().remote, format!("r1_cs_1_{}.m4s", AHEAD - 1));
        finish(&mut planner, &ahead);
        let past = planner.next(&local, 41_000, 4);
        assert_eq!(names(&past), ["cinit_0.mp4", "cinit_1.mp4", "cs_0_0.m4s", "cs_1_0.m4s"]);
    }

    #[test]
    fn a_hole_the_playhead_left_behind_in_its_region_goes_up_before_the_window() {
        let local = [region(0, 0, 40, true)];
        let mut planner = Planner::new();
        let first = planner.next(&local, 41_000, 4);
        finish(&mut planner, &first[..3]);
        planner.failed(&first[3].remote);
        // The room played on two segments before that audio segment could go up.
        assert_eq!(names(&planner.next(&local, 49_000, 1)), ["r1_cs_1_0.m4s"]);
    }

    #[test]
    fn the_past_stops_where_the_playhead_region_starts() {
        let local = [region(0, 0, 40, true)];
        let mut planner = Planner::new();
        let all = planner.next(&local, 41_000, 1_000);
        assert!(all.iter().any(|i| i.remote == "cs_0_9.m4s"));
        assert!(!all.iter().any(|i| i.remote == "cs_0_10.m4s"));
        assert!(all.iter().any(|i| i.remote == "r1_cs_0_29.m4s"));
        assert_eq!(all.len(), 2 + 2 * 10 + 2 + 2 * 30);
    }

    #[test]
    fn from_the_start_it_is_region_zero_with_its_own_names() {
        let local = [region(0, 0, 10, true)];
        let mut planner = Planner::new();
        assert_eq!(names(&planner.next(&local, 0, 3)), ["cinit_0.mp4", "cinit_1.mp4", "cs_0_0.m4s"]);
    }

    #[test]
    fn a_short_seek_ahead_extends_the_region_and_fills_the_gap_behind_it_first() {
        let local = [region(0, 0, 40, true)];
        let mut planner = Planner::new();
        let first = planner.next(&local, 41_000, 8);
        finish(&mut planner, &first);
        let items = planner.next(&local, 41_000 + 6 * 4_000, 4);
        assert_eq!(names(&items), ["r1_cs_0_3.m4s", "r1_cs_1_3.m4s", "r1_cs_0_4.m4s", "r1_cs_1_4.m4s"]);
    }

    #[test]
    fn a_long_seek_opens_a_new_region_at_the_front_of_the_queue() {
        let local = [region(0, 0, 100, true)];
        let mut planner = Planner::new();
        let first = planner.next(&local, 41_000, 8);
        finish(&mut planner, &first);
        let items = planner.next(&local, 300_000, 4);
        assert_eq!(names(&items), ["r2_cinit_0.mp4", "r2_cinit_1.mp4", "r2_cs_0_0.m4s", "r2_cs_1_0.m4s"]);
        assert_eq!(items[2].local, "cs_0_75.m4s");
    }

    #[test]
    fn in_flight_objects_are_not_handed_out_twice_and_failures_come_back() {
        let local = [region(0, 0, 10, true)];
        let mut planner = Planner::new();
        let first = planner.next(&local, 0, 2);
        let second = planner.next(&local, 0, 2);
        assert!(first.iter().all(|i| !second.contains(i)));
        planner.failed(&first[0].remote);
        assert_eq!(planner.next(&local, 0, 1)[0], first[0]);
    }

    #[test]
    fn a_long_seek_displaces_what_is_in_flight_and_puts_it_back_in_the_queue() {
        let local = [region(0, 0, 100, true)];
        let mut planner = Planner::new();
        let first = planner.next(&local, 0, 4);
        finish(&mut planner, &first);
        let flying = planner.next(&local, 0, 4);
        let mut displaced = planner.displaced(&local, 300_000, 4);
        displaced.sort();
        assert_eq!(displaced, ["cs_0_1.m4s", "cs_0_2.m4s", "cs_1_1.m4s", "cs_1_2.m4s"]);
        assert_eq!(names(&planner.next(&local, 300_000, 4)), ["r1_cinit_0.mp4", "r1_cinit_1.mp4", "r1_cs_0_0.m4s", "r1_cs_1_0.m4s"]);
        let rest = planner.next(&local, 300_000, 1_000);
        assert!(flying.iter().all(|item| rest.contains(item)));
    }

    #[test]
    fn a_short_seek_keeps_in_flight_what_the_region_still_needs_behind_it() {
        let local = [region(0, 0, 100, true)];
        let mut planner = Planner::new();
        let first = planner.next(&local, 0, 4);
        finish(&mut planner, &first);
        planner.next(&local, 0, 4);
        assert!(planner.displaced(&local, 8_100, 4).is_empty());
        assert_eq!(names(&planner.next(&local, 8_100, 2)), ["cs_0_3.m4s", "cs_1_3.m4s"]);
    }

    #[test]
    fn a_later_local_region_is_sliced_under_its_own_prefix() {
        let local = [region(0, 0, 5, false), region(3, 600_000, 10, false)];
        let mut planner = Planner::new();
        let items = planner.next(&local, 608_000, 3);
        assert_eq!(names(&items), ["r1_cinit_0.mp4", "r1_cinit_1.mp4", "r1_cs_0_0.m4s"]);
        assert_eq!(items[0].local, "r3_cinit_0.mp4");
        assert_eq!(items[2].local, "r3_cs_0_2.m4s");
    }

    #[test]
    fn regions_span_the_uploaded_prefix_and_playlists_are_sliced() {
        let local = [region(0, 0, 20, false)];
        let mut planner = Planner::new();
        let first = planner.next(&local, 41_000, 8);
        finish(&mut planner, &first);
        let regions = planner.regions(&local);
        assert_eq!(regions, [RegionReport { n: 1, start_ms: 40_000, produced_ms: 12_000, growing: true }]);
        let playlists = planner.playlists(&local);
        assert_eq!(playlists.keys().collect::<Vec<_>>(), ["r1_client_stream_0.m3u8", "r1_client_stream_1.m3u8"]);
        assert!(playlists["r1_client_stream_0.m3u8"].contains("r1_cs_0_9.m4s"));
        assert!(!playlists["r1_client_stream_0.m3u8"].contains("r1_cs_0_10.m4s"));
    }

    #[test]
    fn a_region_fully_sent_from_a_sealed_cache_stops_growing() {
        let local = [region(0, 0, 3, true)];
        let mut planner = Planner::new();
        let all = planner.next(&local, 0, 100);
        finish(&mut planner, &all);
        assert_eq!(planner.regions(&local), [RegionReport { n: 0, start_ms: 0, produced_ms: 12_000, growing: false }]);
        assert!(planner.next(&local, 0, 100).is_empty());
    }
}
