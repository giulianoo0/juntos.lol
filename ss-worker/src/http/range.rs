use std::sync::atomic::Ordering;
use std::sync::Arc;
use std::time::Duration;

use axum::body::Body;
use axum::extract::{Path, Query, State};
use axum::http::{header, HeaderMap, HeaderValue, StatusCode};
use axum::response::{IntoResponse, Response};
use serde::Deserialize;
use tokio::sync::mpsc;

use super::{fail, AppState};
use crate::engine::{Prio, Reader};

#[derive(Deserialize, Default)]
pub struct RangeQuery {
    pub prio: Option<String>,
    pub gen: Option<u64>,
}

/// RFC 9110 single-range parsing: an end past the size is clamped, a start
/// at or past the size is unsatisfiable, and `bytes=-N` means the tail.
pub fn parse_range(value: Option<&HeaderValue>, size: u64) -> Result<(u64, u64), ()> {
    let Some(value) = value.and_then(|v| v.to_str().ok()) else { return Ok((0, size.saturating_sub(1))) };
    let spec = value.strip_prefix("bytes=").ok_or(())?;
    let (a, b) = spec.split_once('-').ok_or(())?;
    if a.is_empty() {
        let n: u64 = b.parse().map_err(|_| ())?;
        if n == 0 {
            return Err(());
        }
        return Ok((size.saturating_sub(n), size.saturating_sub(1)));
    }
    let start: u64 = a.parse().map_err(|_| ())?;
    if start >= size {
        return Err(());
    }
    let end = if b.is_empty() { size - 1 } else { b.parse::<u64>().map_err(|_| ())?.min(size - 1) };
    if end < start {
        return Err(());
    }
    Ok((start, end))
}

/// GET /v1/f/{ticket}: bytes of the ticket's file, streamed as the pieces
/// arrive. A response promises at most `response_cap` bytes and says so in
/// Content-Range; the client asks for the rest. Nothing is buffered.
pub async fn get(
    State(state): State<Arc<AppState>>,
    Path(ticket): Path<String>,
    Query(query): Query<RangeQuery>,
    headers: HeaderMap,
) -> Response {
    let ticket = match state.verify(&ticket) {
        Ok(t) => t,
        Err(e) => return fail(StatusCode::UNAUTHORIZED, "*", &e.to_string()),
    };
    let aud = ticket.audience.clone();
    let size = match state.engine.file_size(&ticket.infohash, ticket.file_index) {
        Ok(s) => s,
        Err(_) => return fail(StatusCode::NOT_FOUND, &aud, "unknown file"),
    };
    let (start, end) = match parse_range(headers.get(header::RANGE), size) {
        Ok(r) => r,
        Err(()) => {
            let mut r = fail(StatusCode::RANGE_NOT_SATISFIABLE, &aud, "range");
            r.headers_mut().insert(header::CONTENT_RANGE, HeaderValue::from_str(&format!("bytes */{size}")).unwrap());
            return r;
        }
    };
    let end = end.min(start + state.engine.cfg.response_cap - 1);
    let len = end - start + 1;
    let prio = Prio::parse(query.prio.as_deref());
    // A request that names no generation is never superseded by a hint.
    let gen = query.gen.unwrap_or(u64::MAX);
    state.metrics.range_requests.fetch_add(1, Ordering::Relaxed);

    let reader = match state.engine.open(&ticket.infohash, ticket.file_index, start, prio).await {
        Ok(r) => r,
        Err(e) => {
            tracing::info!(infohash = %ticket.infohash, error = %format!("{e:#}"), "range open refused");
            return fail(StatusCode::SERVICE_UNAVAILABLE, &aud, &format!("open: {e:#}"));
        }
    };
    let (tx, mut rx) = mpsc::channel::<bytes::Bytes>(4);
    let chunk = state.engine.read_chunk_size();
    let stall = state.engine.cfg.stall_deadline;
    let first_byte = state.engine.cfg.first_byte_deadline + Duration::from_secs(1);
    let metrics = state.metrics.clone();
    tokio::spawn(pump(reader, len, chunk, first_byte, stall, gen, tx, metrics));

    // Headers wait for the first chunk: a piece nobody has yet is a 504 the
    // client waits out on its own budget, not a silent open body.
    let first = match tokio::time::timeout(state.engine.cfg.first_byte_deadline, rx.recv()).await {
        Ok(Some(chunk)) => chunk,
        Ok(None) => return fail(StatusCode::SERVICE_UNAVAILABLE, &aud, "read ended before first byte"),
        Err(_) => {
            state.metrics.first_byte_timeouts.fetch_add(1, Ordering::Relaxed);
            return fail(StatusCode::GATEWAY_TIMEOUT, &aud, "waiting on the swarm");
        }
    };
    let stream = futures::stream::unfold((Some(first), rx), |(first, mut rx)| async move {
        if let Some(chunk) = first {
            return Some((Ok::<_, std::io::Error>(chunk), (None, rx)));
        }
        rx.recv().await.map(|chunk| (Ok(chunk), (None, rx)))
    });
    let mut response = Response::builder()
        .status(StatusCode::PARTIAL_CONTENT)
        .header(header::CONTENT_TYPE, "application/octet-stream")
        .header(header::ACCEPT_RANGES, "bytes")
        .header(header::CONTENT_RANGE, format!("bytes {start}-{end}/{size}"))
        .body(Body::from_stream(stream))
        .unwrap();
    super::cors::apply(&mut response, &aud);
    response
}

