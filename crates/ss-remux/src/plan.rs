use anyhow::{bail, Context};
use serde::Deserialize;

pub use ss_media::plan::{AudioAction, AudioTrack, Chapter, SourcePlan, SubtitleTrack};

// The explicit codec matrix, mirrored from internal/remux: an unlisted
// codec is a clear refusal, never a hidden transcode.

#[derive(Deserialize)]
struct ProbeDoc {
    #[serde(default)]
    streams: Vec<ProbeStream>,
    #[serde(default)]
    format: Option<ProbeFormat>,
    #[serde(default)]
    chapters: Vec<ProbeChapter>,
}

#[derive(Deserialize)]
struct ProbeChapter {
    #[serde(default)]
    start_time: Option<String>,
    #[serde(default)]
    end_time: Option<String>,
    #[serde(default)]
    tags: Option<ProbeTags>,
}

/// ffprobe's chapter list as the room stores it: ordered, non-empty spans,
/// titled by the file or by their number.
fn plan_chapters(raw: &[ProbeChapter]) -> Vec<Chapter> {
    let seconds = |v: &Option<String>| v.as_deref().and_then(|s| s.parse::<f64>().ok()).map(|s| (s.max(0.0) * 1000.0) as u64);
    let mut out = Vec::new();
    for (index, chapter) in raw.iter().enumerate() {
        let (Some(start_ms), Some(end_ms)) = (seconds(&chapter.start_time), seconds(&chapter.end_time)) else { continue };
        if end_ms <= start_ms {
            continue;
        }
        let title = chapter
            .tags
            .as_ref()
            .and_then(|t| t.title.clone())
            .map(|t| t.trim().chars().take(200).collect::<String>())
            .filter(|t| !t.is_empty())
            .unwrap_or_else(|| format!("{}", index + 1));
        out.push(Chapter { start_ms, end_ms, title });
    }
    out
}

#[derive(Deserialize)]
struct ProbeFormat {
    #[serde(default)]
    duration: Option<String>,
}

#[derive(Deserialize)]
struct ProbeStream {
    codec_type: Option<String>,
    codec_name: Option<String>,
    #[serde(default)]
    profile: Option<String>,
    #[serde(default)]
    level: Option<i64>,
    #[serde(default)]
    pix_fmt: Option<String>,
    #[serde(default)]
    width: Option<u32>,
    #[serde(default)]
    height: Option<u32>,
    #[serde(default)]
    channels: Option<u32>,
    #[serde(default)]
    tags: Option<ProbeTags>,
    #[serde(default)]
    duration: Option<String>,
}

#[derive(Deserialize)]
struct ProbeTags {
    #[serde(default)]
    language: Option<String>,
    #[serde(default)]
    title: Option<String>,
    #[serde(default, rename = "DURATION")]
    duration: Option<String>,
}

const TEXT_SUBTITLE_CODECS: &[&str] = &["ass", "ssa", "subrip", "srt", "webvtt", "mov_text", "text"];
const BITMAP_SUBTITLE_CODECS: &[&str] = &["hdmv_pgs_subtitle", "dvd_subtitle", "dvb_subtitle", "xsub"];

const MAX_AUDIO_CHANNELS: u32 = 8;

const AAC_BITRATE: u32 = 160_000;
/// Bytes and microseconds FFmpeg may read off an input before muxing.
const PROBE_SIZE: &str = "2000000";
const LOW_VIDEO_BITRATE: &str = "1200k";
const LOW_VIDEO_MAXRATE: &str = "1500k";
const LOW_VIDEO_BUFSIZE: &str = "3000k";

/// None means the track is dropped from the output — a codec outside the
/// matrix or a layout we don't take never costs the whole file, since a
/// BluRay rip carries its lossless track next to a usable AC3 one.
fn audio_action(codec: &str, channels: u32) -> Option<AudioAction> {
    if channels == 0 || channels > MAX_AUDIO_CHANNELS {
        return None;
    }
    match codec {
        "aac" => Some(AudioAction::Copy),
        "ac3" | "eac3" | "dts" | "dca" | "opus" | "flac" | "mp3" | "vorbis" | "truehd" | "mlp"
        | "pcm_bluray" | "pcm_dvd" | "pcm_s16le" | "pcm_s24le" | "pcm_s16be" | "pcm_s24be" => {
            Some(AudioAction::ConvertAac)
        }
        _ => None,
    }
}

