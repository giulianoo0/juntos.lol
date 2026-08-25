pub mod envelope;
pub mod identity;
mod jobs;

use std::sync::Arc;
use std::time::{Duration, Instant};

use anyhow::Context;
use futures::{SinkExt, StreamExt};
use serde_json::json;
use tokio::sync::Notify;
use tokio_tungstenite::tungstenite::Message;

use crate::config::WorkerConfig;
use crate::engine::Engine;
use crate::http::{tls::CertSlot, AppState};
use envelope::{Envelope, NonceStore};
use identity::Identity;

/// The outbound control link. The worker dials the server (no inbound
/// port needed), introduces itself, and from then on sends a heartbeat
/// every ten seconds and runs whatever signed jobs come back.
///
/// Wire format, JSON text frames:
///   → {type:"hello", workerId, pubkey, version, publicBase, ts, sig, enrollmentToken?}
///     sig = Ed25519 over "hello|{workerId}|{pubkey}|{publicBase}|{ts}"; ts within ±2 min
///   ← {type:"welcome", workerId, serverPubkey} | {type:"reject", error}
///   → {type:"heartbeat", ...engine snapshot, cert, ready}
///   ← {type:"job", payload, sig}          (payload: base64url JSON Job)
///   → {type:"result", jobId, kind, ok, ...}
pub struct Control {
    cfg: WorkerConfig,
    engine: Arc<Engine>,
    app: Arc<AppState>,
    slot: Option<Arc<CertSlot>>,
    acme_result: Option<Arc<crate::http::acme::Acme>>,
    identity: std::sync::Mutex<Identity>,
    nonces: NonceStore,
    drain: Arc<Notify>,
    started: Instant,
}

const HEARTBEAT: Duration = Duration::from_secs(10);
const SEND_TIMEOUT: Duration = Duration::from_secs(10);
// The server answers every heartbeat; this many beats without any frame
// from it means the link is dead even if the socket says otherwise.
const SILENCE_LIMIT: Duration = Duration::from_secs(45);
const RECONNECT_MIN: Duration = Duration::from_secs(1);
const RECONNECT_MAX: Duration = Duration::from_secs(60);

impl Control {
    pub fn new(
        cfg: WorkerConfig,
        engine: Arc<Engine>,
        app: Arc<AppState>,
        slot: Option<Arc<CertSlot>>,
        acme: Option<Arc<crate::http::acme::Acme>>,
        drain: Arc<Notify>,
    ) -> anyhow::Result<Self> {
        let identity = Identity::load_or_create(&cfg.data_dir.join("identity.json"))?;
        *app.worker_id.write().unwrap() = identity.worker_id.clone();
        *app.server_key.write().unwrap() = identity.server_key()?;
        let nonces = NonceStore::open(cfg.data_dir.join("nonces.json"));
        Ok(Self { cfg, engine, app, slot, acme_result: acme, identity: std::sync::Mutex::new(identity), nonces, drain, started: Instant::now() })
    }

    fn hello(&self) -> anyhow::Result<String> {
        let id = self.identity.lock().unwrap();
        let ts = crate::ticket::now_secs();
        let pubkey = id.pubkey_b64()?;
        let public_base = self.cfg.public_base();
        let message = format!("hello|{}|{}|{}|{}", id.worker_id, pubkey, public_base, ts);
        let mut hello = json!({
            "type": "hello",
            "workerId": id.worker_id,
            "pubkey": pubkey,
            "version": env!("CARGO_PKG_VERSION"),
            "publicBase": public_base,
            "ts": ts,
            "sig": id.sign(message.as_bytes())?,
        });
        if id.worker_id.is_empty() {
            let token = self.cfg.enrollment_token.clone().context("not enrolled and no SS_WORKER_ENROLLMENT_TOKEN")?;
            hello["enrollmentToken"] = json!(token);
        }
        Ok(hello.to_string())
    }

    fn heartbeat(&self) -> String {
        let snap = self.engine.snapshot();
        let cert = self.slot.as_ref().map(|s| {
            json!({
                "notAfter": s.not_after(),
                "lastResult": self.acme_result.as_ref().and_then(|a| a.last_result.lock().unwrap().clone()),
            })
        });
        let ready = match &self.slot {
            Some(slot) => slot.ready(30 * 60) && !snap.draining,
            None => !snap.draining,
        };
        json!({
            "type": "heartbeat",
            "version": env!("CARGO_PKG_VERSION"),
            "uptimeSecs": self.started.elapsed().as_secs(),
            "publicBase": self.cfg.public_base(),
            "ready": ready,
            "draining": snap.draining,
            "cert": cert,
            "disk": { "used": snap.disk_used, "quota": snap.disk_quota },
            "leases": snap.leases,
            "maxLeases": self.cfg.max_leases,
            "maxTorrents": self.cfg.max_torrents,
            "permitsInUse": snap.permits_in_use,
            "torrents": snap.torrents,
        })
        .to_string()
    }

