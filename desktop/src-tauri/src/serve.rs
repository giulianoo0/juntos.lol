//! The cache as the webview's player reads it: `juntos-media://localhost/<key>/hls/<name>`
//! (or `http://juntos-media.localhost/...` where the platform maps schemes
//! that way), with Range, and open to the site's origin.
use std::path::Path;

use tauri::http::{header, HeaderValue, Response, StatusCode};

pub const SCHEME: &str = "juntos-media";

pub fn content_type(name: &str) -> &'static str {
    if name.ends_with(".m3u8") {
        "application/vnd.apple.mpegurl"
    } else if name.ends_with(".m4s") {
        "video/iso.segment"
    } else {
        "video/mp4"
    }
}

/// WebKit takes a custom scheme for insecure content and will not let an
/// https page read it; marked secure, the site reaches the cache like any
/// other https resource. WebView2 needs nothing: its `*.localhost` is trusted.
pub fn mark_secure(webview: tauri::webview::PlatformWebview) {
    #[cfg(target_os = "macos")]
    unsafe {
        use objc2::runtime::AnyObject;
        use objc2::{msg_send, sel};
        let view = webview.inner() as *mut AnyObject;
        let config: *mut AnyObject = msg_send![view, configuration];
        let pool: *mut AnyObject = msg_send![config, processPool];
        let responds: bool = msg_send![pool, respondsToSelector: sel!(_registerURLSchemeAsSecure:)];
        if !responds {
            tracing::warn!("this WebKit cannot mark the media scheme secure");
            return;
        }
        let scheme = objc2_foundation::NSString::from_str(SCHEME);
        let _: () = msg_send![pool, _registerURLSchemeAsSecure: &*scheme];
    }
    #[cfg(target_os = "linux")]
    {
        use webkit2gtk::{SecurityManagerExt, WebContextExt, WebViewExt};
        if let Some(manager) = webview.inner().context().and_then(|context| context.security_manager()) {
            manager.register_uri_scheme_as_secure(SCHEME);
            manager.register_uri_scheme_as_cors_enabled(SCHEME);
        }
    }
    #[cfg(windows)]
    let _ = webview;
}

/// A region's master as the bucket has it. FFmpeg leaves the video out of its
/// own until it knows the bitrate, which a Matroska source never says, and
/// names region 0's without the `r0_` the player asks for.
fn local_master(path: &Path) -> Option<String> {
    let name = path.file_name()?.to_str()?;
    let region: u64 = if name == "master.m3u8" { 0 } else { name.strip_prefix('r')?.strip_suffix("_master.m3u8")?.parse().ok()? };
    let hls_dir = path.parent()?;
    let meta: crate::local::Meta = serde_json::from_slice(&std::fs::read(hls_dir.parent()?.join("meta.json")).ok()?).ok()?;
    let prefix = ss_remux::plan::region_prefix(region);
    if !meta.regions.iter().any(|r| r.n == region) || !hls_dir.join(crate::hls::playlist_name(&prefix, 0)).exists() {
        return None;
    }
    let info = crate::hls::MasterInfo {
        audio_langs: meta.audio_langs,
        video_codecs: meta.video_codecs,
        bandwidth: 0,
        low_resolution: None,
    };
    Some(crate::hls::master(&prefix, &info, None))
}

pub fn serve(root: &Path, request_path: &str, range: Option<&HeaderValue>) -> Response<Vec<u8>> {
    use std::io::{Read, Seek, SeekFrom};

    let reply = |status: StatusCode| {
        Response::builder()
            .status(status)
            .header(header::ACCESS_CONTROL_ALLOW_ORIGIN, "*")
            .header(header::ACCESS_CONTROL_EXPOSE_HEADERS, "Content-Range, Content-Length, Accept-Ranges")
            .header(header::ACCEPT_RANGES, "bytes")
            .header(header::CACHE_CONTROL, "no-store")
    };
    let empty = |status: StatusCode| reply(status).body(Vec::new()).expect("response");

    let Some(path) = crate::cache::resolve(root, request_path) else { return empty(StatusCode::NOT_FOUND) };
    if let Some(body) = local_master(&path) {
        return reply(StatusCode::OK).header(header::CONTENT_TYPE, content_type("master.m3u8")).body(body.into_bytes()).expect("response");
    }
    let Ok(mut file) = std::fs::File::open(&path) else { return empty(StatusCode::NOT_FOUND) };
    let size = file.metadata().map(|m| m.len()).unwrap_or(0);
    let Ok((start, end)) = ss_remux::range::parse_range(range, size) else {
        return reply(StatusCode::RANGE_NOT_SATISFIABLE)
            .header(header::CONTENT_RANGE, format!("bytes */{size}"))
            .body(Vec::new())
            .expect("response");
    };
    let mut body = vec![0u8; if size == 0 { 0 } else { (end - start + 1) as usize }];
    if file.seek(SeekFrom::Start(start)).and_then(|_| file.read_exact(&mut body)).is_err() {
        return empty(StatusCode::INTERNAL_SERVER_ERROR);
    }
    let name = path.file_name().and_then(|n| n.to_str()).unwrap_or_default();
    let mut builder = reply(if range.is_some() { StatusCode::PARTIAL_CONTENT } else { StatusCode::OK })
        .header(header::CONTENT_TYPE, content_type(name));
    if range.is_some() {
        builder = builder.header(header::CONTENT_RANGE, format!("bytes {start}-{end}/{size}"));
    }
    builder.body(body).expect("response")
}

