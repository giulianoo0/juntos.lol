//! One elementary stream read over HTTP the way yt-dlp does: in fixed
//! pieces asked for with the URL's own `range=` parameter, which the CDN
//! serves at full speed where one long request gets throttled. Both edges of
//! the file are kept in memory, because the demuxer returns to them on every
//! seek.
use std::sync::Arc;
use std::time::{Duration, Instant};

use anyhow::{bail, Context};
use async_trait::async_trait;
use bytes::Bytes;
use futures::StreamExt;
use parking_lot::{Mutex, RwLock};

use crate::source::{ByteSource, SourceReader};

const PIECE: u64 = 10 * 1024 * 1024;
const EDGE: u64 = 4 * 1024 * 1024;
const ATTEMPTS: usize = 4;
const REFRESH_COOLDOWN: Duration = Duration::from_secs(45);

/// Hands the stream a new URL once the old one stops answering.
#[async_trait]
pub trait Refresh: Send + Sync {
    async fn fresh_url(&self) -> anyhow::Result<String>;
}

pub struct HttpSource {
    inner: Arc<Inner>,
}

struct Inner {
    client: reqwest::Client,
    itag: String,
    url: RwLock<String>,
    size: u64,
    refresh: Arc<dyn Refresh>,
    last_refresh: Mutex<Option<Instant>>,
    head: tokio::sync::OnceCell<Bytes>,
    tail: tokio::sync::OnceCell<Bytes>,
}

impl HttpSource {
    pub fn new(client: reqwest::Client, itag: String, url: String, size: u64, refresh: Arc<dyn Refresh>) -> Self {
        Self {
            inner: Arc::new(Inner {
                client,
                itag,
                url: RwLock::new(url),
                size,
                refresh,
                last_refresh: Mutex::new(None),
                head: tokio::sync::OnceCell::new(),
                tail: tokio::sync::OnceCell::new(),
            }),
        }
    }

    pub fn itag(&self) -> &str {
        &self.inner.itag
    }
}

fn with_range(url: &str, start: u64, end: u64) -> String {
    let sep = if url.contains('?') { '&' } else { '?' };
    format!("{url}{sep}range={start}-{end}")
}

impl Inner {
    /// One `[start, end]` piece as a body stream, retried across blips and
    /// re-resolved once the CDN says the URL is spent.
    async fn piece(&self, start: u64, end: u64) -> anyhow::Result<reqwest::Response> {
        let mut last = None;
        for attempt in 0..ATTEMPTS {
            let url = with_range(&self.url.read(), start, end);
            match self.client.get(&url).send().await {
                Ok(response) if response.status().is_success() => return Ok(response),
                Ok(response) => {
                    let status = response.status();
                    tracing::warn!(itag = %self.itag, %status, start, attempt, "youtube piece refused");
                    if matches!(status.as_u16(), 403 | 404 | 410) {
                        self.refresh_url().await?;
                    }
                    last = Some(anyhow::anyhow!("piece {start}-{end} refused: {status}"));
                }
                Err(e) => {
                    tracing::warn!(itag = %self.itag, error = %e, start, attempt, "youtube piece failed");
                    last = Some(e.into());
                }
            }
            tokio::time::sleep(Duration::from_millis(400 * (attempt as u64 + 1))).await;
        }
        Err(last.unwrap_or_else(|| anyhow::anyhow!("piece {start}-{end} failed")))
    }

    async fn refresh_url(&self) -> anyhow::Result<()> {
        let recent = self.last_refresh.lock().map(|at| at.elapsed() < REFRESH_COOLDOWN).unwrap_or(false);
        if recent {
            return Ok(());
        }
        *self.last_refresh.lock() = Some(Instant::now());
        let fresh = self.refresh.fresh_url().await.context("youtube_expired")?;
        *self.url.write() = fresh;
        tracing::info!(itag = %self.itag, "youtube stream url refreshed");
        Ok(())
    }

    async fn whole(&self, start: u64, end: u64) -> anyhow::Result<Bytes> {
        let response = self.piece(start, end).await?;
        let body = response.bytes().await.context("edge body")?;
        if body.len() as u64 != end - start + 1 {
            bail!("edge {start}-{end} came short: {} bytes", body.len());
        }
        Ok(body)
    }

