mod config;
mod control;
mod engine;
mod http;
mod metrics;
mod ticket;

use std::sync::atomic::Ordering;
use std::sync::{Arc, Mutex, RwLock};
use std::time::Duration;

use config::{TlsMode, WorkerConfig};
use tracing_subscriber::EnvFilter;

// ss-worker: one node of the torrent fleet. It dials the server, takes
// signed jobs, joins swarms, and serves the bytes straight to the host's
// browser over HTTPS Range. The remux never happens here; the viewers never
// touch it.
#[tokio::main]
async fn main() -> anyhow::Result<()> {
    tracing_subscriber::fmt()
        .with_env_filter(EnvFilter::try_from_default_env().unwrap_or_else(|_| EnvFilter::new("info,librqbit=warn")))
        .init();
    let _ = rustls::crypto::ring::default_provider().install_default();
    let cfg = WorkerConfig::load()?;
    std::fs::create_dir_all(&cfg.data_dir)?;
    tracing::info!(data_dir = %cfg.data_dir.display(), public_base = %cfg.public_base(), tls = ?cfg.tls, "starting");

    let engine = engine::Engine::new(cfg.clone()).await?;
    let app = Arc::new(http::AppState {
        engine: engine.clone(),
        server_key: RwLock::new(None),
        worker_id: RwLock::new(String::new()),
        revoked: Mutex::new(Default::default()),
        metrics: Arc::new(http::Metrics::default()),
    });

    let (slot, acme) = match cfg.tls {
        TlsMode::Off => (None, None),
        TlsMode::SelfSigned => {
            let slot = Arc::new(http::tls::CertSlot::default());
            let (chain, key) = http::tls::self_signed(http::acme::ip_names(&cfg))?;
            slot.install(chain, key)?;
            (Some(slot), None)
        }
        TlsMode::Acme => {
            let slot = Arc::new(http::tls::CertSlot::default());
            let acme = Arc::new(http::acme::Acme::new(cfg.clone(), slot.clone()));
            if acme.load_existing()? {
                tracing::info!(not_after = ?slot.not_after(), "certificate loaded from disk");
            }
            let challenges = acme.challenges();
            let addr = cfg.http_addr;
            tokio::spawn(async move {
                if let Err(e) = http::serve_challenges(addr, challenges).await {
                    tracing::error!(error = %e, "challenge listener died");
                }
            });
            tokio::spawn(acme.clone().run());
            (Some(slot), Some(acme))
        }
    };

    let handle = axum_server::Handle::new();
    {
        let (state, slot, handle) = (app.clone(), slot.clone(), handle.clone());
        tokio::spawn(async move {
            if let Err(e) = http::serve(state, slot, handle).await {
                tracing::error!(error = %e, "data plane died");
            }
        });
    }
    {
        let (state, slot, addr) = (app.clone(), slot.clone(), cfg.metrics_addr);
        tokio::spawn(async move {
            if let Err(e) = http::serve_metrics(addr, state, slot).await {
                tracing::error!(error = %e, "metrics listener died");
            }
        });
    }

    let drain = Arc::new(tokio::sync::Notify::new());
    let control = Arc::new(control::Control::new(cfg.clone(), engine.clone(), app.clone(), slot, acme, drain.clone())?);
    tokio::spawn(control.run());

    // Shutdown: stop taking leases, let responses in flight finish (bounded),
    // then close the listener.
    shutdown_signal().await;
    tracing::info!("draining");
    engine.drain();
    let deadline = tokio::time::Instant::now() + cfg.drain_deadline;
    while app.metrics.in_flight.load(Ordering::Relaxed) > 0 && tokio::time::Instant::now() < deadline {
        tokio::time::sleep(Duration::from_millis(200)).await;
    }
    handle.graceful_shutdown(Some(Duration::from_secs(5)));
    tokio::time::sleep(Duration::from_millis(500)).await;
    Ok(())
}

async fn shutdown_signal() {
    let ctrl_c = tokio::signal::ctrl_c();
    #[cfg(unix)]
    {
        let mut term = tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate()).expect("sigterm");
        tokio::select! {
            _ = ctrl_c => {}
            _ = term.recv() => {}
        }
    }
    #[cfg(not(unix))]
    {
        let _ = ctrl_c.await;
    }
}
