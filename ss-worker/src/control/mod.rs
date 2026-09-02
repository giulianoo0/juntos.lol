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
pub struct Control {
    cfg: WorkerConfig,
    engine: Arc<Engine>,
    app: Arc<AppState>,
    slot: Option<Arc<CertSlot>>,
    acme_result: Option<Arc<crate::http::acme::Acme>>,
    identity: parking_lot::Mutex<Identity>,
    nonces: NonceStore,
    drain: Arc<Notify>,
    started: Instant,
    reenrolls: std::sync::atomic::AtomicU32,
    egress_mark: parking_lot::Mutex<(u64, Instant)>,
}

const HEARTBEAT: Duration = Duration::from_secs(10);
const SEND_TIMEOUT: Duration = Duration::from_secs(10);
const SILENCE_LIMIT: Duration = Duration::from_secs(45);
const RECONNECT_MIN: Duration = Duration::from_secs(1);
const RECONNECT_MAX: Duration = Duration::from_secs(60);
const SESSION_HEALTHY: Duration = Duration::from_secs(60);
const REENROLL_BUDGET: u32 = 3;

const UNKNOWN_WORKER: &str = "unknown_worker";

/// A hello the server turned away, carrying the reason verbatim so the
/// reconnect loop can tell a stale identity from a passing refusal.
#[derive(Debug)]
struct Rejected(String);

impl std::fmt::Display for Rejected {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "server rejected: {}", self.0)
    }
}

impl std::error::Error for Rejected {}

/// What a rejected hello leaves the worker to do.
#[derive(Debug, PartialEq, Eq)]
enum AfterReject {
    Retry,
    Reenroll,
    NoToken,
    Exhausted,
}

