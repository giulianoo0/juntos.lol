use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;

use anyhow::bail;
use parking_lot::Mutex;
use sha2::{Digest, Sha256};
use tokio::io::AsyncWriteExt;
use tokio::sync::{mpsc, Notify};

#[derive(Debug, PartialEq, Eq, Clone, Copy)]
pub enum ObjectKind {
    Manifest,
    Media,
}

/// The name grammar is the same allowlist the server signs against; the
/// sink refuses anything outside it before a byte lands on disk.
pub fn object_kind(name: &str) -> Option<ObjectKind> {
    let rest = strip_region(name)?;
    if rest == "master.m3u8" {
        return Some(ObjectKind::Manifest);
    }
    if let Some(n) = rest.strip_prefix("client_stream_").and_then(|r| r.strip_suffix(".m3u8")) {
        return digits(n, 4).then_some(ObjectKind::Manifest);
    }
    if let Some(n) = rest.strip_prefix("cinit_").and_then(|r| r.strip_suffix(".mp4")) {
        return digits(n, 4).then_some(ObjectKind::Media);
    }
    if let Some(body) = rest.strip_prefix("cs_").and_then(|r| r.strip_suffix(".m4s")) {
        let (a, b) = body.split_once('_')?;
        return (digits(a, 4) && digits(b, 7)).then_some(ObjectKind::Media);
    }
    None
}

fn strip_region(name: &str) -> Option<&str> {
    let Some(rest) = name.strip_prefix('r') else { return Some(name) };
    match rest.split_once('_') {
        Some((n, tail)) if digits(n, 6) => Some(tail),
        _ => Some(name),
    }
}

fn digits(s: &str, max: usize) -> bool {
    !s.is_empty() && s.len() <= max && s.bytes().all(|b| b.is_ascii_digit())
}

/// Spool budget and temp file held by one in-flight body, given back on any
/// exit — including the future being dropped by a dying connection.
struct SpoolHold<'a> {
    sink: &'a Sink,
    amount: u64,
    tmp: Option<std::path::PathBuf>,
}

impl Drop for SpoolHold<'_> {
    fn drop(&mut self) {
        if self.amount > 0 {
            self.sink.release(self.amount);
        }
        if let Some(tmp) = self.tmp.take() {
            let _ = std::fs::remove_file(tmp);
        }
    }
}

#[derive(Clone)]
pub struct ClosedObject {
    pub name: String,
    pub path: PathBuf,
    pub size: u64,
    pub digest: [u8; 32],
}

const MAX_MANIFEST_BYTES: usize = 512 * 1024;

/// One run's output sink: manifests as replaceable snapshots in memory,
/// media objects spooled to disk under a byte budget the muxer feels.
pub struct Sink {
    dir: PathBuf,
    object_cap: u64,
    free: Mutex<u64>,
    freed: Notify,
    manifests: Mutex<HashMap<String, String>>,
    closed: Mutex<HashMap<String, ClosedObject>>,
    closed_tx: Mutex<Option<mpsc::UnboundedSender<ClosedObject>>>,
    cancelled: AtomicBool,
    serial: std::sync::atomic::AtomicU64,
}

impl Sink {
    pub fn new(dir: PathBuf, spool_bytes: u64, object_cap: u64) -> anyhow::Result<(Arc<Self>, mpsc::UnboundedReceiver<ClosedObject>)> {
        std::fs::create_dir_all(&dir)?;
        let (tx, rx) = mpsc::unbounded_channel();
        Ok((
            Arc::new(Self {
                dir,
                object_cap,
                free: Mutex::new(spool_bytes.max(object_cap)),
                freed: Notify::new(),
                manifests: Mutex::new(HashMap::new()),
                closed: Mutex::new(HashMap::new()),
                closed_tx: Mutex::new(Some(tx)),
                cancelled: AtomicBool::new(false),
                serial: std::sync::atomic::AtomicU64::new(0),
            }),
            rx,
        ))
    }

    pub fn cancel(&self) {
        self.cancelled.store(true, Ordering::SeqCst);
        self.freed.notify_waiters();
        self.close_producer();
    }

    /// Nothing else will be produced: the uploader drains what exists and ends.
    pub fn close_producer(&self) {
        self.closed_tx.lock().take();
    }

    pub fn cancelled(&self) -> bool {
        self.cancelled.load(Ordering::SeqCst)
    }

    pub fn manifests(&self) -> HashMap<String, String> {
        self.manifests.lock().clone()
    }

    pub fn closed_count(&self) -> usize {
        self.closed.lock().len()
    }

    pub fn store_manifest(&self, name: &str, body: String) -> anyhow::Result<()> {
        if body.len() > MAX_MANIFEST_BYTES {
            bail!("manifest over size");
        }
        self.manifests.lock().insert(name.to_string(), body);
        Ok(())
    }

