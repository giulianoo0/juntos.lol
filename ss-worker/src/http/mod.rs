pub mod acme;
mod cors;
mod file;
mod hint;
pub mod range;
pub mod relay;
pub mod throttle;
pub mod tls;

use std::collections::HashMap;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;
use parking_lot::{Mutex, RwLock};
use std::time::Duration;

use axum::extract::{Path, State};
use axum::http::{header, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post};
use axum::Router;
use ed25519_dalek::VerifyingKey;

use crate::config::TlsMode;
use crate::engine::Engine;
use crate::ticket::{self, Ticket};

pub struct AppState {
    pub engine: Arc<Engine>,
    pub throttle: Arc<throttle::Throttle>,
    pub relay: Option<relay::Relay>,
    pub server_key: RwLock<Option<VerifyingKey>>,
    pub worker_id: RwLock<String>,
    pub revoked: Mutex<HashMap<String, u64>>,
    pub probe_spent: Mutex<HashMap<String, (usize, u64)>>,
    pub metrics: Arc<Metrics>,
    pub remux: parking_lot::RwLock<Option<Arc<crate::remux::Remux>>>,
}

impl AppState {
    pub fn verify(&self, raw: &str) -> anyhow::Result<Ticket> {
        let key = self
            .server_key
            .read()
            .ok_or_else(|| anyhow::anyhow!("worker not enrolled"))?;
        let worker_id = self.worker_id.read().clone();
        let ticket = ticket::verify(raw, &key, &worker_id)?;
        if self.revoked.lock().contains_key(&ticket.jti) {
            anyhow::bail!("ticket revoked");
        }
        Ok(ticket)
    }

    pub fn revoke(&self, jti: &str, exp: u64) {
        let mut revoked = self.revoked.lock();
        let now = ticket::now_secs();
        revoked.retain(|_, e| *e > now);
        revoked.insert(jti.to_string(), exp);
    }
}

#[derive(Default)]
pub struct Metrics {
    pub range_requests: AtomicU64,
    pub bytes_served: AtomicU64,
    pub stalls: AtomicU64,
    pub first_byte_timeouts: AtomicU64,
    pub superseded: AtomicU64,
    pub in_flight: AtomicU64,
    pub first_byte_buckets: [AtomicU64; 8],
    pub first_byte_sum_ms: AtomicU64,
    pub first_byte_count: AtomicU64,
    pub stall_sum_ms: AtomicU64,
}

pub const FIRST_BYTE_BOUNDS: [f64; 8] = [0.1, 0.25, 0.5, 1.0, 2.5, 5.0, 10.0, 30.0];

impl Metrics {
    pub fn observe_first_byte(&self, d: Duration) {
        let secs = d.as_secs_f64();
        for (i, bound) in FIRST_BYTE_BOUNDS.iter().enumerate() {
            if secs <= *bound {
                self.first_byte_buckets[i].fetch_add(1, Ordering::Relaxed);
            }
        }
        self.first_byte_sum_ms
            .fetch_add(d.as_millis() as u64, Ordering::Relaxed);
        self.first_byte_count.fetch_add(1, Ordering::Relaxed);
    }
    pub fn observe_stall(&self, d: Duration) {
        self.stall_sum_ms
            .fetch_add(d.as_millis() as u64, Ordering::Relaxed);
    }
}

pub fn fail(status: StatusCode, audience: &str, detail: &str) -> Response {
    let mut response = (
        status,
        [(header::CONTENT_TYPE, "application/json")],
        serde_json::json!({ "error": detail }).to_string(),
    )
        .into_response();
    cors::apply(&mut response, audience);
    response
}

pub fn ok_json(audience: &str, value: serde_json::Value) -> Response {
    let mut response = (
        StatusCode::OK,
        [(header::CONTENT_TYPE, "application/json")],
        value.to_string(),
    )
        .into_response();
    cors::apply(&mut response, audience);
    response
}

async fn preflight(State(state): State<Arc<AppState>>, Path(ticket): Path<String>) -> Response {
    match state.verify(&ticket) {
        Ok(t) => {
            let mut response = StatusCode::NO_CONTENT.into_response();
            cors::apply(&mut response, &t.audience);
            response
        }
        Err(_) => StatusCode::FORBIDDEN.into_response(),
    }
}