// Reads `len` bytes into the channel. A chunk that takes longer than the
// deadline (first-byte for the first, stall for the rest) ends the body
// early — the client resumes from wherever it got to; so does a reader
// superseded by a hint. A receiver that went away — the browser aborted,
// or the handler gave up waiting for the first byte — cancels the read in
// progress, so the slot and the permit go back at once.
#[allow(clippy::too_many_arguments)]
async fn pump(
    mut reader: Reader,
    len: u64,
    chunk: usize,
    first_byte: Duration,
    stall: Duration,
    gen: u64,
    tx: mpsc::Sender<bytes::Bytes>,
    metrics: Arc<super::Metrics>,
) {
    let mut left = len;
    let mut buf = vec![0u8; chunk];
    let started = std::time::Instant::now();
    let mut first = true;
    while left > 0 {
        if reader.superseded(gen) {
            return;
        }
        let want = (left as usize).min(buf.len());
        let deadline = if first { first_byte } else { stall };
        let read = tokio::select! {
            r = tokio::time::timeout(deadline, reader.read(&mut buf[..want])) => r,
            _ = tx.closed() => return,
        };
        let n = match read {
            Ok(Ok(0)) => return,
            Ok(Ok(n)) => n,
            Ok(Err(e)) => {
                tracing::debug!(error = %e, "read failed");
                return;
            }
            Err(_) => {
                if !first {
                    metrics.stalls.fetch_add(1, Ordering::Relaxed);
                    metrics.observe_stall(started.elapsed());
                }
                return;
            }
        };
        if first {
            metrics.observe_first_byte(started.elapsed());
            first = false;
        }
        left -= n as u64;
        metrics.bytes_served.fetch_add(n as u64, Ordering::Relaxed);
        if tx.send(bytes::Bytes::copy_from_slice(&buf[..n])).await.is_err() {
            return;
        }
    }
}

pub async fn head(
    State(state): State<Arc<AppState>>,
    Path(ticket): Path<String>,
) -> Response {
    let ticket = match state.verify(&ticket) {
        Ok(t) => t,
        Err(e) => return fail(StatusCode::UNAUTHORIZED, "*", &e.to_string()),
    };
    let size = match state.engine.file_size(&ticket.infohash, ticket.file_index) {
        Ok(s) => s,
        Err(_) => return fail(StatusCode::NOT_FOUND, &ticket.audience, "unknown file"),
    };
    let mut response = (
        StatusCode::OK,
        [(header::ACCEPT_RANGES, "bytes".to_string()), (header::CONTENT_LENGTH, size.to_string())],
    )
        .into_response();
    super::cors::apply(&mut response, &ticket.audience);
    response
}