    /// Streams one media object body into the spool, reserving budget in
    /// slabs as the body grows rather than the whole object ceiling up front.
    /// A body that outgrows the free budget stops being read until an upload
    /// returns bytes.
    pub async fn store_media<S, B, E>(&self, name: &str, mut body: S) -> anyhow::Result<()>
    where
        S: futures::Stream<Item = Result<B, E>> + Unpin,
        B: AsRef<[u8]>,
        E: std::fmt::Display,
    {
        let held = { self.closed.lock().get(name).cloned() };
        if let Some(held) = held {
            return self.verify_retry(&held, &mut body).await;
        }
        let slab = self.object_cap.min(16 * 1024 * 1024);
        let serial = self.serial.fetch_add(1, Ordering::Relaxed);
        let tmp = self.dir.join(format!("part_{serial}.tmp"));
        let mut hold = SpoolHold { sink: self, amount: 0, tmp: Some(tmp.clone()) };
        let object = self.consume(name, &tmp, &mut body, slab, &mut hold.amount).await?;
        tokio::fs::rename(&tmp, &object.path).await?;
        hold.tmp = None;
        let over = hold.amount - object.size;
        hold.amount = 0;
        self.release(over);
        self.closed.lock().insert(name.to_string(), object.clone());
        if let Some(tx) = self.closed_tx.lock().as_ref() { let _ = tx.send(object); }
        Ok(())
    }

    async fn consume<S, B, E>(&self, name: &str, tmp: &PathBuf, body: &mut S, slab: u64, reserved: &mut u64) -> anyhow::Result<ClosedObject>
    where
        S: futures::Stream<Item = Result<B, E>> + Unpin,
        B: AsRef<[u8]>,
        E: std::fmt::Display,
    {
        use futures::StreamExt;
        self.reserve(slab).await?;
        *reserved = slab;
        let mut file = tokio::fs::File::create(tmp).await?;
        let mut hasher = Sha256::new();
        let mut size: u64 = 0;
        loop {
            let next = loop {
                match tokio::time::timeout(std::time::Duration::from_secs(30), body.next()).await {
                    Ok(item) => break item,
                    Err(_) => tracing::warn!(name, size, "media body quiet for 30s"),
                }
            };
            let Some(chunk) = next else { break };
            if self.cancelled() {
                bail!("run cancelled");
            }
            let chunk = match chunk {
                Ok(c) => c,
                Err(e) => bail!("body failed: {e}"),
            };
            let bytes = chunk.as_ref();
            size += bytes.len() as u64;
            if size > self.object_cap {
                bail!("object over the {} byte ceiling", self.object_cap);
            }
            while size > *reserved {
                let step = slab.min(self.object_cap - *reserved);
                self.reserve(step).await?;
                *reserved += step;
            }
            hasher.update(bytes);
            file.write_all(bytes).await?;
        }
        file.flush().await?;
        if size == 0 {
            bail!("empty object");
        }
        tracing::info!(name, size, "media object closed");
        Ok(ClosedObject {
            name: name.to_string(),
            path: self.dir.join(name),
            size,
            digest: hasher.finalize().into(),
        })
    }

    async fn verify_retry<S, B, E>(&self, held: &ClosedObject, body: &mut S) -> anyhow::Result<()>
    where
        S: futures::Stream<Item = Result<B, E>> + Unpin,
        B: AsRef<[u8]>,
        E: std::fmt::Display,
    {
        use futures::StreamExt;
        let mut hasher = Sha256::new();
        let mut size: u64 = 0;
        while let Some(chunk) = body.next().await {
            let chunk = match chunk {
                Ok(c) => c,
                Err(e) => bail!("body failed: {e}"),
            };
            hasher.update(chunk.as_ref());
            size += chunk.as_ref().len() as u64;
            if size > held.size {
                bail!("retry with different bytes");
            }
        }
        let digest: [u8; 32] = hasher.finalize().into();
        if size != held.size || digest != held.digest {
            bail!("retry with different bytes");
        }
        Ok(())
    }

    pub fn free_bytes(&self) -> u64 {
        *self.free.lock()
    }

    async fn reserve(&self, need: u64) -> anyhow::Result<()> {
        loop {
            if self.cancelled() {
                bail!("run cancelled");
            }
            let notified = self.freed.notified();
            tokio::pin!(notified);
            notified.as_mut().enable();
            {
                let mut free = self.free.lock();
                if *free >= need {
                    *free -= need;
                    return Ok(());
                }
            }
            notified.await;
        }
    }

    pub fn release(&self, amount: u64) {
        if amount == 0 {
            return;
        }
        *self.free.lock() += amount;
        self.freed.notify_waiters();
    }

    /// The uploader confirmed (or the run abandoned) this object: its bytes
    /// leave the spool and the budget comes back.
    pub async fn discard(&self, object: &ClosedObject) {
        let _ = tokio::fs::remove_file(&object.path).await;
        self.release(object.size);
    }