fn bit_depth(pix_fmt: &str) -> u32 {
    if pix_fmt.contains("12") {
        12
    } else if pix_fmt.contains("10") {
        10
    } else {
        8
    }
}

/// The CODECS entry for AV1 and VP9, from what ffprobe knows. The level is
/// advisory to every browser that matters, so an unknown one gets a
/// plausible value rather than blocking the room.
fn video_codec_attr(codec: &str, profile: Option<&str>, level: Option<i64>, pix_fmt: Option<&str>) -> Option<String> {
    let depth = bit_depth(pix_fmt.unwrap_or(""));
    match codec {
        "av1" => {
            let profile = match profile.unwrap_or("") {
                "High" => 1,
                "Professional" => 2,
                _ => 0,
            };
            let level = level.filter(|l| (0..=31).contains(l)).unwrap_or(8);
            Some(format!("av01.{profile}.{level:02}M.{depth:02}"))
        }
        "vp9" => {
            let profile = profile
                .and_then(|p| p.trim_start_matches("Profile").trim().parse::<u32>().ok())
                .unwrap_or(0);
            let level = level.filter(|l| (10..=62).contains(l)).unwrap_or(10);
            Some(format!("vp09.{profile:02}.{level:02}.{depth:02}"))
        }
        _ => None,
    }
}

fn parse_mkv_duration(tag: &str) -> Option<u64> {
    let mut parts = tag.split(':');
    let h: u64 = parts.next()?.parse().ok()?;
    let m: u64 = parts.next()?.parse().ok()?;
    let s: f64 = parts.next()?.parse().ok()?;
    Some(((h * 3600 + m * 60) as f64 * 1000.0 + s * 1000.0) as u64)
}

pub fn plan_streams(probe_json: &str) -> anyhow::Result<SourcePlan> {
    let doc: ProbeDoc = serde_json::from_str(probe_json).context("ffprobe output")?;
    let chapters = plan_chapters(&doc.chapters);
    let mut video_codec = None;
    let mut video_codecs = None;
    let mut video_size = None;
    let mut audios = Vec::new();
    let mut audio_index = 0usize;
    let mut subtitles = Vec::new();
    let mut subtitle_index = 0usize;
    let mut bitmap_subtitles = 0usize;
    let mut attachments = 0usize;
    let mut duration_ms = doc
        .format
        .and_then(|f| f.duration)
        .and_then(|d| d.parse::<f64>().ok())
        .map(|s| (s * 1000.0) as u64)
        .unwrap_or(0);
    for stream in &doc.streams {
        match stream.codec_type.as_deref() {
            Some("video") if video_codec.is_none() => {
                let codec = stream.codec_name.clone().unwrap_or_default();
                match codec.as_str() {
                    "h264" | "hevc" | "av1" | "vp9" => {
                        video_codecs = video_codec_attr(
                            &codec,
                            stream.profile.as_deref(),
                            stream.level,
                            stream.pix_fmt.as_deref(),
                        );
                        video_codec = Some(codec);
                        video_size = stream.width.zip(stream.height).filter(|&(w, h)| w > 0 && h > 0);
                    }
                    other => bail!("video codec {other:?} has no matrix entry"),
                }
            }
            Some("audio") => {
                let codec = stream.codec_name.clone().unwrap_or_default();
                let channels = stream.channels.unwrap_or(0);
                let Some(action) = audio_action(&codec, channels) else {
                    tracing::warn!(codec = %codec, channels, "audio track skipped: outside the matrix");
                    audio_index += 1;
                    continue;
                };
                audios.push(AudioTrack {
                    input_file: 0,
                    input_index: audio_index,
                    codec,
                    channels,
                    language: stream
                        .tags
                        .as_ref()
                        .and_then(|t| t.language.clone())
                        .unwrap_or_else(|| "und".into()),
                    action,
                });
                audio_index += 1;
            }
            Some("subtitle") => {
                let codec = stream.codec_name.clone().unwrap_or_default();
                if TEXT_SUBTITLE_CODECS.contains(&codec.as_str()) {
                    subtitles.push(SubtitleTrack {
                        input_index: subtitle_index,
                        codec,
                        language: stream
                            .tags
                            .as_ref()
                            .and_then(|t| t.language.clone())
                            .unwrap_or_else(|| "und".into()),
                        title: stream.tags.as_ref().and_then(|t| t.title.clone()).unwrap_or_default(),
                    });
                } else if BITMAP_SUBTITLE_CODECS.contains(&codec.as_str()) {
                    bitmap_subtitles += 1;
                }
                subtitle_index += 1;
            }
            Some("attachment") => attachments += 1,
            _ => {}
        }
        if duration_ms == 0 {
            if let Some(d) = stream.duration.as_ref().and_then(|d| d.parse::<f64>().ok()) {
                duration_ms = (d * 1000.0) as u64;
            }
            if let Some(tag) = stream.tags.as_ref().and_then(|t| t.duration.as_deref()) {
                if let Some(ms) = parse_mkv_duration(tag) {
                    duration_ms = ms;
                }
            }
        }
    }
    let video_codec = video_codec.context("no video stream")?;
    // A silent source is fine; a source whose every track was skipped is not,
    // since that would play mute without ever saying why.
    if audios.is_empty() && audio_index > 0 {
        bail!("no audio track the matrix can copy or convert");
    }
    if duration_ms == 0 {
        bail!("source reports no usable duration");
    }
    Ok(SourcePlan { video_codec, video_codecs, video_size, audios, duration_ms, subtitles, bitmap_subtitles, attachments,
        chapters,
    })
}

