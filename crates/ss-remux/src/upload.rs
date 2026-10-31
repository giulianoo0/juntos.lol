use std::sync::Arc;
use std::time::Duration;

use anyhow::{bail, Context};
use serde::Deserialize;
use tokio::sync::{mpsc, Semaphore};

use super::sink::{ClosedObject, Sink};

/// Closed objects flow: presign in coalesced batches, PUT under a per-job
/// and a global ceiling, then hand the object to the committer. The spool
/// bytes stay until the committer releases them.
pub struct Uploader {
    pub client: reqwest::Client,
    pub api_base: String,
    pub room_id: String,
    pub claim: String,
    pub job_puts: usize,
    pub global_puts: Arc<Semaphore>,
    pub uploaded_tx: mpsc::UnboundedSender<ClosedObject>,
}

#[derive(Deserialize)]
struct PresignResponse {
    objects: Vec<PresignedObject>,
}

#[derive(Clone, Deserialize)]
pub struct PresignedObject {
    pub name: String,
    pub url: String,
    #[serde(default)]
    pub headers: std::collections::HashMap<String, String>,
}

const PRESIGN_BATCH: usize = 16;
const PRESIGN_GAP: Duration = Duration::from_millis(25);
const PRESIGN_WINDOW: Duration = Duration::from_millis(100);
const PUT_RETRIES: usize = 5;

impl Uploader {
    pub async fn run(self, sink: Arc<Sink>, mut closed_rx: mpsc::UnboundedReceiver<ClosedObject>) -> anyhow::Result<()> {
        let local = Arc::new(Semaphore::new(self.job_puts.max(1)));
        let mut inflight = tokio::task::JoinSet::new();
        loop {
            let mut batch = Vec::with_capacity(PRESIGN_BATCH);
            match closed_rx.recv().await {
                Some(object) => batch.push(object),
                None => break,
            }
            // A whole-file remux closes objects milliseconds apart: wait a
            // beat for the next one rather than signing each on its own.
            let deadline = tokio::time::Instant::now() + PRESIGN_WINDOW;
            while batch.len() < PRESIGN_BATCH {
                let wait = PRESIGN_GAP.min(deadline.saturating_duration_since(tokio::time::Instant::now()));
                match tokio::time::timeout(wait, closed_rx.recv()).await {
                    Ok(Some(object)) => batch.push(object),
                    _ => break,
                }
            }
            if sink.cancelled() {
                break;
            }
            let signed = self.presign(&batch).await?;
            for object in batch {
                let Some(target) = signed.iter().find(|s| s.name == object.name) else {
                    bail!("presign missing {}", object.name);
                };
                let url = target.url.clone();
                let headers = target.headers.clone();
                let local = local.clone();
                let global = self.global_puts.clone();
                let client = self.client.clone();
                let uploaded = self.uploaded_tx.clone();
                let sink = sink.clone();
                inflight.spawn(async move {
                    let _job_permit = local.acquire_owned().await?;
                    let _global_permit = global.acquire_owned().await?;
                    if sink.cancelled() {
                        return Ok(());
                    }
                    put_with_retry(&client, &url, &headers, &object).await?;
                    let _ = uploaded.send(object);
                    anyhow::Ok(())
                });
                while let Some(done) = inflight.try_join_next() {
                    done.context("upload task")??;
                }
            }
        }
        while let Some(done) = inflight.join_next().await {
            done.context("upload task")??;
        }
        Ok(())
    }

    async fn presign(&self, batch: &[ClosedObject]) -> anyhow::Result<Vec<PresignedObject>> {
        presign(&self.client, &self.api_base, &self.room_id, &self.claim, batch).await
    }
}

