pub mod acme;
mod cors;
pub mod throttle;
mod file;
mod haves;
mod hint;
mod range;
pub mod tls;

use std::collections::HashMap;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex, RwLock};
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

/// What every handler needs: the engine, the key tickets are checked
/// against, this worker's id, the revoked set, and the counters.
pub struct AppState {
    pub engine: Arc<Engine>,
    pub throttle: Arc<throttle::Throttle>,
    pub server_key: RwLock<Option<VerifyingKey>>,
    pub worker_id: RwLock<String>,
    pub revoked: Mutex<HashMap<String, u64>>,
    pub metrics: Arc<Metrics>,
}

impl AppState {
    pub fn verify(&self, raw: &str) -> anyhow::Result<Ticket> {
        let key = self.server_key.read().unwrap().ok_or_else(|| anyhow::anyhow!("worker not enrolled"))?;
        let worker_id = self.worker_id.read().unwrap().clone();
        let ticket = ticket::verify(raw, &key, &worker_id)?;
        if self.revoked.lock().unwrap().contains_key(&ticket.jti) {
            anyhow::bail!("ticket revoked");
        }
        Ok(ticket)
    }

    pub fn revoke(&self, jti: &str, exp: u64) {
        let mut revoked = self.revoked.lock().unwrap();
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
    pub in_flight: AtomicU64,
    // Histogram buckets in seconds for the first byte of a range: the SLI
    // a viewer actually feels.
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
        self.first_byte_sum_ms.fetch_add(d.as_millis() as u64, Ordering::Relaxed);
        self.first_byte_count.fetch_add(1, Ordering::Relaxed);
    }
    pub fn observe_stall(&self, d: Duration) {
        self.stall_sum_ms.fetch_add(d.as_millis() as u64, Ordering::Relaxed);
    }
}

pub fn fail(status: StatusCode, audience: &str, detail: &str) -> Response {
    let mut response = (status, [(header::CONTENT_TYPE, "application/json")], serde_json::json!({ "error": detail }).to_string())
        .into_response();
    cors::apply(&mut response, audience);
    response
}

pub fn ok_json(audience: &str, value: serde_json::Value) -> Response {
    let mut response = (StatusCode::OK, [(header::CONTENT_TYPE, "application/json")], value.to_string()).into_response();
    cors::apply(&mut response, audience);
    response
}

// Preflights carry no ticket the server could trust without parsing, so
// the ticket in the path is verified the same way and the origin is its
// audience. An unverifiable ticket gets no CORS at all.
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

async fn preflight_sub(State(state): State<Arc<AppState>>, Path((ticket, _)): Path<(String, String)>) -> Response {
    preflight(State(state), Path(ticket)).await
}

async fn healthz(State(state): State<Arc<AppState>>) -> Response {
    let snapshot = state.engine.snapshot();
    (StatusCode::OK, serde_json::json!({ "ok": true, "torrents": snapshot.torrents.len(), "leases": snapshot.leases }).to_string())
        .into_response()
}

pub fn router(state: Arc<AppState>) -> Router {
    Router::new()
        .route("/healthz", get(healthz))
        .route("/v1/f/:ticket", get(range::get).head(range::head).options(preflight))
        .route("/v1/hint/:ticket", post(hint::post).options(preflight))
        .route("/v1/file/:ticket/:index", get(file::get).options(preflight_sub))
        .route("/v1/t/:ticket/haves", get(haves::get).options(preflight_sub))
        .layer(axum::middleware::from_fn_with_state(state.clone(), in_flight))
        .with_state(state)
}

// Counts responses still being written, for the drain on shutdown.
async fn in_flight(State(state): State<Arc<AppState>>, request: axum::extract::Request, next: axum::middleware::Next) -> Response {
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
            axum_server::bind(cfg.http_addr).handle(handle).serve(app.into_make_service()).await?;
        }
        (_, Some(slot)) => {
            let rustls = axum_server::tls_rustls::RustlsConfig::from_config(tls::server_config(slot));
            let mut server = axum_server::bind_rustls(cfg.https_addr, rustls).handle(handle);
            // Generous windows: a stream fed from disk at WAN latency must
            // not be throttled by a 64 KiB default.
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
pub async fn serve_challenges(addr: std::net::SocketAddr, challenges: Arc<Mutex<HashMap<String, String>>>) -> anyhow::Result<()> {
    let app = Router::new()
        .route(
            "/.well-known/acme-challenge/:token",
            get(|Path(token): Path<String>, State(map): State<Arc<Mutex<HashMap<String, String>>>>| async move {
                match map.lock().unwrap().get(&token) {
                    Some(auth) => (StatusCode::OK, auth.clone()).into_response(),
                    None => StatusCode::NOT_FOUND.into_response(),
                }
            }),
        )
        .with_state(challenges);
    axum_server::bind(addr).serve(app.into_make_service()).await?;
    Ok(())
}

pub async fn serve_metrics(addr: std::net::SocketAddr, state: Arc<AppState>, slot: Option<Arc<tls::CertSlot>>) -> anyhow::Result<()> {
    let app = Router::new()
        .route(
            "/metrics",
            get(move |State(state): State<Arc<AppState>>| {
                let slot = slot.clone();
                async move { (StatusCode::OK, crate::metrics::render(&state, slot.as_deref())).into_response() }
            }),
        )
        .with_state(state);
    axum_server::bind(addr).serve(app.into_make_service()).await?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::range::parse_range;
    use axum::http::HeaderValue;

    #[test]
    fn ranges() {
        let h = |s: &str| HeaderValue::from_str(s).unwrap();
        assert_eq!(parse_range(Some(&h("bytes=0-99")), 1000), Ok((0, 99)));
        assert_eq!(parse_range(Some(&h("bytes=990-5000")), 1000), Ok((990, 999)));
        assert_eq!(parse_range(Some(&h("bytes=500-")), 1000), Ok((500, 999)));
        assert_eq!(parse_range(Some(&h("bytes=-10")), 1000), Ok((990, 999)));
        assert_eq!(parse_range(Some(&h("bytes=1000-")), 1000), Err(()));
        assert_eq!(parse_range(Some(&h("bytes=5-4")), 1000), Err(()));
        assert_eq!(parse_range(None, 1000), Ok((0, 999)));
    }
}
