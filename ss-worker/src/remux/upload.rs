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

#[derive(Deserialize)]
struct PresignedObject {
    name: String,
    url: String,
    #[serde(default)]
    headers: std::collections::HashMap<String, String>,
}

const PRESIGN_BATCH: usize = 16;
const PUT_RETRIES: usize = 2;

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
            while batch.len() < PRESIGN_BATCH {
                match closed_rx.try_recv() {
                    Ok(object) => batch.push(object),
                    Err(_) => break,
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
        let body = serde_json::json!({
            "claim": self.claim,
            "objects": batch.iter().map(|o| serde_json::json!({"name": o.name, "size": o.size})).collect::<Vec<_>>(),
        });
        let url = format!("{}/api/rooms/{}/client-media/presign", self.api_base, self.room_id);
        for attempt in 0..3u32 {
            let response = self.client.post(&url).json(&body).send().await;
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
}

async fn put_with_retry(
    client: &reqwest::Client,
    url: &str,
    headers: &std::collections::HashMap<String, String>,
    object: &ClosedObject,
) -> anyhow::Result<()> {
    let mut last = None;
    for _ in 0..=PUT_RETRIES {
        let bytes = tokio::fs::read(&object.path).await.context("read spool")?;
        let mut request = client.put(url).body(bytes);
        for (name, value) in headers {
            request = request.header(name, value);
        }
        match request.send().await {
            Ok(r) if r.status().is_success() => return Ok(()),
            Ok(r) => last = Some(anyhow::anyhow!("PUT {} failed: {}", object.name, r.status())),
            Err(e) => last = Some(e.into()),
        }
        tokio::time::sleep(Duration::from_millis(400)).await;
    }
    Err(last.unwrap_or_else(|| anyhow::anyhow!("PUT failed")))
}
