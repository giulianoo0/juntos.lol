//! Hands an fMP4 stream on at the pace of its own timestamps.
//!
//! FFmpeg reads a live's HLS playlists as fast as it can download them, so
//! the first segments arrive at once and the rest a whole segment at a time.
//! Pacing it with `-readrate` stalled the output while each next segment
//! downloaded and then poured the backlog out in a burst, and the groups the
//! relay received in those bursts were the ones viewers lost. Here FFmpeg
//! runs free, the backlog it builds at the start is kept as a cushion, and
//! each fragment leaves when the media clock reaches it.
use std::collections::{HashMap, VecDeque};
use std::time::{Duration, Instant};

/// A fragment this late is not chased: the clock restarts from it, so a long
/// stall upstream shows as one pause instead of a pause and then a burst.
const LATE_RESTART: Duration = Duration::from_secs(1);

struct Unit {
    at: Option<f64>,
    bytes: Vec<u8>,
}

#[derive(Default)]
pub struct Pacer {
    buf: Vec<u8>,
    timescales: HashMap<u32, u32>,
    held: Vec<u8>,
    held_at: Option<f64>,
    queue: VecDeque<Unit>,
    anchor: Option<(Instant, f64)>,
}

impl Pacer {
    pub fn push(&mut self, bytes: &[u8]) {
        self.buf.extend_from_slice(bytes);
        let mut offset = 0;
        while let Some((kind, size)) = box_header(&self.buf[offset..]) {
            if self.buf.len() - offset < size {
                break;
            }
            let body = self.buf[offset..offset + size].to_vec();
            offset += size;
            self.take_box(kind, body);
        }
        self.buf.drain(..offset);
    }

    fn take_box(&mut self, kind: [u8; 4], body: Vec<u8>) {
        match &kind {
            b"moov" => {
                self.timescales.extend(track_timescales(&body));
                self.queue.push_back(Unit { at: None, bytes: body });
            }
            b"moof" => {
                self.held_at = fragment_time(&body, &self.timescales);
                self.held.extend(body);
            }
            b"mdat" => {
                self.held.extend(body);
                let bytes = std::mem::take(&mut self.held);
                self.queue.push_back(Unit { at: self.held_at.take(), bytes });
            }
            _ if self.held.is_empty() => self.queue.push_back(Unit { at: None, bytes: body }),
            _ => self.held.extend(body),
        }
    }

    /// When the next held fragment is due, if one is held.
    pub fn next_due(&self) -> Option<Instant> {
        let unit = self.queue.front()?;
        match (unit.at, self.anchor) {
            (Some(at), Some((start, origin))) => Some(start + secs(at - origin)),
            _ => Some(Instant::now()),
        }
    }

    /// Every piece due by `now`, in order.
    pub fn ready(&mut self, now: Instant) -> Vec<Vec<u8>> {
        let mut out = Vec::new();
        while let Some(unit) = self.queue.front() {
            if let Some(at) = unit.at {
                match self.anchor {
                    None => self.anchor = Some((now, at)),
                    Some((start, origin)) => {
                        let due = start + secs(at - origin);
                        if due > now {
                            break;
                        }
                        if now - due > LATE_RESTART {
                            self.anchor = Some((now, at));
                        }
                    }
                }
            }
            out.push(self.queue.pop_front().unwrap().bytes);
        }
        out
    }

    /// Whatever is still held, for when the stream has ended.
    pub fn drain(&mut self) -> Vec<Vec<u8>> {
        let mut out: Vec<Vec<u8>> = self.queue.drain(..).map(|unit| unit.bytes).collect();
        if !self.held.is_empty() {
            out.push(std::mem::take(&mut self.held));
        }
        if !self.buf.is_empty() {
            out.push(std::mem::take(&mut self.buf));
        }
        out
    }

    /// Media seconds held back, from the next fragment to the newest.
    pub fn backlog(&self) -> f64 {
        let first = self.queue.iter().find_map(|unit| unit.at);
        let last = self.queue.iter().rev().find_map(|unit| unit.at);
        match (first, last) {
            (Some(first), Some(last)) => last - first,
            _ => 0.0,
        }
    }
}

