use std::sync::Arc;

use axum::body::Body;
use axum::extract::{Path, State};
use axum::http::{HeaderMap, Method, StatusCode, Uri};
use axum::response::{IntoResponse, Response};

/// The fleet's front door. A worker on a private network never shows the
/// browser its address: the site points readers here instead, and this
/// worker forwards the exchange to the app, which routes it to the sibling.
pub struct Relay {
    pub upstream: String,
    client: reqwest::Client,
}

impl Relay {
    pub fn new(upstream: String) -> Self {
        Self {
            upstream: upstream.trim_end_matches('/').to_string(),
            client: reqwest::Client::builder().build().expect("relay client"),
        }
    }
}

const FORWARDED_REQUEST_HEADERS: &[&str] = &["range", "content-type", "origin", "accept"];

pub async fn any(
    State(state): State<Arc<super::AppState>>,
    Path(path): Path<String>,
    method: Method,
    uri: Uri,
    headers: HeaderMap,
    body: axum::body::Bytes,
) -> Response {
    let Some(relay) = &state.relay else {
        return (StatusCode::NOT_FOUND, "no relay here").into_response();
    };
    let query = uri.query().map(|q| format!("?{q}")).unwrap_or_default();
    let url = format!("{}/relay/{}{}", relay.upstream, path, query);
    let mut request = relay.client.request(method, &url);
    for name in FORWARDED_REQUEST_HEADERS {
        if let Some(value) = headers.get(*name) {
            request = request.header(*name, value);
        }
    }
    if !body.is_empty() {
        request = request.body(body);
    }
    let upstream = match request.send().await {
        Ok(r) => r,
        Err(e) => {
            tracing::debug!(error = %e, "relay upstream unreachable");
            return (StatusCode::BAD_GATEWAY, "relay upstream unreachable").into_response();
        }
    };
    let status = StatusCode::from_u16(upstream.status().as_u16()).unwrap_or(StatusCode::BAD_GATEWAY);
    let mut response = Response::builder().status(status);
    if let Some(headers_mut) = response.headers_mut() {
        for (name, value) in upstream.headers() {
            if matches!(name.as_str(), "connection" | "transfer-encoding" | "keep-alive" | "upgrade") {
                continue;
            }
            headers_mut.insert(name.clone(), value.clone());
        }
    }
    response
        .body(Body::from_stream(upstream.bytes_stream()))
        .unwrap_or_else(|_| (StatusCode::BAD_GATEWAY, "relay body").into_response())
}