/// Signs a batch of PUTs under the run's claim.
pub async fn presign(
    client: &reqwest::Client,
    api_base: &str,
    room_id: &str,
    claim: &str,
    batch: &[ClosedObject],
) -> anyhow::Result<Vec<PresignedObject>> {
    let body = serde_json::json!({
        "claim": claim,
        "objects": batch.iter().map(|o| serde_json::json!({"name": o.name, "size": o.size})).collect::<Vec<_>>(),
    });
    let url = format!("{api_base}/api/rooms/{room_id}/client-media/presign");
    for attempt in 0..3u32 {
        let response = client.post(&url).json(&body).send().await;
        match response {
            Ok(r) if r.status().is_success() => {
                let parsed: PresignResponse = r.json().await.context("presign body")?;
                return Ok(parsed.objects);
            }
            Ok(r) if r.status().is_client_error() => {
                bail!("presign refused: {}", r.status());
            }
            Ok(r) => tracing::warn!(status = %r.status(), "presign retryable failure"),
            Err(e) => tracing::warn!(error = %e, "presign network failure"),
        }
        tokio::time::sleep(Duration::from_millis(500 * (attempt as u64 + 1))).await;
    }
    bail!("presign kept failing");
}

pub async fn put_with_retry(
    client: &reqwest::Client,
    url: &str,
    headers: &std::collections::HashMap<String, String>,
    object: &ClosedObject,
) -> anyhow::Result<()> {
    let mut last = None;
    for attempt in 0..=PUT_RETRIES {
        // Streamed off the spool: two dozen PUTs of a 4K segment each would
        // otherwise sit in memory whole.
        let file = tokio::fs::File::open(&object.path).await.context("read spool")?;
        let mut request = client
            .put(url)
            .header(reqwest::header::CONTENT_LENGTH, object.size)
            .body(reqwest::Body::from(file));
        // The presign pins Content-Length too, and a second copy of it is a
        // 400 at Cloudflare's edge before R2 ever checks the signature.
        for (name, value) in headers.iter().filter(|(name, _)| !name.eq_ignore_ascii_case("content-length")) {
            request = request.header(name, value);
        }
        match request.send().await {
            Ok(r) if r.status().is_success() => return Ok(()),
            Ok(r) => last = Some(anyhow::anyhow!("PUT {} failed: {}", object.name, r.status())),
            Err(e) => last = Some(e.into()),
        }
        tracing::warn!(name = %object.name, attempt, error = %last.as_ref().map(|e| e.to_string()).unwrap_or_default(), "PUT failed; retrying");
        tokio::time::sleep(Duration::from_millis(400 << attempt.min(5))).await;
    }
    Err(last.unwrap_or_else(|| anyhow::anyhow!("PUT failed")))
}

#[cfg(test)]
mod tests {
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::time::Duration;

    use axum::extract::State;
    use axum::routing::{post, put};

    use super::*;

    #[derive(Clone, Default)]
    pub(crate) struct Api {
        pub base: Arc<parking_lot::Mutex<String>>,
        pub presigns: Arc<AtomicUsize>,
    }

    async fn sign(State(api): State<Api>, axum::Json(body): axum::Json<serde_json::Value>) -> axum::Json<serde_json::Value> {
        api.presigns.fetch_add(1, Ordering::SeqCst);
        let base = api.base.lock().clone();
        let objects: Vec<serde_json::Value> = body["objects"]
            .as_array()
            .unwrap()
            .iter()
            .map(|o| serde_json::json!({ "name": o["name"], "url": format!("{base}/put/{}", o["name"].as_str().unwrap()), "headers": signed_headers(o["size"].as_u64().unwrap()) }))
            .collect();
        axum::Json(serde_json::json!({ "objects": objects }))
    }

    /// What the server's presign pins into the signature (R2.PresignPut).
    fn signed_headers(size: u64) -> serde_json::Value {
        serde_json::json!({ "Content-Type": "video/iso.segment", "Cache-Control": "public, max-age=31536000, immutable", "Content-Length": size.to_string() })
    }

    async fn store(_body: axum::body::Bytes) -> axum::http::StatusCode {
        axum::http::StatusCode::OK
    }