fn after_reject(reason: &str, has_token: bool, reenrolls: u32) -> AfterReject {
    if reason != UNKNOWN_WORKER {
        return AfterReject::Retry;
    }
    if !has_token {
        return AfterReject::NoToken;
    }
    if reenrolls >= REENROLL_BUDGET {
        return AfterReject::Exhausted;
    }
    AfterReject::Reenroll
}

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
        *app.worker_id.write() = identity.worker_id.clone();
        *app.server_key.write() = identity.server_key()?;
        let nonces = NonceStore::open(cfg.data_dir.join("nonces.json"));
        Ok(Self {
            cfg,
            engine,
            app,
            slot,
            acme_result: acme,
            identity: parking_lot::Mutex::new(identity),
            nonces,
            drain,
            started: Instant::now(),
            reenrolls: std::sync::atomic::AtomicU32::new(0),
            egress_mark: parking_lot::Mutex::new((0, Instant::now())),
        })
    }

    fn hello(&self) -> anyhow::Result<String> {
        let id = self.identity.lock();
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
            "relayed": self.cfg.relayed,
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
                "lastResult": self.acme_result.as_ref().and_then(|a| a.last_result.lock().clone()),
            })
        });
        let ready = match &self.slot {
            Some(slot) => slot.ready(30 * 60) && !snap.draining,
            None => !snap.draining,
        };
        let used_bps = {
            let total = self.app.metrics.bytes_served.load(std::sync::atomic::Ordering::Relaxed);
            let mut mark = self.egress_mark.lock();
            let elapsed = mark.1.elapsed().as_secs_f64().max(0.5);
            let delta = total.saturating_sub(mark.0);
            *mark = (total, Instant::now());
            (delta as f64 / elapsed) as u64
        };
        json!({
            "type": "heartbeat",
            "version": env!("CARGO_PKG_VERSION"),
            "uptimeSecs": self.started.elapsed().as_secs(),
            "publicBase": self.cfg.public_base(),
            "ready": ready,
            "draining": snap.draining,
            "relayed": self.cfg.relayed,
            "cert": cert,
            "disk": { "used": snap.disk_used, "real": snap.disk_real, "quota": snap.disk_quota },
            "transfer": { "capBps": self.cfg.transfer_bps, "usedBps": used_bps },
            "leases": snap.leases,
            "maxLeases": self.cfg.max_leases,
            "maxTorrents": self.cfg.max_torrents,
            "permitsInUse": snap.permits_in_use,
            "torrents": snap.torrents,
            "remux": self.app.remux.read().as_ref().and_then(|r| r.heartbeat()),
        })
        .to_string()
    }

    fn on_welcome(&self, msg: &serde_json::Value) -> anyhow::Result<()> {
        let worker_id = msg["workerId"].as_str().context("welcome without workerId")?;
        let server_pubkey = msg["serverPubkey"].as_str().context("welcome without serverPubkey")?;
        let key = identity::parse_pubkey(server_pubkey)?;
        let mut id = self.identity.lock();
        let changed = id.worker_id != worker_id || id.server_pubkey.as_deref() != Some(server_pubkey);
        id.worker_id = worker_id.to_string();
        id.server_pubkey = Some(server_pubkey.to_string());
        if changed {
            id.save(&self.cfg.data_dir.join("identity.json"))?;
        }
        *self.app.worker_id.write() = worker_id.to_string();
        *self.app.server_key.write() = Some(key);
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
            Some("reject") => return Err(Rejected(msg["error"].as_str().unwrap_or_default().to_string()).into()),
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
        let key = self.app.server_key.read();
        let Some(key) = key.as_ref() else { return };
        let worker_id = self.app.worker_id.read().clone();
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

    /// A rejected hello is the server's last word on that identity: only the
    /// one reason that says the key itself is unknown earns a new one.
    fn on_reject(&self, reason: &str) {
        let spent = self.reenrolls.load(std::sync::atomic::Ordering::Relaxed);
        match after_reject(reason, self.cfg.enrollment_token.is_some(), spent) {
            AfterReject::Retry => {}
            AfterReject::NoToken => {
                tracing::warn!(reason, "server does not know this worker and there is no enrollment token to get known again; retrying as is");
            }
            AfterReject::Exhausted => {
                tracing::warn!(reason, reenrolls = spent, "server does not know this worker even after enrolling afresh; retrying as is");
            }
            AfterReject::Reenroll => {
                let path = self.cfg.data_dir.join("identity.json");
                match Identity::fresh(&path) {
                    Ok(fresh) => {
                        let stale = std::mem::replace(&mut *self.identity.lock(), fresh);
                        self.reenrolls.store(spent + 1, std::sync::atomic::Ordering::Relaxed);
                        self.app.worker_id.write().clear();
                        *self.app.server_key.write() = None;
                        tracing::info!(
                            previous = %stale.worker_id,
                            attempt = spent + 1,
                            "server no longer knows this worker; discarded its identity and will enroll again"
                        );
                    }
                    Err(e) => tracing::error!(error = %e, "stale identity could not be replaced"),
                }
            }
        }
    }

    pub async fn run(self: Arc<Self>) {
        let mut backoff = RECONNECT_MIN;
        loop {
            let started = Instant::now();
            match self.session().await {
                Ok(()) => {}
                Err(e) => {
                    tracing::warn!(error = %e, "control link dropped");
                    if let Some(rejected) = e.downcast_ref::<Rejected>() {
                        self.on_reject(&rejected.0);
                    }
                }
            }
            if started.elapsed() > SESSION_HEALTHY {
                backoff = RECONNECT_MIN;
                self.reenrolls.store(0, std::sync::atomic::Ordering::Relaxed);
            }
            let jitter = Duration::from_millis(rand::random::<u64>() % 1000);
            tokio::time::sleep(backoff + jitter).await;
            backoff = (backoff * 2).min(RECONNECT_MAX);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_an_unknown_key_is_worth_a_new_identity() {
        assert_eq!(after_reject(UNKNOWN_WORKER, true, 0), AfterReject::Reenroll);
        for reason in ["hello_incomplete", "hello_clock_skew", "hello_signature", "enrollment_refused", "revoked", "draining", "version_refused", "", "unknown_worker "] {
            assert_eq!(after_reject(reason, true, 0), AfterReject::Retry, "{reason}");
        }
    }

    #[test]
    fn re_enrolling_is_bounded_and_needs_a_token() {
        assert_eq!(after_reject(UNKNOWN_WORKER, false, 0), AfterReject::NoToken);
        assert_eq!(after_reject(UNKNOWN_WORKER, true, REENROLL_BUDGET - 1), AfterReject::Reenroll);
        assert_eq!(after_reject(UNKNOWN_WORKER, true, REENROLL_BUDGET), AfterReject::Exhausted);
        assert_eq!(after_reject(UNKNOWN_WORKER, true, REENROLL_BUDGET + 9), AfterReject::Exhausted);
        assert_eq!(after_reject("hello_signature", true, REENROLL_BUDGET), AfterReject::Retry);
    }
}
