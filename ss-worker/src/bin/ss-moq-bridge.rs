// ss-moq-bridge: the MoQ relay for WebKit. Safari stalls long WebTransport
// sessions and the Cloudflare relay speaks nothing else, so a WebKit viewer
// connects here over WebSocket (qmux) instead. One QUIC session to the relay
// takes every announced broadcast; each WebSocket session is served from it,
// read-only.

use std::net::SocketAddr;
use std::time::Duration;

use anyhow::Context;
use tracing_subscriber::EnvFilter;

// A viewer can ask for a screen moments before the relay's announce reaches us.
const ANNOUNCE_WAIT: Duration = Duration::from_secs(8);

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    tracing_subscriber::fmt()
        .with_env_filter(EnvFilter::try_from_default_env().unwrap_or_else(|_| EnvFilter::new("info,moq_native=warn")))
        .init();

    let upstream: url::Url = std::env::var("SS_MOQ_UPSTREAM")
        .context("SS_MOQ_UPSTREAM")?
        .parse()
        .context("SS_MOQ_UPSTREAM is not a url")?;
    let addr: SocketAddr = std::env::var("SS_MOQ_BRIDGE_ADDR")
        .unwrap_or_else(|_| "[::]:4450".into())
        .parse()
        .context("SS_MOQ_BRIDGE_ADDR")?;

    let origin = moq_net::Origin::random().produce();
    let mut config = moq_native::ClientConfig::default();
    config.backoff.timeout = Duration::ZERO;
    let client = config.init().context("moq client")?;
    let upstream_session = client.with_subscriber(origin.clone()).reconnect(upstream);

    let mut dynamic = origin.dynamic();
    let announced = origin.consume();
    tokio::spawn(async move {
        while let Ok(request) = dynamic.requested_broadcast().await {
            let announced = announced.clone();
            tokio::spawn(async move {
                let path = request.path().to_owned();
                match tokio::time::timeout(ANNOUNCE_WAIT, announced.announced_broadcast(&path)).await {
                    Ok(Some(broadcast)) => request.accept(broadcast),
                    _ => {
                        tracing::debug!(%path, "never announced");
                        request.reject(moq_net::Error::NotFound);
                    }
                }
            });
        }
    });

    let listener = moq_native::websocket::Listener::bind(addr).await.context("bind")?;
    tracing::info!(%addr, "bridge listening");
    let server = moq_net::Server::new().with_publisher(origin.consume());
    while let Some(accepted) = listener.accept().await {
        let session = match accepted {
            Ok(session) => session,
            Err(err) => {
                tracing::debug!(%err, "websocket upgrade failed");
                continue;
            }
        };
        let server = server.clone();
        tokio::spawn(async move {
            match server.accept(session).await {
                Ok((session, driver)) => {
                    tracing::info!(version = ?session.version(), "viewer connected");
                    let result = driver.await;
                    tracing::info!(?result, "viewer left");
                }
                Err(err) => tracing::debug!(%err, "handshake failed"),
            }
        });
    }
    drop(upstream_session);
    Ok(())
}