fn secs(value: f64) -> Duration {
    Duration::from_secs_f64(value.max(0.0))
}

fn box_header(bytes: &[u8]) -> Option<([u8; 4], usize)> {
    if bytes.len() < 8 {
        return None;
    }
    let size = u32::from_be_bytes(bytes[0..4].try_into().unwrap()) as usize;
    let kind: [u8; 4] = bytes[4..8].try_into().unwrap();
    let size = match size {
        1 => {
            if bytes.len() < 16 {
                return None;
            }
            u64::from_be_bytes(bytes[8..16].try_into().unwrap()) as usize
        }
        // Size 0 runs to the end of the stream, which a live never reaches.
        0 => usize::MAX,
        size => size,
    };
    Some((kind, size))
}

/// The children of a box, as (type, payload) pairs.
fn children(body: &[u8]) -> Vec<([u8; 4], &[u8])> {
    let mut out = Vec::new();
    let mut offset = 0;
    while let Some((kind, size)) = box_header(&body[offset..]) {
        let header = if u32::from_be_bytes(body[offset..offset + 4].try_into().unwrap()) == 1 { 16 } else { 8 };
        if size < header || offset.checked_add(size).map_or(true, |end| end > body.len()) {
            break;
        }
        out.push((kind, &body[offset + header..offset + size]));
        offset += size;
    }
    out
}

fn payload(whole: &[u8]) -> &[u8] {
    if whole.len() >= 16 && u32::from_be_bytes(whole[0..4].try_into().unwrap()) == 1 {
        &whole[16..]
    } else {
        &whole[8.min(whole.len())..]
    }
}

fn read_u32(bytes: &[u8], at: usize) -> Option<u32> {
    Some(u32::from_be_bytes(bytes.get(at..at + 4)?.try_into().ok()?))
}

fn read_u64(bytes: &[u8], at: usize) -> Option<u64> {
    Some(u64::from_be_bytes(bytes.get(at..at + 8)?.try_into().ok()?))
}

fn track_timescales(moov: &[u8]) -> HashMap<u32, u32> {
    let mut out = HashMap::new();
    for (kind, trak) in children(payload(moov)) {
        if &kind != b"trak" {
            continue;
        }
        let mut id = None;
        let mut scale = None;
        for (kind, inner) in children(trak) {
            match &kind {
                b"tkhd" => id = read_u32(inner, if inner.first() == Some(&1) { 20 } else { 12 }),
                b"mdia" => {
                    for (kind, mdhd) in children(inner) {
                        if &kind == b"mdhd" {
                            scale = read_u32(mdhd, if mdhd.first() == Some(&1) { 20 } else { 12 });
                        }
                    }
                }
                _ => {}
            }
        }
        if let (Some(id), Some(scale)) = (id, scale) {
            if scale > 0 {
                out.insert(id, scale);
            }
        }
    }
    out
}

/// The earliest decode time among a moof's tracks, in seconds.
fn fragment_time(moof: &[u8], timescales: &HashMap<u32, u32>) -> Option<f64> {
    let mut earliest: Option<f64> = None;
    for (kind, traf) in children(payload(moof)) {
        if &kind != b"traf" {
            continue;
        }
        let mut id = None;
        let mut time = None;
        for (kind, inner) in children(traf) {
            match &kind {
                b"tfhd" => id = read_u32(inner, 4),
                b"tfdt" => {
                    time = if inner.first() == Some(&1) {
                        read_u64(inner, 4)
                    } else {
                        read_u32(inner, 4).map(u64::from)
                    }
                }
                _ => {}
            }
        }
        let Some(scale) = id.and_then(|id| timescales.get(&id)) else { continue };
        let Some(time) = time else { continue };
        let seconds = time as f64 / *scale as f64;
        earliest = Some(earliest.map_or(seconds, |e: f64| e.min(seconds)));
    }
    earliest
}

#[cfg(test)]
mod tests {
    use super::*;

