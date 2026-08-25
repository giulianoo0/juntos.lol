mod cli;
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
    match std::env::args().nth(1).as_deref() {
        Some("setup") => return cli::setup(),
        Some("--help" | "-h" | "help") => {
            cli::help();
            return Ok(());
        }
        Some("--version" | "-V") => {
            println!("ss-worker {}", env!("CARGO_PKG_VERSION"));
            return Ok(());
        }
        Some(other) => anyhow::bail!("unknown argument {other}; try --help"),
        None => {}
    }
    // The env file the wizard writes; explicit env always wins over it.
    let env_file = std::env::var("SS_WORKER_ENV_FILE").unwrap_or_else(|_| "ss-worker.env".into());
    if std::path::Path::new(&env_file).exists() {
        let loaded = config::load_env_file(std::path::Path::new(&env_file))?;
        eprintln!("loaded {loaded} settings from {env_file}");
    }
    tracing_subscriber::fmt()
        .with_env_filter(EnvFilter::try_from_default_env().unwrap_or_else(|_| EnvFilter::new("info,librqbit=warn")))
        .with_target(false)
        .compact()
        .init();
    let _ = rustls::crypto::ring::default_provider().install_default();
    let cfg = WorkerConfig::load()?;
    std::fs::create_dir_all(&cfg.data_dir)?;
    tracing::info!(data_dir = %cfg.data_dir.display(), public_base = %cfg.public_base(), tls = ?cfg.tls, "starting");

    let engine = engine::Engine::new(cfg.clone()).await?;
    let app = Arc::new(http::AppState {
        engine: engine.clone(),
        throttle: Arc::new(http::throttle::Throttle::new(cfg.transfer_bps)),
        relay: cfg.relay_upstream.clone().map(http::relay::Relay::new),
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
        TlsMode::File => {
            let slot = Arc::new(http::tls::CertSlot::default());
            let (cert, key) = (cfg.tls_cert_file.clone().unwrap(), cfg.tls_key_file.clone().unwrap());
            http::tls::install_from_files(&slot, &cert, &key)?;
            tracing::info!(not_after = ?slot.not_after(), cert = %cert.display(), "certificate loaded from files");
            // Whoever renews the files does it on their own clock; an hourly
            // re-read is early enough for any real certificate lifetime.
            let reload = slot.clone();
            tokio::spawn(async move {
                loop {
                    tokio::time::sleep(Duration::from_secs(3600)).await;
                    if let Err(e) = http::tls::install_from_files(&reload, &cert, &key) {
                        tracing::warn!(error = %e, "certificate re-read failed; keeping the loaded one");
                    }
                }
            });
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

    // Shutdown — a signal, or a drain job from the server: stop taking
    // leases, let responses in flight finish (bounded), close the listener.
    tokio::select! {
        _ = shutdown_signal() => {}
        _ = drain.notified() => {}
    }
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