/// Output names mirror the client pipeline's grammar exactly: the server's
/// allowlist is the authorization, so a name outside it never gets signed.
pub fn region_prefix(region: u64) -> String {
    if region == 0 { String::new() } else { format!("r{region}_") }
}

/// The encoder behind the 480p rendition: x264 on the fleet, the GPU's on a
/// Mac running the app.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Encoder {
    X264,
    VideoToolbox,
}

impl Encoder {
    pub fn from_name(name: &str) -> Option<Self> {
        match name {
            "libx264" => Some(Self::X264),
            "h264_videotoolbox" => Some(Self::VideoToolbox),
            _ => None,
        }
    }
}

/// The 480p variant's index: after every audio, so the full variant and the
/// audio keep the names they have without it.
pub fn low_variant(plan: &SourcePlan) -> usize {
    1 + plan.audios.len()
}

/// The 480p variant's size, as `scale=-2:'min(480,ih)'` gives it: the
/// source's height up to 480, and the width that keeps the aspect, even.
pub fn low_resolution(plan: &SourcePlan) -> Option<(u32, u32)> {
    let (width, height) = plan.video_size?;
    let out_height = height.min(480);
    let half = (u64::from(out_height) * u64::from(width) + u64::from(height)) / (2 * u64::from(height));
    Some(((half * 2) as u32, out_height))
}

/// The second video output, encoded down to 480p. Its keyframes are the
/// source's, so both variants cut their segments at the same instants and
/// the player can switch between them.
fn low_rendition_args(encoder: Encoder) -> Vec<String> {
    let mut args: Vec<String> = vec!["-map".into(), "0:v:0".into()];
    match encoder {
        Encoder::X264 => args.extend([
            "-c:v:1".into(), "libx264".into(),
            "-preset:v:1".into(), "superfast".into(),
            // A scene cut of its own would cut a segment the full variant lacks.
            "-sc_threshold:v:1".into(), "0".into(),
        ]),
        Encoder::VideoToolbox => args.extend(["-c:v:1".into(), "h264_videotoolbox".into()]),
    }
    args.extend([
        "-filter:v:1".into(), "scale=-2:'min(480,ih)'".into(),
        "-pix_fmt:v:1".into(), "yuv420p".into(),
        // Main 3.1 plays on any phone; past it some decoders refuse the variant.
        "-profile:v:1".into(), "main".into(),
        "-level:v:1".into(), "3.1".into(),
        "-b:v:1".into(), LOW_VIDEO_BITRATE.into(),
        "-maxrate:v:1".into(), LOW_VIDEO_MAXRATE.into(),
        "-bufsize:v:1".into(), LOW_VIDEO_BUFSIZE.into(),
        "-g:v:1".into(), "1000".into(),
        "-force_key_frames:v:1".into(), "source".into(),
    ]);
    args
}

/// Where a run seeks to, and whether the keyframe search confirmed a
/// keyframe there.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Start {
    pub seconds: f64,
    pub offset_ms: u64,
    pub on_keyframe: bool,
}

impl Start {
    pub const ZERO: Start = Start { seconds: 0.0, offset_ms: 0, on_keyframe: true };

