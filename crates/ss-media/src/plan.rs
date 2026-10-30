//! What a run carries out of its source, stream by stream.

#[derive(Debug, Clone, PartialEq)]
pub enum AudioAction {
    Copy,
    ConvertAac,
}

#[derive(Debug, Clone)]
#[allow(dead_code)]
pub struct AudioTrack {
    /// Which `-i` carries the track: 0 for a container, one per stream when
    /// the elementary streams arrive separately.
    pub input_file: usize,
    pub input_index: usize,
    pub codec: String,
    pub channels: u32,
    pub language: String,
    pub action: AudioAction,
}

/// One text subtitle stream, addressed as `0:s:{input_index}`.
#[derive(Debug, Clone, PartialEq)]
pub struct SubtitleTrack {
    pub input_index: usize,
    pub codec: String,
    pub language: String,
    pub title: String,
}

#[derive(Debug, Clone)]
#[allow(dead_code)]
pub struct SourcePlan {
    pub video_codec: String,
    /// The RFC 6381 string for the video track, when the player cannot read
    /// it off the init segment itself: hls.js infers avc1/hvc1 from the
    /// sample entry but not av01/vp09, and without CODECS in the master it
    /// opens the SourceBuffers wrong and fails on the first audio append.
    pub video_codecs: Option<String>,
    pub audios: Vec<AudioTrack>,
    pub duration_ms: u64,
    pub subtitles: Vec<SubtitleTrack>,
    pub bitmap_subtitles: usize,
    pub attachments: usize,
    pub chapters: Vec<Chapter>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Chapter {
    pub start_ms: u64,
    pub end_ms: u64,
    pub title: String,
}
