//! The local cache's HLS as FFmpeg writes it, and the slice of it that goes
//! to the bucket as a region of its own. A slice keeps the bytes and renames
//! them into the server's grammar under the remote region's prefix.

/// One variant playlist: its init, its segments in order, and whether
/// FFmpeg already sealed it.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct Variant {
    pub init: Option<String>,
    pub segments: Vec<(String, f64)>,
    pub ended: bool,
    pub target_duration: u32,
}

impl Variant {
    pub fn parse(body: &str) -> Self {
        let mut out = Variant::default();
        let mut pending: Option<f64> = None;
        for line in body.lines().map(str::trim) {
            if let Some(rest) = line.strip_prefix("#EXTINF:") {
                pending = rest.split(',').next().and_then(|d| d.parse().ok());
            } else if let Some(rest) = line.strip_prefix("#EXT-X-MAP:") {
                out.init = rest
                    .split("URI=\"")
                    .nth(1)
                    .and_then(|tail| tail.split('"').next())
                    .map(|uri| uri.rsplit('/').next().unwrap_or(uri).to_string());
            } else if let Some(rest) = line.strip_prefix("#EXT-X-TARGETDURATION:") {
                out.target_duration = rest.parse().unwrap_or(0);
            } else if line == "#EXT-X-ENDLIST" {
                out.ended = true;
            } else if !line.is_empty() && !line.starts_with('#') {
                let name = line.rsplit('/').next().unwrap_or(line).to_string();
                out.segments.push((name, pending.take().unwrap_or(0.0)));
            }
        }
        out
    }

    /// Where segment `index` starts, in ms from the playlist's start.
    pub fn start_ms(&self, index: usize) -> u64 {
        let seconds: f64 = self.segments.iter().take(index).map(|(_, d)| d).sum();
        (seconds * 1000.0).round() as u64
    }

    pub fn duration_ms(&self) -> u64 {
        self.start_ms(self.segments.len())
    }

    /// The segment holding `offset_ms`, or None past the last one.
    pub fn index_at(&self, offset_ms: u64) -> Option<usize> {
        (0..self.segments.len()).find(|&i| offset_ms < self.start_ms(i + 1))
    }
}

pub fn init_name(prefix: &str, variant: usize) -> String {
    format!("{prefix}cinit_{variant}.mp4")
}

pub fn segment_name(prefix: &str, variant: usize, index: usize) -> String {
    format!("{prefix}cs_{variant}_{index}.m4s")
}

pub fn playlist_name(prefix: &str, variant: usize) -> String {
    format!("{prefix}client_stream_{variant}.m3u8")
}

/// The variant from segment `from` on, as remote variant `variant` under
/// `prefix`: numbered from zero and pointing at the renamed init.
pub fn slice(source: &Variant, from: usize, prefix: &str, variant: usize) -> String {
    let target = source.target_duration.max(1);
    let mut out = format!(
        "#EXTM3U\n#EXT-X-VERSION:7\n#EXT-X-TARGETDURATION:{target}\n#EXT-X-MEDIA-SEQUENCE:0\n\
#EXT-X-PLAYLIST-TYPE:EVENT\n#EXT-X-INDEPENDENT-SEGMENTS\n#EXT-X-MAP:URI=\"{}\"\n",
        init_name(prefix, variant)
    );
    for (index, (_, duration)) in source.segments.iter().skip(from).enumerate() {
        out.push_str(&format!("#EXTINF:{duration:.6},\n{}\n", segment_name(prefix, variant, index)));
    }
    if source.ended {
        out.push_str("#EXT-X-ENDLIST\n");
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    const LOCAL: &str = "#EXTM3U\n#EXT-X-VERSION:7\n#EXT-X-TARGETDURATION:5\n#EXT-X-MEDIA-SEQUENCE:0\n\
#EXT-X-PLAYLIST-TYPE:EVENT\n#EXT-X-INDEPENDENT-SEGMENTS\n#EXT-X-MAP:URI=\"r2_cinit_0.mp4\"\n\
#EXTINF:4.004000,\nr2_cs_0_0.m4s\n#EXTINF:4.000000,\nr2_cs_0_1.m4s\n#EXTINF:3.500000,\nr2_cs_0_2.m4s\n";

    #[test]
    fn parses_init_segments_and_seal() {
        let open = Variant::parse(LOCAL);
        assert_eq!(open.init.as_deref(), Some("r2_cinit_0.mp4"));
        assert_eq!(open.segments.len(), 3);
        assert_eq!(open.segments[2], ("r2_cs_0_2.m4s".to_string(), 3.5));
        assert_eq!(open.target_duration, 5);
        assert!(!open.ended);
        assert!(Variant::parse(&format!("{LOCAL}#EXT-X-ENDLIST\n")).ended);
    }

    #[test]
    fn positions_map_to_segments() {
        let v = Variant::parse(LOCAL);
        assert_eq!(v.start_ms(0), 0);
        assert_eq!(v.start_ms(2), 8_004);
        assert_eq!(v.duration_ms(), 11_504);
        assert_eq!(v.index_at(0), Some(0));
        assert_eq!(v.index_at(4_003), Some(0));
        assert_eq!(v.index_at(4_004), Some(1));
        assert_eq!(v.index_at(11_503), Some(2));
        assert_eq!(v.index_at(11_504), None);
    }

    #[test]
    fn slice_renames_into_the_remote_region_from_zero() {
        let v = Variant::parse(&format!("{LOCAL}#EXT-X-ENDLIST\n"));
        let out = slice(&v, 1, "r5_", 0);
        assert!(out.starts_with("#EXTM3U\n"));
        assert!(out.contains("#EXT-X-MEDIA-SEQUENCE:0\n"));
        assert!(out.contains("#EXT-X-MAP:URI=\"r5_cinit_0.mp4\"\n"));
        assert!(out.contains("#EXTINF:4.000000,\nr5_cs_0_0.m4s\n#EXTINF:3.500000,\nr5_cs_0_1.m4s\n"));
        assert!(!out.contains("r2_"));
        assert!(out.ends_with("#EXT-X-ENDLIST\n"));
    }

    #[test]
    fn slice_of_an_open_variant_stays_open() {
        let out = slice(&Variant::parse(LOCAL), 0, "", 1);
        assert!(out.contains("cinit_1.mp4"));
        assert!(out.contains("\ncs_1_2.m4s\n"));
        assert!(!out.contains("ENDLIST"));
    }
}