    async fn edge(&self, position: u64) -> anyhow::Result<Option<(Bytes, u64)>> {
        if self.size <= 2 * EDGE {
            let all = self.head.get_or_try_init(|| self.whole(0, self.size - 1)).await?;
            return Ok(Some((all.clone(), 0)));
        }
        if position < EDGE {
            let head = self.head.get_or_try_init(|| self.whole(0, EDGE - 1)).await?;
            return Ok(Some((head.clone(), 0)));
        }
        let tail_start = self.size - EDGE;
        if position >= tail_start {
            let tail = self.tail.get_or_try_init(|| self.whole(tail_start, self.size - 1)).await?;
            return Ok(Some((tail.clone(), tail_start)));
        }
        Ok(None)
    }
}

#[async_trait]
impl ByteSource for HttpSource {
    fn size(&self) -> u64 {
        self.inner.size
    }

    async fn open(&self, _reader: &str, position: u64) -> anyhow::Result<Box<dyn SourceReader>> {
        Ok(Box::new(HttpReader { inner: self.inner.clone(), position, pending: Bytes::new(), body: None }))
    }
}

type BodyStream = futures::stream::BoxStream<'static, reqwest::Result<Bytes>>;

struct HttpReader {
    inner: Arc<Inner>,
    position: u64,
    pending: Bytes,
    body: Option<(BodyStream, u64)>,
}

impl HttpReader {
    fn take(&mut self, buf: &mut [u8]) -> usize {
        let n = buf.len().min(self.pending.len());
        buf[..n].copy_from_slice(&self.pending[..n]);
        self.pending = self.pending.slice(n..);
        self.position += n as u64;
        n
    }
}

