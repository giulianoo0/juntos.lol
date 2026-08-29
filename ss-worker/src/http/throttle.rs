use parking_lot::Mutex;
use std::time::{Duration, Instant};

/// A token bucket over the data plane's egress. The pump asks before every
/// chunk it sends; past the ceiling it waits, which is exactly the
/// backpressure h2 passes on to the reader. Burst is a quarter second of
/// the cap, so short reads stay snappy and sustained ones average out.
pub struct Throttle {
    cap_bps: f64,
    state: Mutex<(f64, Instant)>,
}

impl Throttle {
    pub fn new(cap_bps: u64) -> Self {
        Self { cap_bps: cap_bps as f64, state: Mutex::new((cap_bps as f64 / 4.0, Instant::now())) }
    }

    pub fn cap_bps(&self) -> u64 {
        self.cap_bps as u64
    }

    pub async fn acquire(&self, bytes: usize) {
        if self.cap_bps <= 0.0 {
            return;
        }
        let need = bytes as f64;
        loop {
            let wait = {
                let mut state = self.state.lock();
                let (ref mut tokens, ref mut last) = *state;
                let now = Instant::now();
                *tokens = (*tokens + now.duration_since(*last).as_secs_f64() * self.cap_bps).min(self.cap_bps / 4.0);
                *last = now;
                if *tokens >= need {
                    *tokens -= need;
                    None
                } else {
                    Some(Duration::from_secs_f64(((need - *tokens) / self.cap_bps).min(0.5)))
                }
            };
            match wait {
                None => return,
                Some(d) => tokio::time::sleep(d).await,
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test(start_paused = true)]
    async fn caps_sustained_throughput() {
        let throttle = Throttle::new(1_000_000); // 1 MB/s
        let started = tokio::time::Instant::now();
        for _ in 0..8 {
            throttle.acquire(250_000).await;
        }
        // 2 MB at 1 MB/s minus the initial burst: at least ~1.7 s.
        assert!(started.elapsed() >= Duration::from_millis(1_600), "took {:?}", started.elapsed());
    }

    #[tokio::test]
    async fn uncapped_never_waits() {
        let throttle = Throttle::new(0);
        throttle.acquire(usize::MAX / 2).await;
    }
}