    fn boxed(kind: &[u8; 4], body: &[u8]) -> Vec<u8> {
        let mut out = ((body.len() + 8) as u32).to_be_bytes().to_vec();
        out.extend_from_slice(kind);
        out.extend_from_slice(body);
        out
    }

    fn full(version: u8, rest: &[u8]) -> Vec<u8> {
        let mut out = vec![version, 0, 0, 0];
        out.extend_from_slice(rest);
        out
    }

    fn moov() -> Vec<u8> {
        let trak = |id: u32, scale: u32| {
            let mut tkhd = vec![0u8; 8];
            tkhd.extend_from_slice(&id.to_be_bytes());
            tkhd.extend_from_slice(&[0u8; 72]);
            let mut mdhd = vec![0u8; 8];
            mdhd.extend_from_slice(&scale.to_be_bytes());
            mdhd.extend_from_slice(&[0u8; 8]);
            let mdia = boxed(b"mdia", &boxed(b"mdhd", &full(0, &mdhd)));
            let mut body = boxed(b"tkhd", &full(0, &tkhd));
            body.extend(mdia);
            boxed(b"trak", &body)
        };
        let mut body = trak(1, 90_000);
        body.extend(trak(2, 44_100));
        boxed(b"moov", &body)
    }

    fn fragment(video: u64, audio: u64) -> Vec<u8> {
        let traf = |id: u32, time: u64| {
            let mut body = boxed(b"tfhd", &full(0, &id.to_be_bytes()));
            body.extend(boxed(b"tfdt", &full(1, &time.to_be_bytes())));
            boxed(b"traf", &body)
        };
        let mut moof = traf(1, video);
        moof.extend(traf(2, audio));
        let mut out = boxed(b"moof", &moof);
        out.extend(boxed(b"mdat", &[7u8; 32]));
        out
    }

    fn stream(fragments: usize) -> Vec<u8> {
        let mut out = boxed(b"ftyp", b"isom");
        out.extend(moov());
        for i in 0..fragments as u64 {
            out.extend(fragment(i * 22_500, i * 11_025));
        }
        out
    }

    #[test]
    fn reads_the_fragment_time_from_both_tracks() {
        let mut pacer = Pacer::default();
        pacer.push(&stream(3));
        assert!((pacer.backlog() - 0.5).abs() < 1e-6);
    }

    #[test]
    fn a_backlog_leaves_at_its_own_pace() {
        let mut pacer = Pacer::default();
        pacer.push(&stream(8));
        let start = Instant::now();
        let first = pacer.ready(start);
        // ftyp, moov and the first fragment go at once.
        assert_eq!(first.len(), 3);
        assert!(pacer.ready(start + Duration::from_millis(200)).is_empty());
        assert_eq!(pacer.ready(start + Duration::from_millis(260)).len(), 1);
        assert_eq!(pacer.ready(start + Duration::from_millis(1010)).len(), 3);
        let due = pacer.next_due().unwrap();
        assert_eq!(due, start + Duration::from_millis(1250));
    }

    #[test]
    fn split_reads_make_the_same_units() {
        let bytes = stream(4);
        let mut whole = Pacer::default();
        whole.push(&bytes);
        let mut pieces = Pacer::default();
        for chunk in bytes.chunks(7) {
            pieces.push(chunk);
        }
        let far = Instant::now() + Duration::from_secs(10);
        assert_eq!(whole.ready(far), pieces.ready(far));
    }

    #[test]
    fn a_long_stall_restarts_the_clock_instead_of_bursting() {
        let mut pacer = Pacer::default();
        pacer.push(&stream(1));
        let start = Instant::now();
        assert_eq!(pacer.ready(start).len(), 3);
        // The next four fragments only arrive five seconds later.
        let mut late = Vec::new();
        for i in 1..5u64 {
            late.extend(fragment(i * 22_500, i * 11_025));
        }
        pacer.push(&late);
        let now = start + Duration::from_secs(5);
        assert_eq!(pacer.ready(now).len(), 1);
        assert!(pacer.ready(now + Duration::from_millis(100)).is_empty());
        assert_eq!(pacer.ready(now + Duration::from_millis(260)).len(), 1);
    }
}
