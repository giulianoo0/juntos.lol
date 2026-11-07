//! A file at an address an extension handed out, read in pieces with Range
//! through the media proxy's client: public addresses only, the allowed
//! headers, every redirect checked. A piece that comes back for a different
//! file (a host out of connections hands out a short "blocked" video) is an
//! error, never bytes spliced into the film.
use std::sync::Arc;
use std::time::Duration;

use anyhow::{anyhow, bail, Context};
use async_trait::async_trait;
use bytes::Bytes;
use futures::StreamExt;
use http::{HeaderValue, Method};
use parking_lot::RwLock;
use url::Url;

use ss_remux::{ByteSource, SourceReader};

use crate::proxy::MediaProxy;

const PIECE: u64 = 8 << 20;
const ATTEMPTS: usize = 4;
const STALL: Duration = Duration::from_secs(60);

pub struct UrlSource {
    inner: Arc<Inner>,
}

struct Inner {
    proxy: Arc<MediaProxy>,
    asked: Url,
    /// Where the redirects led last time; a piece goes there first.
    landed: RwLock<Url>,
    headers: Vec<(&'static str, String)>,
    size: u64,
}

impl UrlSource {
    /// Asks for the first byte to learn the file's size. A host busy with the
    /// connection that just closed (one per address, as some are) gets a few
    /// more chances.
    pub async fn open(proxy: Arc<MediaProxy>, url: &str, headers: Vec<(&'static str, String)>) -> anyhow::Result<Self> {
        let asked = Url::parse(url).context("bad url")?;
        let range = HeaderValue::from_static("bytes=0-0");
        let mut attempt = 0;
        let (landed, response) = loop {
            let (landed, response) = proxy
                .fetch(asked.clone(), &Method::GET, Some(&range), &headers)
                .await
                .map_err(|status| anyhow!("source refused: {status}"))?;
            let status = response.status().as_u16();
            if status == 206 {
                break (landed, response);
            }
            attempt += 1;
            if !matches!(status, 429 | 502 | 503 | 504) || attempt == ATTEMPTS {
                bail!("source does not answer Range ({})", response.status());
            }
            tracing::warn!(status, attempt, "url source busy");
            tokio::time::sleep(Duration::from_secs(2 * attempt as u64)).await;
        };
        let size = content_range(&response).and_then(|(_, total)| total).context("source without a size")?;
        Ok(Self { inner: Arc::new(Inner { proxy, asked, landed: RwLock::new(landed), headers, size }) })
    }
}

/// `bytes a-b/total` as (a, total).
fn content_range(response: &reqwest::Response) -> Option<(u64, Option<u64>)> {
    let value = response.headers().get("content-range")?.to_str().ok()?;
    let rest = value.strip_prefix("bytes ")?;
    let (span, total) = rest.split_once('/')?;
    let start = span.split_once('-')?.0.parse().ok()?;
    Some((start, total.parse().ok()))
}

impl Inner {
    /// `[start, end]` as a body stream, from where the redirects led or, once
    /// that stops answering, from the address asked for.
    async fn piece(&self, start: u64, end: u64) -> anyhow::Result<reqwest::Response> {
        let range = HeaderValue::from_str(&format!("bytes={start}-{end}"))?;
        let mut last = anyhow!("piece {start}-{end} failed");
        for attempt in 0..ATTEMPTS {
            let target = if attempt == 0 { self.landed.read().clone() } else { self.asked.clone() };
            match self.proxy.fetch(target, &Method::GET, Some(&range), &self.headers).await {
                Ok((landed, response)) if response.status().as_u16() == 206 => {
                    match content_range(&response) {
                        Some((at, total)) if at == start && total.is_none_or(|t| t == self.size) => {
                            *self.landed.write() = landed;
                            return Ok(response);
                        }
                        Some((at, total)) => {
                            last = anyhow!("source answered byte {at} of {total:?} for byte {start} of {}", self.size);
                        }
                        None => last = anyhow!("source answered without Content-Range"),
                    }
                }
                Ok((_, response)) => last = anyhow!("piece {start}-{end} refused: {}", response.status()),
                Err(status) => last = anyhow!("piece {start}-{end} refused: {status}"),
            }
            tracing::warn!(start, attempt, error = %last, "url piece failed");
            tokio::time::sleep(Duration::from_millis(500 * (attempt as u64 + 1))).await;
        }
        Err(last)
    }
}

#[async_trait]
impl ByteSource for UrlSource {
    fn size(&self) -> u64 {
        self.inner.size
    }

    async fn open(&self, _reader: &str, position: u64) -> anyhow::Result<Box<dyn SourceReader>> {
        Ok(Box::new(UrlReader { inner: self.inner.clone(), position, pending: Bytes::new(), body: None }))
    }
}

type BodyStream = futures::stream::BoxStream<'static, reqwest::Result<Bytes>>;

struct UrlReader {
    inner: Arc<Inner>,
    position: u64,
    pending: Bytes,
    /// The piece being read and the byte after its end.
    body: Option<(BodyStream, u64)>,
}

impl UrlReader {
    fn take(&mut self, buf: &mut [u8]) -> usize {
        let n = buf.len().min(self.pending.len());
        buf[..n].copy_from_slice(&self.pending[..n]);
        self.pending = self.pending.slice(n..);
        self.position += n as u64;
        n
    }
}

#[async_trait]
impl SourceReader for UrlReader {
    async fn read(&mut self, buf: &mut [u8]) -> anyhow::Result<usize> {
        if buf.is_empty() || self.position >= self.inner.size {
            return Ok(0);
        }
        if !self.pending.is_empty() {
            return Ok(self.take(buf));
        }
        for _ in 0..ATTEMPTS {
            if self.body.as_ref().is_none_or(|(_, end)| self.position >= *end) {
                let end = (self.position + PIECE).min(self.inner.size) - 1;
                let response = self.inner.piece(self.position, end).await?;
                self.body = Some((response.bytes_stream().boxed(), end + 1));
            }
            let (stream, _) = self.body.as_mut().expect("body");
            match tokio::time::timeout(STALL, stream.next()).await {
                Ok(Some(Ok(chunk))) if !chunk.is_empty() => {
                    self.pending = chunk;
                    return Ok(self.take(buf));
                }
                Ok(Some(Ok(_))) => continue,
                // Cut short or stalled: the next piece starts where this one stopped.
                Ok(Some(Err(e))) => tracing::warn!(position = self.position, error = %e, "url body failed"),
                Ok(None) => {}
                Err(_) => tracing::warn!(position = self.position, "url body stalled"),
            }
            self.body = None;
        }
        bail!("source kept failing at byte {}", self.position)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn answered(value: &str) -> reqwest::Response {
        http::Response::builder().status(206).header("content-range", value).body(Vec::<u8>::new()).unwrap().into()
    }

    #[test]
    fn reads_the_start_and_the_whole_size() {
        assert_eq!(content_range(&answered("bytes 0-0/3688209314")), Some((0, Some(3688209314))));
        assert_eq!(content_range(&answered("bytes 8388608-16777215/*")), Some((8388608, None)));
        assert_eq!(content_range(&answered("items 0-1/2")), None);
    }
}
