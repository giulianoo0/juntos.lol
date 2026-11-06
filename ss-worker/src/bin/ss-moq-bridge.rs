// ss-moq-bridge: the MoQ relay over WebSocket (qmux). Safari stalls long
// WebTransport sessions and a network that drops UDP never opens one, and the
// Cloudflare relay speaks nothing else, so those browsers connect here.
//
// Every room has a relay of its own, so the server signs each viewer a
// ticket naming the room's relay and broadcast base. One QUIC session per
// relay is shared by the viewers on it and closed when the last one leaves;
// a viewer sees only the broadcasts under its room's base. A ticket that
// also names a publish relay and a path lets its holder write that one
// broadcast, handed on through a QUIC session of its own.

use std::collections::HashMap;
use std::net::SocketAddr;
use std::sync::{Arc, Weak};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use anyhow::Context;
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use base64::Engine;
use parking_lot::Mutex;
use ring::hmac;
use serde::Deserialize;
use tracing_subscriber::EnvFilter;

// A viewer can ask for a screen moments before the relay's announce reaches us.
const ANNOUNCE_WAIT: Duration = Duration::from_secs(8);

#[derive(Deserialize)]
struct Ticket {
    /// The room's broadcast base, `juntos/{room}/{secret}`.
    b: String,
    /// The room's relay with its subscribe token.
    u: String,
    /// Unix seconds after which the ticket opens nothing.
    e: u64,
    /// The room's relay with its publish token, for a member who writes.
    #[serde(default)]
    p: Option<String>,
    /// The one broadcast that member may write.
    #[serde(default)]
    w: Option<String>,
}

impl Ticket {
    fn write(&self) -> Option<(url::Url, String)> {
        let path = self.w.as_ref()?;
        let inside = path.strip_prefix(self.b.as_str())?.strip_prefix('/')?;
        if inside.is_empty() {
            return None;
        }
        Some((self.p.as_ref()?.parse().ok()?, path.clone()))
    }
}

fn verify(key: &hmac::Key, ticket: &str) -> Option<Ticket> {
    let (payload, sig) = ticket.split_once('.')?;
    let sig = URL_SAFE_NO_PAD.decode(sig).ok()?;
    hmac::verify(key, payload.as_bytes(), &sig).ok()?;
    let ticket: Ticket = serde_json::from_slice(&URL_SAFE_NO_PAD.decode(payload).ok()?).ok()?;
    let now = SystemTime::now().duration_since(UNIX_EPOCH).ok()?.as_secs();
    (ticket.e > now && !ticket.b.is_empty()).then_some(ticket)
}

struct Upstream {
    origin: moq_net::origin::Producer,
    _session: moq_native::Reconnect,
    announces: tokio::task::AbortHandle,
}

impl Drop for Upstream {
    fn drop(&mut self) {
        self.announces.abort();
    }
}

type Upstreams = Arc<Mutex<HashMap<String, Weak<Upstream>>>>;