async fn preflight_sub(
    State(state): State<Arc<AppState>>,
    Path((ticket, _)): Path<(String, String)>,
) -> Response {
    preflight(State(state), Path(ticket)).await
}

const PROBE_CAP: usize = 4 * 1024 * 1024;
const PROBE_TICKET_BUDGET: usize = 8 * 1024 * 1024;

/// Charges `bytes` to a probe ticket's lifetime budget; false when the
/// charge would pass it. Expired entries are swept on the way through.
fn spend_probe_budget(
    spent: &mut HashMap<String, (usize, u64)>,
    jti: &str,
    exp: u64,
    bytes: usize,
) -> bool {
    let now = ticket::now_secs();
    spent.retain(|_, (_, exp)| *exp > now);
    let used = spent.entry(jti.to_string()).or_insert((0, exp));
    if used.0 + bytes > PROBE_TICKET_BUDGET {
        return false;
    }
    used.0 += bytes;
    true
}

async fn probe(
    State(state): State<Arc<AppState>>,
    Path(ticket): Path<String>,
    axum::extract::Query(query): axum::extract::Query<std::collections::HashMap<String, String>>,
) -> Response {
    let ticket = match state.verify(&ticket) {
        Ok(t) => t,
        Err(e) => return fail(StatusCode::UNAUTHORIZED, "*", &e.to_string()),
    };
    let bytes = query
        .get("bytes")
        .and_then(|b| b.parse::<usize>().ok())
        .unwrap_or(2 * 1024 * 1024)
        .min(PROBE_CAP);
    {
        let mut spent = state.probe_spent.lock();
        if !spend_probe_budget(&mut spent, &ticket.jti, ticket.exp, bytes) {
            return fail(
                StatusCode::TOO_MANY_REQUESTS,
                &ticket.audience,
                "probe budget spent",
            );
        }
    }
    let mut response = (
        StatusCode::OK,
        [(header::CONTENT_TYPE, "application/octet-stream")],
        vec![0u8; bytes],
    )
        .into_response();
    cors::apply(&mut response, &ticket.audience);
    response
}

async fn healthz(State(state): State<Arc<AppState>>) -> Response {
    let snapshot = state.engine.snapshot();
    (StatusCode::OK, serde_json::json!({ "ok": true, "torrents": snapshot.torrents.len(), "leases": snapshot.leases }).to_string())
        .into_response()
}

pub fn router(state: Arc<AppState>) -> Router {
    Router::new()
        .route("/healthz", get(healthz))
        .route(
            "/v1/f/:ticket",
            get(range::get).head(range::head).options(preflight),
        )
        .route("/v1/hint/:ticket", post(hint::post).options(preflight))
        .route(
            "/v1/file/:ticket/:index",
            get(file::get).options(preflight_sub),
        )
        .route("/v1/probe/:ticket", get(probe).options(preflight))
        .route("/relay/*path", axum::routing::any(relay::any))
        .layer(axum::middleware::from_fn_with_state(
            state.clone(),
            in_flight,
        ))
        .with_state(state)
}

async fn in_flight(
    State(state): State<Arc<AppState>>,
    request: axum::extract::Request,
    next: axum::middleware::Next,
) -> Response {
    state.metrics.in_flight.fetch_add(1, Ordering::Relaxed);
    let response = next.run(request).await;
    state.metrics.in_flight.fetch_sub(1, Ordering::Relaxed);
    response
}