    /// The bucket as the wire carries it. hyper's server folds a repeated
    /// Content-Length into one; Cloudflare's edge answers it with a 400.
    async fn raw_bucket() -> (String, tokio::sync::oneshot::Receiver<(Vec<String>, usize)>) {
        use tokio::io::{AsyncReadExt, AsyncWriteExt};
        let listener = tokio::net::TcpListener::bind(("127.0.0.1", 0)).await.unwrap();
        let url = format!("http://{}/put/x", listener.local_addr().unwrap());
        let (tx, rx) = tokio::sync::oneshot::channel();
        tokio::spawn(async move {
            let (mut socket, _) = listener.accept().await.unwrap();
            let mut seen = Vec::new();
            let mut chunk = vec![0u8; 64 << 10];
            let end = loop {
                let n = socket.read(&mut chunk).await.unwrap();
                seen.extend_from_slice(&chunk[..n]);
                if let Some(at) = seen.windows(4).position(|w| w == b"\r\n\r\n") {
                    break at + 4;
                }
            };
            let head: Vec<String> = String::from_utf8_lossy(&seen[..end]).lines().map(str::to_ascii_lowercase).collect();
            let declared = head.iter().find_map(|l| l.strip_prefix("content-length: ")).map_or(0, |n| n.parse().unwrap());
            while seen.len() < end + declared {
                let n = socket.read(&mut chunk).await.unwrap();
                seen.extend_from_slice(&chunk[..n]);
            }
            socket.write_all(b"HTTP/1.1 200 OK\r\ncontent-length: 0\r\n\r\n").await.unwrap();
            tx.send((head, seen.len() - end)).unwrap();
        });
        (url, rx)
    }

    pub(crate) async fn fake_api() -> Api {
        let api = Api::default();
        let app = axum::Router::new()
            .route("/api/rooms/:room/client-media/presign", post(sign))
            .route("/put/:name", put(store))
            .with_state(api.clone());
        let listener = tokio::net::TcpListener::bind(("127.0.0.1", 0)).await.unwrap();
        *api.base.lock() = format!("http://{}", listener.local_addr().unwrap());
        tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
        api
    }

    fn object(dir: &std::path::Path, n: usize, size: usize) -> ClosedObject {
        let name = format!("cs_0_{n}.m4s");
        let path = dir.join(&name);
        std::fs::write(&path, vec![7u8; size]).unwrap();
        ClosedObject { name, path, size: size as u64, digest: [0; 32] }
    }

    fn uploader(api: &Api) -> (Uploader, mpsc::UnboundedReceiver<ClosedObject>) {
        let (uploaded_tx, uploaded_rx) = mpsc::unbounded_channel();
        let uploader = Uploader {
            client: reqwest::Client::new(),
            api_base: api.base.lock().clone(),
            room_id: "ROOM".into(),
            claim: "c".into(),
            job_puts: 4,
            global_puts: Arc::new(Semaphore::new(8)),
            uploaded_tx,
        };
        (uploader, uploaded_rx)
    }

    #[tokio::test]
    async fn objects_closing_close_together_are_signed_together() {
        let api = fake_api().await;
        let dir = crate::run_tests::scratch("presign");
        let (sink, _) = Sink::new(dir.join("spool"), 1 << 20, 1 << 20).unwrap();
        let (uploader, mut uploaded) = uploader(&api);
        let (closed_tx, closed_rx) = mpsc::unbounded_channel();
        let task = tokio::spawn(uploader.run(sink, closed_rx));
        for n in 0..40 {
            closed_tx.send(object(&dir, n, 1000)).unwrap();
            tokio::time::sleep(Duration::from_millis(5)).await;
        }
        drop(closed_tx);
        task.await.unwrap().unwrap();
        let mut done = 0;
        while uploaded.try_recv().is_ok() {
            done += 1;
        }
        assert_eq!(done, 40);
        let presigns = api.presigns.load(Ordering::SeqCst);
        assert!(presigns <= 5, "{presigns} presign requests for 40 objects");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[tokio::test]
    async fn a_put_declares_its_length_once_as_the_bucket_requires() {
        let (url, received) = raw_bucket().await;
        let dir = crate::run_tests::scratch("put");
        let object = object(&dir, 0, 1 << 20);
        let signed = serde_json::from_value(signed_headers(object.size)).unwrap();
        put_with_retry(&reqwest::Client::new(), &url, &signed, &object).await.unwrap();
        let (head, body) = received.await.unwrap();
        let framing: Vec<&String> =
            head.iter().filter(|l| l.starts_with("content-length:") || l.starts_with("transfer-encoding:")).collect();
        assert_eq!(framing, [&format!("content-length: {}", 1 << 20)]);
        assert_eq!(body, 1 << 20);
        let _ = std::fs::remove_dir_all(&dir);
    }
}