fn upstream(client: &moq_native::Client, upstreams: &Upstreams, url: &url::Url) -> Arc<Upstream> {
    let mut map = upstreams.lock();
    map.retain(|_, held| held.strong_count() > 0);
    if let Some(found) = map.get(url.as_str()).and_then(Weak::upgrade) {
        return found;
    }
    let origin = moq_net::Origin::random().produce();
    let session = client.clone().with_subscriber(origin.clone()).reconnect(url.clone());

    let mut dynamic = origin.dynamic();
    let announced = origin.consume();
    let announces = tokio::spawn(async move {
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

    let found = Arc::new(Upstream { origin, _session: session, announces: announces.abort_handle() });
    map.insert(url.as_str().to_owned(), Arc::downgrade(&found));
    found
}

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    tracing_subscriber::fmt()
        .with_env_filter(EnvFilter::try_from_default_env().unwrap_or_else(|_| EnvFilter::new("info,moq_native=warn")))
        .init();

    let secret = std::env::var("SS_MOQ_BRIDGE_SECRET").context("SS_MOQ_BRIDGE_SECRET")?;
    anyhow::ensure!(secret.len() >= 32, "SS_MOQ_BRIDGE_SECRET is too short");
    let key = hmac::Key::new(hmac::HMAC_SHA256, secret.as_bytes());
    let addr: SocketAddr = std::env::var("SS_MOQ_BRIDGE_ADDR")
        .unwrap_or_else(|_| "[::]:4450".into())
        .parse()
        .context("SS_MOQ_BRIDGE_ADDR")?;

    let mut config = moq_native::ClientConfig::default();
    config.backoff.timeout = Duration::ZERO;
    let client = config.init().context("moq client")?;
    let upstreams: Upstreams = Arc::default();

    // The server only hands out request URLs alongside a listener of its own:
    // a loopback qmux port nobody dials keeps it from opening QUIC on 443.
    let mut server_config = moq_native::ServerConfig::default();
    server_config.tcp.bind = Some("127.0.0.1:0".parse().expect("loopback address"));
    let listener = moq_native::websocket::Listener::bind(addr).await.context("bind")?;
    let mut server = server_config.init().context("moq server")?.with_websocket(listener);
    tracing::info!(%addr, "bridge listening");

    while let Some(request) = server.accept().await {
        let ticket = request
            .url()
            .and_then(|url| url.query_pairs().find(|(name, _)| name == "t").map(|(_, value)| value.into_owned()))
            .and_then(|ticket| verify(&key, &ticket));
        let Some((ticket, relay)) = ticket.and_then(|ticket| ticket.u.parse::<url::Url>().ok().map(|relay| (ticket, relay))) else {
            tracing::debug!("viewer without a valid ticket");
            tokio::spawn(request.close(403));
            continue;
        };
        let held = upstream(&client, &upstreams, &relay);
        let Some(scoped) = held.origin.consume().scope(&[moq_net::Path::new(&ticket.b).to_owned()]) else {
            tokio::spawn(request.close(403));
            continue;
        };
        let mut request = request.with_publisher(scoped);
        let mut forward = None;
        if let Some((relay, path)) = ticket.write() {
            let local = moq_net::Origin::random().produce();
            let Some(ingress) = local.scope(&[moq_net::Path::new(&path).to_owned()]) else {
                tokio::spawn(request.close(403));
                continue;
            };
            request = request.with_subscriber(ingress);
            forward = Some((client.clone().with_publisher(local.consume()).reconnect(relay), path));
        }
        tokio::spawn(async move {
            let room = ticket.b.split('/').nth(1).unwrap_or("").to_owned();
            match request.ok().await {
                Ok(session) => {
                    match &forward {
                        Some((_, path)) => tracing::info!(%room, broadcast = path.rsplit('/').next().unwrap_or(""), "publisher connected"),
                        None => tracing::info!(%room, "viewer connected"),
                    }
                    let reason = session.closed().await;
                    tracing::info!(%reason, "viewer left");
                }
                Err(err) => tracing::debug!(%err, "handshake failed"),
            }
            drop(forward);
            drop(held);
        });
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sign(key: &[u8], payload: &str) -> String {
        let payload = URL_SAFE_NO_PAD.encode(payload);
        let sig = hmac::sign(&hmac::Key::new(hmac::HMAC_SHA256, key), payload.as_bytes());
        format!("{payload}.{}", URL_SAFE_NO_PAD.encode(sig.as_ref()))
    }

    #[test]
    fn a_signed_ticket_opens_its_room() {
        let key = b"0123456789abcdef0123456789abcdef";
        let ticket = sign(key, r#"{"b":"juntos/ROOM/secret","u":"https://relay/token","e":99999999999}"#);
        let opened = verify(&hmac::Key::new(hmac::HMAC_SHA256, key), &ticket).expect("valid ticket");
        assert_eq!(opened.b, "juntos/ROOM/secret");
        assert_eq!(opened.u, "https://relay/token");
    }

    #[test]
    fn a_publish_ticket_writes_only_its_own_path_inside_the_room() {
        let key = b"0123456789abcdef0123456789abcdef";
        let open = |payload: &str| verify(&hmac::Key::new(hmac::HMAC_SHA256, key), &sign(key, payload)).expect("valid ticket");
        let mine = open(r#"{"b":"juntos/ROOM/secret","u":"https://relay/sub","e":99999999999,"p":"https://relay/pub","w":"juntos/ROOM/secret/m2.hang"}"#);
        let (relay, path) = mine.write().expect("a publish grant");
        assert_eq!(relay.as_str(), "https://relay/pub");
        assert_eq!(path, "juntos/ROOM/secret/m2.hang");
        let elsewhere = open(r#"{"b":"juntos/ROOM/secret","u":"https://relay/sub","e":99999999999,"p":"https://relay/pub","w":"juntos/OTHER/secret/m2.hang"}"#);
        assert!(elsewhere.write().is_none());
        let watching = open(r#"{"b":"juntos/ROOM/secret","u":"https://relay/sub","e":99999999999}"#);
        assert!(watching.write().is_none());
    }

    #[test]
    fn a_ticket_from_another_key_or_past_its_time_opens_nothing() {
        let key = hmac::Key::new(hmac::HMAC_SHA256, b"0123456789abcdef0123456789abcdef");
        let forged = sign(b"another key, just as long as it.", r#"{"b":"juntos/ROOM/secret","u":"https://relay/t","e":99999999999}"#);
        assert!(verify(&key, &forged).is_none());
        let stale = sign(b"0123456789abcdef0123456789abcdef", r#"{"b":"juntos/ROOM/secret","u":"https://relay/t","e":1}"#);
        assert!(verify(&key, &stale).is_none());
        assert!(verify(&key, "no-dot").is_none());
    }
}