/// Serves the data plane: TLS with h2 unless the topology proxies it.
pub async fn serve(
    state: Arc<AppState>,
    slot: Option<Arc<tls::CertSlot>>,
    handle: axum_server::Handle,
) -> anyhow::Result<()> {
    let cfg = &state.engine.cfg;
    let app = router(state.clone());
    match (&cfg.tls, slot) {
        (TlsMode::Off, _) => {
            tracing::info!(addr = %cfg.http_addr, "data plane on plain http");
            axum_server::bind(cfg.http_addr)
                .handle(handle)
                .serve(app.into_make_service())
                .await?;
        }
        (_, Some(slot)) => {
            let rustls =
                axum_server::tls_rustls::RustlsConfig::from_config(tls::server_config(slot));
            let mut server = axum_server::bind_rustls(cfg.https_addr, rustls).handle(handle);
            server
                .http_builder()
                .http2()
                .initial_stream_window_size(Some(4 * 1024 * 1024))
                .initial_connection_window_size(Some(16 * 1024 * 1024))
                .max_concurrent_streams(Some(64));
            tracing::info!(addr = %cfg.https_addr, "data plane on https");
            server.serve(app.into_make_service()).await?;
        }
        (_, None) => anyhow::bail!("tls enabled but no certificate slot"),
    }
    Ok(())
}

/// Port 80: the ACME challenge, and a hint for anything else.
pub async fn serve_challenges(
    addr: std::net::SocketAddr,
    challenges: Arc<Mutex<HashMap<String, String>>>,
) -> anyhow::Result<()> {
    let app = Router::new()
        .route(
            "/.well-known/acme-challenge/:token",
            get(
                |Path(token): Path<String>,
                 State(map): State<Arc<Mutex<HashMap<String, String>>>>| async move {
                    match map.lock().get(&token) {
                        Some(auth) => (StatusCode::OK, auth.clone()).into_response(),
                        None => StatusCode::NOT_FOUND.into_response(),
                    }
                },
            ),
        )
        .with_state(challenges);
    axum_server::bind(addr)
        .serve(app.into_make_service())
        .await?;
    Ok(())
}

pub async fn serve_metrics(
    addr: std::net::SocketAddr,
    state: Arc<AppState>,
    slot: Option<Arc<tls::CertSlot>>,
) -> anyhow::Result<()> {
    let app = Router::new()
        .route(
            "/metrics",
            get(move |State(state): State<Arc<AppState>>| {
                let slot = slot.clone();
                async move {
                    (
                        StatusCode::OK,
                        crate::metrics::render(&state, slot.as_deref()),
                    )
                        .into_response()
                }
            }),
        )
        .with_state(state);
    axum_server::bind(addr)
        .serve(app.into_make_service())
        .await?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::range::parse_range;
    use super::spend_probe_budget;
    use axum::http::HeaderValue;

    #[test]
    fn probe_budget_is_per_ticket_and_lifetime() {
        let mut spent = std::collections::HashMap::new();
        let exp = crate::ticket::now_secs() + 90;
        assert!(spend_probe_budget(&mut spent, "j1", exp, 4 * 1024 * 1024));
        assert!(spend_probe_budget(&mut spent, "j1", exp, 4 * 1024 * 1024));
        assert!(
            !spend_probe_budget(&mut spent, "j1", exp, 1),
            "third request passes the budget"
        );
        assert!(
            spend_probe_budget(&mut spent, "j2", exp, 4 * 1024 * 1024),
            "another ticket has its own budget"
        );
        let mut stale =
            std::collections::HashMap::from([("old".to_string(), (8 * 1024 * 1024usize, 1u64))]);
        assert!(spend_probe_budget(&mut stale, "j3", exp, 1));
        assert!(!stale.contains_key("old"));
    }

    #[test]
    fn ranges() {
        let h = |s: &str| HeaderValue::from_str(s).unwrap();
        assert_eq!(parse_range(Some(&h("bytes=0-99")), 1000), Ok((0, 99)));
        assert_eq!(
            parse_range(Some(&h("bytes=990-5000")), 1000),
            Ok((990, 999))
        );
        assert_eq!(parse_range(Some(&h("bytes=500-")), 1000), Ok((500, 999)));
        assert_eq!(parse_range(Some(&h("bytes=-10")), 1000), Ok((990, 999)));
        assert_eq!(parse_range(Some(&h("bytes=1000-")), 1000), Err(()));
        assert_eq!(parse_range(Some(&h("bytes=5-4")), 1000), Err(()));
        assert_eq!(parse_range(None, 1000), Ok((0, 999)));
    }
}
