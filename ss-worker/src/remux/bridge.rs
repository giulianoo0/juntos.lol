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

/// The loopback bridge: FFmpeg's whole world. One listener on 127.0.0.1,
/// an ephemeral port, and per-run random capabilities on both sides —
/// torrent bytes in, HLS objects out.
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
    tracing::info!(reader = %target.reader, start, end, "remux input request");
    let (tx, rx) = tokio::sync::mpsc::channel::<Result<bytes::Bytes, std::io::Error>>(4);
    let chunk = target.engine.read_chunk_size();
    const STRIDE: u64 = 16 * 1024 * 1024;
    let trace_tag = format!("{} start={start}", target.reader);
    tokio::spawn(async move {
        let mut position = start;
        let mut sent: u64 = 0;
        let mut logged: u64 = 0;
        let mut buf = vec![0u8; chunk];
        let deliver_err = |tx: &tokio::sync::mpsc::Sender<Result<bytes::Bytes, std::io::Error>>, why: String| {
            let tx = tx.clone();
            async move { let _ = tx.send(Err(std::io::Error::other(why))).await; }
        };
        while position <= end {
            let stride_end = (position + STRIDE - 1).min(end);
            let opened = tokio::time::timeout(
                std::time::Duration::from_secs(40),
                target.engine.open(&target.infohash, &target.reader, target.file_index, position, Prio::Playhead),
            )
            .await;
            let opened = match opened {
                Ok(r) => r,
                Err(_) => {
                    tracing::warn!(reader = %target.reader, position, "remux input open timed out");
                    deliver_err(&tx, "input open timed out".into()).await;
                    return;
                }
            };
            let mut reader = match opened {
                Ok(r) => {
                    if sent == 0 {
                        tracing::info!(reader = %target.reader, position, "remux input open ok");
                    }
                    r
                }
                Err(e) => {
                    tracing::warn!(reader = %target.reader, sent, error = %e, "remux input reopen failed");
                    deliver_err(&tx, e.to_string()).await;
                    return;
                }
            };
            let mut left = stride_end - position + 1;
            while left > 0 {
                let want = (left as usize).min(buf.len());
                let read = tokio::time::timeout(std::time::Duration::from_secs(60), reader.read(&mut buf[..want])).await;
                let read = match read {
                    Ok(r) => r,
                    Err(_) => {
                        tracing::warn!(reader = %target.reader, sent, "remux input read stalled");
                        deliver_err(&tx, "input read stalled".into()).await;
                        return;
                    }
                };
                match read {
                    Ok(0) => {
                        deliver_err(&tx, "input ended early".into()).await;
                        return;
                    }
                    Ok(n) => {
                        left -= n as u64;
                        position += n as u64;
                        sent += n as u64;
                        if logged == 0 || sent - logged >= 64 * 1024 * 1024 {
                            logged = sent;
                            tracing::info!(reader = %target.reader, start, sent, "remux input flowing");
                        }
                        match tokio::time::timeout(
                            std::time::Duration::from_secs(180),
                            tx.send(Ok(bytes::Bytes::copy_from_slice(&buf[..n]))),
                        )
                        .await
                        {
                            Ok(Ok(())) => {}
                            Ok(Err(_)) => return,
                            Err(_) => {
                                tracing::info!(reader = %target.reader, start, sent, "remux input consumer idle, closing");
                                return;
                            }
                        }
                    }
                    Err(e) => {
                        tracing::warn!(reader = %target.reader, sent, error = %e, "remux input read failed");
                        deliver_err(&tx, e.to_string()).await;
                        return;
                    }
                }
            }
        }
        tracing::info!(reader = %target.reader, sent, "remux input range served");
    });
    let body = Body::from_stream(Traced {
        inner: tokio_stream::wrappers::ReceiverStream::new(rx),
        tag: trace_tag,
        polled: false,
        yielded: 0,
    });
    let mut response = Response::builder()
        .status(if ranged { StatusCode::PARTIAL_CONTENT } else { StatusCode::OK })
        .header(header::ACCEPT_RANGES, "bytes")
        .header(header::CONTENT_LENGTH, total.to_string())
        .header(header::CONTENT_TYPE, "application/octet-stream")
        .header(header::CONNECTION, "close");
    if ranged {
        response = response.header(header::CONTENT_RANGE, format!("bytes {start}-{end}/{size}"));
    }
    response.body(body).unwrap_or_else(|_| StatusCode::INTERNAL_SERVER_ERROR.into_response())
}

/// Says whether hyper ever pulls the response body: distinguishes a consumer
/// that never reads from a connection task that never writes.
struct Traced<S> {
    inner: S,
    tag: String,
    polled: bool,
    yielded: u64,
}

impl<S, E> tokio_stream::Stream for Traced<S>
where
    S: tokio_stream::Stream<Item = Result<bytes::Bytes, E>> + Unpin,
{
    type Item = Result<bytes::Bytes, E>;
    fn poll_next(
        mut self: std::pin::Pin<&mut Self>,
        cx: &mut std::task::Context<'_>,
    ) -> std::task::Poll<Option<<Self as tokio_stream::Stream>::Item>> {
        if !self.polled {
            self.polled = true;
            tracing::info!(tag = %self.tag, "remux input body first poll");
        }
        let poll = std::pin::Pin::new(&mut self.inner).poll_next(cx);
        if let std::task::Poll::Ready(Some(Ok(chunk))) = &poll {
            if self.yielded == 0 {
                tracing::info!(tag = %self.tag, len = chunk.len(), "remux input body first chunk to hyper");
            }
            self.yielded += chunk.len() as u64;
        }
        if let std::task::Poll::Ready(None) = &poll {
            tracing::info!(tag = %self.tag, yielded = self.yielded, "remux input body done");
        }
        poll
    }
}

async fn write_output(
    State(state): State<BridgeState>,
    Path((cap, name)): Path<(String, String)>,
    request: Request,
) -> Response {
    tracing::info!(name = %name, "remux output request");
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
