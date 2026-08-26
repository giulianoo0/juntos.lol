//! Which pieces a streaming read actually needs.
//!
//! librqbit selects by whole file, so a reader that wants ten seconds around
//! its cursor still drags the entire file down behind it — tens of gigabytes
//! of bandwidth and disk for a 4K release nobody will watch to the end. These
//! turn a set of read cursors into the piece set worth holding.

/// Kept selected ahead of each cursor.
pub const AHEAD: u64 = 256 * 1024 * 1024;
/// Kept behind it, so a small step back does not refetch.
pub const BEHIND: u64 = 32 * 1024 * 1024;
/// The head and tail of the file always stay selected: the container's header
/// sits at the front, and Matroska keeps its Cues at the very end. Drop either
/// and the demuxer cannot seek at all.
pub const PIN: u64 = 32 * 1024 * 1024;

/// How many cursors one file can have windows for at once: the playhead and
/// the subtitle scan each park a stream, and head probes never get one.
const CURSORS: u64 = 2;

/// The most this file can occupy while the window is doing its job: the
/// pinned head and tail, plus a full span around every cursor that can exist.
///
/// This is what a torrent should be admitted against. Reserving the whole
/// file was right before the window existed and is now wildly pessimistic —
/// it would turn away a second room over disk that the first one never takes,
/// since everything behind the window is punched back out to the filesystem.
/// Generous on purpose: pieces are only released on the sweep, so what is
/// held overshoots the ideal between rounds.
pub fn footprint(file_len: u64, ahead: u64, behind: u64, pin: u64) -> u64 {
    let spans = (ahead + behind).saturating_mul(CURSORS);
    let pins = pin.saturating_mul(2);
    spans.saturating_add(pins).min(file_len)
}

/// File-relative byte ranges worth holding for these read cursors, as
/// half-open `[start, end)` pairs, merged and in order.
pub fn needed_ranges(file_len: u64, cursors: &[u64], ahead: u64, behind: u64, pin: u64) -> Vec<(u64, u64)> {
    if file_len == 0 {
        return Vec::new();
    }
    let mut ranges: Vec<(u64, u64)> = Vec::with_capacity(cursors.len() + 2);
    let pin = pin.min(file_len);
    ranges.push((0, pin));
    ranges.push((file_len.saturating_sub(pin), file_len));
    for &cursor in cursors {
        let cursor = cursor.min(file_len);
        let start = cursor.saturating_sub(behind);
        let end = cursor.saturating_add(ahead).min(file_len);
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
    fn pins_the_head_and_tail_around_a_cursor_in_the_middle() {
        // Without the tail, a Matroska file's Cues stop being fetched and the
        // next seek has nothing to seek with.
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

        // 390..500 and 440..550 overlap into one span.
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
        // The file starts 10 pieces into the torrent, so file byte 0 is piece 10.
        let pieces = pieces_for_ranges(10 * MB, MB, 100, &[(0, 2 * MB)]);

        assert_eq!(pieces, vec![10, 11]);
    }

    #[test]
    fn includes_a_piece_the_range_only_partly_covers() {
        // Half of piece 0 and a byte of piece 1 are still both needed.
        let pieces = pieces_for_ranges(0, MB, 100, &[(MB / 2, MB + 1)]);

        assert_eq!(pieces, vec![0, 1]);
    }

    #[test]
    fn never_names_a_piece_past_the_end_of_the_torrent() {
        let pieces = pieces_for_ranges(0, MB, 4, &[(0, 100 * MB)]);

        assert_eq!(pieces, vec![0, 1, 2, 3]);
    }

    #[test]
    fn an_empty_file_needs_nothing() {
        assert!(needed_ranges(0, &[0], AHEAD, BEHIND, PIN).is_empty());
    }

    #[test]
    fn a_huge_file_is_admitted_against_its_window_not_its_length() {
        // The whole point: a 23 GB release never sits on the disk in full, so
        // reserving 23 GB for it turns away rooms that would have fitted.
        let held = footprint(23 * 1024 * MB, AHEAD, BEHIND, PIN);

        assert!(held < 1024 * MB, "expected well under a gigabyte, got {held}");
    }

    #[test]
    fn a_file_smaller_than_the_window_reserves_only_itself() {
        assert_eq!(footprint(50 * MB, AHEAD, BEHIND, PIN), 50 * MB);
    }
}
