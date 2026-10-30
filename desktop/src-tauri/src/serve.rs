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

/// Answers one request against the cache at `root`.
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
