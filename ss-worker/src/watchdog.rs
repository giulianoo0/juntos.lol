//! Keeps a wedged worker from staying wedged.
//!
//! A lock cycle anywhere in the process — the engine, librqbit, a peer task
//! — parks every runtime thread on a futex within seconds: the data plane
//! stops answering, the control link goes silent, and the server drops the
//! worker as gone while the container stays up, so nothing restarts it.
//! This runs on its own thread, outside the runtime, and turns that into a
//! logged abort the supervisor recovers from.

use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;
use std::time::Duration;

/// How often the cycle check runs and the runtime tick is inspected.
const CHECK: Duration = Duration::from_secs(10);
/// How long the runtime may go without a tick before it counts as wedged.
/// Long enough for any disk sweep; a healthy runtime ticks every second.
const STALL: Duration = Duration::from_secs(60);

pub fn spawn() {
    let tick = Arc::new(AtomicU64::new(0));
    let beat = tick.clone();
    tokio::spawn(async move {
        loop {
            tokio::time::sleep(Duration::from_secs(1)).await;
            beat.fetch_add(1, Ordering::Relaxed);
        }
    });
    std::thread::Builder::new()
        .name("watchdog".into())
        .spawn(move || {
            let mut last = tick.load(Ordering::Relaxed);
            let mut stalled_for = Duration::ZERO;
            loop {
                std::thread::sleep(CHECK);
                let cycles = parking_lot::deadlock::check_deadlock();
                if !cycles.is_empty() {
                    for (i, cycle) in cycles.iter().enumerate() {
                        for thread in cycle {
                            tracing::error!(
                                cycle = i,
                                thread = ?thread.thread_id(),
                                backtrace = %format!("{:?}", thread.backtrace()),
                                "deadlock",
                            );
                        }
                    }
                    tracing::error!(cycles = cycles.len(), "deadlock detected; aborting so the supervisor restarts the worker");
                    std::process::abort();
                }
                let now = tick.load(Ordering::Relaxed);
                if now != last {
                    last = now;
                    stalled_for = Duration::ZERO;
                    continue;
                }
                stalled_for += CHECK;
                if stalled_for >= STALL {
                    tracing::error!(stalled_for = ?stalled_for, "runtime stopped ticking; aborting so the supervisor restarts the worker");
                    std::process::abort();
                }
            }
        })
        .expect("watchdog thread");
}
