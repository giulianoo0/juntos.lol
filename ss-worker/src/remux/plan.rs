use anyhow::{bail, Context};
use serde::Deserialize;

/// The explicit codec matrix, mirrored from internal/remux: an unlisted
/// codec is a clear refusal, never a hidden transcode.

#[derive(Debug, Clone, PartialEq)]
pub enum AudioAction {
    Copy,
    ConvertAac { bitrate: u32 },
}

#[derive(Debug, Clone)]
#[allow(dead_code)]
pub struct AudioTrack {
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

fn aac_bitrate(channels: u32) -> u32 {
    if channels <= 2 { 160_000 } else { 384_000 }
}

fn audio_action(codec: &str, channels: u32) -> anyhow::Result<AudioAction> {
    if channels == 0 || channels > MAX_AUDIO_CHANNELS {
        bail!("audio layout with {channels} channels is outside the supported range");
    }
    match codec {
        "aac" => Ok(AudioAction::Copy),
        "ac3" | "eac3" | "dts" | "dca" | "opus" | "flac" | "mp3" | "vorbis" => Ok(AudioAction::ConvertAac { bitrate: aac_bitrate(channels) }),
        other => bail!("audio codec {other:?} has no matrix entry"),
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
                    "h264" | "hevc" => video_codec = Some(codec),
                    other => bail!("video codec {other:?} has no matrix entry"),
                }
            }
            Some("audio") => {
                let codec = stream.codec_name.clone().unwrap_or_default();
                let channels = stream.channels.unwrap_or(0);
                let action = audio_action(&codec, channels)?;
                audios.push(AudioTrack {
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
    if duration_ms == 0 {
        bail!("source reports no usable duration");
    }
    Ok(SourcePlan { video_codec, audios, duration_ms, subtitles, bitmap_subtitles, attachments,
        chapters,
    })
}

/// Output names mirror the client pipeline's grammar exactly: the server's
/// allowlist is the authorization, so a name outside it never gets signed.
pub fn region_prefix(region: u64) -> String {
    if region == 0 { String::new() } else { format!("r{region}_") }
}

/// FFmpeg argv for one run: video copied, audio per the matrix, HLS fMP4 in
/// 4-second target segments, every output PUT to the loopback sink.
pub fn ffmpeg_args(
    input_url: &str,
    sink_base: &str,
    prefix: &str,
    plan: &SourcePlan,
    start_seconds: f64,
    end_seconds: Option<f64>,
) -> Vec<String> {
    let mut args: Vec<String> = vec![
        "-nostdin".into(),
        "-hide_banner".into(),
        "-loglevel".into(),
        "error".into(),
        "-progress".into(),
        "pipe:1".into(),
    ];
    if start_seconds > 0.0 {
        args.extend(["-ss".into(), format!("{start_seconds:.3}")]);
    }
    if let Some(end) = end_seconds {
        args.extend(["-to".into(), format!("{end:.3}")]);
    }
    args.extend([
        "-protocol_whitelist".into(),
        "http,tcp".into(),
        "-i".into(),
        input_url.into(),
        "-map".into(),
        "0:v:0".into(),
        "-c:v".into(),
        "copy".into(),
    ]);
    if plan.video_codec == "hevc" {
        args.extend(["-tag:v".into(), "hvc1".into()]);
    }
    let mut var_map = vec!["v:0,agroup:aud".to_string()];
    for (out_index, audio) in plan.audios.iter().enumerate() {
        args.extend(["-map".into(), format!("0:a:{}", audio.input_index)]);
        match &audio.action {
            AudioAction::Copy => args.extend([format!("-c:a:{out_index}"), "copy".into()]),
            AudioAction::ConvertAac { bitrate } => args.extend([
                format!("-c:a:{out_index}"),
                "aac".into(),
                format!("-b:a:{out_index}"),
                bitrate.to_string(),
                format!("-filter:a:{out_index}"),
                "aformat=channel_layouts=7.1|5.1|stereo|mono".into(),
            ]),
        }
        var_map.push(format!(
            "a:{out_index},agroup:aud,language:{}{}",
            safe_language(&audio.language),
            if out_index == 0 { ",default:yes" } else { "" },
        ));
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
        assert_eq!(plan.audios[1].action, AudioAction::ConvertAac { bitrate: 384_000 });
    }

    #[test]
    fn refuses_unlisted_codecs_clearly() {
        let vp9 = PROBE.replace("h264", "vp9");
        assert!(plan_streams(&vp9).unwrap_err().to_string().contains("matrix"));
        let truehd = PROBE.replace("\"ac3\"", "\"truehd\"");
        assert!(plan_streams(&truehd).unwrap_err().to_string().contains("matrix"));
        let wide = PROBE.replace("\"channels\":6", "\"channels\":10");
        assert!(plan_streams(&wide).unwrap_err().to_string().contains("channels"));
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
        let args = ffmpeg_args("http://127.0.0.1:9/in/c", "http://127.0.0.1:9/out/c", "r2_", &plan, 61.0, None);
        let joined = args.join(" ");
        assert!(joined.contains("-ss 61.000"));
        assert!(joined.contains("r2_cs_%v_%d.m4s"));
        assert!(joined.contains("r2_cinit_%v.mp4"));
        assert!(joined.contains("r2_master.m3u8"));
        assert!(joined.ends_with("r2_client_stream_%v.m3u8"));
        assert!(joined.contains("v:0,agroup:aud a:0,agroup:aud,language:eng,default:yes a:1,agroup:aud,language:por"));
        assert!(joined.contains("-c:a:0 copy"));
        assert!(joined.contains("-c:a:1 aac -b:a:1 384000"));
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