    fn on_welcome(&self, msg: &serde_json::Value) -> anyhow::Result<()> {
        let worker_id = msg["workerId"].as_str().context("welcome without workerId")?;
        let server_pubkey = msg["serverPubkey"].as_str().context("welcome without serverPubkey")?;
        let key = identity::parse_pubkey(server_pubkey)?;
        let mut id = self.identity.lock().unwrap();
        let changed = id.worker_id != worker_id || id.server_pubkey.as_deref() != Some(server_pubkey);
        id.worker_id = worker_id.to_string();
        id.server_pubkey = Some(server_pubkey.to_string());
        if changed {
            id.save(&self.cfg.data_dir.join("identity.json"))?;
        }
        *self.app.worker_id.write().unwrap() = worker_id.to_string();
        *self.app.server_key.write().unwrap() = Some(key);
        tracing::info!(worker_id, "enrolled with server");
        Ok(())
    }

    async fn session(&self) -> anyhow::Result<()> {
        let (ws, _) = tokio::time::timeout(Duration::from_secs(15), tokio_tungstenite::connect_async(&self.cfg.server_url))
            .await
            .context("connect timeout")?
            .context("connect")?;
        let (mut tx, mut rx) = ws.split();
        let hello = self.hello()?;
        tokio::time::timeout(SEND_TIMEOUT, tx.send(Message::Text(hello))).await.context("hello send timeout")??;
        let first = tokio::time::timeout(Duration::from_secs(15), rx.next()).await.context("welcome timeout")?;
        let Some(Ok(Message::Text(text))) = first else { anyhow::bail!("no welcome") };
        let msg: serde_json::Value = serde_json::from_str(&text)?;
        match msg["type"].as_str() {
            Some("welcome") => self.on_welcome(&msg)?,
            Some("reject") => anyhow::bail!("server rejected: {}", msg["error"]),
            other => anyhow::bail!("unexpected first message {other:?}"),
        }
        tokio::time::timeout(SEND_TIMEOUT, tx.send(Message::Text(self.heartbeat()))).await.context("send timeout")??;
        let mut ticker = tokio::time::interval(HEARTBEAT);
        ticker.tick().await;
        let (results_tx, mut results_rx) = tokio::sync::mpsc::channel::<String>(64);
        let mut last_frame = Instant::now();
        loop {
            tokio::select! {
                _ = ticker.tick() => {
                    if last_frame.elapsed() > SILENCE_LIMIT {
                        anyhow::bail!("server silent for {:?}", last_frame.elapsed());
                    }
                    tokio::time::timeout(SEND_TIMEOUT, tx.send(Message::Text(self.heartbeat()))).await.context("send timeout")??;
                }
                Some(result) = results_rx.recv() => {
                    tokio::time::timeout(SEND_TIMEOUT, tx.send(Message::Text(result))).await.context("send timeout")??;
                }
                incoming = rx.next() => {
                    let Some(frame) = incoming else { anyhow::bail!("server closed") };
                    last_frame = Instant::now();
                    match frame? {
                        Message::Text(text) => self.on_message(&text, results_tx.clone()),
                        Message::Ping(p) => {
                            tokio::time::timeout(SEND_TIMEOUT, tx.send(Message::Pong(p))).await.context("send timeout")??;
                        }
                        Message::Close(_) => anyhow::bail!("server closed"),
                        _ => {}
                    }
                }
            }
        }
    }

    fn on_message(&self, text: &str, results: tokio::sync::mpsc::Sender<String>) {
        let msg: serde_json::Value = match serde_json::from_str(text) {
            Ok(m) => m,
            Err(e) => {
                tracing::warn!(error = %e, "unparseable frame");
                return;
            }
        };
        if msg["type"].as_str() != Some("job") {
            return;
        }
        let envelope: Envelope = match serde_json::from_value(msg.clone()) {
            Ok(e) => e,
            Err(e) => {
                tracing::warn!(error = %e, "malformed job frame");
                return;
            }
        };
        let key = self.app.server_key.read().unwrap();
        let Some(key) = key.as_ref() else { return };
        let worker_id = self.app.worker_id.read().unwrap().clone();
        let job = match envelope::verify(&envelope, key, &worker_id, &self.nonces) {
            Ok(j) => j,
            Err(e) => {
                tracing::warn!(error = %e, "job refused");
                return;
            }
        };
        let engine = self.engine.clone();
        let app = self.app.clone();
        let drain = self.drain.clone();
        tokio::spawn(async move {
            let result = jobs::run(job, &engine, &app, &drain).await;
            let _ = results.send(result.to_string()).await;
        });
    }

    pub async fn run(self: Arc<Self>) {
        let mut backoff = RECONNECT_MIN;
        loop {
            let started = Instant::now();
            match self.session().await {
                Ok(()) => {}
                Err(e) => tracing::warn!(error = %e, "control link dropped"),
            }
            if started.elapsed() > Duration::from_secs(60) {
                backoff = RECONNECT_MIN;
            }
            let jitter = Duration::from_millis(rand::random::<u64>() % 1000);
            tokio::time::sleep(backoff + jitter).await;
            backoff = (backoff * 2).min(RECONNECT_MAX);
        }
    }
}
