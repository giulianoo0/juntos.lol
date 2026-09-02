use axum::http::{header, HeaderValue, Response};

pub fn apply<B>(response: &mut Response<B>, audience: &str) {
    let headers = response.headers_mut();
    if let Ok(origin) = HeaderValue::from_str(audience) {
        headers.insert(header::ACCESS_CONTROL_ALLOW_ORIGIN, origin);
    }
    headers.insert(header::VARY, HeaderValue::from_static("Origin"));
    headers.insert(
        header::ACCESS_CONTROL_EXPOSE_HEADERS,
        HeaderValue::from_static("Content-Range, Accept-Ranges, Content-Length, X-Bitfield-Len, X-Piece-Length"),
    );
    headers.insert(header::ACCESS_CONTROL_ALLOW_METHODS, HeaderValue::from_static("GET, HEAD, POST, OPTIONS"));
    headers.insert(header::ACCESS_CONTROL_ALLOW_HEADERS, HeaderValue::from_static("Range, Content-Type"));
    headers.insert(header::ACCESS_CONTROL_MAX_AGE, HeaderValue::from_static("600"));
    headers.insert(header::CACHE_CONTROL, HeaderValue::from_static("no-store"));
}
