use std::collections::HashMap;
use std::net::SocketAddr;
use std::sync::Arc;

use axum::body::Body;
use axum::extract::{Path, State};
use axum::extract::Request;
use axum::http::{header, HeaderMap, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::routing::{get, put};
use parking_lot::Mutex;
use rand::RngCore;

use crate::engine::{Engine, Prio};
use crate::http::range::parse_range;

use super::sink::{object_kind, ObjectKind, Sink};

/// The loopback bridge: FFmpeg's whole world. One listener on 127.0.0.1, an
/// ephemeral port, and per-run random capabilities on both sides — reading
/// the verified torrent bytes in, and writing HLS objects out. Loopback is
/// where it listens, the capability is what authorizes; neither alone.
pub struct Bridge {
    pub addr: SocketAddr,
    inputs: Arc<Mutex<HashMap<String, Arc<InputTarget>>>>,
    outputs: Arc<Mutex<HashMap<String, Arc<Sink>>>>,
}

pub struct InputTarget {
    pub engine: Arc<Engine>,
    pub infohash: String,
    pub file_index: usize,
    pub reader: String,
    pub size: u64,
}

fn capability() -> String {
    let mut raw = [0u8; 16];
    rand::thread_rng().fill_bytes(&mut raw);
    hex::encode(raw)
}

#[derive(Clone)]
struct BridgeState {
    inputs: Arc<Mutex<HashMap<String, Arc<InputTarget>>>>,
    outputs: Arc<Mutex<HashMap<String, Arc<Sink>>>>,
}

impl Bridge {
    pub async fn start() -> anyhow::Result<Arc<Self>> {
        let inputs: Arc<Mutex<HashMap<String, Arc<InputTarget>>>> = Default::default();
        let outputs: Arc<Mutex<HashMap<String, Arc<Sink>>>> = Default::default();
        let state = BridgeState { inputs: inputs.clone(), outputs: outputs.clone() };
        let app = axum::Router::new()
            .route("/in/:cap", get(read_input).head(head_input))
            .route("/out/:cap/:name", put(write_output))
            .with_state(state);
        let listener = tokio::net::TcpListener::bind(("127.0.0.1", 0)).await?;
        let addr = listener.local_addr()?;
        tokio::spawn(async move {
            let _ = axum::serve(listener, app).await;
        });
        Ok(Arc::new(Self { addr, inputs, outputs }))
    }

    pub fn register_input(&self, target: InputTarget) -> (String, String) {
        let cap = capability();
        self.inputs.lock().insert(cap.clone(), Arc::new(target));
        (format!("http://{}/in/{}", self.addr, cap), cap)
    }

    pub fn register_output(&self, sink: Arc<Sink>) -> (String, String) {
        let cap = capability();
        self.outputs.lock().insert(cap.clone(), sink);
        (format!("http://{}/out/{}", self.addr, cap), cap)
    }

    pub fn revoke(&self, input_cap: &str, output_cap: &str) {
        self.inputs.lock().remove(input_cap);
        self.outputs.lock().remove(output_cap);
    }
}

async fn head_input(State(state): State<BridgeState>, Path(cap): Path<String>) -> Response {
    let Some(target) = state.inputs.lock().get(&cap).cloned() else {
        return StatusCode::NOT_FOUND.into_response();
    };
    (
        [
            (header::ACCEPT_RANGES, "bytes".to_string()),
            (header::CONTENT_LENGTH, target.size.to_string()),
            (header::CONTENT_TYPE, "application/octet-stream".to_string()),
        ],
        StatusCode::OK,
    )
        .into_response()
}

async fn read_input(State(state): State<BridgeState>, Path(cap): Path<String>, headers: HeaderMap) -> Response {
    let Some(target) = state.inputs.lock().get(&cap).cloned() else {
        return StatusCode::NOT_FOUND.into_response();
    };
    let size = target.size;
    let Ok((start, end)) = parse_range(headers.get(header::RANGE), size) else {
        return StatusCode::RANGE_NOT_SATISFIABLE.into_response();
    };
    let ranged = headers.get(header::RANGE).is_some();
    let total = end - start + 1;
    let mut reader = match target
        .engine
        .open(&target.infohash, &target.reader, target.file_index, start, Prio::Playhead)
        .await
    {
        Ok(r) => r,
        Err(e) => {
            tracing::warn!(error = %e, "remux input open failed");
            return StatusCode::SERVICE_UNAVAILABLE.into_response();
        }
    };
    let (tx, rx) = tokio::sync::mpsc::channel::<Result<bytes::Bytes, std::io::Error>>(4);
    let chunk = target.engine.read_chunk_size();
    tokio::spawn(async move {
        let mut left = total;
        let mut buf = vec![0u8; chunk];
        while left > 0 {
            let want = (left as usize).min(buf.len());
            // A read that parks forever wedges FFmpeg with it; a timed-out
            // connection dies loudly and the supervisor's retry reopens a
            // fresh reader over whatever has downloaded meanwhile.
            let read = tokio::time::timeout(std::time::Duration::from_secs(60), reader.read(&mut buf[..want])).await;
            let read = match read {
                Ok(r) => r,
                Err(_) => {
                    let _ = tx.send(Err(std::io::Error::other("input read stalled"))).await;
                    return;
                }
            };
            match read {
                Ok(0) => {
                    // Short read of a range whose length was promised: the
                    // connection dies so FFmpeg sees an error, never a clean
                    // EOF with bytes missing.
                    let _ = tx.send(Err(std::io::Error::other("input ended early"))).await;
                    return;
                }
                Ok(n) => {
                    left -= n as u64;
                    if tx.send(Ok(bytes::Bytes::copy_from_slice(&buf[..n]))).await.is_err() {
                        return;
                    }
                }
                Err(e) => {
                    let _ = tx.send(Err(std::io::Error::other(e.to_string()))).await;
                    return;
                }
            }
        }
    });
    let body = Body::from_stream(tokio_stream::wrappers::ReceiverStream::new(rx));
    let mut response = Response::builder()
        .status(if ranged { StatusCode::PARTIAL_CONTENT } else { StatusCode::OK })
        .header(header::ACCEPT_RANGES, "bytes")
        .header(header::CONTENT_LENGTH, total.to_string())
        .header(header::CONTENT_TYPE, "application/octet-stream");
    if ranged {
        response = response.header(header::CONTENT_RANGE, format!("bytes {start}-{end}/{size}"));
    }
    response.body(body).unwrap_or_else(|_| StatusCode::INTERNAL_SERVER_ERROR.into_response())
}

async fn write_output(
    State(state): State<BridgeState>,
    Path((cap, name)): Path<(String, String)>,
    request: Request,
) -> Response {
    let Some(sink) = state.outputs.lock().get(&cap).cloned() else {
        return StatusCode::NOT_FOUND.into_response();
    };
    if sink.cancelled() {
        return StatusCode::GONE.into_response();
    }
    let Some(kind) = object_kind(&name) else {
        return StatusCode::FORBIDDEN.into_response();
    };
    let body = request.into_body();
    match kind {
        ObjectKind::Manifest => {
            let bytes = match axum::body::to_bytes(body, 512 * 1024).await {
                Ok(b) => b,
                Err(_) => return StatusCode::PAYLOAD_TOO_LARGE.into_response(),
            };
            let Ok(text) = String::from_utf8(bytes.to_vec()) else {
                return StatusCode::BAD_REQUEST.into_response();
            };
            match sink.store_manifest(&name, text) {
                Ok(()) => StatusCode::CREATED.into_response(),
                Err(_) => StatusCode::PAYLOAD_TOO_LARGE.into_response(),
            }
        }
        ObjectKind::Media => match sink.store_media(&name, body.into_data_stream()).await {
            Ok(()) => StatusCode::CREATED.into_response(),
            Err(e) => {
                tracing::warn!(error = %e, name, "remux sink refused object");
                StatusCode::CONFLICT.into_response()
            }
        },
    }
}