    pub async fn destroy(&self) {
        self.cancel();
        let _ = tokio::fs::remove_dir_all(&self.dir).await;
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use futures::stream;

    fn chunks(parts: &[&[u8]]) -> impl futures::Stream<Item = Result<Vec<u8>, std::convert::Infallible>> + Unpin {
        stream::iter(parts.iter().map(|p| Ok(p.to_vec())).collect::<Vec<_>>())
    }

    fn temp_sink(spool: u64, cap: u64) -> (Arc<Sink>, mpsc::UnboundedReceiver<ClosedObject>) {
        let dir = std::env::temp_dir().join(format!("ssw-sink-{}-{}", std::process::id(), rand::random::<u32>()));
        Sink::new(dir, spool, cap).unwrap()
    }

    #[test]
    fn grammar_is_the_servers() {
        assert_eq!(object_kind("master.m3u8"), Some(ObjectKind::Manifest));
        assert_eq!(object_kind("r12_master.m3u8"), Some(ObjectKind::Manifest));
        assert_eq!(object_kind("client_stream_0.m3u8"), Some(ObjectKind::Manifest));
        assert_eq!(object_kind("cinit_0.mp4"), Some(ObjectKind::Media));
        assert_eq!(object_kind("r3_cs_1_42.m4s"), Some(ObjectKind::Media));
        for bad in ["../x.m4s", "cs_1.m4s", "cs_a_1.m4s", "evil.txt", "cs_1_12345678.m4s", "r_cs_1_1.m4s", ""] {
            assert_eq!(object_kind(bad), None, "{bad}");
        }
    }

    #[tokio::test]
    async fn closes_objects_and_frees_budget_on_discard() {
        let (sink, mut rx) = temp_sink(1024, 512);
        sink.store_media("cs_0_1.m4s", chunks(&[b"abc", b"def"])).await.unwrap();
        let object = rx.recv().await.unwrap();
        assert_eq!(object.size, 6);
        assert!(object.path.exists());
        sink.discard(&object).await;
        assert!(!object.path.exists());
        sink.destroy().await;
    }

    #[tokio::test]
    async fn truncated_bodies_never_close() {
        let (sink, mut rx) = temp_sink(1024, 512);
        let failing = stream::iter(vec![Ok::<Vec<u8>, String>(b"abc".to_vec()), Err("reset".into())]);
        let err = sink.store_media("cs_0_1.m4s", failing).await.unwrap_err();
        assert!(err.to_string().contains("body failed"));
        assert!(rx.try_recv().is_err());
        sink.destroy().await;
    }

    #[tokio::test]
    async fn retry_only_accepts_the_same_bytes() {
        let (sink, mut rx) = temp_sink(2048, 512);
        sink.store_media("cs_0_1.m4s", chunks(&[b"same"])).await.unwrap();
        let _ = rx.recv().await.unwrap();
        sink.store_media("cs_0_1.m4s", chunks(&[b"same"])).await.unwrap();
        assert!(rx.try_recv().is_err(), "retry must not enqueue again");
        let err = sink.store_media("cs_0_1.m4s", chunks(&[b"diff"])).await.unwrap_err();
        assert!(err.to_string().contains("different bytes"));
        sink.destroy().await;
    }

    #[tokio::test]
    async fn oversize_objects_fail_controlled() {
        let (sink, mut rx) = temp_sink(1024, 4);
        let err = sink.store_media("cs_0_1.m4s", chunks(&[b"12345"])).await.unwrap_err();
        assert!(err.to_string().contains("ceiling"));
        assert!(rx.try_recv().is_err());
        sink.destroy().await;
    }

    #[tokio::test]
    async fn a_full_spool_stalls_admission_until_a_discard() {
        let (sink, mut rx) = temp_sink(512, 512);
        sink.store_media("cs_0_1.m4s", chunks(&[b"x"])).await.unwrap();
        let first = rx.recv().await.unwrap();
        let sink2 = sink.clone();
        let second = tokio::spawn(async move { sink2.store_media("cs_0_2.m4s", chunks(&[b"y"])).await });
        tokio::time::sleep(std::time::Duration::from_millis(50)).await;
        assert!(!second.is_finished(), "admission should be parked on budget");
        sink.discard(&first).await;
        second.await.unwrap().unwrap();
        sink.destroy().await;
    }

    #[tokio::test]
    async fn cancel_wakes_parked_admissions() {
        let (sink, _rx) = temp_sink(512, 512);
        sink.store_media("cs_0_1.m4s", chunks(&[b"x"])).await.unwrap();
        let sink2 = sink.clone();
        let parked = tokio::spawn(async move { sink2.store_media("cs_0_2.m4s", chunks(&[b"y"])).await });
        tokio::time::sleep(std::time::Duration::from_millis(20)).await;
        sink.cancel();
        assert!(parked.await.unwrap().is_err());
        sink.destroy().await;
    }
}
