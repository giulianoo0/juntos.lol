//! Which renditions of a live on the air are put on the relay.
use crate::{Error, Format, Info};

const MAX_HEIGHT: u32 = 1080;

/// The renditions a live is taken from: one H.264 video playlist and, when
/// the live offers one apart, the best audio playlist.
#[derive(Clone, Debug)]
pub struct Selection {
    pub video: Format,
    pub audio: Option<Format>,
}

fn is_hls(format: &Format) -> bool {
    format
        .protocol
        .as_deref()
        .map(|p| p.starts_with("m3u8"))
        .unwrap_or(false)
        && format.url.is_some()
        && format.has_drm != Some(true)
}

fn bitrate(format: &Format) -> u64 {
    format
        .abr
        .or(format.tbr)
        .map(|b| (b * 1000.0) as u64)
        .unwrap_or(0)
}

/// Picks the tallest H.264 rendition up to 1080p and the richest audio one.
/// Only a live that is on the air qualifies: an announced one has nothing to
/// read yet, and a finished one is a recording the VOD path serves.
pub fn select(info: &Info) -> Result<Selection, Error> {
    match info.live_status.as_deref() {
        Some("is_upcoming") => {
            return Err(Error::Unavailable("the live has not started yet".into()))
        }
        _ if info.is_live == Some(true) || info.live_status.as_deref() == Some("is_live") => {}
        _ => return Err(Error::Unsupported("not a live stream".into())),
    }
    let video = info
        .formats
        .iter()
        .filter(|f| {
            is_hls(f)
                && f.vcodec
                    .as_deref()
                    .map(|v| v.starts_with("avc1"))
                    .unwrap_or(false)
        })
        .filter(|f| f.height.unwrap_or(0) <= MAX_HEIGHT)
        .max_by(|a, b| {
            a.height
                .cmp(&b.height)
                .then_with(|| bitrate(a).cmp(&bitrate(b)))
        })
        .cloned()
        .ok_or_else(|| Error::Unsupported("the live has no H.264 rendition".into()))?;
    let audio = info
        .formats
        .iter()
        .filter(|f| is_hls(f) && crate::is_none(&f.vcodec))
        .max_by(|a, b| {
            bitrate(a)
                .cmp(&bitrate(b))
                .then_with(|| numeric(&a.format_id).cmp(&numeric(&b.format_id)))
        })
        .cloned();
    Ok(Selection { video, audio })
}

fn numeric(id: &str) -> u64 {
    id.parse().unwrap_or(0)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn fixture() -> Info {
        serde_json::from_str(include_str!("../tests/fixtures/live.json")).unwrap()
    }

    #[test]
    fn picks_1080p_h264_and_the_richest_audio() {
        let picked = select(&fixture()).unwrap();
        assert_eq!(picked.video.format_id, "270");
        assert_eq!(picked.video.height, Some(1080));
        assert_eq!(
            picked.audio.as_ref().map(|a| a.format_id.as_str()),
            Some("234")
        );
    }

    #[test]
    fn refuses_what_is_not_on_the_air() {
        let mut info = fixture();
        info.is_live = Some(false);
        info.live_status = Some("was_live".into());
        assert_eq!(select(&info).unwrap_err().code(), "youtube_unsupported");
        info.live_status = Some("is_upcoming".into());
        assert_eq!(select(&info).unwrap_err().code(), "youtube_unavailable");
    }
}