#[cfg(test)]
mod tests {
    use super::*;

    fn cache() -> tempfile::TempDir {
        let dir = tempfile::tempdir().unwrap();
        std::fs::create_dir_all(dir.path().join("t-1/hls")).unwrap();
        std::fs::write(dir.path().join("t-1/hls/cs_0_0.m4s"), b"0123456789").unwrap();
        std::fs::write(dir.path().join("t-1/hls/master.m3u8"), b"#EXTM3U\n").unwrap();
        std::fs::write(dir.path().join("t-1/meta.json"), b"{}").unwrap();
        dir
    }

    #[test]
    fn whole_file_with_its_type_and_open_to_the_site() {
        let dir = cache();
        let response = serve(dir.path(), "/t-1/hls/master.m3u8", None);
        assert_eq!(response.status(), StatusCode::OK);
        assert_eq!(response.body(), b"#EXTM3U\n");
        assert_eq!(response.headers()[header::CONTENT_TYPE], "application/vnd.apple.mpegurl");
        assert_eq!(response.headers()[header::ACCESS_CONTROL_ALLOW_ORIGIN], "*");
        assert_eq!(response.headers()[header::ACCEPT_RANGES], "bytes");
    }

    #[test]
    fn a_region_master_names_the_video_ffmpeg_left_out() {
        let dir = cache();
        std::fs::write(dir.path().join("t-1/hls/r2_client_stream_0.m3u8"), b"#EXTM3U\n").unwrap();
        std::fs::write(
            dir.path().join("t-1/meta.json"),
            br#"{"key":"t-1","title":"x","durationMs":1,"audioLangs":["jpn"],"videoCodecs":null,"regions":[{"n":2,"startMs":60000,"low":false}]}"#,
        )
        .unwrap();
        let body = serve(dir.path(), "/t-1/hls/r2_master.m3u8", None).into_body();
        let body = String::from_utf8(body).unwrap();
        assert!(body.contains("#EXT-X-STREAM-INF:BANDWIDTH=2000000,AUDIO=\"aud\"\nr2_client_stream_0.m3u8"), "{body}");
        assert!(body.contains("URI=\"r2_client_stream_1.m3u8\""));
        assert_eq!(serve(dir.path(), "/t-1/hls/r0_master.m3u8", None).status(), StatusCode::NOT_FOUND);
    }

    #[test]
    fn a_range_gets_its_slice() {
        let dir = cache();
        let response = serve(dir.path(), "/t-1/hls/cs_0_0.m4s", Some(&HeaderValue::from_static("bytes=2-5")));
        assert_eq!(response.status(), StatusCode::PARTIAL_CONTENT);
        assert_eq!(response.body(), b"2345");
        assert_eq!(response.headers()[header::CONTENT_RANGE], "bytes 2-5/10");
    }

    #[test]
    fn an_unsatisfiable_range_is_416() {
        let dir = cache();
        let response = serve(dir.path(), "/t-1/hls/cs_0_0.m4s", Some(&HeaderValue::from_static("bytes=20-")));
        assert_eq!(response.status(), StatusCode::RANGE_NOT_SATISFIABLE);
        assert_eq!(response.headers()[header::CONTENT_RANGE], "bytes */10");
    }

    #[test]
    fn missing_and_outside_paths_are_404() {
        let dir = cache();
        assert_eq!(serve(dir.path(), "/t-1/hls/cs_0_9.m4s", None).status(), StatusCode::NOT_FOUND);
        assert_eq!(serve(dir.path(), "/t-1/meta.json", None).status(), StatusCode::NOT_FOUND);
        assert_eq!(serve(dir.path(), "/t-1/hls/../meta.json", None).status(), StatusCode::NOT_FOUND);
    }
}