    /// The keyframe the search found, never past the target; the target
    /// itself, unconfirmed, when none was found.
    pub fn seek(start_ms: u64, keyframe: Option<f64>) -> Start {
        if start_ms == 0 {
            return Start::ZERO;
        }
        match keyframe {
            Some(pts) if pts * 1000.0 <= start_ms as f64 && (pts * 1000.0) as u64 > 0 => {
                Start { seconds: pts, offset_ms: (pts * 1000.0) as u64, on_keyframe: true }
            }
            _ => Start { seconds: start_ms as f64 / 1000.0, offset_ms: start_ms, on_keyframe: false },
        }
    }

    /// The 480p encoder the run really uses: the copy and the encoder only
    /// start on the same frame from a confirmed keyframe.
    pub fn low(&self, encoder: Option<Encoder>) -> Option<Encoder> {
        encoder.filter(|_| self.on_keyframe)
    }
}

/// The first frame's pts in an ffprobe `-show_entries frame=pts_time` dump.
pub fn first_frame_pts(probe_json: &str) -> Option<f64> {
    let doc: serde_json::Value = serde_json::from_str(probe_json).ok()?;
    doc["frames"].as_array()?.first()?["pts_time"].as_str()?.parse().ok()
}

/// FFmpeg argv for one run: video copied, audio per the matrix, HLS fMP4 in
/// 4-second target segments, every output PUT to the loopback sink. The
/// first input carries the video; the seek applies to every input. With an
/// encoder and a start on a keyframe, a 480p variant rides along (see
/// `low_variant` and `Start::low`).
pub fn ffmpeg_args(
    inputs: &[String],
    sink_base: &str,
    prefix: &str,
    plan: &SourcePlan,
    start: Start,
    end_seconds: Option<f64>,
    low: Option<Encoder>,
) -> Vec<String> {
    let low = start.low(low);
    let mut args: Vec<String> = vec![
        "-nostdin".into(),
        "-hide_banner".into(),
        "-loglevel".into(),
        "error".into(),
        "-progress".into(),
        "pipe:1".into(),
    ];
    if start.seconds > 0.0 {
        args.extend(["-ss".into(), format!("{:.3}", start.seconds)]);
    }
    if let Some(end) = end_seconds {
        args.extend(["-to".into(), format!("{end:.3}")]);
    }
    // ffprobe already read the streams; a short probe spares the torrent a
    // read of several megabytes before the first segment.
    for input in inputs {
        args.extend(["-probesize".into(), PROBE_SIZE.into(), "-analyzeduration".into(), PROBE_SIZE.into()]);
        args.extend(["-protocol_whitelist".into(), "http,tcp".into(), "-i".into(), input.clone()]);
    }
    args.extend(["-map".into(), "0:v:0".into(), "-c:v:0".into(), "copy".into()]);
    if low.is_some() {
        // A seek lands the copy one GOP early while the encoder starts at
        // -ss; without that GOP both variants cut at the same keyframes.
        args.extend(["-copypriorss:v:0".into(), "0".into()]);
    }
    if plan.video_codec == "hevc" {
        args.extend(["-tag:v:0".into(), "hvc1".into()]);
    }
    let mut var_map = vec!["v:0,agroup:aud".to_string()];
    for (out_index, audio) in plan.audios.iter().enumerate() {
        args.extend(["-map".into(), format!("{}:a:{}", audio.input_file, audio.input_index)]);
        match &audio.action {
            AudioAction::Copy => args.extend([format!("-c:a:{out_index}"), "copy".into()]),
            AudioAction::ConvertAac => args.extend([
                format!("-c:a:{out_index}"),
                "aac".into(),
                // The default coder is most of a remux's cost; at 160 kb/s
                // stereo the fast one is indistinguishable.
                format!("-aac_coder:a:{out_index}"),
                "fast".into(),
                format!("-b:a:{out_index}"),
                AAC_BITRATE.to_string(),
                format!("-filter:a:{out_index}"),
                "aformat=channel_layouts=stereo".into(),
            ]),
        }
        var_map.push(format!(
            "a:{out_index},agroup:aud,language:{}{}",
            safe_language(&audio.language),
            if out_index == 0 { ",default:yes" } else { "" },
        ));
    }
    if let Some(encoder) = low {
        args.extend(low_rendition_args(encoder));
        var_map.push("v:1,agroup:aud".into());
    }
    args.extend([
        "-f".into(),
        "hls".into(),
        "-hls_time".into(),
        "4".into(),
        "-hls_playlist_type".into(),
        "event".into(),
        "-hls_segment_type".into(),
        "fmp4".into(),
        "-hls_flags".into(),
        "independent_segments".into(),
        // A dub that starts late in the MKV keeps that delay only in the
        // init's edit list, which MSE ignores; frag_discont writes it into
        // each fragment's tfdt, so the track plays where it was muxed.
        "-hls_segment_options".into(),
        "movflags=+frag_discont".into(),
        "-master_pl_name".into(),
        format!("{prefix}master.m3u8"),
        "-hls_segment_filename".into(),
        format!("{sink_base}/{prefix}cs_%v_%d.m4s"),
        "-hls_fmp4_init_filename".into(),
        format!("{prefix}cinit_%v.mp4"),
        "-var_stream_map".into(),
        var_map.join(" "),
        "-method".into(),
        "PUT".into(),
        "-http_persistent".into(),
        "1".into(),
        format!("{sink_base}/{prefix}client_stream_%v.m3u8"),
    ]);
    args
}

