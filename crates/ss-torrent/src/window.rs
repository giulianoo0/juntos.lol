//! Which pieces a streaming read actually needs.
//!
//! librqbit selects by whole file, so a reader that wants ten seconds around
//! its cursor still drags the entire file down behind it — tens of gigabytes
//! of bandwidth and disk for a 4K release nobody will watch to the end. These
//! turn a set of read cursors into the piece set worth holding.

pub const AHEAD: u64 = 256 * 1024 * 1024;
pub const STARTUP_AHEAD: u64 = 32 * 1024 * 1024;
pub const STARTUP: std::time::Duration = std::time::Duration::from_secs(3);
pub const SCAN_AHEAD: u64 = 32 * 1024 * 1024;
pub const BEHIND: u64 = 32 * 1024 * 1024;
pub const PIN: u64 = 32 * 1024 * 1024;

const CURSORS: u64 = 2;

/// The most this file can occupy while the window is doing its job: the
/// pinned head and tail, plus a full span around every cursor that can exist.
pub fn footprint(file_len: u64, ahead: u64, behind: u64, pin: u64) -> u64 {
    let spans = (ahead + behind).saturating_mul(CURSORS);
    let pins = pin.saturating_mul(2);
    spans.saturating_add(pins).min(file_len)
}

#[derive(Clone, Copy, Debug)]
pub struct Cursor {
    pub at: u64,
    pub ahead: u64,
    pub behind: u64,
}

/// File-relative byte ranges worth holding for these read cursors, as
/// half-open `[start, end)` pairs, merged and in order.
#[cfg(test)]
pub fn needed_ranges(file_len: u64, cursors: &[u64], ahead: u64, behind: u64, pin: u64) -> Vec<(u64, u64)> {
    let cursors: Vec<Cursor> = cursors.iter().map(|&at| Cursor { at, ahead, behind }).collect();
    needed_ranges_for(file_len, &cursors, pin)
}

/// Like `needed_ranges`, with each cursor carrying its own span.
pub fn needed_ranges_for(file_len: u64, cursors: &[Cursor], pin: u64) -> Vec<(u64, u64)> {
    if file_len == 0 {
        return Vec::new();
    }
    let mut ranges: Vec<(u64, u64)> = Vec::with_capacity(cursors.len() + 2);
    let pin = pin.min(file_len);
    ranges.push((0, pin));
    ranges.push((file_len.saturating_sub(pin), file_len));
    for cursor in cursors {
        let at = cursor.at.min(file_len);
        let start = at.saturating_sub(cursor.behind);
        let end = at.saturating_add(cursor.ahead).min(file_len);
        if start < end {
            ranges.push((start, end));
        }
    }
    ranges.sort_unstable();
    let mut merged: Vec<(u64, u64)> = Vec::with_capacity(ranges.len());
    for (start, end) in ranges {
        match merged.last_mut() {
            Some(last) if start <= last.1 => last.1 = last.1.max(end),
            _ => merged.push((start, end)),
        }
    }
    merged
}

/// Torrent piece indices covering file-relative ranges. A piece straddling the
/// edge of a range is included: a partly-wanted piece is still wanted.
pub fn pieces_for_ranges(
    file_offset_in_torrent: u64,
    piece_len: u64,
    total_pieces: u32,
    ranges: &[(u64, u64)],
) -> Vec<u32> {
    if piece_len == 0 {
        return Vec::new();
    }
    let mut out = Vec::new();
    for &(start, end) in ranges {
        if start >= end {
            continue;
        }
        let first = (file_offset_in_torrent + start) / piece_len;
        let last = (file_offset_in_torrent + end - 1) / piece_len;
        for piece in first..=last {
            if piece < total_pieces as u64 {
                out.push(piece as u32);
            }
        }
    }
    out.sort_unstable();
    out.dedup();
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    const MB: u64 = 1024 * 1024;

    #[test]
    fn a_fill_cursor_swallows_pins_and_windows_alike() {
        let cursors = [
            Cursor { at: 500 * MB, ahead: 100 * MB, behind: 10 * MB },
            Cursor { at: 0, ahead: 1000 * MB, behind: 0 },
        ];
        assert_eq!(needed_ranges_for(1000 * MB, &cursors, 32 * MB), vec![(0, 1000 * MB)]);
    }

    #[test]
    fn pins_the_head_and_tail_around_a_cursor_in_the_middle() {
        let ranges = needed_ranges(1000 * MB, &[500 * MB], 100 * MB, 10 * MB, 32 * MB);

        assert_eq!(
            ranges,
            vec![
                (0, 32 * MB),
                (490 * MB, 600 * MB),
                (968 * MB, 1000 * MB),
            ]
        );
    }

    #[test]
    fn merges_windows_that_touch() {
        let ranges = needed_ranges(1000 * MB, &[400 * MB, 450 * MB], 100 * MB, 10 * MB, 1 * MB);

        assert_eq!(ranges[1], (390 * MB, 550 * MB));
    }

    #[test]
    fn clamps_a_window_to_the_end_of_the_file() {
        let ranges = needed_ranges(100 * MB, &[99 * MB], 100 * MB, 10 * MB, 1 * MB);

        assert!(ranges.iter().all(|(_, end)| *end <= 100 * MB));
    }

    #[test]
    fn a_cursor_near_the_start_does_not_underflow() {
        let ranges = needed_ranges(100 * MB, &[1 * MB], 10 * MB, 32 * MB, 1 * MB);

        assert_eq!(ranges[0].0, 0);
    }

    #[test]
    fn maps_ranges_to_pieces_through_the_file_offset() {
        let pieces = pieces_for_ranges(10 * MB, MB, 100, &[(0, 2 * MB)]);

        assert_eq!(pieces, vec![10, 11]);
    }

    #[test]
    fn includes_a_piece_the_range_only_partly_covers() {
        let pieces = pieces_for_ranges(0, MB, 100, &[(MB / 2, MB + 1)]);

        assert_eq!(pieces, vec![0, 1]);
    }

    #[test]
    fn never_names_a_piece_past_the_end_of_the_torrent() {
        let pieces = pieces_for_ranges(0, MB, 4, &[(0, 100 * MB)]);

        assert_eq!(pieces, vec![0, 1, 2, 3]);
    }

    #[test]
    fn each_cursor_carries_its_own_span() {
        let ranges = needed_ranges_for(
            1000 * MB,
            &[
                Cursor { at: 500 * MB, ahead: 32 * MB, behind: 10 * MB },
                Cursor { at: 100 * MB, ahead: 32 * MB, behind: 0 },
            ],
            1 * MB,
        );

        assert_eq!(ranges, vec![(0, MB), (100 * MB, 132 * MB), (490 * MB, 532 * MB), (999 * MB, 1000 * MB)]);
    }

    #[test]
    fn an_empty_file_needs_nothing() {
        assert!(needed_ranges(0, &[0], AHEAD, BEHIND, PIN).is_empty());
    }

    #[test]
    fn a_huge_file_is_admitted_against_its_window_not_its_length() {
        let held = footprint(23 * 1024 * MB, AHEAD, BEHIND, PIN);

        assert!(held < 1024 * MB, "expected well under a gigabyte, got {held}");
    }

    #[test]
    fn a_file_smaller_than_the_window_reserves_only_itself() {
        assert_eq!(footprint(50 * MB, AHEAD, BEHIND, PIN), 50 * MB);
    }
}
