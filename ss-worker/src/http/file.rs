use std::sync::Arc;

use axum::extract::{Path, State};
use axum::http::{header, StatusCode};
use axum::response::{IntoResponse, Response};

use super::{fail, AppState};
use crate::engine::{Prio, MAX_SIDECAR};

/// GET /v1/file/{ticket}/{index}: a sidecar subtitle beside the ticket's
/// video, whole. Capped small; anything bigger is not a subtitle.
pub async fn get(State(state): State<Arc<AppState>>, Path((ticket, index)): Path<(String, usize)>) -> Response {
    let ticket = match state.verify(&ticket) {
        Ok(t) => t,
        Err(e) => return fail(StatusCode::UNAUTHORIZED, "*", &e.to_string()),
    };
    let aud = ticket.audience.clone();
    let (size, name) = match (
        state.engine.file_size(&ticket.infohash, index),
        state.engine.file_name(&ticket.infohash, index),
    ) {
        (Ok(s), Ok(n)) => (s, n),
        _ => return fail(StatusCode::NOT_FOUND, &aud, "unknown file"),
    };
    if size == 0 || size > MAX_SIDECAR || !crate::engine::is_sidecar(&name, size) {
        return fail(StatusCode::FORBIDDEN, &aud, "not a sidecar");
    }
    let mut reader = match state.engine.open(&ticket.infohash, &ticket.room_id, index, 0, Prio::Head).await {
        Ok(r) => r,
        Err(e) => return fail(StatusCode::SERVICE_UNAVAILABLE, &aud, &format!("open: {e:#}")),
    };
    let mut out = Vec::with_capacity(size as usize);
    let mut buf = vec![0u8; 256 * 1024];
    let deadline = tokio::time::Instant::now() + state.engine.cfg.first_byte_deadline * 2;
    while (out.len() as u64) < size {
        let read = tokio::time::timeout_at(deadline, reader.read(&mut buf)).await;
        match read {
            Ok(Ok(0)) => break,
            Ok(Ok(n)) => out.extend_from_slice(&buf[..n]),
            Ok(Err(e)) => return fail(StatusCode::SERVICE_UNAVAILABLE, &aud, &format!("read: {e:#}")),
            Err(_) => return fail(StatusCode::GATEWAY_TIMEOUT, &aud, "waiting on the swarm"),
        }
    }
    let mut response = (StatusCode::OK, [(header::CONTENT_TYPE, "application/octet-stream")], out).into_response();
    super::cors::apply(&mut response, &aud);
    response
}