fn safe_language(language: &str) -> String {
    let cleaned: String = language
        .chars()
        .filter(|c| c.is_ascii_alphanumeric())
        .take(8)
        .collect();
    if cleaned.is_empty() { "und".into() } else { cleaned }
}

#[cfg(test)]
mod tests {
    use super::*;

    const PROBE: &str = r#"{
      "streams": [
        {"codec_type":"video","codec_name":"h264"},
        {"codec_type":"audio","codec_name":"aac","channels":2,"tags":{"language":"eng"}},
        {"codec_type":"audio","codec_name":"ac3","channels":6,"tags":{"language":"por"}}
      ],
      "format": {"duration":"634.500"}
    }"#;

    #[test]
    fn plans_copy_and_convert_by_the_matrix() {
        let plan = plan_streams(PROBE).unwrap();
        assert_eq!(plan.video_codec, "h264");
        assert_eq!(plan.duration_ms, 634_500);
        assert_eq!(plan.audios.len(), 2);
        assert_eq!(plan.audios[0].action, AudioAction::Copy);
        assert_eq!(plan.audios[1].action, AudioAction::ConvertAac);
    }

    #[test]
    fn converts_truehd_and_the_lossless_neighbours() {
        for codec in ["truehd", "mlp", "pcm_bluray", "pcm_s24le"] {
            let probe = PROBE.replace("\"ac3\"", &format!("{codec:?}"));
            let plan = plan_streams(&probe).unwrap_or_else(|e| panic!("{codec} rejected: {e}"));
            assert_eq!(plan.audios[1].action, AudioAction::ConvertAac, "{codec}");
        }
    }

    #[test]
    fn skips_the_unplayable_track_instead_of_losing_the_file() {
        let exotic = PROBE.replace("\"ac3\"", "\"nellymoser\"");
        let plan = plan_streams(&exotic).unwrap();
        assert_eq!(plan.audios.len(), 1, "the good track survives alone");
        assert_eq!(plan.audios[0].codec, "aac");
        assert_eq!(plan.audios[0].input_index, 0);

        let wide = PROBE.replace("\"channels\":6", "\"channels\":10");
        let plan = plan_streams(&wide).unwrap();
        assert_eq!(plan.audios.len(), 1);

        // A skipped track must not shift the ffmpeg mapping of the ones after it.
        let first_bad = PROBE.replace("\"aac\"", "\"nellymoser\"");
        let plan = plan_streams(&first_bad).unwrap();
        assert_eq!(plan.audios.len(), 1);
        assert_eq!(plan.audios[0].codec, "ac3");
        assert_eq!(plan.audios[0].input_index, 1, "the ac3 is still the second audio stream of the input");
    }

    #[test]
    fn refuses_a_source_with_no_usable_audio() {
        let none = PROBE.replace("\"aac\"", "\"nellymoser\"").replace("\"ac3\"", "\"nellymoser\"");
        let err = plan_streams(&none).unwrap_err().to_string();
        assert!(err.contains("audio"), "{err}");
    }

    #[test]
    fn converted_audio_is_downmixed_to_stereo() {
        let plan = plan_streams(PROBE).unwrap();
        let args = ffmpeg_args(&["in".into()], "http://sink", "", &plan, Start::ZERO, None, None);
        let joined = args.join(" ");
        assert!(joined.contains("aformat=channel_layouts=stereo"), "{joined}");
        assert!(joined.contains("160000"), "{joined}");
        assert!(!joined.contains("384000"), "{joined}");
    }

    #[test]
    fn refuses_unlisted_video_clearly() {
        let mpeg2 = PROBE.replace("h264", "mpeg2video");
        assert!(plan_streams(&mpeg2).unwrap_err().to_string().contains("matrix"));
    }

    #[test]
    fn av1_and_vp9_copy_and_carry_a_codecs_string() {
        let av1 = PROBE.replace(
            r#"{"codec_type":"video","codec_name":"h264"}"#,
            r#"{"codec_type":"video","codec_name":"av1","profile":"Main","level":1,"pix_fmt":"yuv420p10le"}"#,
        );
        let plan = plan_streams(&av1).unwrap();
        assert_eq!(plan.video_codec, "av1");
        assert_eq!(plan.video_codecs.as_deref(), Some("av01.0.01M.10"));

        let vp9 = PROBE.replace(
            r#"{"codec_type":"video","codec_name":"h264"}"#,
            r#"{"codec_type":"video","codec_name":"vp9","profile":"Profile0","level":-99,"pix_fmt":"yuv420p"}"#,
        );
        let plan = plan_streams(&vp9).unwrap();
        assert_eq!(plan.video_codecs.as_deref(), Some("vp09.00.10.08"));

        let plan = plan_streams(PROBE).unwrap();
        assert_eq!(plan.video_codecs, None, "avc is read off the init segment; the master stays as it was");
    }

    #[test]
    fn duration_can_come_from_mkv_tags() {
        let probe = r#"{
          "streams": [
            {"codec_type":"video","codec_name":"hevc","tags":{"DURATION":"00:41:59.940000000"}}
          ]
        }"#;
        let plan = plan_streams(probe).unwrap();
        assert_eq!(plan.duration_ms, 2_519_940);
    }

    #[test]
    fn args_name_objects_inside_the_server_grammar() {
        let plan = plan_streams(PROBE).unwrap();
        let args = ffmpeg_args(&["http://127.0.0.1:9/in/c".to_string()], "http://127.0.0.1:9/out/c", "r2_", &plan, Start::seek(61_000, None), None, None);
        let joined = args.join(" ");
        assert!(joined.contains("-ss 61.000"));
        assert!(joined.contains("r2_cs_%v_%d.m4s"));
        assert!(joined.contains("r2_cinit_%v.mp4"));
        assert!(joined.contains("r2_master.m3u8"));
        assert!(joined.ends_with("r2_client_stream_%v.m3u8"));
        assert!(joined.contains("v:0,agroup:aud a:0,agroup:aud,language:eng,default:yes a:1,agroup:aud,language:por"));
        assert!(joined.contains("-c:a:0 copy"));
        assert!(joined.contains("-b:a:1 160000"));
        assert!(joined.contains("-hls_segment_options movflags=+frag_discont"));
    }

    #[test]
    fn converted_audio_uses_the_fast_aac_coder() {
        let plan = plan_streams(PROBE).unwrap();
        let joined = ffmpeg_args(&["http://127.0.0.1:9/in/c".to_string()], "http://127.0.0.1:9/out/c", "", &plan, Start::ZERO, None, None).join(" ");
        assert!(joined.contains("-c:a:1 aac -aac_coder:a:1 fast"));
        assert!(!joined.contains("-aac_coder:a:0"), "a copied track has no coder");
    }

    #[test]
    fn every_input_is_opened_with_a_short_probe() {
        let plan = plan_streams(PROBE).unwrap();
        let inputs: Vec<String> = ["v", "a"].iter().map(|s| format!("http://127.0.0.1:9/in/{s}")).collect();
        let joined = ffmpeg_args(&inputs, "http://127.0.0.1:9/out/c", "", &plan, Start::ZERO, None, None).join(" ");
        for input in &inputs {
            assert!(joined.contains(&format!("-probesize 2000000 -analyzeduration 2000000 -protocol_whitelist http,tcp -i {input}")));
        }
    }

    fn args_with(plan: &SourcePlan, low: Option<Encoder>) -> String {
        ffmpeg_args(&["http://127.0.0.1:9/in/c".to_string()], "http://127.0.0.1:9/out/c", "r2_", plan, Start::ZERO, None, low).join(" ")
    }

    #[test]
    fn the_480p_variant_comes_after_the_audio_and_follows_the_source_keyframes() {
        let plan = plan_streams(PROBE).unwrap();
        assert_eq!(low_variant(&plan), 3);
        let joined = args_with(&plan, Some(Encoder::X264));
        assert!(joined.contains("-map 0:a:1 -c:a:1 aac"));
        assert!(joined.contains("-map 0:v:0 -c:v:1 libx264 -preset:v:1 superfast"));
        assert!(joined.contains("-filter:v:1 scale=-2:'min(480,ih)'"));
        assert!(joined.contains("-force_key_frames:v:1 source"));
        assert!(joined.contains("-pix_fmt:v:1 yuv420p"));
        assert!(joined.contains("a:1,agroup:aud,language:por v:1,agroup:aud -method"));
        assert!(joined.contains("-c:v:0 copy -copypriorss:v:0 0"));
    }

    #[test]
    fn the_480p_variant_can_be_encoded_by_videotoolbox() {
        let plan = plan_streams(PROBE).unwrap();
        let joined = args_with(&plan, Some(Encoder::VideoToolbox));
        assert!(joined.contains("-c:v:1 h264_videotoolbox"));
        assert!(!joined.contains("superfast"));
        assert!(joined.contains("-force_key_frames:v:1 source"));
        assert_eq!(Encoder::from_name("h264_videotoolbox"), Some(Encoder::VideoToolbox));
        assert_eq!(Encoder::from_name("libx264"), Some(Encoder::X264));
        assert_eq!(Encoder::from_name("nvenc"), None);
    }

    #[test]
    fn without_renditions_there_is_one_video_variant() {
        let plan = plan_streams(PROBE).unwrap();
        let joined = args_with(&plan, None);
        assert_eq!(joined.matches("-map 0:v:0").count(), 1);
        assert!(!joined.contains("v:1"));
        assert!(!joined.contains("copypriorss"));
    }

    fn sized(width: u32, height: u32) -> SourcePlan {
        let probe = PROBE.replace(
            r#"{"codec_type":"video","codec_name":"h264"}"#,
            &format!(r#"{{"codec_type":"video","codec_name":"h264","width":{width},"height":{height}}}"#),
        );
        plan_streams(&probe).unwrap()
    }

    // The size FFmpeg's scale=-2:'min(480,ih)' gives the 480p variant.
    #[test]
    fn the_480p_size_keeps_the_source_aspect() {
        assert_eq!(sized(1920, 1080).video_size, Some((1920, 1080)));
        assert_eq!(low_resolution(&sized(1920, 1080)), Some((854, 480)));
        assert_eq!(low_resolution(&sized(1920, 800)), Some((1152, 480)));
        assert_eq!(low_resolution(&sized(1440, 1080)), Some((640, 480)));
        assert_eq!(low_resolution(&sized(640, 360)), Some((640, 360)), "never scaled up");
        assert_eq!(low_resolution(&plan_streams(PROBE).unwrap()), None, "no size probed");
    }

    #[test]
    fn the_480p_variant_is_main_at_level_3_1_on_either_encoder() {
        let plan = plan_streams(PROBE).unwrap();
        for encoder in [Encoder::X264, Encoder::VideoToolbox] {
            let joined = args_with(&plan, Some(encoder));
            assert!(joined.contains("-profile:v:1 main"), "{joined}");
            assert_eq!(joined.matches("-level:v:1 3.1").count(), 1, "{joined}");
        }
    }

    #[test]
    fn first_frame_pts_reads_ffprobe_frames() {
        let json = r#"{"frames":[{"pts_time":"1077.577000"},{"pts_time":"1081.0"}]}"#;
        assert_eq!(first_frame_pts(json), Some(1077.577));
        assert_eq!(first_frame_pts("{}"), None);
    }

    #[test]
    fn a_run_starts_on_the_keyframe_at_or_before_the_target() {
        assert_eq!(Start::seek(0, Some(3.0)), Start::ZERO);
        assert_eq!(Start::seek(61_000, Some(59.5)), Start { seconds: 59.5, offset_ms: 59_500, on_keyframe: true });
        let unconfirmed = Start { seconds: 61.0, offset_ms: 61_000, on_keyframe: false };
        assert_eq!(Start::seek(61_000, Some(64.0)), unconfirmed, "never later than asked");
        assert_eq!(Start::seek(61_000, None), unconfirmed, "no keyframe found: the target itself");
        assert_eq!(Start::seek(61_000, Some(0.0)), unconfirmed);
    }

    fn seek_args(plan: &SourcePlan, start: Start) -> String {
        ffmpeg_args(&["http://127.0.0.1:9/in/c".to_string()], "http://127.0.0.1:9/out/c", "r2_", plan, start, None, Some(Encoder::X264)).join(" ")
    }

    // Without a keyframe under the seek the copy and the encoder start at
    // different frames, and the variants would cut different segments.
    #[test]
    fn a_seek_without_a_confirmed_keyframe_writes_no_480p() {
        let plan = plan_streams(PROBE).unwrap();
        for start in [Start::seek(61_000, None), Start::seek(61_000, Some(64.0))] {
            assert_eq!(start.low(Some(Encoder::X264)), None);
            let joined = seek_args(&plan, start);
            assert!(!joined.contains("v:1"), "{joined}");
            assert!(!joined.contains("copypriorss"), "{joined}");
        }
    }

    #[test]
    fn a_seek_onto_a_keyframe_keeps_the_480p_aligned() {
        let plan = plan_streams(PROBE).unwrap();
        let start = Start::seek(61_000, Some(59.5));
        assert_eq!(start.low(Some(Encoder::X264)), Some(Encoder::X264));
        let joined = seek_args(&plan, start);
        assert!(joined.contains("-ss 59.500"));
        assert!(joined.contains("-c:v:0 copy -copypriorss:v:0 0"));
        assert!(joined.contains("-c:v:1 libx264"));
    }

    #[test]
    fn hevc_tagging_stays_on_the_copied_variant() {
        let hevc = PROBE.replace(r#""codec_name":"h264""#, r#""codec_name":"hevc""#);
        let plan = plan_streams(&hevc).unwrap();
        let joined = args_with(&plan, Some(Encoder::X264));
        assert!(joined.contains("-tag:v:0 hvc1"));
        assert!(!joined.contains("-tag:v hvc1"));
    }

    #[test]
    fn subtitle_streams_keep_their_stream_order() {
        let probe = r#"{
          "streams": [
            {"codec_type":"video","codec_name":"h264"},
            {"codec_type":"subtitle","codec_name":"hdmv_pgs_subtitle","tags":{"language":"eng"}},
            {"codec_type":"subtitle","codec_name":"ass","tags":{"language":"por","title":"Português"}},
            {"codec_type":"subtitle","codec_name":"subrip"},
            {"codec_type":"attachment","codec_name":"ttf","tags":{"filename":"a.ttf"}}
          ],
          "format": {"duration":"10"}
        }"#;
        let plan = plan_streams(probe).unwrap();
        assert_eq!(plan.bitmap_subtitles, 1);
        assert_eq!(plan.attachments, 1);
        assert_eq!(plan.subtitles.len(), 2);
        assert_eq!(plan.subtitles[0], SubtitleTrack { input_index: 1, codec: "ass".into(), language: "por".into(), title: "Português".into() });
        assert_eq!(plan.subtitles[1].input_index, 2);
        assert_eq!(plan.subtitles[1].language, "und");
    }

    #[test]
    fn separate_streams_map_each_input_once() {
        let mut plan = plan_streams(PROBE).unwrap();
        plan.audios[0].input_file = 1;
        plan.audios[0].input_index = 0;
        plan.audios[1].input_file = 2;
        plan.audios[1].input_index = 0;
        let inputs: Vec<String> = ["v", "a1", "a2"].iter().map(|s| format!("http://127.0.0.1:9/in/{s}")).collect();
        let args = ffmpeg_args(&inputs, "http://127.0.0.1:9/out/c", "", &plan, Start::ZERO, None, None);
        let joined = args.join(" ");
        assert_eq!(joined.matches(" -i ").count(), 3);
        assert!(joined.contains("-map 0:v:0"));
        assert!(joined.contains("-map 1:a:0"));
        assert!(joined.contains("-map 2:a:0"));
        assert!(!joined.contains("-ss"));
    }

    #[test]
    fn region_prefixes() {
        assert_eq!(region_prefix(0), "");
        assert_eq!(region_prefix(3), "r3_");
    }
}

#[cfg(test)]
mod chapter_tests {
    use super::*;

    #[test]
    fn chapters_come_from_ffprobe_in_order_with_fallback_titles() {
        let json = r#"{"streams":[{"codec_type":"video","codec_name":"h264"}],"format":{"duration":"100"},
            "chapters":[{"start_time":"0.000000","end_time":"10.5","tags":{"title":" Intro "}},
                        {"start_time":"10.5","end_time":"10.5"},
                        {"start_time":"10.5","end_time":"99.0"}]}"#;
        let plan = plan_streams(json).unwrap();
        assert_eq!(plan.chapters, vec![
            Chapter { start_ms: 0, end_ms: 10_500, title: "Intro".into() },
            Chapter { start_ms: 10_500, end_ms: 99_000, title: "3".into() },
        ]);
    }
}