#[async_trait]
impl SourceReader for HttpReader {
    async fn read(&mut self, buf: &mut [u8]) -> anyhow::Result<usize> {
        if buf.is_empty() || self.position >= self.inner.size {
            return Ok(0);
        }
        if !self.pending.is_empty() {
            return Ok(self.take(buf));
        }
        if let Some((edge, base)) = self.inner.edge(self.position).await? {
            let offset = (self.position - base) as usize;
            self.pending = edge.slice(offset..);
            self.body = None;
            return Ok(self.take(buf));
        }
        loop {
            if let Some((stream, expected_end)) = self.body.as_mut() {
                match tokio::time::timeout(Duration::from_secs(60), stream.next()).await {
                    Ok(Some(Ok(chunk))) => {
                        self.pending = chunk;
                        return Ok(self.take(buf));
                    }
                    Ok(Some(Err(e))) => {
                        tracing::warn!(itag = %self.inner.itag, error = %e, position = self.position, "youtube piece cut; resuming");
                        self.body = None;
                    }
                    Ok(None) => {
                        let expected_end = *expected_end;
                        self.body = None;
                        if self.position <= expected_end {
                            bail!("piece ended early at {} of {}", self.position, expected_end);
                        }
                    }
                    Err(_) => {
                        tracing::warn!(itag = %self.inner.itag, position = self.position, "youtube piece stalled; resuming");
                        self.body = None;
                    }
                }
                continue;
            }
            let piece_end = ((self.position / PIECE + 1) * PIECE - 1).min(self.inner.size - 1);
            let response = self.inner.piece(self.position, piece_end).await?;
            self.body = Some((response.bytes_stream().boxed(), piece_end));
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::extract::{Query, State};
    use axum::routing::get;
    use std::collections::HashMap;
    use std::sync::atomic::{AtomicUsize, Ordering};

    struct NoRefresh;
    #[async_trait]
    impl Refresh for NoRefresh {
        async fn fresh_url(&self) -> anyhow::Result<String> {
            bail!("no refresh")
        }
    }

    struct Counting(Arc<AtomicUsize>, String);
    #[async_trait]
    impl Refresh for Counting {
        async fn fresh_url(&self) -> anyhow::Result<String> {
            self.0.fetch_add(1, Ordering::SeqCst);
            Ok(self.1.clone())
        }
    }

    #[derive(Clone)]
    struct Served {
        data: Arc<Vec<u8>>,
        hits: Arc<AtomicUsize>,
    }

    async fn serve(State(s): State<Served>, Query(q): Query<HashMap<String, String>>) -> axum::response::Response {
        use axum::response::IntoResponse;
        s.hits.fetch_add(1, Ordering::SeqCst);
        if q.get("key").map(|k| k != "good").unwrap_or(false) {
            return axum::http::StatusCode::FORBIDDEN.into_response();
        }
        let Some(range) = q.get("range") else {
            return axum::http::StatusCode::BAD_REQUEST.into_response();
        };
        let (a, b) = range.split_once('-').unwrap();
        let (a, b): (usize, usize) = (a.parse().unwrap(), b.parse().unwrap());
        s.data[a..=b].to_vec().into_response()
    }

    async fn start(data: Vec<u8>) -> (String, Arc<AtomicUsize>) {
        let hits = Arc::new(AtomicUsize::new(0));
        let served = Served { data: Arc::new(data), hits: hits.clone() };
        let app = axum::Router::new().route("/v", get(serve)).with_state(served);
        let listener = tokio::net::TcpListener::bind(("127.0.0.1", 0)).await.unwrap();
        let addr = listener.local_addr().unwrap();
        tokio::spawn(async move {
            axum::serve(listener, app).await.unwrap();
        });
        (format!("http://{addr}/v?key=good"), hits)
    }

    async fn read_all(source: &HttpSource, from: u64, len: usize) -> Vec<u8> {
        let mut reader = source.open("t", from).await.unwrap();
        let mut out = Vec::new();
        let mut buf = vec![0u8; 7000];
        while out.len() < len {
            let n = reader.read(&mut buf).await.unwrap();
            if n == 0 {
                break;
            }
            out.extend_from_slice(&buf[..n]);
        }
        out.truncate(len);
        out
    }

    #[tokio::test]
    async fn reads_by_range_parameter_across_pieces_and_edges() {
        let data: Vec<u8> = (0..(EDGE * 3 + 12345) as usize).map(|i| (i % 251) as u8).collect();
        let (url, hits) = start(data.clone()).await;
        let source = HttpSource::new(reqwest::Client::new(), "1".into(), url, data.len() as u64, Arc::new(NoRefresh));
        let mid = EDGE + 100;
        let got = read_all(&source, mid, 50_000).await;
        assert_eq!(got, data[mid as usize..mid as usize + 50_000].to_vec());
        let head = read_all(&source, 10, 100).await;
        assert_eq!(head, data[10..110].to_vec());
        let before = hits.load(Ordering::SeqCst);
        let head_again = read_all(&source, 0, 1000).await;
        assert_eq!(head_again, data[..1000].to_vec());
        assert_eq!(hits.load(Ordering::SeqCst), before, "the head edge is served from memory");
        let tail_from = data.len() as u64 - 300;
        let tail = read_all(&source, tail_from, 300).await;
        assert_eq!(tail, data[tail_from as usize..].to_vec());
        let crossing = read_all(&source, EDGE - 10, 40).await;
        assert_eq!(crossing, data[(EDGE - 10) as usize..(EDGE + 30) as usize].to_vec());
    }

    #[tokio::test]
    async fn a_refused_url_is_refreshed_once_and_the_read_goes_on() {
        let data: Vec<u8> = (0..(EDGE * 3) as usize).map(|i| (i % 13) as u8).collect();
        let (url, _hits) = start(data.clone()).await;
        let refreshes = Arc::new(AtomicUsize::new(0));
        let stale = url.replace("key=good", "key=stale");
        let source = HttpSource::new(
            reqwest::Client::new(),
            "1".into(),
            stale,
            data.len() as u64,
            Arc::new(Counting(refreshes.clone(), url)),
        );
        let got = read_all(&source, EDGE + 5, 100).await;
        assert_eq!(got, data[(EDGE + 5) as usize..(EDGE + 105) as usize].to_vec());
        assert_eq!(refreshes.load(Ordering::SeqCst), 1);
    }
}
