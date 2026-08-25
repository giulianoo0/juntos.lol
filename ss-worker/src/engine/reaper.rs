use std::sync::Weak;
use std::time::Duration;

use super::entry::Phase;
use super::Engine;

const SWEEP: Duration = Duration::from_secs(5);
// How long a parked stream may sit unread before its priority window is
// considered stale and released back to whoever is still reading.
const SLOT_IDLE: Duration = Duration::from_secs(20);
// A lease the server never released outlives its usefulness by this much;
// the server's own sweeper releases sooner, this is the worker's backstop.
const LEASE_TTL: Duration = Duration::from_secs(6 * 3600);

/// idle > grace → pause, keep the bytes; idle > grace + ttl → delete. A
/// lease taken in between cancels both, which is what makes a reload or a
/// failover come back to warm pieces.
pub fn spawn(engine: Weak<Engine>) {
    tokio::spawn(async move {
        loop {
            tokio::time::sleep(SWEEP).await;
            let Some(engine) = engine.upgrade() else { break };
            engine.expire_stale_leases(LEASE_TTL);
            engine.drop_stale_slots(SLOT_IDLE);
            engine.retry_failed().await;
            let grace = engine.cfg.idle_grace;
            let ttl = engine.cfg.reap_ttl;
            for (id, handle, phase, idle) in engine.idle_candidates() {
                match phase {
                    Phase::Ready | Phase::Serving if idle > grace => {
                        engine.pause_if_idle(&id, &handle).await;
                    }
                    Phase::Idle if idle > grace + ttl => {
                        engine.set_phase(&id, Phase::Reaping);
                        engine.reap(&id, &handle).await;
                    }
                    _ => {}
                }
            }
        }
    });
}
