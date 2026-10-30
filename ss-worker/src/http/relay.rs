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

/// The upstream URL for a relayed path. The path arrives percent-decoded,
/// and a dot segment in it would resolve out of the upstream's /relay/.
fn relay_url(upstream: &str, path: &str, query: Option<&str>) -> Option<String> {
    if path.split(['/', '\\']).any(|segment| segment == "." || segment == "..") {
        return None;
    }
    let query = query.map(|q| format!("?{q}")).unwrap_or_default();
    Some(format!("{upstream}/relay/{path}{query}"))
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
    let Some(url) = relay_url(&relay.upstream, &path, uri.query()) else {
        return (StatusCode::BAD_REQUEST, "bad relay path").into_response();
    };
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

#[cfg(test)]
mod tests {
    use super::relay_url;

    #[test]
    fn a_relayed_path_stays_under_the_upstream_relay() {
        assert_eq!(relay_url("http://app", "w1/v1/f/t", Some("prio=head")).as_deref(), Some("http://app/relay/w1/v1/f/t?prio=head"));
        assert_eq!(relay_url("http://app", "../api/rooms", None), None);
        assert_eq!(relay_url("http://app", "w1/../../api", None), None);
        assert_eq!(relay_url("http://app", "w1/./v1", None), None);
        assert_eq!(relay_url("http://app", "w1\\..\\api", None), None);
    }
}
