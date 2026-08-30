use anyhow::{bail, Context};
use serde::Deserialize;

/// The explicit codec matrix, mirrored from internal/remux. Nothing outside
/// it is accepted by analogy: an unlisted codec is a clear refusal, never a
/// hidden transcode.

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

#[derive(Debug, Clone)]
#[allow(dead_code)]
pub struct SourcePlan {
    pub video_codec: String,
    pub audios: Vec<AudioTrack>,
    pub duration_ms: u64,
}

#[derive(Deserialize)]
struct ProbeDoc {
    #[serde(default)]
    streams: Vec<ProbeStream>,
    #[serde(default)]
    format: Option<ProbeFormat>,
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
    #[serde(default, rename = "DURATION")]
    duration: Option<String>,
}

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
        "ac3" | "dts" | "dca" => Ok(AudioAction::ConvertAac { bitrate: aac_bitrate(channels) }),
        other => bail!("audio codec {other:?} has no matrix entry"),
    }
}

fn parse_mkv_duration(tag: &str) -> Option<u64> {
    // 00:41:59.940000000
    let mut parts = tag.split(':');
    let h: u64 = parts.next()?.parse().ok()?;
    let m: u64 = parts.next()?.parse().ok()?;
    let s: f64 = parts.next()?.parse().ok()?;
    Some(((h * 3600 + m * 60) as f64 * 1000.0 + s * 1000.0) as u64)
}

pub fn plan_streams(probe_json: &str) -> anyhow::Result<SourcePlan> {
    let doc: ProbeDoc = serde_json::from_str(probe_json).context("ffprobe output")?;
    let mut video_codec = None;
    let mut audios = Vec::new();
    let mut audio_index = 0usize;
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
    Ok(SourcePlan { video_codec, audios, duration_ms })
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
    // The input is the loopback bridge and nothing else: only http, no
    // redirects off the box, and a probe bounded rather than unbounded.
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
        "0".into(),
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
        let opus = PROBE.replace("\"ac3\"", "\"opus\"");
        assert!(plan_streams(&opus).unwrap_err().to_string().contains("matrix"));
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
    fn region_prefixes() {
        assert_eq!(region_prefix(0), "");
        assert_eq!(region_prefix(3), "r3_");
    }
}
